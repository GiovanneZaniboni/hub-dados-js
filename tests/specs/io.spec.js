(function () {
  'use strict';

  const { HubError, LimitError } = Hub.limits;
  const { decodeText, detectDelimiter, parseDelimited, readDelimited } = Hub.csvReader;
  const { readBytes } = Hub.fileReader;
  const { columnIndex, numberToText, readXlsx, serialToIso } = Hub.xlsxReader;
  const { buildXlsx } = Hub.xlsxWriter;
  const { LIMITS, bytes, handmadeXlsx } = TestHelpers;
  const { buildZip, listZip, extractZip } = Hub.zip;
  // O leitor de XLSX usa o DOMParser do navegador; no Node esses testes são pulados (rodam no navegador).
  const itDom = typeof DOMParser === 'undefined' ? it.skip : it;

  describe('csv', () => {
    it('decodifica UTF-8 com BOM e cai para Windows-1252', () => {
      expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
      expect(decodeText(Uint8Array.from([0x4a, 0x6f, 0xe3, 0x6f]))).toBe('João');
    });

    it('detecta delimitador ignorando delimitadores dentro de aspas', () => {
      expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
      expect(detectDelimiter('a,b\n1,2')).toBe(',');
      expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
      expect(detectDelimiter('"a;b",c\n"1;2",3')).toBe(',');
      expect(detectDelimiter('sem delimitador')).toBe(',');
    });

    it('RFC 4180: aspas, aspas escapadas, quebra de linha em campo, CRLF', () => {
      const rows = parseDelimited('a,b\r\n"x,1","he said ""hi"""\r\n"l1\nl2",z\r\n', ',', LIMITS);
      expect(rows).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['l1\nl2', 'z']]);
    });

    it('aspas não fechadas são erro, não truncamento silencioso', () => {
      expect(() => parseDelimited('a,b\n"x,1', ',', LIMITS)).toThrow(HubError);
    });

    it('readDelimited: cabeçalhos duplicados/vazios, linhas curtas e linhas vazias', () => {
      const t = readDelimited(bytes('Nome;Nome;\nA;B;C\nD\n\n'), LIMITS);
      expect(t.columns).toEqual(['Nome', 'Nome (2)', 'Coluna_3']);
      expect(t.rows).toEqual([['A', 'B', 'C'], ['D', '', '']]);
    });

    it('linhas com campos a mais criam colunas (sem perder dados) e avisam', () => {
      const t = readDelimited(bytes('a;b\n1;2;3\n'), LIMITS);
      expect(t.columns).toEqual(['a', 'b', 'Coluna_3']);
      expect(t.rows[0]).toEqual(['1', '2', '3']);
      expect(t.warnings).toHaveLength(1);
    });

    it('limites de linhas, colunas e célula', () => {
      expect(() => parseDelimited('a\n1\n2\n3', ',', { ...LIMITS, maxRowsPerFile: 2 })).toThrow(LimitError);
      expect(() => parseDelimited('a,b,c', ',', { ...LIMITS, maxColumns: 2 })).toThrow(LimitError);
      expect(() => parseDelimited('a,bbbbbb', ',', { ...LIMITS, maxCellChars: 3 })).toThrow(LimitError);
      expect(() => parseDelimited('"aaaaaaaa"', ',', { ...LIMITS, maxCellChars: 3 })).toThrow(LimitError);
    });

    it('arquivo vazio', () => {
      expect(() => readDelimited(bytes('\n\n'), LIMITS)).toThrow(HubError);
    });
  });

  describe('readBytes (validação de entrada)', () => {
    it('rejeita .xls e formatos desconhecidos', async () => {
      await expect(readBytes('a.xls', bytes('x'), LIMITS)).rejects.toThrow(/\.xls/);
      await expect(readBytes('a.exe', bytes('x'), LIMITS)).rejects.toThrow(HubError);
      await expect(readBytes('semext', bytes('x'), LIMITS)).rejects.toThrow(HubError);
    });

    it('rejeita binário disfarçado de CSV', async () => {
      await expect(readBytes('a.csv', Uint8Array.from([0x41, 0x00, 0x42]), LIMITS)).rejects.toThrow(/texto/);
      await expect(readBytes('a.csv', bytes('%PDF-1.7 ...'), LIMITS)).rejects.toThrow(/texto/);
      await expect(readBytes('a.csv', await buildZip([['x.txt', bytes('hi')]]), LIMITS)).rejects.toThrow(/texto/);
    });

    it('rejeita arquivo acima do limite', async () => {
      await expect(readBytes('a.csv', bytes('abcdef'), { ...LIMITS, maxFileBytes: 3 })).rejects.toThrow(LimitError);
    });

    it('lê csv e tsv', async () => {
      expect((await readBytes('a.tsv', bytes('x\ty\n1\t2'), LIMITS)).rows).toEqual([['1', '2']]);
    });
  });

  describe('xlsx', () => {
    const styles =
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts>' +
      '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>';

    itDom('lê shared strings, números, datas (nativas e personalizadas), booleanos e inlineStr', async () => {
      const data = await handmadeXlsx({
        shared: ['Nome', 'Data', 'Valor', 'Ana', 'Ok'],
        stylesXml: styles,
        sheetXml:
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>Flag</t></is></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>45292</v></c><c r="C2"><v>0.30000000000000004</v></c><c r="D2" t="b"><v>1</v></c></row>' +
          '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="2"><v>45292.5</v></c><c r="C3"><v>1234.5</v></c></row>',
      });
      const t = await readXlsx(data, LIMITS);
      expect(t.columns).toEqual(['Nome', 'Data', 'Valor', 'Flag']);
      expect(t.rows).toEqual([
        ['Ana', '2024-01-01', '0.3', 'TRUE'],
        ['Ok', '2024-01-01 12:00', '1234.5', ''],
      ]);
    });

    itDom('células esparsas e linha de cabeçalho deslocada', async () => {
      const data = await handmadeXlsx({
        sheetXml:
          '<row r="1"><c r="A1" t="inlineStr"><is><t>Título do relatório</t></is></c></row>' +
          '<row r="3"><c r="A3" t="inlineStr"><is><t>a</t></is></c><c r="C3" t="inlineStr"><is><t>c</t></is></c></row>' +
          '<row r="4"><c r="C4" t="inlineStr"><is><t>9</t></is></c></row>',
      });
      const t = await readXlsx(data, LIMITS);
      expect(t.columns).toEqual(['a', 'Coluna_2', 'c']);
      expect(t.rows).toEqual([['', '', '9']]);
    });

    it('serialToIso e helpers', () => {
      expect(serialToIso(45292, false)).toBe('2024-01-01');
      expect(serialToIso(0.5, false)).toBe('12:00');
      expect(serialToIso(43830, true)).toBe('2024-01-01');
      expect(serialToIso(-1, false)).toBe('-1');
      expect(numberToText('0.1')).toBe('0.1');
      expect(numberToText('abc')).toBe('abc');
      expect(columnIndex('A1')).toBe(0);
      expect(columnIndex('AA9')).toBe(26);
      expect(columnIndex('9')).toBe(-1);
    });

    itDom('ida e volta com o escritor: texto, números, zeros à esquerda e caracteres especiais', async () => {
      const grid = {
        columns: ['Código', 'Valor', 'Obs'],
        rows: [['007', '10.5', '=1+1'], ['008', '2', 'a<b & "c"']],
        sourceColumn: null,
      };
      const t = await readXlsx(await buildXlsx(grid), LIMITS);
      expect(t.columns).toEqual(grid.columns);
      expect(t.rows).toEqual(grid.rows);
    });

    it('o escritor nunca emite fórmulas: textos com "=" são inlineStr', async () => {
      const data = await buildXlsx({ columns: ['a'], rows: [['=cmd|calc']], sourceColumn: null });
      const parts = await extractZip(data, listZip(data, LIMITS), (n) => n === 'xl/worksheets/sheet1.xml');
      const files = new TextDecoder().decode(parts.get('xl/worksheets/sheet1.xml'));
      expect(files).not.toContain('<f>');
      expect(files).toContain('t="inlineStr"');
    });

    itDom('rejeita DTD/entidades (XXE, billion laughs)', async () => {
      const evil = await handmadeXlsx({
        sheetXml: '<row r="1"><c r="A1"><v>1</v></c></row>',
        extra: { 'xl/sharedStrings.xml': '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><sst><si><t>&a;</t></si></sst>' },
      });
      await expect(readXlsx(evil, LIMITS)).rejects.toThrow(/DTD/);
    });

    it('rejeita zip bomb (tamanho declarado) e excesso de entradas', async () => {
      const big = await buildZip([['xl/workbook.xml', new Uint8Array(2_000_000)]]);
      await expect(readXlsx(big, { ...LIMITS, maxXlsxUncompressedBytes: 1_000_000 })).rejects.toThrow(LimitError);
      const many = await buildZip([['a', bytes('1')], ['b', bytes('2')], ['c', bytes('3')]]);
      await expect(readXlsx(many, { ...LIMITS, maxXlsxEntries: 2 })).rejects.toThrow(LimitError);
    });

    it('rejeita arquivos que não são xlsx', async () => {
      await expect(readXlsx(bytes('não sou zip'), LIMITS)).rejects.toThrow(HubError);
      await expect(readXlsx(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), LIMITS)).rejects.toThrow(HubError);
      await expect(readXlsx(await buildZip([['x.txt', bytes('oi')]]), LIMITS)).rejects.toThrow(/planilhas/);
    });

    itDom('XML malformado e limites de linhas/colunas', async () => {
      const broken = await handmadeXlsx({ sheetXml: '<row r="1"><c r="A1"><v>1</v></row>' });
      await expect(readXlsx(broken, LIMITS)).rejects.toThrow(HubError);
      const wide = await handmadeXlsx({ sheetXml: '<row r="1"><c r="ZZ1"><v>1</v></c></row>' });
      await expect(readXlsx(wide, LIMITS)).rejects.toThrow(LimitError);
      const tall = await handmadeXlsx({ sheetXml: '<row r="9999999"><c r="A9999999"><v>1</v></c></row>' });
      await expect(readXlsx(tall, LIMITS)).rejects.toThrow(LimitError);
    });

    itDom('planilha vazia', async () => {
      await expect(readXlsx(await handmadeXlsx({ sheetXml: '' }), LIMITS)).rejects.toThrow(/vazia/);
    });
  });
})();
