(function () {
  if (globalThis.ProjetoFichaSettings) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants;
  const Storage = globalThis.ProjetoFichaStorage;

  function defaults() {
    const material = (C && C.MATERIAL_API_DEFAULTS) || {};
    return {
      provider: (C && C.DEFAULT_PROVIDER) || "material_api",
      materialApi: {
        endpoint: material.endpoint || (C && C.MATERIAL_API_PROXY_URL) || "http://127.0.0.1:8000/generate-order",
        storeId: material.storeId || "",
        timeoutMs: material.timeoutMs || 120000
      }
    };
  }

  function merge(stored) {
    const base = defaults();
    if (!stored || typeof stored !== "object") {
      return base;
    }
    const legacy = stored.lovable && typeof stored.lovable === "object" ? stored.lovable : {};
    const material = stored.materialApi && typeof stored.materialApi === "object"
      ? stored.materialApi
      : legacy;
    const requestedProvider = stored.provider === "chatgpt"
      ? "chatgpt"
      : stored.provider === "lovable" || stored.provider === "material_api"
        ? "material_api"
        : base.provider;
    return {
      provider: requestedProvider,
      materialApi: {
        endpoint: typeof material.endpoint === "string" && material.endpoint.trim()
          ? material.endpoint.trim()
          : base.materialApi.endpoint,
        storeId: typeof material.storeId === "string" ? material.storeId.trim() : base.materialApi.storeId,
        timeoutMs: Number.isFinite(material.timeoutMs) && material.timeoutMs > 0
          ? material.timeoutMs
          : base.materialApi.timeoutMs
      }
    };
  }

  async function get() {
    if (!Storage) {
      return defaults();
    }
    const stored = await Storage.get(C.STORAGE_KEYS.SETTINGS, null);
    const next = merge(stored);
    const hadLegacyToken = Boolean(
      stored &&
      ((stored.lovable && stored.lovable.apiKey) ||
       (stored.materialApi && stored.materialApi.apiKey))
    );
    if (hadLegacyToken) {
      await Storage.set(C.STORAGE_KEYS.SETTINGS, next);
    }
    return next;
  }

  async function set(patch) {
    const current = await get();
    const next = merge({
      provider: patch && patch.provider !== undefined ? patch.provider : current.provider,
      materialApi: {
        ...current.materialApi,
        ...(patch && patch.materialApi ? patch.materialApi : {}),
        ...(patch && patch.lovable ? patch.lovable : {})
      }
    });
    if (Storage) {
      await Storage.set(C.STORAGE_KEYS.SETTINGS, next);
    }
    return next;
  }

  function materialApiReady(settings) {
    return Boolean(
      settings &&
      settings.provider === "material_api" &&
      settings.materialApi &&
      settings.materialApi.endpoint
    );
  }

  globalThis.ProjetoFichaSettings = {
    defaults,
    get,
    materialApiReady,
    merge,
    set
  };
})();