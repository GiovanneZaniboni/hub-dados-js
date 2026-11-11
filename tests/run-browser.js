'use strict';
/**
 * Roda tests/browser/index.html em um Chrome ou Edge real (modo headless), via file://,
 * lendo o resultado pelo protocolo de depuração. Sem dependências: usa só Node (>= 22).
 * Se o navegador não for encontrado automaticamente, informe: CHROME_PATH="caminho\\chrome.exe" npm run test:browser
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

/**
 * Ao analisar um XML malformado (teste proposital), o Chromium/Edge monta um documento de erro com style="..." próprio,
 * e a CSP bloqueia esse estilo. É inofensivo (o documento é descartado e o app mostra seu próprio erro), então não conta.
 */
const isBenignParserError = (e) => /inline style/i.test(e.text) && /parseXml/.test(JSON.stringify(e.stackTrace || ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = CANDIDATES.find((p) => fs.existsSync(p));
  if (!browser) {
    console.error('Chrome/Edge não encontrado. Defina CHROME_PATH com o caminho do executável.');
    return 2;
  }
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tests-'));
  const proc = spawn(
    browser,
    ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore' },
  );
  try {
    let page;
    for (let i = 0; i < 75 && !page; i++) {
      try {
        page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      } catch {
        /* navegador ainda iniciando */
      }
      if (!page) await sleep(200);
    }
    if (!page) throw new Error('Não foi possível conectar ao navegador.');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    const violations = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
      else if (msg.method === 'Log.entryAdded' && /Content Security Policy|Refused to/i.test(msg.params.entry.text) && !isBenignParserError(msg.params.entry)) violations.push(msg.params.entry.text.slice(0, 120) + ' @ ' + (msg.params.entry.url || '?') + ':' + (msg.params.entry.lineNumber || '?') + ' ' + JSON.stringify(msg.params.entry.stackTrace || '').slice(0, 400));
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params }));
      });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.navigate', { url: pathToFileURL(path.join(__dirname, 'browser', 'index.html')).href });

    let result;
    for (let i = 0; i < 300 && !result; i++) {
      await sleep(200);
      const r = await send('Runtime.evaluate', { expression: 'window.__HUB_TESTS__ || null', returnByValue: true });
      result = r.result && r.result.result && r.result.result.value;
    }
    ws.close();
    if (!result) throw new Error('Os testes não terminaram a tempo.');

    for (const f of result.failures) console.error('FALHOU: ' + f);
    for (const v of violations) console.error('VIOLAÇÃO DE CSP: ' + v);
    console.log(`Navegador (${path.basename(browser)}): ${result.passed} passaram, ${result.failed} falharam, ${result.skipped} pulados`);
    return result.failed || violations.length ? 1 : 0;
  } finally {
    proc.kill();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* o navegador pode demorar a soltar a pasta; sem problema */
    }
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e.message || e);
    process.exit(1);
  },
);
