(function (H) {
  'use strict';

  const { HubError, LimitError, mergeLimits } = H.limits;
  const { mergeTables } = H.merge;

  const { NO_FIXES, NO_STRUCTURE, applyFixes, applyStructure, diagnose, findTotalRows } = H.pipeline;

  /** Opções de leitura por arquivo: linhas ocultas por filtro saem por padrão; linhas de total ficam, a menos que o usuário peça. */
  const DEFAULT_FILE_OPTIONS = Object.freeze({ ignoreHidden: true, ignoreTotals: false });

  /** Estado do Hub. Existe apenas em memória: nada é gravado em disco, cookie ou storage. */

  function initialState() {
    return {
      model: null,
      includeModelRows: false,
      files: [],
      mode: 'smart',
      overrides: new Map(),
      structure: { ...NO_STRUCTURE, deleted: [], added: [] },
      fixes: { ...NO_FIXES },
    };
  }

  function newId() {
    return globalThis.crypto.randomUUID();
  }

  function createStore(limitOverrides) {
    const limits = mergeLimits(limitOverrides);
    let state = initialState();
    let cache;
    const listeners = new Set();

    const totalRows = () =>
      state.files.reduce((n, f) => n + f.table.rows.length, 0) +
      (state.model && state.includeModelRows ? state.model.table.rows.length : 0);

    const emit = () => {
      cache = undefined;
      listeners.forEach((l) => l());
    };

    /** Arquivos com as opções aplicadas (linhas ocultas/total removidas), sem alterar a tabela original. */
    const effectiveFiles = () =>
      state.files.map((f) => {
        const skip = new Set();
        if (f.options.ignoreHidden) f.info.hidden.forEach((i) => skip.add(i));
        if (f.options.ignoreTotals) f.info.totals.forEach((i) => skip.add(i));
        if (skip.size === 0) return f;
        return { ...f, table: { ...f.table, rows: f.table.rows.filter((_, i) => !skip.has(i)) } };
      });

    const compute = () => {
      if (!state.model && state.files.length === 0) return null;
      const merge = mergeTables({
        model: state.model,
        includeModelRows: state.includeModelRows,
        files: effectiveFiles(),
        mode: state.mode,
        overrides: state.overrides,
      });
      const structured = applyStructure(
        { columns: merge.columns, rows: merge.rows, sourceColumn: merge.sourceColumn },
        state.structure,
      );
      const grid = applyFixes(structured, state.fixes);
      return { merge, grid, diagnostics: diagnose(grid) };
    };

    return {
      limits,
      getState: () => state,
      getComputed() {
        if (cache === undefined) cache = compute();
        return cache;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setModel(name, bytes, table) {
        state = { ...state, model: { id: newId(), name, bytes, table }, includeModelRows: table.rows.length > 0 };
        emit();
      },
      removeModel() {
        state = { ...state, model: null, includeModelRows: false };
        emit();
      },
      setIncludeModelRows(value) {
        state = { ...state, includeModelRows: value };
        emit();
      },
      addFile(name, bytes, table) {
        if (state.files.length >= limits.maxFiles) throw new LimitError(`Máximo de ${limits.maxFiles} arquivos na fila.`);
        if (totalRows() + table.rows.length > limits.maxTotalRows) {
          throw new LimitError(`O total de linhas excederia o limite de ${limits.maxTotalRows}.`);
        }
        const id = newId();
        const info = { hidden: new Set(table.hidden ?? []), totals: new Set(findTotalRows(table.rows)) };
        state = { ...state, files: [...state.files, { id, name, bytes, table, options: { ...DEFAULT_FILE_OPTIONS }, info }] };
        emit();
        return id;
      },
      setFileOption(id, key, value) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_FILE_OPTIONS, key) || typeof value !== 'boolean') throw new HubError('Opção inválida.');
        if (!state.files.some((f) => f.id === id)) throw new HubError('Arquivo desconhecido.');
        state = { ...state, files: state.files.map((f) => (f.id === id ? { ...f, options: { ...f.options, [key]: value } } : f)) };
        emit();
      },
      removeFile(id) {
        const overrides = new Map(state.overrides);
        overrides.delete(id);
        state = { ...state, files: state.files.filter((f) => f.id !== id), overrides };
        emit();
      },
      setMode(mode) {
        state = { ...state, mode };
        emit();
      },
      setOverride(fileId, sourceIndex, value) {
        if (!state.files.some((f) => f.id === fileId)) throw new HubError('Arquivo desconhecido.');
        const overrides = new Map(state.overrides);
        const forFile = new Map(overrides.get(fileId) ?? []);
        if (value === undefined) forFile.delete(sourceIndex);
        else forFile.set(sourceIndex, value);
        overrides.set(fileId, forFile);
        state = { ...state, overrides };
        emit();
      },
      setStructure(edit) {
        state = { ...state, structure: { order: edit.order ? [...edit.order] : null, deleted: [...edit.deleted], added: [...edit.added] } };
        emit();
      },
      setFixes(rules) {
        state = { ...state, fixes: { ...rules } };
        emit();
      },
      clearAll() {
        state = initialState();
        emit();
      },
    };
  }

  H.store = { createStore };
})((globalThis.Hub = globalThis.Hub || {}));
