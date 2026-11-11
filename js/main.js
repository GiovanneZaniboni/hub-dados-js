(function (H) {
  'use strict';

  const root = document.getElementById('app');
  if (!root) throw new Error('Elemento #app não encontrado.');
  H.mountHub(root);
})(globalThis.Hub);
