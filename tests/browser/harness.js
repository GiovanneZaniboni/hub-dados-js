/** Roda todos os testes e mostra o resultado na página (e em window.__HUB_TESTS__ para o executor automático). */
(function () {
  'use strict';

  // Os testes de interface limpam o <body>; por isso o resultado é montado do zero ao final.
  function show(summary, color, text) {
    const status = document.createElement('p');
    status.textContent = (color === 'seagreen' ? '✓ ' : '✗ ') + summary;
    const pre = document.createElement('pre');
    pre.textContent = text;
    document.body.replaceChildren(status, pre);
  }

  runAll().then(
    (r) => {
      const text = [...r.failures.map((f) => 'FALHOU: ' + f), '', r.log.join('\n')].join('\n');
      show(`${r.passed} passaram, ${r.failed} falharam, ${r.skipped} pulados`, r.failed ? 'crimson' : 'seagreen', text);
      window.__HUB_TESTS__ = { passed: r.passed, failed: r.failed, skipped: r.skipped, failures: r.failures };
    },
    (e) => {
      show('Erro ao executar os testes: ' + e, 'crimson', String(e && e.stack));
      window.__HUB_TESTS__ = { passed: 0, failed: 1, skipped: 0, failures: [String(e)] };
    },
  );
})();
