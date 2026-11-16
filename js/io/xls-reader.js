/**
 * Leitor de planilhas antigas do Excel (.xls, formato BIFF8 do Excel 97-2003), sem bibliotecas.
 *
 * Duas camadas: (1) o "contêiner" OLE2/CFB, que guarda o fluxo "Workbook"; (2) os registros BIFF8 desse fluxo.
 * Só lê valores (texto, números, datas, booleanos e o resultado já calculado de fórmulas). Macros, objetos
 * embutidos e fórmulas nunca são interpretados nem executados. Toda leitura é validada contra os limites do
 * arquivo; qualquer inconsistência vira um HubError (nunca trava nem lê fora do arquivo).
 */
(function (H) {
  'use strict';

  const { HubError, LimitError } = H.limits;
  const { cleanCell } = H.text;
  const { serialToIso, numberToText, gridToTable, fillMerged, isDateFormat, BUILTIN_DATE_FORMATS } = H.xlsxReader;

  const CORRUPT = 'Arquivo .xls corrompido ou em formato não suportado.';
  const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const ENDOFCHAIN = 0xfffffffe;
  const FREESECT = 0xffffffff;

  const fail = () => {
    throw new HubError(CORRUPT);
  };

  // ---- Camada 1: contêiner OLE2 -----------------------------------------------------------------

  function isOle(bytes) {
    return bytes.length >= 512 && OLE_SIGNATURE.every((b, i) => bytes[i] === b);
  }

  /** Segue uma cadeia de setores (com proteção contra ciclos) e devolve os índices. */
  function chainOf(start, next, maxLength) {
    const out = [];
    let s = start;
    while (s !== ENDOFCHAIN) {
      if (s >= next.length || out.length >= maxLength) fail();
      out.push(s);
      s = next[s];
    }
    return out;
  }

  /** Extrai um fluxo pelo nome ("Workbook"). Devolve null se não existir. */
  function readOleStream(bytes, wanted) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const shift = view.getUint16(30, true);
    const miniShift = view.getUint16(32, true);
    if ((shift !== 9 && shift !== 12) || miniShift !== 6) fail();
    const sectorSize = 1 << shift;
    const miniSize = 1 << miniShift;
    const maxSectors = Math.floor(bytes.length / sectorSize) + 2;
    const sectorOffset = (id) => (id + 1) * sectorSize;
    const sector = (id) => {
      const at = sectorOffset(id);
      if (id >= maxSectors || at + sectorSize > bytes.length) fail();
      return at;
    };

    // FAT: lista de setores da tabela de alocação (cabeçalho + cadeia DIFAT).
    const fatIds = [];
    for (let i = 0; i < 109; i++) {
      const id = view.getUint32(76 + i * 4, true);
      if (id !== FREESECT) fatIds.push(id);
    }
    let difat = view.getUint32(68, true);
    for (let guard = 0; difat !== ENDOFCHAIN && difat !== FREESECT; guard++) {
      if (guard > maxSectors) fail();
      const at = sector(difat);
      for (let i = 0; i < sectorSize / 4 - 1; i++) {
        const id = view.getUint32(at + i * 4, true);
        if (id !== FREESECT) fatIds.push(id);
      }
      difat = view.getUint32(at + sectorSize - 4, true);
    }
    if (fatIds.length > maxSectors) fail();
    const fat = new Uint32Array(fatIds.length * (sectorSize / 4));
    fatIds.forEach((id, n) => {
      const at = sector(id);
      for (let i = 0; i < sectorSize / 4; i++) fat[n * (sectorSize / 4) + i] = view.getUint32(at + i * 4, true);
    });

    const readChain = (start, size) => {
      const ids = chainOf(start, fat, maxSectors);
      const out = new Uint8Array(ids.length * sectorSize);
      ids.forEach((id, n) => out.set(bytes.subarray(sector(id), sector(id) + sectorSize), n * sectorSize));
      return size === undefined ? out : out.subarray(0, Math.min(size, out.length));
    };

    // Diretório
    const dir = readChain(view.getUint32(48, true));
    const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const entries = [];
    for (let at = 0; at + 128 <= dir.length; at += 128) {
      const nameLen = dv.getUint16(at + 64, true);
      if (nameLen < 2 || nameLen > 64) continue;
      let name = '';
      for (let i = 0; i < nameLen / 2 - 1; i++) name += String.fromCharCode(dv.getUint16(at + i * 2, true));
      entries.push({ name, type: dir[at + 66], start: dv.getUint32(at + 116, true), size: dv.getUint32(at + 120, true) });
    }
    const root = entries.find((e) => e.type === 5);
    const entry = entries.find((e) => e.type === 2 && wanted.includes(e.name));
    if (!entry) return null;
    if (entry.size > bytes.length * 4) fail();

    const cutoff = view.getUint32(56, true);
    if (entry.size >= cutoff) return readChain(entry.start, entry.size);

    // Fluxo pequeno: vive no "mini stream" (cadeia própria, dentro do fluxo da raiz).
    if (!root) fail();
    const miniStream = readChain(root.start, root.size);
    const miniFatBytes = readChain(view.getUint32(60, true));
    const mv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    const miniFat = new Uint32Array(miniFatBytes.length / 4);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mv.getUint32(i * 4, true);
    const ids = chainOf(entry.start, miniFat, Math.ceil(entry.size / miniSize) + 1);
    const out = new Uint8Array(ids.length * miniSize);
    ids.forEach((id, n) => {
      const at = id * miniSize;
      if (at + miniSize > miniStream.length) fail();
      out.set(miniStream.subarray(at, at + miniSize), n * miniSize);
    });
    return out.subarray(0, entry.size);
  }

  // ---- Camada 2: registros BIFF8 ----------------------------------------------------------------

  const REC = {
    BOF: 0x0809,
    EOF: 0x000a,
    CONTINUE: 0x003c,
    FILEPASS: 0x002f,
    DATEMODE: 0x0022,
    BOUNDSHEET: 0x0085,
    SST: 0x00fc,
    XF: 0x00e0,
    FORMAT: 0x041e,
    LABELSST: 0x00fd,
    LABEL: 0x0204,
    RSTRING: 0x00d6,
    NUMBER: 0x0203,
    RK: 0x027e,
    MULRK: 0x00bd,
    BOOLERR: 0x0205,
    FORMULA: 0x0006,
    STRING: 0x0207,
    ROW: 0x0208,
    MERGEDCELLS: 0x00e5,
  };

  const ERROR_TEXT = new Map([[0x00, '#NULL!'], [0x07, '#DIV/0!'], [0x0f, '#VALUE!'], [0x17, '#REF!'], [0x1d, '#NAME?'], [0x24, '#NUM!'], [0x2a, '#N/A']]);

  /** Lista os registros do fluxo: { type, data } com os CONTINUE já anexados em `chunks`. */
  function* records(stream) {
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    let p = 0;
    while (p + 4 <= stream.length) {
      const type = view.getUint16(p, true);
      const len = view.getUint16(p + 2, true);
      if (p + 4 + len > stream.length) return; // fim truncado: usa o que foi lido
      yield { type, at: p + 4, len };
      p += 4 + len;
    }
  }

  /** Leitor de strings Unicode do Excel (BIFF8), com suporte a quebra em registros CONTINUE. */
  class Chunks {
    constructor(stream, parts) {
      this.stream = stream;
      this.parts = parts; // [{at, len}]
      this.i = 0;
      this.pos = parts.length > 0 ? parts[0].at : 0;
      this.view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    }

    get left() {
      const part = this.parts[this.i];
      return part ? part.at + part.len - this.pos : 0;
    }

    next() {
      this.i++;
      if (this.i >= this.parts.length) fail();
      this.pos = this.parts[this.i].at;
    }

    ensure() {
      while (this.left === 0) this.next();
    }

    u8() {
      this.ensure();
      return this.stream[this.pos++];
    }

    u16() {
      return this.u8() | (this.u8() << 8);
    }

    u32() {
      return (this.u16() | (this.u16() << 16)) >>> 0;
    }

    skip(n) {
      while (n > 0) {
        this.ensure();
        const take = Math.min(n, this.left);
        this.pos += take;
        n -= take;
      }
    }

    /** XLUnicodeRichExtendedString: cch, flags, [runs], [ext], caracteres, runs, ext. */
    string() {
      const cch = this.u16();
      return this.stringBody(cch);
    }

    stringBody(cch) {
      const flags = this.u8();
      let utf16 = (flags & 1) !== 0;
      const rich = (flags & 8) !== 0;
      const ext = (flags & 4) !== 0;
      const runs = rich ? this.u16() : 0;
      const extSize = ext ? this.u32() : 0;
      let out = '';
      let remaining = cch;
      while (remaining > 0) {
        if (this.left === 0) {
          this.next();
          utf16 = (this.stream[this.pos++] & 1) !== 0; // byte de opções no início de cada continuação
        }
        const width = utf16 ? 2 : 1;
        const n = Math.min(remaining, Math.floor(this.left / width));
        if (n === 0) fail();
        for (let k = 0; k < n; k++) {
          out += String.fromCharCode(utf16 ? this.view.getUint16(this.pos + k * 2, true) : this.stream[this.pos + k]);
        }
        this.pos += n * width;
        remaining -= n;
      }
      this.skip(runs * 4 + extSize);
      return out;
    }
  }

  function rkValue(rk) {
    let n;
    if (rk & 2) n = rk >> 2;
    else {
      const b = new DataView(new ArrayBuffer(8));
      b.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
      n = b.getFloat64(0, true);
    }
    return rk & 1 ? n / 100 : n;
  }

  function readXls(bytes, limits) {
    try {
      return parseXls(bytes, limits);
    } catch (e) {
      if (e instanceof HubError) throw e;
      throw new HubError(CORRUPT);
    }
  }

  function parseXls(bytes, limits) {
    const stream = readOleStream(bytes, ['Workbook', 'Book']);
    if (!stream) throw new HubError('O .xls não contém uma planilha do Excel.');
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);

    // BIFF8 começa com BOF versão 0x0600. Versões anteriores (Excel 5/95) usam outra codificação de texto.
    if (stream.length < 8 || view.getUint16(0, true) !== REC.BOF || view.getUint16(4, true) !== 0x0600) {
      throw new HubError('Esta versão antiga do Excel (anterior ao 97) não é suportada. Abra no Excel e salve como .xlsx.');
    }

    // Passo 1: registros globais (abas, textos, formatos).
    const sheets = [];
    const xfFormat = [];
    const customFormats = new Map();
    let sst = [];
    let date1904 = false;
    const recs = [...records(stream)];
    let idx = 0;
    for (; idx < recs.length; idx++) {
      const r = recs[idx];
      if (r.type === REC.EOF) break;
      if (r.type === REC.FILEPASS) throw new HubError('O .xls está protegido por senha e não pode ser lido.');
      if (r.type === REC.DATEMODE) date1904 = view.getUint16(r.at, true) === 1;
      else if (r.type === REC.XF) xfFormat.push(view.getUint16(r.at + 2, true));
      else if (r.type === REC.FORMAT) {
        const c = new Chunks(stream, [{ at: r.at + 2, len: r.len - 2 }]);
        customFormats.set(view.getUint16(r.at, true), c.string());
      } else if (r.type === REC.BOUNDSHEET) {
        const kind = stream[r.at + 5];
        const c = new Chunks(stream, [{ at: r.at + 6, len: r.len - 6 }]);
        const cch = c.u8();
        sheets.push({ offset: view.getUint32(r.at, true), kind, name: c.stringBody(cch) });
      } else if (r.type === REC.SST) {
        const parts = [{ at: r.at, len: r.len }];
        while (idx + 1 < recs.length && recs[idx + 1].type === REC.CONTINUE) {
          idx++;
          parts.push({ at: recs[idx].at, len: recs[idx].len });
        }
        const c = new Chunks(stream, parts);
        c.u32();
        const unique = c.u32();
        if (unique > limits.maxRowsPerFile * limits.maxColumns) throw new LimitError('Textos compartilhados demais.');
        sst = [];
        for (let k = 0; k < unique; k++) {
          // Um SST truncado/errado não deve derrubar a leitura: o que faltar fica vazio.
          try {
            sst.push(c.string());
          } catch (e) {
            if (e instanceof LimitError) throw e;
            break;
          }
        }
      }
    }

    const dateFormat = new Set();
    xfFormat.forEach((fmt, i) => {
      if (BUILTIN_DATE_FORMATS.has(fmt) || (customFormats.has(fmt) && isDateFormat(customFormats.get(fmt)))) dateFormat.add(i);
    });

    const worksheets = sheets.filter((s) => s.kind === 0 && s.offset < stream.length);
    if (worksheets.length === 0) throw new HubError('O .xls não contém planilhas legíveis.');
    const sorted = [...worksheets].sort((a, b) => a.offset - b.offset);
    for (let i = 0; i < sorted.length; i++) sorted[i].weight = (sorted[i + 1] ? sorted[i + 1].offset : stream.length) - sorted[i].offset;
    const chosen = worksheets.reduce((a, b) => (b.weight > a.weight ? b : a));

    // Passo 2: células da aba escolhida.
    const grid = [];
    let maxCol = 0;

    const put = (row, col, text) => {
      if (row > limits.maxRowsPerFile + 26) throw new LimitError(`O arquivo excede o limite de ${limits.maxRowsPerFile} linhas.`);
      if (col >= limits.maxColumns) throw new LimitError(`O arquivo excede o limite de ${limits.maxColumns} colunas.`);
      const line = grid[row] ?? (grid[row] = []);
      line[col] = cleanCell(text, limits);
      if (col + 1 > maxCol) maxCol = col + 1;
    };
    const num = (value, ixfe) => (dateFormat.has(ixfe) ? serialToIso(value, date1904) : numberToText(String(value)));

    const hiddenGrid = new Set();
    const mergeRanges = [];
    let pendingFormula = null; // fórmula cujo resultado de texto vem no registro STRING seguinte
    const start = recs.findIndex((r) => r.at - 4 === chosen.offset);
    if (start === -1) fail();
    for (let i = start + 1; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === REC.EOF) break;
      const a = r.at;
      switch (r.type) {
        case REC.ROW:
          if (r.len >= 14 && (view.getUint16(a + 12, true) & 0x20) !== 0) hiddenGrid.add(view.getUint16(a, true));
          break;
        case REC.MERGEDCELLS: {
          const count = Math.min(view.getUint16(a, true), Math.floor((r.len - 2) / 8));
          for (let k = 0; k < count && mergeRanges.length < 100_000; k++) {
            const p = a + 2 + k * 8;
            mergeRanges.push([view.getUint16(p, true), view.getUint16(p + 4, true), view.getUint16(p + 2, true), view.getUint16(p + 6, true)]);
          }
          break;
        }
        case REC.LABELSST: {
          put(view.getUint16(a, true), view.getUint16(a + 2, true), sst[view.getUint32(a + 6, true)] ?? '');
          break;
        }
        case REC.LABEL:
        case REC.RSTRING: {
          const c = new Chunks(stream, [{ at: a + 6, len: r.len - 6 }]);
          put(view.getUint16(a, true), view.getUint16(a + 2, true), c.string());
          break;
        }
        case REC.NUMBER:
          put(view.getUint16(a, true), view.getUint16(a + 2, true), num(view.getFloat64(a + 6, true), view.getUint16(a + 4, true)));
          break;
        case REC.RK:
          put(view.getUint16(a, true), view.getUint16(a + 2, true), num(rkValue(view.getUint32(a + 6, true)), view.getUint16(a + 4, true)));
          break;
        case REC.MULRK: {
          const row = view.getUint16(a, true);
          const first = view.getUint16(a + 2, true);
          const count = Math.floor((r.len - 6) / 6);
          for (let k = 0; k < count; k++) {
            put(row, first + k, num(rkValue(view.getUint32(a + 4 + k * 6 + 2, true)), view.getUint16(a + 4 + k * 6, true)));
          }
          break;
        }
        case REC.BOOLERR: {
          const v = stream[a + 6];
          put(view.getUint16(a, true), view.getUint16(a + 2, true), stream[a + 7] ? (ERROR_TEXT.get(v) ?? '#ERRO') : v ? 'TRUE' : 'FALSE');
          break;
        }
        case REC.FORMULA: {
          const row = view.getUint16(a, true);
          const col = view.getUint16(a + 2, true);
          const ixfe = view.getUint16(a + 4, true);
          if (view.getUint16(a + 12, true) !== 0xffff) {
            put(row, col, num(view.getFloat64(a + 6, true), ixfe));
            break;
          }
          const kind = stream[a + 6];
          if (kind === 0) pendingFormula = { row, col };
          else if (kind === 1) put(row, col, stream[a + 8] ? 'TRUE' : 'FALSE');
          else if (kind === 2) put(row, col, ERROR_TEXT.get(stream[a + 8]) ?? '#ERRO');
          break;
        }
        case REC.STRING: {
          if (pendingFormula) {
            const parts = [{ at: a, len: r.len }];
            while (i + 1 < recs.length && recs[i + 1].type === REC.CONTINUE) {
              i++;
              parts.push({ at: recs[i].at, len: recs[i].len });
            }
            put(pendingFormula.row, pendingFormula.col, new Chunks(stream, parts).string());
            pendingFormula = null;
          }
          break;
        }
        default:
          break;
      }
    }

    const merged = fillMerged(grid, mergeRanges, maxCol, limits);
    maxCol = merged.maxCol;
    const { columns, rows, hidden } = gridToTable(grid, maxCol, limits, hiddenGrid);
    const warnings = [];
    if (merged.filled > 0) warnings.push(`${merged.filled} célula(s) de áreas mescladas foram preenchidas repetindo o valor.`);
    if (worksheets.length > 1) warnings.push(`O arquivo tem ${worksheets.length} abas; foi usada a maior ("${chosen.name}").`);
    return { columns, rows, warnings, sheetName: chosen.name, hidden };
  }

  H.xlsReader = { isOle, readXls, readOleStream };
})((globalThis.Hub = globalThis.Hub || {}));
