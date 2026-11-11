/**
 * Executor de testes mínimo (sem dependências): describe / it / it.skip / beforeEach / afterEach.
 * Funciona no Node e no navegador. `await runAll()` devolve { passed, failed, skipped, failures, log }.
 */
(function (g) {
  'use strict';

  const root = { name: '', children: [], before: [], after: [], parent: null };
  let current = root;

  g.describe = (name, fn) => {
    const suite = { name, children: [], before: [], after: [], parent: current };
    current.children.push(suite);
    const prev = current;
    current = suite;
    try {
      fn();
    } finally {
      current = prev;
    }
  };
  g.beforeEach = (fn) => current.before.push(fn);
  g.afterEach = (fn) => current.after.push(fn);
  g.it = (name, fn) => current.children.push({ name, fn, parent: current, skip: false });
  g.it.skip = (name) => current.children.push({ name, fn: null, parent: current, skip: true });

  const chain = (node) => {
    const out = [];
    for (let n = node.parent; n; n = n.parent) out.unshift(n);
    return out;
  };

  async function runAll() {
    const result = { passed: 0, failed: 0, skipped: 0, failures: [], log: [] };
    async function walk(suite, path) {
      for (const child of suite.children) {
        const full = [...path, child.name].filter(Boolean).join(' › ');
        if (child.children) {
          await walk(child, [...path, child.name]);
          continue;
        }
        if (child.skip) {
          result.skipped++;
          result.log.push('- ' + full);
          continue;
        }
        const suites = chain(child);
        try {
          for (const s of suites) for (const b of s.before) await b();
          await child.fn();
          result.passed++;
          result.log.push('✓ ' + full);
        } catch (e) {
          result.failed++;
          result.failures.push(full + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e));
          result.log.push('✗ ' + full);
        } finally {
          for (const s of [...suites].reverse()) {
            for (const a of s.after) {
              try {
                await a();
              } catch {
                /* ignora erros de limpeza */
              }
            }
          }
        }
      }
    }
    await walk(root, []);
    return result;
  }

  g.runAll = runAll;
})(globalThis);
