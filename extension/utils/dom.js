(function () {
  if (globalThis.ProjetoFichaDom) {
    return;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }
    const style = globalThis.getComputedStyle ? getComputedStyle(element) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function bySelectors(root, selectors) {
    const searchRoot = root || document;
    for (const selector of selectors || []) {
      try {
        const found = searchRoot.querySelector(selector);
        if (found) {
          return found;
        }
      } catch (error) {
        console.debug("Projeto Ficha: seletor ignorado", selector, error);
      }
    }
    return null;
  }

  function allBySelectors(root, selectors) {
    const searchRoot = root || document;
    const found = [];
    const seen = new Set();
    for (const selector of selectors || []) {
      try {
        for (const node of searchRoot.querySelectorAll(selector)) {
          if (!seen.has(node)) {
            seen.add(node);
            found.push(node);
          }
        }
      } catch (error) {
        console.debug("Projeto Ficha: seletor ignorado", selector, error);
      }
    }
    return found;
  }

  async function waitFor(predicate, options) {
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 30000;
    const intervalMs = options && options.intervalMs ? options.intervalMs : 250;
    const start = Date.now();
    let lastError = null;

    while (Date.now() - start < timeoutMs) {
      try {
        const result = await predicate();
        if (result) {
          return result;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }

    const error = new Error(options && options.message ? options.message : "Tempo esgotado aguardando elemento");
    if (lastError) {
      error.cause = lastError;
    }
    throw error;
  }

  async function waitForDomStable(options) {
    const target = options && options.target ? options.target : document.body;
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 30000;
    const stableMs = options && options.stableMs ? options.stableMs : 1000;
    const start = Date.now();
    let lastMutationAt = Date.now();

    if (!target) {
      await sleep(stableMs);
      return true;
    }

    const observer = new MutationObserver(() => {
      lastMutationAt = Date.now();
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });

    try {
      while (Date.now() - start < timeoutMs) {
        if (Date.now() - lastMutationAt >= stableMs) {
          return true;
        }
        await sleep(250);
      }
      return false;
    } finally {
      observer.disconnect();
    }
  }

  function textMatches(element, patterns) {
    const text = normalizeText(element ? element.textContent : "");
    const label = normalizeText(element ? element.getAttribute("aria-label") : "");
    return (patterns || []).some((pattern) => pattern.test(text) || pattern.test(label));
  }

  function findByText(root, selector, patterns) {
    const searchRoot = root || document;
    const nodes = Array.from(searchRoot.querySelectorAll(selector));
    return nodes.find((node) => isVisible(node) && textMatches(node, patterns)) || null;
  }

  function clickElement(element) {
    if (!element) {
      return false;
    }
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    element.click();
    return true;
  }

  function setNativeValue(element, value) {
    if (!element) {
      return false;
    }

    element.focus();

    if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (element.isContentEditable || element.getAttribute("contenteditable") === "true") {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value
      }));
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value
      }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));
      return true;
    }

    return false;
  }

  function getText(element) {
    return normalizeText(element ? element.innerText || element.textContent || "" : "");
  }

  async function waitForStableText(getter, options) {
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 120000;
    const intervalMs = options && options.intervalMs ? options.intervalMs : 500;
    const stableMs = options && options.stableMs ? options.stableMs : 2500;
    const minLength = options && options.minLength ? options.minLength : 12;
    const start = Date.now();
    let lastValue = "";
    let stableSince = 0;

    while (Date.now() - start < timeoutMs) {
      const value = normalizeText(await getter());
      if (value && value === lastValue) {
        if (!stableSince) {
          stableSince = Date.now();
        }
        if (value.length >= minLength && Date.now() - stableSince >= stableMs) {
          return value;
        }
      } else {
        lastValue = value;
        stableSince = 0;
      }
      await sleep(intervalMs);
    }

    if (lastValue) {
      return lastValue;
    }
    throw new Error("Nao foi possivel capturar uma resposta estavel do ChatGPT.");
  }

  function makeId(prefix) {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix || "id"}-${Date.now()}-${random}`;
  }

  globalThis.ProjetoFichaDom = {
    allBySelectors,
    bySelectors,
    clickElement,
    findByText,
    getText,
    isVisible,
    makeId,
    normalizeText,
    setNativeValue,
    sleep,
    textMatches,
    waitFor,
    waitForDomStable,
    waitForStableText
  };
})();
