(function (H) {
  'use strict';

  const { listZip, extractZip } = H.zip;
  const { parseXml, byTag, decodeXml, forEachElement, forEachElementInBytes } = H.xml;
  const { HubError, LimitError } = H.limits;

  const { cleanCell, dedupeHeaders } = H.text;

  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  /** Texto de <si>/<is>: junta <t> de runs ricos, ignorando fonética (<rPh>). */
  function richText(el) {
    let out = '';
    const walk = (node) => {
      for (const child of Array.from(node.children)) {
        if (child.localName === 't') out += child.textContent ?? '';
        else if (child.localName !== 'rPh') walk(child);
      }
    };
    walk(el);
    return out;
  }

  const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

  function isDateFormat(code) {
    const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[ymdhs]/i.test(stripped);
  }

  function readDateStyles(doc) {
    const dateXf = new Set();
    if (!doc) return dateXf;
    const custom = new Map();
    for (const f of byTag(doc, 'numFmt')) {
      const id = Number(f.getAttribute('numFmtId'));
      if (Number.isInteger(id)) custom.set(id, f.getAttribute('formatCode') ?? '');
    }
    const cellXfs = byTag(doc, 'cellXfs')[0];
    if (!cellXfs) return dateXf;
    Array.from(cellXfs.children).forEach((xf, i) => {
      const id = Number(xf.getAttribute('numFmtId'));
      if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id) ?? ''))) dateXf.add(i);
    });
    return dateXf;
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** Número de série do Excel -> texto ISO (data, ou data e hora quando houver hora). */
  function serialToIso(serial, date1904) {
    if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return String(serial);
    const epoch = Date.UTC(1899, 11, 30) + (date1904 ? 1462 * 86_400_000 : 0);
    const ms = Math.round(serial * 86_400_000 / 60_000) * 60_000; // arredonda ao minuto
    const d = new Date(epoch + ms);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    if (serial < 1) return time;
    return time === '00:00' ? date : `${date} ${time}`;
  }

  function numberToText(raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : raw;
  }

  /** "BC12" -> índice de coluna 54 (base 0). */
  function columnIndex(ref) {
    const m = /^([A-Z]+)/i.exec(ref);
    if (!m) return -1;
    let n = 0;
    for (const ch of (m[1]).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  /**
   * Células mescladas: o Excel guarda o valor só na célula do canto; as demais ficam vazias. Repete o valor nas linhas
   * de baixo (mesclagens verticais, como uma "Região" que agrupa várias linhas). Mesclagens de uma linha só (títulos) são ignoradas.
   * ranges: [[linha1, coluna1, linha2, coluna2], ...] com índices a partir de 0. Retorna { filled, maxCol }.
   */
  function fillMerged(grid, ranges, maxCol, limits) {
    const MAX_FILLED = 5_000_000;
    let filled = 0;
    for (const [r1, c1, r2, c2] of ranges) {
      if (r2 <= r1 || c2 >= limits.maxColumns || r2 > limits.maxRowsPerFile + 26) continue;
      const top = grid[r1] ? grid[r1][c1] : undefined;
      if (top === undefined || top === '') continue;
      for (let r = r1 + 1; r <= r2; r++) {
        const row = grid[r] ?? (grid[r] = []);
        for (let c = c1; c <= c2; c++) {
          if (row[c] === undefined || row[c] === '') {
            if (++filled > MAX_FILLED) return { filled: MAX_FILLED, maxCol };
            row[c] = top;
          }
        }
        if (c2 + 1 > maxCol) maxCol = c2 + 1;
      }
    }
    return { filled, maxCol };
  }

  /** Lê as áreas mescladas (<mergeCell ref="A3:A4"/>) do fim do XML da aba, onde o Excel as grava. */
  function readMergeRanges(sheetBytes) {
    const win = new TextDecoder('utf-8').decode(sheetBytes.subarray(Math.max(0, sheetBytes.length - 16 * 1024 * 1024)));
    const ranges = [];
    const re = /<(?:[\w.-]+:)?mergeCell\s[^>]*?ref="([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)"/g;
    let m;
    while ((m = re.exec(win)) && ranges.length < 100_000) {
      ranges.push([Number(m[2]) - 1, columnIndex(m[1]), Number(m[4]) - 1, columnIndex(m[3])]);
    }
    return ranges;
  }

  /** grade (linhas esparsas) -> tabela: acha o cabeçalho, remove linhas vazias e aplica os limites. */
  function gridToTable(grid, maxCol, limits, hiddenGrid) {
    // Cabeçalho = linha com mais células preenchidas nas primeiras 25 linhas.
    let headerAt = -1;
    let best = 0;
    for (let i = 0; i < Math.min(grid.length, 25); i++) {
      const count = (grid[i] ?? []).filter((x) => x !== '').length;
      if (count > best) {
        best = count;
        headerAt = i;
      }
    }
    if (headerAt === -1) throw new HubError('A planilha está vazia.');

    const columns = dedupeHeaders(
      Array.from({ length: maxCol }, (_, i) => (grid[headerAt] ?? [])[i] ?? ''),
      limits.maxHeaderChars,
    );
    const rows = [];
    const hidden = []; // posições (em `rows`) das linhas ocultas por filtro
    for (let i = headerAt + 1; i < grid.length; i++) {
      const r = grid[i];
      if (!r) continue;
      const out = Array.from({ length: maxCol }, (_, j) => r[j] ?? '');
      if (out.some((x) => x !== '')) {
        if (hiddenGrid && hiddenGrid.has(i)) hidden.push(rows.length);
        rows.push(out);
      }
      if (rows.length > limits.maxRowsPerFile) throw new LimitError(`O arquivo excede o limite de ${limits.maxRowsPerFile} linhas.`);
    }
    return { columns, rows, hidden };
  }

  async function readXlsx(bytes, limits) {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new HubError('O arquivo não é um .xlsx válido.');
    }

    // Passo 1: valida o zip sem descompactar nada (zip bomb / entradas demais).
    const zip = listZip(bytes, limits);
    const names = zip.names;

    const need = new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml']);
    const sheetPaths = names.filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
    if (!names.includes('xl/workbook.xml') || sheetPaths.length === 0) throw new HubError('O .xlsx não contém planilhas.');
    sheetPaths.forEach((p) => need.add(p));

    // Passo 2: descompacta só o necessário (com o limite imposto durante a descompactação).
    const files = await extractZip(bytes, zip, (name) => need.has(name));

    const workbook = parseXml(files.get('xl/workbook.xml'), 'workbook');
    const relsBytes = files.get('xl/_rels/workbook.xml.rels');
    const rels = relsBytes ? parseXml(relsBytes, 'relações') : null;
    const date1904 = byTag(workbook, 'workbookPr')[0]?.getAttribute('date1904') === '1';

    const target = new Map();
    if (rels) {
      for (const r of byTag(rels, 'Relationship')) {
        const id = r.getAttribute('Id');
        const t = r.getAttribute('Target');
        if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t}`);
      }
    }

    const sheets = [];
    for (const s of byTag(workbook, 'sheet')) {
      const rid = s.getAttributeNS(NS_REL, 'id') ?? s.getAttribute('r:id') ?? '';
      const path = target.get(rid);
      const sheetBytes = path ? files.get(path) : undefined;
      if (path && sheetBytes) {
        sheets.push({ name: s.getAttribute('name') ?? 'Planilha', path, weight: sheetBytes.length });
      }
    }
    if (sheets.length === 0) throw new HubError('O .xlsx não contém planilhas legíveis.');

    // Aba escolhida: a de maior tamanho (mais dados).
    const chosen = sheets.reduce((a, b) => (b.weight > a.weight ? b : a));

    const shared = [];
    const sharedBytes = files.get('xl/sharedStrings.xml');
    if (sharedBytes) {
      forEachElement(decodeXml(sharedBytes, 'textos'), 'si', (si) => {
        shared.push(richText(si));
        if (shared.length > limits.maxRowsPerFile * limits.maxColumns) throw new LimitError('Textos compartilhados demais.');
      }, 'textos');
    }
    const stylesBytes = files.get('xl/styles.xml');
    const dateStyles = readDateStyles(stylesBytes ? parseXml(stylesBytes, 'estilos') : null);

    const sheetBytes = files.get(chosen.path);
    files.delete(chosen.path); // libera memória: a aba é o maior objeto
    const grid = [];
    let maxCol = 0;
    let seq = 0;
    const hiddenGrid = new Set();
    let formulasWithoutValue = 0;

    // Uma linha por vez (sem montar a árvore da planilha inteira): essencial para arquivos com centenas de milhares de linhas.
    forEachElementInBytes(sheetBytes, 'row', (rowEl) => {
      seq++;
      const rowNo = Number(rowEl.getAttribute('r')) || seq;
      if (rowNo > limits.maxRowsPerFile + 26) throw new LimitError(`O arquivo excede o limite de ${limits.maxRowsPerFile} linhas.`);
      const cells = [];
      const hiddenAttr = rowEl.getAttribute('hidden');
      if (hiddenAttr === '1' || hiddenAttr === 'true') hiddenGrid.add(rowNo - 1);

      for (const c of Array.from(rowEl.children)) {
        if (c.localName !== 'c') continue;
        const ref = c.getAttribute('r');
        const col = ref ? columnIndex(ref) : cells.length;
        if (col < 0 || col >= limits.maxColumns) {
          if (col >= limits.maxColumns) throw new LimitError(`O arquivo excede o limite de ${limits.maxColumns} colunas.`);
          continue;
        }
        const type = c.getAttribute('t') ?? 'n';
        const vEl = Array.from(c.children).find((x) => x.localName === 'v');
        const v = vEl?.textContent ?? '';
        if (!vEl && type !== 'inlineStr' && c.children.some((x) => x.localName === 'f')) formulasWithoutValue++;
        let text = '';
        if (type === 's') text = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') {
          const is = Array.from(c.children).find((x) => x.localName === 'is');
          text = is ? richText(is) : '';
        } else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e' || type === 'd') text = v;
        else if (v !== '') {
          const style = Number(c.getAttribute('s') ?? '0');
          text = dateStyles.has(style) ? serialToIso(Number(v), date1904) : numberToText(v);
        }
        cells[col] = cleanCell(text, limits);
        if (col + 1 > maxCol) maxCol = col + 1;
      }
      grid[rowNo - 1] = Array.from(cells, (x) => x ?? '');
    }, 'planilha');

    const merged = fillMerged(grid, readMergeRanges(sheetBytes), maxCol, limits);
    maxCol = merged.maxCol;
    const { columns, rows, hidden } = gridToTable(grid, maxCol, limits, hiddenGrid);
    const warnings = [];
    if (merged.filled > 0) warnings.push(`${merged.filled} célula(s) de áreas mescladas foram preenchidas repetindo o valor.`);
    if (formulasWithoutValue > 0) {
      warnings.push(`${formulasWithoutValue} célula(s) têm fórmula sem valor calculado e ficaram vazias. Abra o arquivo no Excel e salve de novo para gravar os valores.`);
    }
    if (sheets.length > 1) warnings.push(`O arquivo tem ${sheets.length} abas; foi usada a maior ("${chosen.name}").`);
    return { columns, rows, warnings, sheetName: chosen.name, hidden };
  }

  H.xlsxReader = { serialToIso, numberToText, columnIndex, readXlsx, gridToTable, fillMerged, isDateFormat, BUILTIN_DATE_FORMATS };
})((globalThis.Hub = globalThis.Hub || {}));
