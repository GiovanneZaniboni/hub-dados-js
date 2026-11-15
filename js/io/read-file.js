(function (H) {
  'use strict';

  const { HubError, LimitError } = H.limits;
  const { readDelimited } = H.csvReader;

  const { readXlsx } = H.xlsxReader;
  const { isOle, readXls } = H.xlsReader;

  const EXCEL_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls']);
  const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'txt']);

  function extensionOf(name) {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  }

  /** Assinaturas de formatos binários conhecidos que não podem ser lidos como texto. */
  function looksBinary(bytes) {
    const head = bytes.subarray(0, 8192);
    if (head.includes(0)) return true;
    const sig = String.fromCharCode(...head.subarray(0, 4));
    return sig.startsWith('PK') || sig.startsWith('%PDF') || sig.startsWith('MZ') || sig.startsWith('\x7fELF');
  }

  /**
   * .xlsx/.xlsm/.xls: o formato real é decidido pelo conteúdo, não pela extensão (arquivos renomeados são comuns).
   * Macros (.xlsm) nunca são lidas nem executadas: só os valores das células.
   */
  async function readExcelLike(ext, bytes, limits) {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readXlsx(bytes, limits);
    if (isOle(bytes)) return readXls(bytes, limits);
    const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();
    if (head.startsWith('<')) {
      throw new HubError(`O arquivo .${ext} é na verdade uma página HTML/XML (comum em exportações de sistemas). Abra-o no Excel e salve como .xlsx.`);
    }
    if (looksBinary(bytes)) throw new HubError(`O arquivo .${ext} não é uma planilha do Excel válida.`);
    // Texto puro com extensão de Excel (também é comum): lê como CSV/TSV e avisa.
    const table = readDelimited(bytes, limits);
    table.warnings.push(`O arquivo .${ext} era um texto delimitado, não uma planilha do Excel; foi lido como CSV.`);
    return table;
  }

  /** Lê bytes já em memória. Testável sem a API File. */
  async function readBytes(name, bytes, limits) {
    if (bytes.length > limits.maxFileBytes) {
      throw new LimitError(`O arquivo excede o limite de ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB.`);
    }
    const ext = extensionOf(name);
    if (EXCEL_EXTENSIONS.has(ext)) return readExcelLike(ext, bytes, limits);
    if (ext === 'xlsb') {
      throw new HubError('Formato .xlsb (binário do Excel) não é suportado. Abra no Excel e salve como .xlsx.');
    }
    if (!TEXT_EXTENSIONS.has(ext)) throw new HubError(`Formato .${ext || '(sem extensão)'} não suportado. Use .xlsx, .csv, .tsv ou .txt.`);
    if (looksBinary(bytes)) throw new HubError('O conteúdo não parece um arquivo de texto delimitado.');
    return readDelimited(bytes, limits);
  }

  /** Lê um File do navegador (verifica o tamanho ANTES de carregar o conteúdo). */
  async function readFile(file, limits) {
    if (file.size > limits.maxFileBytes) {
      throw new LimitError(`O arquivo excede o limite de ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB.`);
    }
    return readBytes(file.name, new Uint8Array(await file.arrayBuffer()), limits);
  }

  H.fileReader = { readBytes, readFile };
})((globalThis.Hub = globalThis.Hub || {}));
