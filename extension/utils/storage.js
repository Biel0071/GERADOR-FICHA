(function () {
  if (globalThis.ProjetoFichaStorage) {
    return;
  }

  function hasChromeStorage() {
    return Boolean(globalThis.chrome && chrome.storage && chrome.storage.local);
  }

  function getLocalStorageValue(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    } catch (error) {
      console.debug("Projeto Ficha: erro lendo localStorage", error);
      return undefined;
    }
  }

  function setLocalStorageValue(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.debug("Projeto Ficha: erro salvando localStorage", error);
    }
  }

  async function get(key, fallbackValue) {
    if (!hasChromeStorage()) {
      const localValue = getLocalStorageValue(key);
      return localValue === undefined ? fallbackValue : localValue;
    }

    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (result) => {
          if (chrome.runtime.lastError) {
            console.debug("Projeto Ficha: erro lendo chrome.storage", chrome.runtime.lastError);
            resolve(fallbackValue);
            return;
          }
          resolve(result[key] === undefined ? fallbackValue : result[key]);
        });
      } catch (error) {
        console.debug("Projeto Ficha: contexto de storage indisponivel", error);
        resolve(fallbackValue);
      }
    });
  }

  async function set(key, value) {
    if (!hasChromeStorage()) {
      setLocalStorageValue(key, value);
      return;
    }

    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            console.debug("Projeto Ficha: erro salvando chrome.storage", chrome.runtime.lastError);
          }
          resolve();
        });
      } catch (error) {
        console.debug("Projeto Ficha: contexto de storage indisponivel", error);
        resolve();
      }
    });
  }

  async function append(key, item, maxItems) {
    const limit = maxItems || 20;
    const list = await get(key, []);
    const next = Array.isArray(list) ? list.slice(-limit + 1) : [];
    next.push(item);
    await set(key, next);
    return next;
  }

  globalThis.ProjetoFichaStorage = {
    append,
    get,
    set
  };
})();
