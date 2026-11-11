(function () {
  'use strict';

  const { LimitError } = Hub.limits;
  const { buildCsv, buildJson, buildSql, csvSafeCell, sqlIdent, sqlString } = Hub.textFormats;
  const { buildXlsx, columnLetters, safeSheetName, xmlEscape } = Hub.xlsxWriter;

  const grid = (columns, rows) => ({ columns, rows, sourceColumn: null });

  describe('csv', () => {
    it('csvSafeCell neutraliza fórmulas e preserva números', () => {
      expect(csvSafeCell('=1+1')).toBe("'=1+1");
      expect(csvSafeCell('@cmd')).toBe("'@cmd");
      expect(csvSafeCell('+55 11 9999')).toBe("'+55 11 9999");
      expect(csvSafeCell('\t=x')).toBe("'\t=x");
      expect(csvSafeCell('-5')).toBe('-5');
      expect(csvSafeCell('-5,5')).toBe('-5,5');
      expect(csvSafeCell('ok')).toBe('ok');
      expect(csvSafeCell('')).toBe('');
    });

    it('buildCsv: BOM, ";" e aspas escapadas; cabeçalhos também são protegidos', () => {
      const csv = buildCsv(grid(['=a', 'b'], [['x"y', '=HYPERLINK("http://x")']]));
      expect(csv.startsWith('\ufeff"\'=a";"b"\r\n')).toBe(true);
      expect(csv).toContain('"x""y";"\'=HYPERLINK(""http://x"")"');
    });
  });

  describe('json', () => {
    it('lista de objetos; chave "__proto__" vira dado comum', () => {
      const out = JSON.parse(buildJson(grid(['__proto__', 'b'], [['1', '2']])));
      expect(Object.keys(out[0])).toEqual(['__proto__', 'b']);
      expect(Object.keys(Object.prototype)).toEqual([]);
    });
  });

  describe('sql', () => {
    it('escapa identificadores e valores', () => {
      expect(sqlIdent('a"b')).toBe('"a""b"');
      expect(sqlString("O'B\0")).toBe("'O''B'");
    });

    it('lotes de INSERT e tabela sem colunas', () => {
      expect(buildSql(grid(['a'], Array.from({ length: 5 }, (_, i) => [String(i)])), 't', 2).match(/INSERT INTO/g)).toHaveLength(3);
      expect(buildSql(grid([], []))).toContain('CREATE TABLE');
    });
  });

  describe('xlsx writer', () => {
    it('helpers', () => {
      expect(columnLetters(0)).toBe('A');
      expect(columnLetters(25)).toBe('Z');
      expect(columnLetters(26)).toBe('AA');
      expect(columnLetters(16383)).toBe('XFD');
      expect(xmlEscape('a<b>&"\u0001')).toBe('a&lt;b&gt;&amp;&quot;');
      expect(safeSheetName('a/b:c*?[x]')).toBe('a b c   x');
      expect(safeSheetName('   ')).toBe('Dados');
      expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
    });

    it('respeita limites do formato', async () => {
      await expect(buildXlsx(grid(Array.from({ length: 16385 }, (_, i) => `c${i}`), []))).rejects.toThrow(LimitError);
      await expect(buildXlsx(grid(['a'], new Array(1_048_576).fill(['x'])))).rejects.toThrow(LimitError);
    });
  });
})();
