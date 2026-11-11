/** Auxiliares compartilhados pelos testes (Node e navegador). */
(function (g) {
  'use strict';

  const H = g.Hub;

  const LIMITS = { ...H.limits.DEFAULT_LIMITS };

  const table = (columns, rows, warnings = []) => ({ columns, rows, warnings });

  let seq = 0;
  const loaded = (name, columns, rows) => ({
    id: `id-${++seq}`,
    name,
    bytes: 100,
    table: table(columns, rows),
  });

  const bytes = (text) => new TextEncoder().encode(text);

  const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

  /** Monta um .xlsx à mão (com sharedStrings e estilos), para testar o leitor de forma independente do escritor. */
  async function handmadeXlsx(opts) {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const files = [
      [
        'xl/workbook.xml',
        bytes(
          `${HEAD}<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        ),
      ],
      [
        'xl/_rels/workbook.xml.rels',
        bytes(
          `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
        ),
      ],
      ['xl/worksheets/sheet1.xml', bytes(`${HEAD}<worksheet ${ns}><sheetData>${opts.sheetXml}</sheetData></worksheet>`)],
    ];
    if (opts.shared) {
      files.push(['xl/sharedStrings.xml', bytes(`${HEAD}<sst ${ns}>${opts.shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`)]);
    }
    if (opts.stylesXml) files.push(['xl/styles.xml', bytes(opts.stylesXml)]);
    for (const [k, v] of Object.entries(opts.extra ?? {})) {
      const at = files.findIndex(([name]) => name === k);
      if (at >= 0) files[at] = [k, bytes(v)];
      else files.push([k, bytes(v)]);
    }
    return H.zip.buildZip(files);
  }

  g.TestHelpers = { LIMITS, table, loaded, bytes, handmadeXlsx };
})(globalThis);
