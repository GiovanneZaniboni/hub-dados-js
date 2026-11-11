/**
 * Leitor e escritor de ZIP mínimos, sem bibliotecas: usam só o que o navegador já traz
 * (DecompressionStream/CompressionStream com "deflate-raw").
 *
 * Segurança (arquivos .xlsx são zips e podem vir de fontes não confiáveis):
 * - o diretório central é lido e VALIDADO antes de descompactar qualquer coisa
 *   (nº de entradas, soma dos tamanhos declarados, nomes duplicados, criptografia, zip64);
 * - durante a descompactação o limite é imposto de verdade: se uma entrada produzir mais bytes
 *   que o tamanho declarado, ela é abortada (um zip-bomba não consegue mentir sobre o tamanho);
 * - o CRC-32 de cada entrada extraída é conferido.
 */
(function (H) {
  'use strict';

  const { HubError, LimitError } = H.limits;

  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;
  const CORRUPT = 'Não foi possível abrir o .xlsx (arquivo corrompido?).';

  // ---- CRC-32 --------------------------------------------------------------------------
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- leitura -------------------------------------------------------------------------

  /** Lê o diretório central. Não descompacta nada. Lança HubError/LimitError se algo for suspeito. */
  function listZip(bytes, limits) {
    if (bytes.length < 22) throw new HubError(CORRUPT);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Fim do diretório central (EOCD): fica nos últimos 22 + 65535 bytes.
    let eocd = -1;
    const lowest = Math.max(0, bytes.length - 22 - 0xffff);
    for (let i = bytes.length - 22; i >= lowest; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new HubError(CORRUPT);

    const total = view.getUint16(eocd + 10, true);
    const dirSize = view.getUint32(eocd + 12, true);
    const dirOffset = view.getUint32(eocd + 16, true);
    if (total === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
      throw new HubError('Arquivo .xlsx em formato zip64 não é suportado.');
    }
    if (total > limits.maxXlsxEntries) throw new LimitError('O .xlsx contém entradas demais.');
    if (dirOffset + dirSize > bytes.length) throw new HubError(CORRUPT);

    const decoder = new TextDecoder('utf-8');
    const entries = [];
    const seen = new Set();
    let declared = 0;
    let p = dirOffset;
    for (let i = 0; i < total; i++) {
      if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) throw new HubError(CORRUPT);
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      if (p + 46 + nameLen > bytes.length) throw new HubError(CORRUPT);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      if (flags & 1) throw new HubError('Arquivo .xlsx protegido por senha não é suportado.');
      if (compSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
        throw new HubError('Arquivo .xlsx em formato zip64 não é suportado.');
      }
      if (method !== 0 && method !== 8) throw new HubError(CORRUPT);
      // Nomes repetidos podem fazer dois programas lerem conteúdos diferentes: recusa.
      if (seen.has(name)) throw new HubError(CORRUPT);
      seen.add(name);

      declared += size;
      if (declared > limits.maxXlsxUncompressedBytes) throw new LimitError('O .xlsx descompactado é grande demais.');
      entries.push({ name, method, crc, compSize, size, offset });
    }
    return { entries, names: entries.map((e) => e.name) };
  }

  /** Descompacta um bloco "deflate-raw" abortando se passar de `expected` bytes. */
  async function inflateRaw(raw, expected) {
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    // Erros de escrita (dados corrompidos) também aparecem na leitura; evita rejeição sem tratamento.
    writer.write(raw).then(() => writer.close()).catch(() => {});

    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > expected) {
        await reader.cancel().catch(() => {});
        throw new LimitError('O .xlsx descompactado é maior que o declarado (arquivo suspeito).');
      }
      chunks.push(value);
    }
    return concat(chunks, total);
  }

  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  /** Extrai só as entradas aceitas por `wanted(nome)`. Retorna um Map nome -> bytes. */
  async function extractZip(bytes, zip, wanted) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const files = new Map();
    for (const entry of zip.entries) {
      if (!wanted(entry.name)) continue;
      const at = entry.offset;
      if (at + 30 > bytes.length || view.getUint32(at, true) !== SIG_LOCAL) throw new HubError(CORRUPT);
      const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
      const end = start + entry.compSize;
      if (end > bytes.length) throw new HubError(CORRUPT);
      const raw = bytes.subarray(start, end);

      let data;
      try {
        data = entry.method === 0 ? raw.slice() : await inflateRaw(raw, entry.size);
      } catch (e) {
        if (e instanceof HubError) throw e;
        throw new HubError(CORRUPT);
      }
      if (data.length !== entry.size || crc32(data) !== entry.crc) throw new HubError(CORRUPT);
      files.set(entry.name, data);
    }
    return files;
  }

  // ---- escrita -------------------------------------------------------------------------

  async function deflateRaw(data) {
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    writer.write(data).then(() => writer.close());
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    return concat(chunks, total);
  }

  /** Monta um zip. `files` é uma lista de [nome, bytes]. Data fixa (1980-01-01) para saída reproduzível. */
  async function buildZip(files) {
    const encoder = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const [name, data] of files) {
      const nameBytes = encoder.encode(name);
      const crc = crc32(data);
      let method = 8;
      let body = await deflateRaw(data);
      if (body.length >= data.length) {
        method = 0;
        body = data;
      }

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, SIG_LOCAL, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // nomes em UTF-8
      lv.setUint16(8, method, true);
      lv.setUint16(12, 0x0021, true); // 1980-01-01
      lv.setUint32(14, crc, true);
      lv.setUint32(18, body.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, SIG_CENTRAL, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(14, 0x0021, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, body.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);

      locals.push(local, body);
      centrals.push(central);
      offset += local.length + body.length;
    }

    const dirSize = centrals.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, dirSize, true);
    ev.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, end];
    return concat(parts, parts.reduce((n, c) => n + c.length, 0));
  }

  H.zip = { crc32, listZip, extractZip, buildZip };
})((globalThis.Hub = globalThis.Hub || {}));
