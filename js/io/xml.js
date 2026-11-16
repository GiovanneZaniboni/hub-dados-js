/**
 * Leitor de XML mínimo e seguro, sem DOM. Existe porque a CSP do app exige Trusted Types, que impede o uso de
 * DOMParser com texto comum; além disso funciona no Node (testes) e elimina qualquer risco de XXE:
 * DOCTYPE, entidades personalizadas e instruções de processamento fora do cabeçalho são recusados.
 *
 * Resultado: um "documento" com `children`; cada nó tem `localName`, `children`, `textContent` (texto direto do
 * elemento), `getAttribute(nome)` e `getAttributeNS(_ns, nomeLocal)`.
 */
(function (H) {
  'use strict';

  const { HubError } = H.limits;

  const MAX_DEPTH = 256;
  const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
  const TAG = /<([^\s/>!?][^\s/>]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const BAD_AMP = /&(?!(?:#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);)/;
  const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  class XNode {
    constructor(qname) {
      this.qname = qname;
      const colon = qname.indexOf(':');
      this.localName = colon === -1 ? qname : qname.slice(colon + 1);
      this.attrs = null;
      this.children = [];
      this.textContent = '';
    }

    getAttribute(name) {
      return this.attrs && name in this.attrs ? this.attrs[name] : null;
    }

    /** Atributo pelo nome local, com qualquer prefixo (ex.: r:id). O namespace não é verificado. */
    getAttributeNS(_ns, local) {
      if (!this.attrs) return null;
      for (const key in this.attrs) {
        if (key === local || key.endsWith(':' + local)) return this.attrs[key];
      }
      return null;
    }
  }

  function decode(s, fail) {
    if (s.indexOf('&') === -1) return s;
    if (BAD_AMP.test(s)) fail(); // entidade desconhecida ou "&" solto
    return s.replace(ENTITY, (_m, body) => {
      switch (body) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        default: {
          const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail();
          return String.fromCodePoint(code);
        }
      }
    });
  }

  /** Converte texto XML em árvore. `fail()` deve lançar o erro apropriado. */
  function parseXmlText(text, fail) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const doc = new XNode('#document');
    const stack = [doc];
    const n = text.length;
    let i = 0;

    while (i < n) {
      const top = stack[stack.length - 1];
      const lt = text.indexOf('<', i);
      const chunkEnd = lt === -1 ? n : lt;
      if (chunkEnd > i) {
        const raw = text.slice(i, chunkEnd);
        if (top === doc) {
          if (raw.trim() !== '') fail(); // texto fora do elemento raiz
        } else {
          top.textContent += decode(raw, fail);
        }
      }
      if (lt === -1) break;
      i = lt;

      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end === -1) fail();
        i = end + 3;
      } else if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9);
        if (end === -1 || top === doc) fail();
        top.textContent += text.slice(i + 9, end);
        i = end + 3;
      } else if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i + 2);
        if (end === -1) fail();
        i = end + 2;
      } else if (text.startsWith('<!', i)) {
        fail(); // DOCTYPE / ENTITY / qualquer declaração
      } else if (text.startsWith('</', i)) {
        const end = text.indexOf('>', i + 2);
        if (end === -1) fail();
        const name = text.slice(i + 2, end).trim();
        if (stack.length < 2 || top.qname !== name) fail();
        stack.pop();
        i = end + 1;
      } else {
        TAG.lastIndex = i;
        const m = TAG.exec(text);
        if (!m) fail();
        if (stack.length > MAX_DEPTH) fail();
        const node = new XNode(m[1]);
        if (m[2]) {
          const attrs = Object.create(null);
          ATTR.lastIndex = 0;
          let a;
          while ((a = ATTR.exec(m[2]))) {
            if (a[1] in attrs) fail(); // atributo repetido
            attrs[a[1]] = decode(a[2] ?? a[3] ?? '', fail);
          }
          node.attrs = attrs;
        }
        if (top === doc && doc.children.length > 0) fail(); // só um elemento raiz
        top.children.push(node);
        if (m[3] !== '/') stack.push(node);
        i = TAG.lastIndex;
      }
    }

    if (stack.length !== 1 || doc.children.length !== 1) fail();
    return doc;
  }

  /** Bytes (UTF-8) -> documento. Recusa DTD/entidades (XXE, "billion laughs") antes de qualquer análise. */
  function parseXml(bytes, what) {
    const text = new TextDecoder('utf-8').decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new HubError(`Arquivo inválido (${what} contém DTD).`);
    return parseXmlText(text, () => {
      throw new HubError(`Arquivo inválido (${what}).`);
    });
  }

  /** Bytes (UTF-8) -> texto, recusando DTD/entidades. Arquivos gigantes demais viram LimitError, não travamento. */
  function decodeXml(bytes, what) {
    let text;
    try {
      text = new TextDecoder('utf-8').decode(bytes);
    } catch {
      throw new H.limits.LimitError('O arquivo é grande demais para ser lido na memória do navegador.');
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new HubError(`Arquivo inválido (${what} contém DTD).`);
    return text;
  }

  const TAG_END = /[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/y;

  /**
   * Percorre, em ordem, os elementos com o nome local informado (não aninhados), analisando um de cada vez.
   * Assim uma planilha com milhões de células nunca vira uma árvore gigante na memória.
   */
  function forEachElement(text, name, fn, what) {
    const re = new RegExp('<([A-Za-z_][\\w.-]*:)?' + name + '(?=[\\s>/])', 'g');
    let m;
    while ((m = re.exec(text))) {
      const start = m.index;
      TAG_END.lastIndex = start + m[0].length;
      const open = TAG_END.exec(text);
      if (!open) throw new HubError(`Arquivo inválido (${what}).`);
      const openEnd = TAG_END.lastIndex;
      let stop = openEnd;
      if (text.charCodeAt(openEnd - 2) !== 47 /* "/" */) {
        const close = `</${m[1] ?? ''}${name}>`;
        const at = text.indexOf(close, openEnd);
        if (at === -1) throw new HubError(`Arquivo inválido (${what}).`);
        stop = at + close.length;
      }
      const doc = parseXmlText(text.slice(start, stop), () => {
        throw new HubError(`Arquivo inválido (${what}).`);
      });
      fn(doc.children[0]);
      re.lastIndex = stop;
    }
  }

  const BLOCK_BYTES = 32 * 1024 * 1024;

  /** Última posição de `needle` em bytes[from, to), ou -1. */
  function lastIndexOfBytes(bytes, needle, from, to) {
    for (let i = to - needle.length; i >= from; i--) {
      if (bytes[i] !== needle[0]) continue;
      let ok = true;
      for (let k = 1; k < needle.length; k++) {
        if (bytes[i + k] !== needle[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  }

  /**
   * Como forEachElement, mas direto sobre os bytes: decodifica em blocos de ~32 MB cortados logo após um fechamento
   * </nome>, para nunca criar uma string gigante (o navegador não aceita textos acima de ~512 MB).
   */
  function forEachElementInBytes(bytes, name, fn, what) {
    const close = new TextEncoder().encode(`</${name}>`);
    const decoder = new TextDecoder('utf-8');
    let pos = 0;
    while (pos < bytes.length) {
      let end = Math.min(pos + BLOCK_BYTES, bytes.length);
      if (end < bytes.length) {
        let scanFrom = pos;
        let cut = -1;
        // Se o bloco não tem nenhum fechamento, amplia até achar (ou até o fim do arquivo).
        while (cut === -1 && end < bytes.length) {
          cut = lastIndexOfBytes(bytes, close, scanFrom, end);
          if (cut === -1) {
            scanFrom = end;
            end = Math.min(end + BLOCK_BYTES, bytes.length);
          }
        }
        end = cut === -1 ? bytes.length : cut + close.length;
      }
      let text;
      try {
        text = decoder.decode(bytes.subarray(pos, end));
      } catch {
        throw new H.limits.LimitError('O arquivo é grande demais para ser lido na memória do navegador.');
      }
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new HubError(`Arquivo inválido (${what} contém DTD).`);
      forEachElement(text, name, fn, what);
      pos = end;
    }
  }

  /** Todos os descendentes com o nome local informado, na ordem do documento. */
  function byTag(root, name) {
    const out = [];
    const stack = [];
    for (let k = root.children.length - 1; k >= 0; k--) stack.push(root.children[k]);
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.localName === name) out.push(node);
      for (let k = node.children.length - 1; k >= 0; k--) stack.push(node.children[k]);
    }
    return out;
  }

  H.xml = { parseXml, parseXmlText, byTag, decodeXml, forEachElement, forEachElementInBytes };
})((globalThis.Hub = globalThis.Hub || {}));
