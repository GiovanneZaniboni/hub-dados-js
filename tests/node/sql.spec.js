(function () {
  'use strict';

  const { DatabaseSync } = require('node:sqlite');
  const { buildSql } = Hub.textFormats;
  const grid = (columns, rows) => ({ columns, rows, sourceColumn: null });

  describe('sql (SQLite real, somente Node)', () => {
    it('roda no SQLite com valores maliciosos, sem injeção e sem perder linhas', () => {
      const g = grid(['id', 'co"l', 'nome'], [
        ['1', 'x', "O'Brien'); DROP TABLE dados_unificados;--"],
        ['2', 'y', ''],
        ['3', 'z', '\\'],
      ]);
      const db = new DatabaseSync(':memory:');
      db.exec(buildSql(g, 'dados_unificados', 2));
      const rows = db.prepare('SELECT "nome" FROM dados_unificados ORDER BY "_id"').all();
      expect(rows.map((r) => r.nome)).toEqual(["O'Brien'); DROP TABLE dados_unificados;--", '', '\\']);
      db.close();
    });
  });
})();
