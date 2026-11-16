/**
 * Gerador de arquivos .xls (BIFF8 dentro de contêiner OLE2) só para testes, escrito de forma independente do leitor.
 * Suporta: textos (SST, com CONTINUE), NUMBER, RK, MULRK, datas, booleanos, erros, fórmulas (número e texto), LABEL,
 * várias abas, e fluxo "grande" ou "pequeno" (mini stream).
 */
(function (g) {
  'use strict';

  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const u16 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255);
  const u32 = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  const f64 = (x) => new Uint8Array(new Float64Array([x]).buffer);
  const rec = (type, ...data) => {
    const body = concat(data);
    return concat([u16(type), u16(body.length), body]);
  };

  /** Texto -> bytes de caracteres (latin1 comprimido ou utf-16) + flag. */
  function charsOf(text) {
    const wide = [...text].some((c) => c.charCodeAt(0) > 255);
    const bytes = new Uint8Array(text.length * (wide ? 2 : 1));
    for (let i = 0; i < text.length; i++) {
      if (wide) {
        bytes[i * 2] = text.charCodeAt(i) & 255;
        bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
      } else bytes[i] = text.charCodeAt(i);
    }
    return { wide, bytes };
  }

  /** XLUnicodeString simples (cch u16 + flags + caracteres). */
  function xlString(text) {
    const { wide, bytes } = charsOf(text);
    return concat([u16(text.length), Uint8Array.of(wide ? 1 : 0), bytes]);
  }

  /** Registro SST + CONTINUE, quebrando strings no meio dos caracteres (com o byte de opções na continuação). */
  function sstRecords(strings) {
    const chunks = [[]]; // listas de bytes
    let cap = 8224 - 8;
    const push = (bytes) => {
      for (const b of bytes) chunks[chunks.length - 1].push(b);
      cap -= bytes.length;
    };
    const fresh = () => {
      chunks.push([]);
      cap = 8224;
    };
    for (const s of strings) {
      const { wide, bytes } = charsOf(s);
      if (cap < 3) fresh();
      push(u16(s.length));
      push([wide ? 1 : 0]);
      let at = 0;
      const width = wide ? 2 : 1;
      while (at < bytes.length) {
        if (cap < width) {
          fresh();
          push([wide ? 1 : 0]); // byte de opções da continuação
        }
        const n = Math.min(bytes.length - at, Math.floor(cap / width) * width);
        push(bytes.subarray(at, at + n));
        at += n;
      }
    }
    const head = concat([u32(strings.length), u32(strings.length)]);
    const out = [rec(0x00fc, head, Uint8Array.from(chunks[0]))];
    for (let i = 1; i < chunks.length; i++) out.push(rec(0x003c, Uint8Array.from(chunks[i])));
    return out;
  }

  function rkBytes(intValue) {
    return u32(((intValue << 2) | 2) >>> 0);
  }

  function cellRecords(row, col, spec, sstIndex) {
    const pos = (ixfe) => concat([u16(row), u16(col), u16(ixfe)]);
    if (typeof spec === 'string') return [rec(0x00fd, pos(0), u32(sstIndex(spec)))];
    if (typeof spec === 'number') return [rec(0x0203, pos(0), f64(spec))];
    if (spec.date !== undefined) return [rec(0x0203, pos(spec.xf ?? 1), f64(spec.date))];
    if (spec.rk !== undefined) return [rec(0x027e, pos(0), rkBytes(spec.rk))];
    if (spec.mulrk) {
      const body = spec.mulrk.flatMap((v) => [u16(0), rkBytes(v)]);
      return [rec(0x00bd, u16(row), u16(col), ...body, u16(col + spec.mulrk.length - 1))];
    }
    if (spec.bool !== undefined) return [rec(0x0205, pos(0), Uint8Array.of(spec.bool ? 1 : 0, 0))];
    if (spec.err !== undefined) return [rec(0x0205, pos(0), Uint8Array.of(spec.err, 1))];
    if (spec.fnum !== undefined) return [rec(0x0006, pos(0), f64(spec.fnum), u16(0), u32(0), u16(0))];
    if (spec.fstr !== undefined) {
      const marker = Uint8Array.of(0, 0, 0, 0, 0, 0, 0xff, 0xff); // tipo 0 = texto em STRING
      return [rec(0x0006, pos(0), marker, u16(0), u32(0), u16(0)), rec(0x0207, xlString(spec.fstr))];
    }
    if (spec.label !== undefined) return [rec(0x0204, pos(0), xlString(spec.label))];
    throw new Error('célula não suportada no gerador de testes');
  }

  const bof = (kind) => rec(0x0809, u16(0x0600), u16(kind), u16(0), u16(0), u32(0), u32(6));
  const EOF = rec(0x000a);

  /** Contêiner OLE2 com um fluxo "Workbook" (grande: setores normais; pequeno (<4096): mini stream). */
  function buildOle(stream) {
    const FREE = 0xffffffff;
    const END = 0xfffffffe;
    const FATSECT = 0xfffffffd;
    const big = stream.length >= 4096;
    const sectors = [];
    const fat = new Array(128).fill(FREE);
    let miniFatStart = END;
    let numMiniFat = 0;
    let rootStart = END;
    let rootSize = 0;
    let streamStart;

    fat[0] = FATSECT;
    fat[1] = END; // diretório
    const pad = (data, size) => {
      const out = new Uint8Array(Math.ceil(data.length / size) * size);
      out.set(data);
      return out;
    };

    let dataSectors;
    if (big) {
      const data = pad(stream, 512);
      const n = data.length / 512;
      if (n + 2 > 128) throw new Error('fluxo grande demais para o gerador de testes');
      streamStart = 2;
      for (let i = 0; i < n; i++) fat[2 + i] = i === n - 1 ? END : 3 + i;
      dataSectors = [data];
    } else {
      const nMini = Math.ceil(stream.length / 64);
      const miniData = pad(stream, 64);
      const miniFat = new Array(128).fill(FREE);
      for (let i = 0; i < nMini; i++) miniFat[i] = i === nMini - 1 ? END : i + 1;
      miniFatStart = 2;
      numMiniFat = 1;
      fat[2] = END;
      const ms = pad(miniData, 512);
      const n = ms.length / 512;
      rootStart = 3;
      rootSize = miniData.length;
      for (let i = 0; i < n; i++) fat[3 + i] = i === n - 1 ? END : 4 + i;
      streamStart = 0;
      dataSectors = [concat(miniFat.map(u32)), ms];
    }

    const entry = (name, type, start, size, child) => {
      const e = new Uint8Array(128);
      const dv = new DataView(e.buffer);
      for (let i = 0; i < name.length; i++) dv.setUint16(i * 2, name.charCodeAt(i), true);
      dv.setUint16(64, name ? (name.length + 1) * 2 : 0, true);
      e[66] = type;
      dv.setUint32(68, FREE, true);
      dv.setUint32(72, FREE, true);
      dv.setUint32(76, child, true);
      dv.setUint32(116, start, true);
      dv.setUint32(120, size, true);
      return e;
    };
    const dir = concat([
      entry('Root Entry', 5, rootStart, rootSize, 1),
      entry('Workbook', 2, streamStart, stream.length, FREE),
      entry('', 0, 0, 0, FREE),
      entry('', 0, 0, 0, FREE),
    ]);

    const header = new Uint8Array(512);
    const hv = new DataView(header.buffer);
    header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    hv.setUint16(24, 0x3e, true);
    hv.setUint16(26, 3, true);
    hv.setUint16(28, 0xfffe, true);
    hv.setUint16(30, 9, true);
    hv.setUint16(32, 6, true);
    hv.setUint32(44, 1, true);
    hv.setUint32(48, 1, true);
    hv.setUint32(56, 4096, true);
    hv.setUint32(60, miniFatStart, true);
    hv.setUint32(64, numMiniFat, true);
    hv.setUint32(68, END, true);
    for (let i = 0; i < 109; i++) hv.setUint32(76 + i * 4, i === 0 ? 0 : FREE, true);

    sectors.push(concat(fat.map(u32)), dir, ...dataSectors);
    return concat([header, ...sectors]);
  }

  /**
   * spec: { sheets: [{ name, cells: [[linha, coluna, valor], ...], hidden? }], date1904?, forceBig? }
   * Células: string | número | {date} | {rk} | {mulrk:[...]} | {bool} | {err} | {fnum} | {fstr} | {label}
   */
  function buildXls(spec) {
    const strings = [];
    const sstIndex = (s) => {
      let i = strings.indexOf(s);
      if (i === -1) {
        strings.push(s);
        i = strings.length - 1;
      }
      return i;
    };
    const sheetStreams = spec.sheets.map((sheet) => {
      const cells = [...sheet.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const rowRecords = (sheet.hiddenRows ?? []).map((r) => rec(0x0208, u16(r), u16(0), u16(0), u16(255), u16(0), u16(0), u16(0x20), u16(0)));
      const merges = (sheet.merges ?? []).length
        ? [rec(0x00e5, u16(sheet.merges.length), ...sheet.merges.flatMap(([r1, c1, r2, c2]) => [u16(r1), u16(r2), u16(c1), u16(c2)]))]
        : [];
      return concat([bof(0x0010), ...rowRecords, ...cells.flatMap(([r, c, v]) => cellRecords(r, c, v, sstIndex)), ...merges, EOF]);
    });

    const xf = (fmt) => rec(0x00e0, u16(0), u16(fmt), new Uint8Array(16));
    const globals = (offsets) =>
      concat([
        bof(0x0005),
        ...(spec.date1904 ? [rec(0x0022, u16(1))] : []),
        rec(0x041e, u16(164), xlString('dd/mm/yyyy hh:mm')),
        xf(0),
        xf(14),
        xf(164),
        ...spec.sheets.map((s, i) => {
          const { bytes } = charsOf(s.name);
          const wide = [...s.name].some((c) => c.charCodeAt(0) > 255);
          return rec(0x0085, u32(offsets[i]), Uint8Array.of(0, 0), Uint8Array.of(s.name.length, wide ? 1 : 0), bytes);
        }),
        ...sstRecords(strings),
        EOF,
      ]);

    const size = globals(spec.sheets.map(() => 0)).length;
    const offsets = [];
    let at = size;
    for (const s of sheetStreams) {
      offsets.push(at);
      at += s.length;
    }
    const stream = concat([globals(offsets), ...sheetStreams]);
    // Mini stream só vale para fluxos pequenos; `forceBig` completa até 4096 bytes (o Excel faz algo parecido).
    const padded = spec.forceBig && stream.length < 4096 ? concat([stream, new Uint8Array(4096 - stream.length)]) : stream;
    return buildOle(padded);
  }

  g.TestHelpers = Object.assign(g.TestHelpers || {}, { buildXls, buildOle });
})(globalThis);
