(function (H) {
  'use strict';

  const { LimitError } = H.limits;
  const { isNumericColumn } = H.text;
  const { buildZip } = H.zip;

  const MAX_XLSX_ROWS = 1048576;
  const MAX_XLSX_COLS = 16384;

  // Caracteres inválidos em XML 1.0.
  const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

  function xmlEscape(value) {
    return value
      .replace(INVALID_XML, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** "A", "B", ..., "Z", "AA"... (índice base 0). */
  function columnLetters(index) {
    let n = index + 1;
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function safeSheetName(name) {
    const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31);
    return cleaned || 'Dados';
  }

  const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const NS_CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

  const CONTENT_TYPES =
    `${XML_HEADER}<Types xmlns="${NS_CONTENT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${MIME}.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${MIME}.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${MIME}.styles+xml"/>` +
    '</Types>';

  const ROOT_RELS =
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="xl/workbook.xml"/>` +
    '</Relationships>';

  const WORKBOOK_RELS =
    `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_TYPE}/styles" Target="styles.xml"/>` +
    '</Relationships>';

  // Estilo 0 = padrão; estilo 1 = negrito (cabeçalho).
  const STYLES =
    `${XML_HEADER}<styleSheet xmlns="${NS_MAIN}">` +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '</styleSheet>';

  /**
   * Gera um .xlsx mínimo sem fórmulas: textos são sempre `inlineStr` (nunca interpretados como
   * fórmula) e colunas 100% numéricas viram números reais. Retorna Promise<Uint8Array>.
   */
  async function buildXlsx(grid, sheetName = 'Dados Unificados') {
    if (grid.rows.length + 1 > MAX_XLSX_ROWS) {
      throw new LimitError('Há linhas demais para um arquivo .xlsx (máximo de 1.048.575). Exporte em CSV.');
    }
    if (grid.columns.length > MAX_XLSX_COLS) {
      throw new LimitError('Há colunas demais para um arquivo .xlsx.');
    }
    const numeric = grid.columns.map((_, i) => isNumericColumn(grid.rows, i));
    const widths = grid.columns.map((c, i) => {
      let max = c.length;
      for (const r of grid.rows.slice(0, 100)) max = Math.max(max, (r[i] ?? '').length);
      return Math.min(50, Math.max(12, max + 3));
    });

    const text = (ref, v, style = '') =>
      `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;

    const rowsXml = [];
    rowsXml.push(`<row r="1">${grid.columns.map((c, i) => text(`${columnLetters(i)}1`, c, ' s="1"')).join('')}</row>`);
    grid.rows.forEach((r, ri) => {
      const rowNo = ri + 2;
      const cells = [];
      for (let i = 0; i < grid.columns.length; i++) {
        const v = r[i] ?? '';
        if (v === '') continue;
        const ref = `${columnLetters(i)}${rowNo}`;
        // numeric[i] só é verdadeiro se TODAS as células da coluna casam com ^-?\d+(\.\d+)?$
        cells.push(numeric[i] ? `<c r="${ref}"><v>${v}</v></c>` : text(ref, v));
      }
      rowsXml.push(`<row r="${rowNo}">${cells.join('')}</row>`);
    });

    const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const sheet = `${XML_HEADER}<worksheet xmlns="${NS_MAIN}"><cols>${cols}</cols><sheetData>${rowsXml.join('')}</sheetData></worksheet>`;
    const workbook =
      `${XML_HEADER}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      `<sheets><sheet name="${xmlEscape(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

    const enc = new TextEncoder();
    return buildZip([
      ['[Content_Types].xml', enc.encode(CONTENT_TYPES)],
      ['_rels/.rels', enc.encode(ROOT_RELS)],
      ['xl/workbook.xml', enc.encode(workbook)],
      ['xl/_rels/workbook.xml.rels', enc.encode(WORKBOOK_RELS)],
      ['xl/styles.xml', enc.encode(STYLES)],
      ['xl/worksheets/sheet1.xml', enc.encode(sheet)],
    ]);
  }

  H.xlsxWriter = { xmlEscape, columnLetters, safeSheetName, buildXlsx };
})((globalThis.Hub = globalThis.Hub || {}));
