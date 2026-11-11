(function (H) {
  'use strict';

  const { HubError, LimitError } = H.limits;

  const { cleanCell, dedupeHeaders } = H.text;

  /** UTF-8 estrito; se os bytes não forem UTF-8 válido, assume Windows-1252. Remove o BOM. */
  function decodeText(bytes) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('windows-1252').decode(bytes);
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  const DELIMITERS = [';', ',', '\t', '|'];

  /** Conta delimitadores fora de aspas em uma linha. */
  function countDelimiters(line, delimiter) {
    let inQuotes = false;
    let count = 0;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === delimiter && !inQuotes) count++;
    }
    return count;
  }

  /** Escolhe o delimitador mais consistente nas primeiras linhas (fora de aspas). */
  function detectDelimiter(text) {
    const lines = text.split(/\r\n|\n|\r/, 40).filter((l) => l.trim() !== '').slice(0, 20);
    let best = ',';
    let bestScore = 0;
    for (const d of DELIMITERS) {
      const counts = lines.map((l) => countDelimiters(l, d));
      const first = counts[0] ?? 0;
      if (first === 0) continue;
      const consistent = counts.filter((c) => c === first).length;
      const score = consistent * 1000 + first;
      if (score > bestScore) {
        best = d;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Parser RFC 4180: campos entre aspas, "" como aspas literais, quebras de linha dentro de
   * aspas, \r\n / \n / \r. Aplica limites durante a leitura (não depois).
   */
  function parseDelimited(text, delimiter, limits) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    const pushField = () => {
      if (field.length > limits.maxCellChars) {
        throw new LimitError(`Uma célula excede o limite de ${limits.maxCellChars} caracteres.`);
      }
      row.push(field);
      if (row.length > limits.maxColumns) {
        throw new LimitError(`O arquivo excede o limite de ${limits.maxColumns} colunas.`);
      }
      field = '';
    };
    const pushRow = () => {
      pushField();
      if (!(row.length === 1 && row[0] === '')) {
        rows.push(row);
        if (rows.length > limits.maxRowsPerFile + 1) {
          throw new LimitError(`O arquivo excede o limite de ${limits.maxRowsPerFile} linhas.`);
        }
      }
      row = [];
    };

    while (i < n) {
      const ch = text.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
        } else {
          field += ch;
          if (field.length > limits.maxCellChars) {
            throw new LimitError(`Uma célula excede o limite de ${limits.maxCellChars} caracteres.`);
          }
        }
        i++;
        continue;
      }
      if (ch === '"' && field === '') {
        inQuotes = true;
        i++;
      } else if (ch === delimiter) {
        pushField();
        i++;
      } else if (ch === '\r' || ch === '\n') {
        pushRow();
        i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
      } else {
        field += ch;
        i++;
      }
    }
    if (inQuotes) throw new HubError('Arquivo CSV malformado: aspas não fechadas.');
    if (field !== '' || row.length > 0) pushRow();
    return rows;
  }

  /** Converte linhas brutas em Table: cabeçalho = primeira linha não vazia. */
  function rowsToTable(raw, limits) {
    const warnings = [];
    const headerAt = raw.findIndex((r) => r.some((c) => c.trim() !== ''));
    if (headerAt === -1) throw new HubError('O arquivo está vazio.');

    const headerRow = raw[headerAt];
    let width = headerRow.length;
    const dataRows = raw.slice(headerAt + 1);
    let widened = 0;
    for (const r of dataRows) {
      if (r.length > width) {
        width = r.length;
        widened++;
      }
    }
    if (width > limits.maxColumns) throw new LimitError(`O arquivo excede o limite de ${limits.maxColumns} colunas.`);
    if (width > headerRow.length) {
      warnings.push(
        `Algumas linhas têm mais campos que o cabeçalho; ${width - headerRow.length} coluna(s) extra(s) foram criadas para não perder dados.`,
      );
    }

    const columns = dedupeHeaders(
      Array.from({ length: width }, (_, i) => headerRow[i] ?? ''),
      limits.maxHeaderChars,
    );

    const rows = [];
    for (const r of dataRows) {
      const out = Array.from({ length: width }, (_, i) => cleanCell(r[i] ?? '', limits));
      if (out.some((v) => v !== '')) rows.push(out);
    }
    return { columns, rows, warnings };
  }

  function readDelimited(bytes, limits) {
    const text = decodeText(bytes);
    return rowsToTable(parseDelimited(text, detectDelimiter(text), limits), limits);
  }

  H.csvReader = { decodeText, detectDelimiter, parseDelimited, rowsToTable, readDelimited };
})((globalThis.Hub = globalThis.Hub || {}));
