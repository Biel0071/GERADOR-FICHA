(function () {
  if (globalThis.ProjetoFichaLogger) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants;
  const Storage = globalThis.ProjetoFichaStorage;
  const Dom = globalThis.ProjetoFichaDom || {
    makeId: () => `log-${Date.now()}`,
    normalizeText: (value) => String(value || "").trim()
  };

  function debug(message, data) {
    if (!C || !C.DEBUG) {
      return;
    }
    if (data === undefined) {
      console.log(`${C.DEBUG_PREFIX} ${message}`);
      return;
    }
    console.log(`${C.DEBUG_PREFIX} ${message}`, data);
  }

  function trim(value, max) {
    const text = Dom.normalizeText(value);
    const limit = max || 1200;
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}... [truncated]`;
  }

  async function add(entry) {
    const next = {
      id: Dom.makeId ? Dom.makeId("log") : `log-${Date.now()}`,
      time: new Date().toISOString(),
      status: entry && entry.status ? entry.status : "info",
      client: entry && entry.client ? entry.client : "",
      message: entry && entry.message ? trim(entry.message, 900) : "",
      duration_ms: entry && Number.isFinite(entry.duration_ms) ? entry.duration_ms : null,
      error: entry && entry.error ? trim(entry.error, 900) : "",
      metadata: entry && entry.metadata ? entry.metadata : {}
    };

    debug(`log:${next.status} ${next.message}`, next);

    if (Storage && C && C.STORAGE_KEYS) {
      try {
        await Storage.append(C.STORAGE_KEYS.OPERATION_LOGS, next, 80);
      } catch (error) {
        debug("log nao persistido", error.message);
      }
    }
    return next;
  }

  async function getLogs(limit) {
    if (!Storage || !C || !C.STORAGE_KEYS) {
      return [];
    }
    const logs = await Storage.get(C.STORAGE_KEYS.OPERATION_LOGS, []);
    return Array.isArray(logs) ? logs.slice(-(limit || 30)).reverse() : [];
  }

  async function saveLastFicha(payload) {
    if (!Storage || !C || !C.STORAGE_KEYS) {
      return;
    }
    const ficha = {
      saved_at: new Date().toISOString(),
      answer: payload && payload.answer ? payload.answer : "",
      client: payload && payload.conversation ? payload.conversation.client_name : "",
      phone: payload && payload.conversation ? (payload.conversation.phone || "") : "",
      downloadUrl: payload && payload.downloadUrl ? payload.downloadUrl : "",
      downloadId: payload && payload.downloadId ? payload.downloadId : "",
      provider: payload && payload.provider ? payload.provider : "",
      metadata: payload && payload.metadata ? payload.metadata : {}
    };
    await Storage.set(C.STORAGE_KEYS.LAST_FICHA, ficha);
    await Storage.append(C.STORAGE_KEYS.FICHA_HISTORY, ficha, 30);
  }

  async function savePrompt(payload) {
    if (!Storage || !C || !C.STORAGE_KEYS) {
      return;
    }
    const promptEntry = {
      saved_at: new Date().toISOString(),
      prompt: payload && payload.prompt ? trim(payload.prompt, 8000) : "",
      client: payload && payload.conversation ? payload.conversation.client_name : "",
      metadata: payload && payload.metadata ? payload.metadata : {}
    };
    await Storage.set(C.STORAGE_KEYS.LAST_PROMPT, promptEntry.prompt);
    await Storage.append(C.STORAGE_KEYS.PROMPT_HISTORY, promptEntry, 20);
  }

  async function getLastFicha() {
    if (!Storage || !C || !C.STORAGE_KEYS) {
      return null;
    }
    return Storage.get(C.STORAGE_KEYS.LAST_FICHA, null);
  }

  globalThis.ProjetoFichaLogger = {
    add,
    debug,
    getLastFicha,
    getLogs,
    saveLastFicha,
    savePrompt
  };
})();
