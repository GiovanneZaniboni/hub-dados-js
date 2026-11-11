(function () {
  'use strict';

  const { mergeTables } = Hub.merge;
  const { buildCsv, buildJson } = Hub.textFormats;
  const { buildXlsx } = Hub.xlsxWriter;
  const { readBytes } = Hub.fileReader;
  const { LIMITS, bytes, handmadeXlsx, loaded } = TestHelpers;
  const { buildZip } = Hub.zip;
  // Leitura de XLSX precisa do DOMParser (navegador); no Node esses testes são pulados.
  const itDom = typeof DOMParser === 'undefined' ? it.skip : it;

  /** Cenários parecidos com planilhas de verdade (Excel brasileiro, export de sistemas, etc.). */
  describe('cenários realistas', () => {
    it('CSV do Excel pt-BR: BOM, ponto e vírgula, aspas, quebra de linha dentro da célula, acentos', async () => {
      const text = '\ufeffNome;Observação;Valor\r\n"Ação ""Teste""";"linha 1\nlinha 2";"1.234,50"\r\nJosé;;10\r\n';
      const t = await readBytes('x.csv', bytes(text), LIMITS);
      expect(t.columns).toEqual(['Nome', 'Observação', 'Valor']);
      expect(t.rows[0]).toEqual(['Ação "Teste"', 'linha 1\nlinha 2', '1.234,50']);
      expect(t.rows[1]).toEqual(['José', '', '10']);
    });

    it('CSV em Windows-1252 (Excel antigo) mantém os acentos', async () => {
      // "Descrição;Preço" em windows-1252: ç=E7, ã=E3
      const raw = Uint8Array.from([0x44, 0x65, 0x73, 0x63, 0x72, 0x69, 0xe7, 0xe3, 0x6f, 0x3b, 0x50, 0x72, 0x65, 0xe7, 0x6f, 0x0a, 0x41, 0x3b, 0x31, 0x0a]);
      const t = await readBytes('x.csv', raw, LIMITS);
      expect(t.columns).toEqual(['Descrição', 'Preço']);
    });

    itDom('ida e volta: xlsx gerado pelo Hub é lido de volta sem perder nada', async () => {
      const grid = {
        columns: ['Nome', 'CPF', 'Obs', 'Valor'],
        rows: [
          ['Ana', '007', '=1+1', '10.5'],
          ['Zé <&> "x"', '00123456789', 'a'.repeat(5000), '20'],
          ['', '', '', ''],
        ],
        sourceColumn: null,
      };
      const back = await readBytes('saida.xlsx', await buildXlsx(grid), LIMITS);
      expect(back.columns).toEqual(grid.columns);
      expect(back.rows[0]).toEqual(['Ana', '007', '=1+1', '10.5']);
      expect(back.rows[1]?.[0]).toBe('Zé <&> "x"');
      expect(back.rows[1]?.[1]).toBe('00123456789');
      expect(back.rows[1]?.[2]).toHaveLength(5000);
    });

    itDom('xlsx do Excel: texto formatado (rich text), booleano, vazio e resultado de fórmula', async () => {
      const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Nome</t></si><si><t>Ativo</t></si><si><r><t>Ana </t></r><r><rPr><b/></rPr><t>Souza</t></r></si></sst>`;
      const sheet =
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="b"><v>1</v></c></row>' +
        '<row r="3"><c r="A3" t="str"><f>A2&amp;"!"</f><v>Ana Souza!</v></c><c r="B3"/></row>';
      const t = await readBytes('x.xlsx', await handmadeXlsx({ sheetXml: sheet, extra: { 'xl/sharedStrings.xml': shared } }), LIMITS);
      expect(t.columns).toEqual(['Nome', 'Ativo']);
      expect(t.rows[0]?.[0]).toBe('Ana Souza');
      expect(['1', 'TRUE', 'VERDADEIRO', 'true']).toContain(t.rows[0]?.[1]);
      expect(t.rows[1]?.[0]).toBe('Ana Souza!');
    });

    itDom('xlsx com células puladas (colunas A e D preenchidas) mantém o alinhamento', async () => {
      const sheet = '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="D1" t="inlineStr"><is><t>d</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c><c r="D2" t="inlineStr"><is><t>4</t></is></c></row>';
      const t = await readBytes('x.xlsx', await handmadeXlsx({ sheetXml: sheet }), LIMITS);
      expect(t.columns.length).toBeGreaterThanOrEqual(4);
      expect(t.rows[0]?.[0]).toBe('1');
      expect(t.rows[0]?.[3]).toBe('4');
    });

    it('arquivo .xlsx corrompido ou zip vazio gera erro claro, não trava', async () => {
      await expect(readBytes('x.xlsx', bytes('isto não é um zip'), LIMITS)).rejects.toThrow();
      await expect(readBytes('x.xlsx', await buildZip([['a.txt', bytes('oi')]]), LIMITS)).rejects.toThrow();
    });

    it('cenário da empresa: 3 sistemas com nomes de colunas diferentes viram uma tabela só', () => {
      const modelo = loaded('modelo.csv', ['Nome', 'E-mail', 'Telefone', 'Valor'], []);
      const a = loaded('crm.csv', ['cliente', 'email', 'fone', 'preco'], [['Ana', 'a@x.com', '1111', '10']]);
      const b = loaded('loja.csv', ['Nome', 'E-mail', 'Celular', 'Valor'], [['Bia', 'b@x.com', '2222', '20']]);
      const c = loaded('erp.csv', ['NOME', 'Email', 'Telefone', 'Valor Total'], [['Caio', 'c@x.com', '3333', '30']]);
      const r = mergeTables({ model: modelo, files: [a, b, c], mode: 'smart', overrides: new Map(), includeModelRows: false });
      // sinônimos casam (cliente→Nome, fone/Celular→Telefone, preco→Valor)...
      expect(r.columns.slice(0, 4)).toEqual(['Nome', 'E-mail', 'Telefone', 'Valor']);
      expect(r.rows[0]?.slice(0, 4)).toEqual(['Ana', 'a@x.com', '1111', '10']);
      expect(r.rows[1]?.slice(0, 4)).toEqual(['Bia', 'b@x.com', '2222', '20']);
      // ...e o que não casa ("Valor Total") fica como coluna nova, visível, nunca descartado
      expect(r.columns).toContain('Valor Total');
      expect(r.rows[2]?.[r.columns.indexOf('Valor Total')]).toBe('30');
      expect(r.rows).toHaveLength(3);
      expect(r.rows.map((x) => x[0])).toEqual(['Ana', 'Bia', 'Caio']);
    });

    it('volume: 100 mil linhas unificam e exportam em tempo razoável', async () => {
      const rows = Array.from({ length: 100_000 }, (_, i) => [`Pessoa ${i}`, `p${i}@x.com`, String(i)]);
      const f = loaded('grande.csv', ['Nome', 'Email', 'Valor'], rows);
      const t0 = Date.now();
      const r = mergeTables({ model: null, files: [f], mode: 'smart', overrides: new Map(), includeModelRows: true });
      const grid = { columns: r.columns, rows: r.rows, sourceColumn: r.sourceColumn };
      const csv = buildCsv(grid);
      const json = buildJson(grid);
      const xlsx = await buildXlsx(grid);
      expect(r.rows).toHaveLength(100_000);
      expect(csv.length).toBeGreaterThan(1_000_000);
      expect(json.length).toBeGreaterThan(1_000_000);
      expect(xlsx.length).toBeGreaterThan(100_000);
      expect(Date.now() - t0).toBeLessThan(20_000);
    });
  });
})();
