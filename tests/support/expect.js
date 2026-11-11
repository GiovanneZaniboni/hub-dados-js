/**
 * Mini biblioteca de asserções (sem dependências), com a mesma sintaxe dos testes anteriores:
 * expect(x).toBe(y), .toEqual, .toThrow, .not.toBe..., await expect(promessa).rejects.toThrow(...)
 * Funciona no Node e no navegador (script clássico).
 */
(function (g) {
  'use strict';

  function show(v) {
    if (typeof v === 'symbol') return v.toString();
    if (typeof v === 'string') return JSON.stringify(v.length > 200 ? v.slice(0, 200) + '…' : v);
    if (v instanceof Map) return `Map(${JSON.stringify([...v])})`;
    if (v instanceof Set) return `Set(${JSON.stringify([...v])})`;
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try {
      const s = JSON.stringify(v, (_k, x) => (typeof x === 'symbol' ? x.toString() : x));
      return s === undefined ? String(v) : s.length > 300 ? s.slice(0, 300) + '…' : s;
    } catch {
      return String(v);
    }
  }

  const isObj = (v) => v !== null && typeof v === 'object';

  /** Igualdade profunda (valores `undefined` em objetos são tratados como ausentes). */
  function equal(a, b) {
    if (Object.is(a, b)) return true;
    if (!isObj(a) || !isObj(b)) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [k, v] of a) if (!b.has(k) || !equal(v, b.get(k))) return false;
      return true;
    }
    if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    }
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
  }

  function matchesSubset(actual, subset) {
    if (!isObj(subset) || !isObj(actual)) return equal(actual, subset);
    return Object.keys(subset).every((k) => matchesSubset(actual[k], subset[k]));
  }

  function errorMatches(err, expected) {
    if (expected === undefined) return true;
    if (typeof expected === 'string') return String(err && err.message).includes(expected);
    if (expected instanceof RegExp) return expected.test(String(err && err.message));
    if (typeof expected === 'function') return err instanceof expected;
    return false;
  }

  function makeMatchers(actual, negate, asRejection) {
    const check = (pass, message) => {
      if (negate ? pass : !pass) throw new Error((negate ? 'NÃO ' : '') + message);
    };
    const m = {
      toBe: (exp) => check(Object.is(actual, exp), `esperado ${show(exp)}, recebido ${show(actual)}`),
      toEqual: (exp) => check(equal(actual, exp), `esperado ${show(exp)}, recebido ${show(actual)}`),
      toStrictEqual: (exp) => check(equal(actual, exp), `esperado ${show(exp)}, recebido ${show(actual)}`),
      toMatchObject: (exp) => check(matchesSubset(actual, exp), `esperado conter ${show(exp)}, recebido ${show(actual)}`),
      toBeNull: () => check(actual === null, `esperado null, recebido ${show(actual)}`),
      toBeUndefined: () => check(actual === undefined, `esperado undefined, recebido ${show(actual)}`),
      toBeDefined: () => check(actual !== undefined, 'esperado valor definido'),
      toBeTruthy: () => check(!!actual, `esperado verdadeiro, recebido ${show(actual)}`),
      toBeFalsy: () => check(!actual, `esperado falso, recebido ${show(actual)}`),
      toBeGreaterThan: (n) => check(actual > n, `esperado ${show(actual)} > ${n}`),
      toBeGreaterThanOrEqual: (n) => check(actual >= n, `esperado ${show(actual)} >= ${n}`),
      toBeLessThan: (n) => check(actual < n, `esperado ${show(actual)} < ${n}`),
      toBeInstanceOf: (cls) => check(actual instanceof cls, `esperado instância de ${cls && cls.name}, recebido ${show(actual)}`),
      toHaveLength: (n) => check(actual != null && actual.length === n, `esperado tamanho ${n}, recebido ${actual == null ? show(actual) : actual.length}`),
      toContain: (item) => {
        const has = typeof actual === 'string' ? actual.includes(item) : Array.isArray(actual) ? actual.includes(item) : actual instanceof Set ? actual.has(item) : false;
        check(has, `esperado ${show(actual)} conter ${show(item)}`);
      },
      toMatch: (re) => check(typeof re === 'string' ? String(actual).includes(re) : re.test(String(actual)), `esperado ${show(actual)} casar com ${re}`),
      toHaveBeenCalledTimes: (n) => check(actual.calls.length === n, `esperado ${n} chamadas, recebido ${actual.calls.length}`),
      toThrow: (expected) => {
        let threw = false;
        let error;
        try {
          actual();
        } catch (e) {
          threw = true;
          error = e;
        }
        check(threw && errorMatches(error, expected), threw ? `erro inesperado: ${show(error)}` : 'esperado que lançasse erro');
      },
    };
    return m;
  }

  function expect(actual) {
    const api = makeMatchers(actual, false);
    api.not = makeMatchers(actual, true);
    // await expect(promessa).rejects.toThrow(...)
    api.rejects = {
      toThrow: async (expected) => {
        let threw = false;
        let error;
        try {
          await actual;
        } catch (e) {
          threw = true;
          error = e;
        }
        if (!threw) throw new Error('esperado que a promessa fosse rejeitada');
        if (!errorMatches(error, expected)) throw new Error(`erro inesperado: ${show(error)}`);
      },
    };
    return api;
  }

  /** Função "espiã": registra chamadas em `.calls`. */
  function mockFn() {
    const fn = (...args) => {
      fn.calls.push(args);
    };
    fn.calls = [];
    return fn;
  }

  g.expect = expect;
  g.mockFn = mockFn;
})(globalThis);
