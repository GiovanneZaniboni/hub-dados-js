'use strict';
/**
 * Roda no Node (>= 22) os testes que não dependem de DOM, mais os testes só-Node (política de segurança, SQLite).
 * Os testes de XLSX/interface rodam no navegador: abra tests/browser/index.html ou use `npm run test:browser`.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
// Os specs só-Node (segurança, SQLite) usam require e __dirname; os demais não precisam deles.
globalThis.require = require;
globalThis.__dirname = __dirname;
const load = (file) => vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });

// Mesma lista e ordem de <script src> do index.html.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
// Node não tem DOM: não carrega a interface (js/ui/*, js/main.js).
for (const s of scripts) if (!s.startsWith('js/ui/') && s !== 'js/main.js') load(path.join(root, s));

for (const f of ['runner.js', 'expect.js', 'helpers.js']) load(path.join(__dirname, '..', 'support', f));
for (const f of ['core', 'io', 'export', 'store', 'realworld']) load(path.join(__dirname, '..', 'specs', `${f}.spec.js`));
for (const f of ['security', 'sql']) load(path.join(__dirname, `${f}.spec.js`));

runAll().then((r) => {
  if (process.argv.includes('--verbose')) console.log(r.log.join('\n'));
  for (const f of r.failures) console.error('FALHOU: ' + f);
  console.log(`Node: ${r.passed} passaram, ${r.failed} falharam, ${r.skipped} pulados (rodam no navegador)`);
  process.exit(r.failed ? 1 : 0);
});
