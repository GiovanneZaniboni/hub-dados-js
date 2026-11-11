(function (H) {
  'use strict';

  /**
   * Modelo de dados do Hub.
   *
   * Linhas são ARRAYS indexados por coluna (nunca objetos com chave = nome da coluna):
   * assim cabeçalhos como "__proto__" ou "constructor" não podem causar prototype pollution
   * e cabeçalhos duplicados não se sobrescrevem.
   */
  

  
  /** Valor de override que significa "não importar esta coluna". */
  const IGNORE = Symbol.for('hub-dados.ignore');

  
  const SOURCE_COLUMN = 'Arquivo_Origem';
  const MAX_COLLISION_SAMPLES = 50;

  H.types = { IGNORE, SOURCE_COLUMN, MAX_COLLISION_SAMPLES };
})((globalThis.Hub = globalThis.Hub || {}));
