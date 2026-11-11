(function () {
  'use strict';

  const root = require('node:path').join(__dirname, '..', '..');
  const fromRoot = (...p) => join(root, ...p);
  const { readdirSync, readFileSync, statSync } = require('node:fs');
  const { join } = require('node:path');

  /** Testes de política: falham se alguém introduzir uma API que quebre o modelo de segurança. */

  function sourceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? sourceFiles(p) : /\.(js|css)$/.test(name) ? [p] : [];
    });
  }

  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const FORBIDDEN = [
    ['HTML bruto (innerHTML/outerHTML)', /\b(innerHTML|outerHTML)\b/],
    ['insertAdjacentHTML', /insertAdjacentHTML/],
    ['document.write', /document\.write/],
    ['eval / new Function', /\beval\s*\(|new\s+Function\s*\(/],
    ['setTimeout/setInterval com texto', /set(Timeout|Interval)\s*\(\s*['"`]/],
    ['rede: fetch/XHR/WebSocket/EventSource/beacon', /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/],
    ['import dinâmico', /\bimport\s*\(/],
    ['storage/cookies/IndexedDB', /\b(localStorage|sessionStorage|indexedDB|document\.cookie|caches)\b/],
    ['workers e service workers', /\b(new\s+Worker|SharedWorker|serviceWorker)\b/],
    ['postMessage/window.open/opener', /\b(postMessage|window\.open|opener)\b/],
    ['createContextualFragment/DOMParser HTML', /createContextualFragment|text\/html/],
    ['@import / url() em CSS', /@import|url\s*\(/],
  ];

  describe('política de segurança do código-fonte', () => {
    const files = [...sourceFiles(fromRoot('js')), ...sourceFiles(fromRoot('css'))];

    for (const [label, re] of FORBIDDEN) {
      it(`não usa ${label}`, () => {
        // fonts.css embute as fontes como data: URI (verificado no teste abaixo); é a única exceção.
        const offenders = files.filter((f) => !f.endsWith('fonts.css') && re.test(stripComments(readFileSync(f, 'utf8'))));
        expect(offenders).toEqual([]);
      });
    }

    it('fonts.css só usa url() com data:font/woff2 (nada externo)', () => {
      const css = readFileSync(fromRoot('css', 'fonts.css'), 'utf8');
      const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(u.startsWith('data:font/woff2;base64,')).toBe(true);
      expect(css).not.toMatch(/@import/);
    });

    it('DOMParser só é usado com XML', () => {
      for (const f of files) {
        const code = stripComments(readFileSync(f, 'utf8'));
        for (const m of code.matchAll(/parseFromString\([^)]*\)/g)) expect(m[0]).toContain("'application/xml'");
      }
    });

    it('zero dependências: package.json não declara dependencies nem devDependencies', () => {
      const pkg = JSON.parse(readFileSync(fromRoot('package.json'), 'utf8'));
      expect(pkg.dependencies).toBeUndefined();
      expect(pkg.devDependencies).toBeUndefined();
    });

    it('o código-fonte não importa módulos nem bibliotecas (require/import/export)', () => {
      const offenders = files.filter((f) => f.endsWith('.js') && /\brequire\s*\(|^\s*import\s.+from|^\s*export\s/m.test(stripComments(readFileSync(f, 'utf8'))));
      expect(offenders).toEqual([]);
    });
  });

  describe('Content-Security-Policy do index.html', () => {
    const html = readFileSync(fromRoot('index.html'), 'utf8');
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    const directive = (name) =>
      csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);

    it('existe e usa default-src none', () => {
      expect(directive('default-src')).toBe("default-src 'none'");
    });

    for (const [name, value] of [
      ['script-src', "'self'"],
      ['style-src', "'self'"],
      ['connect-src', "'none'"],
      ['worker-src', "'none'"],
      ['frame-src', "'none'"],
      ['object-src', "'none'"],
      ['form-action', "'none'"],
      ['base-uri', "'none'"],
      ['require-trusted-types-for', "'script'"],
      ['trusted-types', "'none'"],
    ]) {
      it(`${name} = ${value}`, () => {
        expect(directive(name)).toBe(`${name} ${value}`);
      });
    }

    it('nunca permite unsafe-inline, unsafe-eval, curingas, data: ou http(s):', () => {
      expect(csp.replace(/font-src data:/, '')).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|\*|data:|https?:|blob:/);
    });

    it('não carrega recursos externos nem scripts inline', () => {
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(html).not.toMatch(/(src|href)="https?:/i);
      expect(html).not.toMatch(/\son[a-z]+=/i);
    });
  });

  describe('tema claro/escuro', () => {
    const css = readFileSync(fromRoot('css', 'styles.css'), 'utf8');

    it('segue o sistema por CSS puro (sem script nem armazenamento)', () => {
      expect(css).toContain('@media (prefers-color-scheme: dark)');
      expect(css).toMatch(/color-scheme:\s*light dark/);
    });

    it('não deixa fundos brancos fixos fora dos tokens', () => {
      expect(css).not.toMatch(/background:\s*#fff\b/);
    });
  });
})();
