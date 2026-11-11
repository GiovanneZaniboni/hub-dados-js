(function (H) {
  'use strict';


  const NUMBER_LIKE = /^[+-]?\d+([.,]\d+)?$/;

  /**
   * Neutraliza injeção de fórmula (CSV/DDE) no Excel e no LibreOffice: textos que começam com
   * = + - @ TAB CR ganham um apóstrofo, exceto números legítimos como "-5".
   */
  function csvSafeCell(value) {
    if (value !== '' && '=+-@\t\r'.includes(value.charAt(0)) && !NUMBER_LIKE.test(value)) return `'${value}`;
    return value;
  }

  const quote = (s) => `"${s.replace(/"/g, '""')}"`;

  /** CSV com BOM UTF-8, delimitador ';' e todos os campos entre aspas. */
  function buildCsv(grid) {
    const lines = [grid.columns.map((c) => quote(csvSafeCell(c))).join(';')];
    for (const r of grid.rows) lines.push(grid.columns.map((_, i) => quote(csvSafeCell(r[i] ?? ''))).join(';'));
    return `\ufeff${lines.join('\r\n')}\r\n`;
  }

  /** JSON como lista de objetos. Usa Object.create(null) para nunca tocar em protótipos. */
  function buildJson(grid) {
    const data = grid.rows.map((r) => {
      const o = Object.create(null);
      grid.columns.forEach((c, i) => {
        o[c] = r[i] ?? '';
      });
      return o;
    });
    return JSON.stringify(data, null, 2);
  }

  const sqlIdent = (name) => `"${name.replace(/\0/g, '').replace(/"/g, '""')}"`;
  const sqlString = (value) => `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`;

  /** Script SQL no dialeto SQLite; INSERTs em lotes. Todas as colunas TEXT (preserva zeros à esquerda). */
  function buildSql(grid, table = 'dados_unificados', batchSize = 500) {
    const lower = new Set(grid.columns.map((c) => c.toLowerCase()));
    let pk = 'id';
    while (lower.has(pk)) pk = `_${pk}`;

    const out = [
      '-- Hub de Dados: script compatível com SQLite',
      `CREATE TABLE IF NOT EXISTS ${sqlIdent(table)} (`,
      `  ${sqlIdent(pk)} INTEGER PRIMARY KEY AUTOINCREMENT${grid.columns.length ? ',' : ''}`,
      ...grid.columns.map((c, i) => `  ${sqlIdent(c)} TEXT${i < grid.columns.length - 1 ? ',' : ''}`),
      ');',
      '',
    ];

    const cols = grid.columns.map(sqlIdent).join(', ');
    for (let i = 0; i < grid.rows.length; i += batchSize) {
      const tuples = grid.rows
        .slice(i, i + batchSize)
        .map((r) => `(${grid.columns.map((_, j) => sqlString(r[j] ?? '')).join(', ')})`);
      out.push(`INSERT INTO ${sqlIdent(table)} (${cols}) VALUES\n${tuples.join(',\n')};`);
    }
    return `${out.join('\n')}\n`;
  }

  H.textFormats = { csvSafeCell, buildCsv, buildJson, sqlIdent, sqlString, buildSql };
})((globalThis.Hub = globalThis.Hub || {}));
