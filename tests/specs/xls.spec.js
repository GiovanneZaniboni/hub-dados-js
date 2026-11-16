(function () {
  'use strict';

  const { HubError } = Hub.limits;
  const { readBytes } = Hub.fileReader;
  const { readXls } = Hub.xlsReader;
  const { parseXmlText, parseXml } = Hub.xml;
  const { LIMITS, bytes, buildXls, buildOle, handmadeXlsx } = TestHelpers;

  const header = (...names) => names.map((n, i) => [0, i, n]);

  describe('xls (Excel 97-2003)', () => {
    for (const forceBig of [false, true]) {
      const kind = forceBig ? 'fluxo grande' : 'mini stream';

      it(`lê textos, números, datas e acentos (${kind})`, async () => {
        const data = buildXls({
          forceBig,
          sheets: [
            {
              name: 'Dados',
              cells: [
                ...header('Nome', 'Data', 'Valor', 'Obs'),
                [1, 0, 'José Ação'], [1, 1, { date: 45292 }], [1, 2, 10.5], [1, 3, 'ok'],
                [2, 0, 'Zoë ✓'], [2, 1, { date: 45292.5, xf: 2 }], [2, 2, 1234], [2, 3, ''],
              ],
            },
          ],
        });
        const t = await readBytes('a.xls', data, LIMITS);
        expect(t.columns).toEqual(['Nome', 'Data', 'Valor', 'Obs']);
        expect(t.rows).toEqual([
          ['José Ação', '2024-01-01', '10.5', 'ok'],
          ['Zoë ✓', '2024-01-01 12:00', '1234', ''],
        ]);
      });
    }

    it('lê RK, MULRK, booleanos, erros, fórmulas (número e texto) e LABEL', async () => {
      const data = buildXls({
        sheets: [
          {
            name: 'S',
            cells: [
              ...header('a', 'b', 'c', 'd'),
              [1, 0, { rk: 42 }], [1, 1, { bool: true }], [1, 2, { err: 0x07 }], [1, 3, { fnum: 3.25 }],
              [2, 0, { mulrk: [1, 2, 3] }], [2, 3, { fstr: 'Total: 6' }],
              [3, 0, { label: 'etiqueta' }], [3, 1, { bool: false }],
            ],
          },
        ],
      });
      const t = readXls(data, LIMITS);
      expect(t.rows[0]).toEqual(['42', 'TRUE', '#DIV/0!', '3.25']);
      expect(t.rows[1]).toEqual(['1', '2', '3', 'Total: 6']);
      expect(t.rows[2]).toEqual(['etiqueta', 'FALSE', '', '']);
    });

    it('textos longos que atravessam registros CONTINUE (latin1 e utf-16) não se perdem', async () => {
      const cells = header('texto');
      const expected = [];
      for (let i = 0; i < 120; i++) {
        const s = (`linha ${i} ` + (i % 7 === 0 ? 'ação—✓ ' : 'abc ').repeat(40)).trim();
        cells.push([i + 1, 0, s]);
        expected.push([s]);
      }
      const data = buildXls({ forceBig: false, sheets: [{ name: 'S', cells }] });
      // O gerador só suporta fluxos de até ~64 KB; este teste deve passar por pelo menos uma CONTINUE.
      const t = await readBytes('a.xls', data, LIMITS);
      expect(t.rows).toHaveLength(120);
      expect(t.rows.map((r) => r[0])).toEqual(expected.map((r) => r[0]));
    });

    it('com várias abas usa a maior e avisa; respeita o modo 1904', async () => {
      const data = buildXls({
        date1904: true,
        sheets: [
          { name: 'Pequena', cells: [...header('x'), [1, 0, 'a']] },
          { name: 'Grande', cells: [...header('x', 'y'), [1, 0, 'a'], [1, 1, { date: 1 }], [2, 0, 'b'], [2, 1, 'c'], [3, 0, 'd'], [3, 1, 'e']] },
        ],
      });
      const t = await readBytes('a.xls', data, LIMITS);
      expect(t.sheetName).toBe('Grande');
      expect(t.warnings).toHaveLength(1);
      expect(t.rows[0]).toEqual(['a', '1904-01-02']);
    });

    it('linha de totais acima do cabeçalho e células vazias no meio', async () => {
      const data = buildXls({
        sheets: [
          {
            name: 'S',
            cells: [
              [0, 3, 'Total'], [0, 4, { fnum: 99 }],
              ...[1].flatMap(() => header('Nome', 'Cidade', 'Qtd', 'Valor').map(([, c, v]) => [1, c, v])),
              [2, 0, 'Ana'], [2, 2, 5], [2, 3, 10],
              [3, 0, 'Bia'], [3, 1, 'Rio'], [3, 2, 6], [3, 3, 20],
            ],
          },
        ],
      });
      const t = await readBytes('a.xls', data, LIMITS);
      expect(t.columns.slice(0, 4)).toEqual(['Nome', 'Cidade', 'Qtd', 'Valor']);
      expect(t.rows[0].slice(0, 4)).toEqual(['Ana', '', '5', '10']);
      expect(t.rows[1].slice(0, 4)).toEqual(['Bia', 'Rio', '6', '20']);
    });

    it('arquivos corrompidos ou adulterados geram erro claro (HubError), nunca travam', async () => {
      const good = buildXls({ sheets: [{ name: 'S', cells: [...header('a'), [1, 0, 'x']] }] });
      const cuts = [good.subarray(0, 600), good.subarray(0, 1100), good.subarray(0, good.length - 10)];
      for (const c of cuts) {
        let error = null;
        try {
          await readBytes('a.xls', c, LIMITS);
        } catch (e) {
          error = e;
        }
        if (error) expect(error).toBeInstanceOf(HubError);
      }
      // Cabeçalho OLE válido seguido de lixo aleatório (várias sementes)
      let seed = 12345;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
      for (let k = 0; k < 40; k++) {
        const junk = Uint8Array.from({ length: 3000 }, rnd);
        junk.set(good.subarray(0, k % 2 ? 76 : 512));
        let error = null;
        try {
          await readBytes('a.xls', junk, LIMITS);
        } catch (e) {
          error = e;
        }
        if (error) expect(error).toBeInstanceOf(HubError);
      }
    });

    it('ciclos na cadeia de setores não geram laço infinito', async () => {
      const good = buildXls({ forceBig: true, sheets: [{ name: 'S', cells: [...header('a'), [1, 0, 'x']] }] });
      const evil = good.slice();
      // FAT está no setor 0 (offset 512): faz a cadeia do fluxo apontar para si mesma.
      new DataView(evil.buffer).setUint32(512 + 2 * 4, 2, true);
      await expect(readBytes('a.xls', evil, LIMITS)).rejects.toThrow(HubError);
    });

    it('versão muito antiga (BIFF5) e arquivo sem pasta Workbook são recusados com explicação', async () => {
      const biff5 = buildOle(Uint8Array.from([0x09, 0x08, 8, 0, 0x00, 0x05, 0x05, 0, 0, 0, 0, 0]));
      await expect(readBytes('a.xls', biff5, LIMITS)).rejects.toThrow(/anterior ao 97/);
    });
  });

  describe('linhas ocultas, células mescladas e fórmulas', () => {
    const is = (r, text) => `<c r="${r}" t="inlineStr"><is><t>${text}</t></is></c>`;
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

    it('.xlsx: linhas ocultas por filtro são identificadas; mescladas verticais repetem o valor; título mesclado é ignorado', async () => {
      const sheet =
        `<worksheet ${NS}><sheetData>` +
        `<row r="1">${is('A1', 'Vendas 2026')}</row>` +
        `<row r="2">${is('A2', 'Região')}${is('B2', 'Produto')}${is('C2', 'Valor')}</row>` +
        `<row r="3">${is('A3', 'Sul')}${is('B3', 'X')}<c r="C3"><v>100</v></c></row>` +
        `<row r="4">${is('B4', 'Y')}<c r="C4"><v>200</v></c></row>` +
        `<row r="5" hidden="1">${is('A5', 'Norte')}${is('B5', 'Z')}<c r="C5"><v>999</v></c></row>` +
        `<row r="6">${is('A6', 'Total')}<c r="C6"><v>300</v></c></row>` +
        '</sheetData><autoFilter ref="A2:C5"/><mergeCells count="2"><mergeCell ref="A1:C1"/><mergeCell ref="A3:A4"/></mergeCells></worksheet>';
      const data = await handmadeXlsx({ sheetXml: '', extra: { 'xl/worksheets/sheet1.xml': sheet } });
      const t = await readBytes('a.xlsx', data, LIMITS);
      expect(t.columns).toEqual(['Região', 'Produto', 'Valor']);
      expect(t.rows).toEqual([['Sul', 'X', '100'], ['Sul', 'Y', '200'], ['Norte', 'Z', '999'], ['Total', '', '300']]);
      expect(t.hidden).toEqual([2]);
      expect(t.warnings.join(' ')).toMatch(/1 célula\(s\) de áreas mescladas/);
    });

    it('.xlsx: fórmula sem valor calculado gera aviso; com valor, o valor é lido', async () => {
      const sheet =
        `<worksheet ${NS}><sheetData>` +
        `<row r="1">${is('A1', 'a')}${is('B1', 'b')}</row>` +
        '<row r="2"><c r="A2"><f>1+1</f><v>2</v></c><c r="B2"><f>2*3</f></c></row></sheetData></worksheet>';
      const data = await handmadeXlsx({ sheetXml: '', extra: { 'xl/worksheets/sheet1.xml': sheet } });
      const t = await readBytes('a.xlsx', data, LIMITS);
      expect(t.rows).toEqual([['2', '']]);
      expect(t.warnings.join(' ')).toMatch(/1 célula\(s\) têm fórmula sem valor/);
    });

    it('.xls: linhas ocultas (registro ROW) e células mescladas (MERGEDCELLS)', async () => {
      const data = buildXls({
        sheets: [
          {
            name: 'S',
            hiddenRows: [3],
            merges: [[0, 0, 0, 2], [1, 0, 2, 0]],
            cells: [
              ...header('Região', 'Produto', 'Valor'),
              [1, 0, 'Sul'], [1, 1, 'X'], [1, 2, 100],
              [2, 1, 'Y'], [2, 2, 200],
              [3, 0, 'Norte'], [3, 1, 'Z'], [3, 2, 999],
            ],
          },
        ],
      });
      const t = await readBytes('a.xls', data, LIMITS);
      expect(t.rows).toEqual([['Sul', 'X', '100'], ['Sul', 'Y', '200'], ['Norte', 'Z', '999']]);
      expect(t.hidden).toEqual([2]);
    });
  });

  describe('extensões de Excel com conteúdo diferente', () => {
    it('.xls que na verdade é HTML ou XML recebe mensagem específica', async () => {
      await expect(readBytes('a.xls', bytes('<html><table><tr><td>x</td></tr></table></html>'), LIMITS)).rejects.toThrow(/HTML/);
      await expect(readBytes('a.xlsx', bytes('<?xml version="1.0"?><Workbook/>'), LIMITS)).rejects.toThrow(/HTML\/XML/);
    });

    it('.xls que na verdade é texto delimitado é lido como CSV, com aviso', async () => {
      const t = await readBytes('a.xls', bytes('nome;valor\nAna;10\n'), LIMITS);
      expect(t.columns).toEqual(['nome', 'valor']);
      expect(t.warnings.join(' ')).toMatch(/texto delimitado/);
    });

    it('.xlsx renomeado de .xls (e vice-versa) é reconhecido pelo conteúdo; .xlsm lê só os valores', async () => {
      const xlsx = await handmadeXlsx({ sheetXml: '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="2"><c r="A2"><v>7</v></c></row>' });
      for (const name of ['a.xls', 'a.xlsm', 'a.xlsx']) {
        const t = await readBytes(name, xlsx, LIMITS);
        expect(t.rows).toEqual([['7']]);
      }
      const xls = buildXls({ sheets: [{ name: 'S', cells: [...header('a'), [1, 0, '7']] }] });
      expect((await readBytes('a.xlsx', xls, LIMITS)).rows).toEqual([['7']]);
    });

    it('.xlsb continua recusado, binário aleatório vira erro claro', async () => {
      await expect(readBytes('a.xlsb', bytes('x'), LIMITS)).rejects.toThrow(/xlsb/);
      await expect(readBytes('a.xls', Uint8Array.from([1, 2, 0, 3, 4]), LIMITS)).rejects.toThrow(HubError);
    });
  });

  describe('xlsx do Excel com filtros, tabelas e totais', () => {
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

    it('autoFilter, tabela, linha de totais com fórmulas, células mescladas e prefixos de namespace', async () => {
      const sheet =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS} ${R}>` +
        '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:C6"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="3" width="14" customWidth="1"/></cols><sheetData>' +
        '<row r="1" spans="1:3"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="C1"><f>SUBTOTAL(109,C3:C5)</f><v>60</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Produto</t></is></c><c r="B2" t="inlineStr"><is><t>Qtd</t></is></c><c r="C2" t="inlineStr"><is><t>Valor</t></is></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>A</t></is></c><c r="B3"><v>1</v></c><c r="C3"><f t="shared" ref="C3:C5" si="0">B3*10</f><v>10</v></c></row>' +
        '<row r="4"><c r="A4" t="inlineStr"><is><t>B</t></is></c><c r="B4"><v>2</v></c><c r="C4"><f t="shared" si="0"/><v>20</v></c></row>' +
        '<row r="5"><c r="A5" t="inlineStr"><is><t>C</t></is></c><c r="B5"><v>3</v></c><c r="C5" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>' +
        '<row r="6"><c r="A6" t="str"><f>"Soma"</f><v>Soma</v></c><c r="C6"><f>SUBTOTAL(109,C3:C5)</f><v>30</v></c></row>' +
        '</sheetData><autoFilter ref="A2:C5"><filterColumn colId="0"><filters><filter val="A"/></filters></filterColumn></autoFilter>' +
        '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
        '<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>';
      const data = await handmadeXlsx({
        sheetXml: '',
        extra: {
          'xl/worksheets/sheet1.xml': sheet,
          'xl/tables/table1.xml': `<table ${NS} id="1" name="Tabela1" displayName="Tabela1" ref="A2:C6" totalsRowCount="1"><autoFilter ref="A2:C5"/></table>`,
          'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="../tables/table1.xml"/></Relationships>',
          'docProps/app.xml': '<Properties/>',
        },
      });
      const t = await readBytes('a.xlsx', data, LIMITS);
      expect(t.columns).toEqual(['Produto', 'Qtd', 'Valor']);
      expect(t.rows[0]).toEqual(['A', '1', '10']);
      expect(t.rows[1]).toEqual(['B', '2', '20']);
      expect(t.rows[2][0]).toBe('C');
      expect(t.rows[3]).toEqual(['Soma', '', '30']);
    });

    it('XML com prefixo de namespace (x:) e CDATA é lido', async () => {
      const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
      const sheet = `<x:worksheet ${ns}><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t><![CDATA[a & b]]></x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
      const data = await handmadeXlsx({ sheetXml: '', extra: { 'xl/worksheets/sheet1.xml': sheet } });
      const t = await readBytes('a.xlsx', data, LIMITS);
      expect(t.columns).toEqual(['a & b']);
    });
  });

  describe('xml (leitor próprio)', () => {
    const fails = (text) => {
      let ok = false;
      try {
        parseXmlText(text, () => {
          throw new Error('x');
        });
      } catch {
        ok = true;
      }
      return ok;
    };

    it('lê elementos, atributos, entidades e CDATA', () => {
      const doc = parseXmlText('<?xml version="1.0"?><a x="1&amp;2" y=\'q\'><b>t&lt;&#65;&#x42;</b><!-- c --><c/><![CDATA[<z>]]></a>', () => {
        throw new Error('x');
      });
      const a = doc.children[0];
      expect(a.getAttribute('x')).toBe('1&2');
      expect(a.getAttribute('y')).toBe('q');
      expect(a.getAttribute('nada')).toBeNull();
      expect(a.children[0].textContent).toBe('t<AB');
      expect(a.children).toHaveLength(2);
      expect(a.textContent).toBe('<z>');
    });

    it('recusa XML inválido e perigoso', () => {
      expect(fails('<a><b></a>')).toBe(true);
      expect(fails('<a>')).toBe(true);
      expect(fails('<a/><b/>')).toBe(true);
      expect(fails('texto<a/>')).toBe(true);
      expect(fails('<a>&nbsp;</a>')).toBe(true);
      expect(fails('<a>&</a>')).toBe(true);
      expect(fails('<a x="1" x="2"/>')).toBe(true);
      expect(fails('<a>&#xD800;</a>')).toBe(true);
      expect(fails('<!DOCTYPE a><a/>')).toBe(true);
      expect(fails('<a>' + '<b>'.repeat(300) + '</b>'.repeat(300) + '</a>')).toBe(true);
    });

    it('parseXml recusa DTD/entidades antes de analisar', () => {
      expect(() => parseXml(bytes('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>'), 'teste')).toThrow(/DTD/);
    });

    it('não é afetado por __proto__ como nome de atributo', () => {
      const doc = parseXmlText('<a __proto__="x" constructor="y"/>', () => {
        throw new Error('x');
      });
      expect(doc.children[0].getAttribute('__proto__')).toBe('x');
      expect(Object.keys(Object.prototype)).toEqual([]);
    });
  });
})();
