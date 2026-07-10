(function () {
  if (globalThis.ProjetoFichaChatGPTAutomationEngine) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants;
  const Dom = globalThis.ProjetoFichaDom;
  const Logger = globalThis.ProjetoFichaLogger;
  const Storage = globalThis.ProjetoFichaStorage;
  const JOB_STATUS = C.JOB_STATUS;

  function automationLog(message, data) {
    Logger.debug(`chatgpt:${message}`, data);
    Logger.add({
      status: "chatgpt",
      message,
      metadata: data || {}
    }).catch((error) => Logger.debug("chatgpt:log-storage-failed", error.message));
  }

  function emitStatus(jobId, status, detail, extra) {
    automationLog(`status:${status}`, { jobId, detail, ...(extra || {}) });
    try {
      chrome.runtime.sendMessage({
        type: C.MESSAGE_TYPES.CHATGPT_AUTOMATION_STATUS,
        jobId,
        status,
        detail: detail || "",
        extra: extra || {}
      });
    } catch (error) {
      automationLog("status:send-failed", { jobId, status, error: error.message });
    }
  }

  function pageText() {
    return Dom.normalizeText(document.body ? document.body.innerText || document.body.textContent : "");
  }

  function dumpDomPartial(label, options) {
    const force = Boolean(options && options.force);
    if (!force && !C.DEBUG_CHATGPT_AUTOMATION) {
      return null;
    }
    const textLimit = options && options.textLimit ? options.textLimit : 3000;
    const htmlLimit = options && options.htmlLimit ? options.htmlLimit : 0;
    const dump = {
      label,
      url: location.href,
      title: document.title,
      text: pageText().slice(0, textLimit),
      bodyText: Dom.normalizeText(document.body ? document.body.innerText || document.body.textContent || "" : "").slice(0, textLimit),
      html: htmlLimit ? String(document.documentElement ? document.documentElement.outerHTML || "" : "").slice(0, htmlLimit) : "",
      controls: Array.from(document.querySelectorAll("button,a,[role='button'],textarea,[contenteditable='true']"))
        .slice(0, 80)
        .map((node) => ({
          tag: node.tagName,
          text: Dom.normalizeText(node.textContent).slice(0, 90),
          aria: Dom.normalizeText(node.getAttribute("aria-label")).slice(0, 90),
          testid: node.getAttribute("data-testid") || "",
          role: node.getAttribute("role") || "",
          visible: Dom.isVisible(node)
        }))
    };
    automationLog(`dump-dom:${label}`, dump);
    if (Storage && C.STORAGE_KEYS) {
      Storage.append(C.STORAGE_KEYS.DIAGNOSTICS, {
        type: "chatgpt_dom_snapshot",
        time: new Date().toISOString(),
        dump
      }, 20).catch((error) => automationLog("dump-dom:storage-failed", { error: error.message }));
    }
    return dump;
  }

  function looksLoggedOut() {
    const text = pageText();
    return /(?:log in|sign up|entrar|fazer login|criar conta|continue with google|continuar com google)/i.test(text) &&
      !Dom.bySelectors(document, C.SELECTORS.chatgptComposer);
  }

  function isProjectUrl() {
    const href = location.href;
    // Matches the project page itself AND any conversation created inside the project
    if (href.includes(C.CHATGPT_PROJECT_ID)) return true;
    if (C.CHATGPT_CONVERSATION_ID && href.includes(C.CHATGPT_CONVERSATION_ID)) return true;
    if (href.startsWith(C.CHATGPT_PROJECT_URL)) return true;
    return false;
  }

  function isSearchLike(node) {
    const text = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""} ${node.closest("[role='search']") ? "search" : ""}`;
    return /search|buscar|pesquisar/i.test(text);
  }

  function isUsableComposer(node) {
    if (!node || !(node instanceof HTMLElement) || !Dom.isVisible(node) || isSearchLike(node)) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 20) {
      return false;
    }
    if (node.disabled || node.getAttribute("aria-disabled") === "true") {
      return false;
    }
    return true;
  }

  function scoreComposer(node) {
    if (!isUsableComposer(node)) {
      return -100;
    }
    let score = 0;
    if (node.closest("form")) score += 10;
    if (node.matches("textarea")) score += 9;
    if (node.matches(".ProseMirror,[data-lexical-editor='true'],[contenteditable='true']")) score += 8;
    if (node.id === "prompt-textarea") score += 8;
    if (node.getAttribute("data-testid")) score += 4;
    const rect = node.getBoundingClientRect();
    if (rect.bottom > window.innerHeight * 0.45) score += 4;
    return score;
  }

  function getComposerCandidates() {
    return Dom.allBySelectors(document, C.SELECTORS.chatgptComposer)
      .filter((node) => node instanceof HTMLElement)
      .map((node) => ({ node, score: scoreComposer(node) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);
  }

  function getComposer() {
    const candidates = getComposerCandidates();
    return candidates[0] ? candidates[0].node : null;
  }

  function findActionByText(patterns) {
    return Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter((node) => Dom.isVisible(node))
      .find((node) => {
        const text = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`;
        return patterns.some((pattern) => pattern.test(text));
      }) || null;
  }

  function elementText(node) {
    if (!node) {
      return "";
    }
    return Dom.normalizeText(`${node.textContent || ""} ${node.getAttribute ? node.getAttribute("aria-label") || "" : ""} ${node.getAttribute ? node.getAttribute("title") || "" : ""}`);
  }

  function isElementClickable(node) {
    if (!node || !(node instanceof HTMLElement) || !Dom.isVisible(node)) {
      return false;
    }
    const style = getComputedStyle(node);
    const tag = node.tagName ? node.tagName.toLowerCase() : "";
    return !node.disabled &&
      node.getAttribute("aria-disabled") !== "true" &&
      style.pointerEvents !== "none" &&
      (
        tag === "button" ||
        tag === "a" ||
        node.getAttribute("role") === "button" ||
        node.hasAttribute("onclick") ||
        node.hasAttribute("tabindex") ||
        style.cursor === "pointer"
      );
  }

  function closestClickable(node) {
    let current = node instanceof HTMLElement ? node : null;
    let depth = 0;
    while (current && depth < 6) {
      if (isElementClickable(current)) {
        return current;
      }
      current = current.parentElement;
      depth += 1;
    }
    return node instanceof HTMLElement && Dom.isVisible(node) ? node : null;
  }

  function describeElement(node) {
    if (!node) {
      return null;
    }
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : {};
    return {
      tag: node.tagName || "",
      id: node.id || "",
      role: node.getAttribute ? node.getAttribute("role") || "" : "",
      aria: node.getAttribute ? node.getAttribute("aria-label") || "" : "",
      title: node.getAttribute ? node.getAttribute("title") || "" : "",
      testid: node.getAttribute ? node.getAttribute("data-testid") || "" : "",
      contenteditable: node.getAttribute ? node.getAttribute("contenteditable") || "" : "",
      text: elementText(node).slice(0, 220),
      visible: Dom.isVisible(node),
      clickable: isElementClickable(node),
      position: {
        x: Math.round(rect.x || 0),
        y: Math.round(rect.y || 0),
        top: Math.round(rect.top || 0),
        left: Math.round(rect.left || 0),
        right: Math.round(rect.right || 0),
        bottom: Math.round(rect.bottom || 0),
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0)
      }
    };
  }

  function createChatScan() {
    const exactPattern = /novo chat em ficha/i;
    const loosePattern = /(?:novo chat|nova conversa|new chat|new conversation|start a new chat|iniciar conversa)/i;
    const emptyPattern = /ainda sem chats/i;
    const text = pageText();
    const searchableSelectors = "button, div[role='button'], span, a, [role='button'], [onclick], [tabindex], [aria-label]";
    const seen = new Set();
    let nodes = Array.from(document.querySelectorAll(searchableSelectors));

    if (!nodes.some((node) => exactPattern.test(elementText(node)))) {
      nodes = nodes.concat(Array.from(document.body ? document.body.querySelectorAll("*") : []).slice(0, 3500));
    }

    const candidates = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || seen.has(node)) {
        continue;
      }
      seen.add(node);
      const label = elementText(node);
      if (!exactPattern.test(label) && !loosePattern.test(label) && !emptyPattern.test(label)) {
        continue;
      }
      const clickTarget = closestClickable(node);
      candidates.push({
        matchedText: label.slice(0, 220),
        exact: exactPattern.test(label),
        loose: loosePattern.test(label),
        emptyStateText: emptyPattern.test(label),
        node: describeElement(node),
        clickTarget: describeElement(clickTarget),
        rawNode: node,
        rawClickTarget: clickTarget
      });
    }

    const exactClickable = candidates.find((item) => item.exact && item.clickTarget && item.clickTarget.visible && item.clickTarget.clickable);
    const looseClickable = candidates.find((item) => item.loose && !item.emptyStateText && item.clickTarget && item.clickTarget.visible && item.clickTarget.clickable);
    const best = exactClickable || looseClickable || null;

    return {
      url: location.href,
      title: document.title,
      bodyHasStillNoChats: emptyPattern.test(text),
      bodyHasNewChatInFicha: exactPattern.test(text),
      bodyTextLength: text.length,
      candidateCount: candidates.length,
      candidates,
      best,
      bestElement: best ? best.rawClickTarget || best.rawNode : null
    };
  }

  function sanitizeCreateChatScan(scan) {
    return {
      url: scan.url,
      title: scan.title,
      bodyHasStillNoChats: scan.bodyHasStillNoChats,
      bodyHasNewChatInFicha: scan.bodyHasNewChatInFicha,
      bodyTextLength: scan.bodyTextLength,
      candidateCount: scan.candidateCount,
      best: scan.best ? {
        matchedText: scan.best.matchedText,
        exact: scan.best.exact,
        loose: scan.best.loose,
        emptyStateText: scan.best.emptyStateText,
        node: scan.best.node,
        clickTarget: scan.best.clickTarget
      } : null,
      candidates: scan.candidates.slice(0, 25).map((item) => ({
        matchedText: item.matchedText,
        exact: item.exact,
        loose: item.loose,
        emptyStateText: item.emptyStateText,
        node: item.node,
        clickTarget: item.clickTarget
      }))
    };
  }

  function createChatError(message, diagnostics) {
    const error = new Error(message);
    error.createChatDiagnostics = diagnostics;
    return error;
  }

  function logDiagnosticStep(jobId, code, diagnostics, extra) {
    const payload = {
      code,
      ...(diagnostics || {}),
      ...(extra || {})
    };
    automationLog(code, payload);
    emitStatus(jobId, JOB_STATUS.CREATING_CHAT, code, payload);
  }

  async function diagnoseCreateChat(jobId, options) {
    const requireComposer = Boolean(options && options.requireComposer);
    const beforeUrl = location.href;
    const diagnostics = {
      beforeUrl,
      afterUrl: "",
      urlChanged: false,
      composerAppeared: false,
      composer: null,
      clickExecuted: false,
      focused: false,
      scrolled: false
    };

    let composer = null;
    try {
      composer = await Dom.waitFor(() => getComposer(), {
        timeoutMs: 12000,
        intervalMs: 350,
        message: "Composer ainda nao apareceu na primeira busca."
      });
    } catch (error) {
      diagnostics.composerFirstError = error.message;
    }

    if (composer) {
      diagnostics.composerAppeared = true;
      diagnostics.composer = describeElement(composer);
      diagnostics.afterUrl = location.href;
      diagnostics.urlChanged = diagnostics.afterUrl !== beforeUrl;
      try {
        composer.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
        composer.focus();
        if (typeof composer.click === "function") {
          composer.click();
        }
        diagnostics.focused = document.activeElement === composer || composer.contains(document.activeElement);
        diagnostics.scrolled = true;
      } catch (error) {
        diagnostics.focusError = error.message;
      }
      logDiagnosticStep(jobId, "COMPOSER_FOUND", diagnostics, {
        composerFirst: true
      });
      return {
        composer,
        diagnostics
      };
    }

    const scan = createChatScan();
    diagnostics.scan = sanitizeCreateChatScan(scan);
    emitStatus(jobId, JOB_STATUS.CREATING_CHAT, "CREATE_CHAT: composer nao encontrado; procurando Novo chat em FICHA apenas como fallback", {
      createChat: diagnostics
    });
    automationLog("create-chat:scan", diagnostics.scan);

    if (!scan.bestElement) {
      diagnostics.failure = "Composer valido nao encontrado apos carregar o Projeto FICHA.";
      diagnostics.dump = requireComposer ? dumpDomPartial("create-chat-no-composer-no-fallback", {
        force: true,
        textLimit: 60000,
        htmlLimit: 120000
      }) : null;
      emitStatus(jobId, JOB_STATUS.CREATING_CHAT, diagnostics.failure, {
        createChat: diagnostics
      });
      if (requireComposer) {
        throw createChatError(diagnostics.failure, diagnostics);
      }
      return {
        composer: null,
        diagnostics
      };
    }

    const target = scan.bestElement;
    target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    diagnostics.scrolled = true;
    await Dom.sleep(250);
    if (typeof target.focus === "function") {
      target.focus();
      diagnostics.focused = document.activeElement === target || target.contains(document.activeElement);
    }
    await Dom.sleep(150);
    diagnostics.clickedElement = describeElement(target);
    diagnostics.clickExecuted = Dom.clickElement(target);
    emitStatus(jobId, JOB_STATUS.CREATING_CHAT, "CREATE_CHAT: scroll, focus e click executados", {
      createChat: diagnostics
    });

    const start = Date.now();
    while (Date.now() - start < 20000) {
      diagnostics.afterUrl = location.href;
      diagnostics.urlChanged = diagnostics.afterUrl !== beforeUrl;
      composer = getComposer();
      if (composer) {
        diagnostics.composerAppeared = true;
        diagnostics.composer = describeElement(composer);
        emitStatus(jobId, JOB_STATUS.CREATING_CHAT, "CREATE_CHAT: composer surgiu apos clique", {
          createChat: diagnostics
        });
        return {
          composer,
          diagnostics
        };
      }
      await Dom.sleep(500);
    }

    diagnostics.afterUrl = location.href;
    diagnostics.urlChanged = diagnostics.afterUrl !== beforeUrl;
    diagnostics.postClickScan = sanitizeCreateChatScan(createChatScan());
    diagnostics.dump = dumpDomPartial("create-chat-no-composer-after-click", {
      force: true,
      textLimit: 60000,
      htmlLimit: 120000
    });
    emitStatus(jobId, JOB_STATUS.CREATING_CHAT, "CREATE_CHAT: clique executado, mas composer nao apareceu", {
      createChat: diagnostics
    });

    if (requireComposer) {
      throw createChatError("CREATE_CHAT falhou: composer valido nao apareceu apos fallback.", diagnostics);
    }

    return {
      composer: null,
      diagnostics
    };
  }

  async function withStepWatchdog(jobId, status, detail, fn, options) {
    const attempts = options && options.attempts ? options.attempts : C.STEP_RETRY_ATTEMPTS;
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : C.STEP_WATCHDOG_MS;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      emitStatus(jobId, status, `${detail} (tentativa ${attempt}/${attempts})`, { attempt });
      const start = Date.now();
      try {
        return await Promise.race([
          fn(attempt),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Watchdog: etapa ${status} excedeu ${timeoutMs}ms.`)), timeoutMs))
        ]);
      } catch (error) {
        lastError = error;
        automationLog("step:retry", {
          jobId,
          status,
          attempt,
          duration_ms: Date.now() - start,
          error: error.message
        });
        if (attempt < attempts) {
          await Dom.sleep(900 * attempt);
        }
      }
    }

    throw lastError || new Error(`Etapa ${status} falhou.`);
  }

  async function waitForProjectReady(jobId) {
    return withStepWatchdog(jobId, JOB_STATUS.OPENING_PROJECT, "Aguardando Projeto FICHA carregar", async () => {
      automationLog("waitForProjectReady:start", { url: location.href });

      if (!isProjectUrl()) {
        location.assign(C.CHATGPT_PROJECT_URL);
      }

      await Dom.waitFor(() => document.body && document.body.children.length > 0, {
        timeoutMs: C.PROJECT_READY_TIMEOUT_MS,
        intervalMs: 500,
        message: "ChatGPT nao carregou o corpo da pagina."
      });

      await Dom.sleep(C.PROJECT_HYDRATION_DELAY_MS);

      if (looksLoggedOut()) {
        dumpDomPartial("logged-out");
        throw new Error("O ChatGPT parece nao estar logado nesse perfil do Chrome.");
      }

      await Dom.waitFor(() => {
        if (looksLoggedOut()) {
          throw new Error("O ChatGPT parece nao estar logado nesse perfil do Chrome.");
        }
        return isProjectUrl() && (
          getComposer() ||
          findActionByText([/ainda sem chats/i, /nova conversa/i, /novo chat/i, /new chat/i, /novo chat em ficha/i, /start/i, /iniciar/i]) ||
          /project|projeto|ficha/i.test(pageText())
        );
      }, {
        timeoutMs: C.PROJECT_READY_TIMEOUT_MS,
        intervalMs: 900,
        message: "Projeto FICHA nao ficou pronto para automacao."
      });

      await Dom.waitForDomStable({
        timeoutMs: 20000,
        stableMs: C.DOM_STABLE_FOR_MS
      });

      automationLog("waitForProjectReady:ready", {
        url: location.href,
        hasComposer: Boolean(getComposer())
      });
      return true;
    }, { attempts: 2, timeoutMs: C.PROJECT_READY_TIMEOUT_MS });
  }

  function findNewConversationButton() {
    return createChatScan().bestElement;
  }

  async function ensureProjectConversation(jobId) {
    return withStepWatchdog(jobId, JOB_STATUS.CREATING_CHAT, "Garantindo nova conversa no Projeto FICHA", async () => {
      await waitForProjectReady(jobId);
      await diagnoseCreateChat(jobId, { requireComposer: false });

      if (!isProjectUrl()) {
        dumpDomPartial("unexpected-url-after-new-chat");
        throw new Error("O ChatGPT saiu do Projeto FICHA antes do envio.");
      }

      return true;
    }, { attempts: 2, timeoutMs: C.STEP_WATCHDOG_MS });
  }

  async function waitForComposer(jobId) {
    return withStepWatchdog(jobId, JOB_STATUS.WAITING_COMPOSER, "Aguardando composer do ChatGPT", async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= C.COMPOSER_RETRY_ATTEMPTS; attempt += 1) {
        try {
          const composer = await Dom.waitFor(() => getComposer(), {
            timeoutMs: Math.max(2500, C.COMPOSER_RETRY_DELAY_MS),
            intervalMs: 350,
            message: "Composer nao encontrado nesta tentativa."
          });
          automationLog("composer:found", {
            attempt,
            tag: composer.tagName,
            id: composer.id,
            role: composer.getAttribute("role") || "",
            contenteditable: composer.getAttribute("contenteditable") || "",
            candidates: getComposerCandidates().length
          });
          return composer;
        } catch (error) {
          lastError = error;
          automationLog("composer:retry", { attempt, error: error.message });
          await Dom.sleep(C.COMPOSER_RETRY_DELAY_MS);
        }
      }
      dumpDomPartial("composer-not-found");
      throw new Error(`Nao encontrei o campo de mensagem do ChatGPT apos retries. ${lastError ? lastError.message : ""}`.trim());
    }, { attempts: 2, timeoutMs: C.STEP_WATCHDOG_MS });
  }

  function readComposerText(composer) {
    return Dom.normalizeText(composer.value || composer.innerText || composer.textContent || "");
  }

  function dispatchTextEvents(element, value) {
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
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  }

  function execInsertText(element, value) {
    element.focus();
    element.click();
    const selection = window.getSelection();
    if (selection && element.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return document.execCommand && document.execCommand("insertText", false, value);
  }

  async function pasteFallback(element, value) {
    element.focus();
    element.click();
    try {
      await navigator.clipboard.writeText(value);
      document.execCommand("paste");
    } catch (error) {
      automationLog("composer:paste-fallback-failed", { error: error.message });
    }
  }

  async function fillComposerSafely(composer, prompt) {
    composer.focus();
    composer.click();
    Dom.setNativeValue(composer, prompt);
    dispatchTextEvents(composer, prompt);
    await Dom.sleep(300);

    let currentText = readComposerText(composer);
    if (currentText.length >= Math.min(40, prompt.length)) {
      return true;
    }

    automationLog("composer:native-value-incomplete-using-execCommand", { currentLength: currentText.length });
    execInsertText(composer, prompt);
    dispatchTextEvents(composer, prompt);
    await Dom.sleep(300);
    currentText = readComposerText(composer);
    if (currentText.length >= Math.min(40, prompt.length)) {
      return true;
    }

    await pasteFallback(composer, prompt);
    dispatchTextEvents(composer, prompt);
    await Dom.sleep(300);
    currentText = readComposerText(composer);
    return currentText.length >= Math.min(40, prompt.length);
  }

  function isStopButton(button) {
    const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`;
    return /stop|parar|interromper/i.test(label);
  }

  function getSendButton(composer) {
    const direct = Dom.allBySelectors(document, C.SELECTORS.chatgptSendButton)
      .filter((button) => button instanceof HTMLElement)
      .filter((button) => Dom.isVisible(button) && !isStopButton(button))
      .find((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
    if (direct) {
      return direct;
    }

    const form = composer && composer.closest("form");
    if (form) {
      const formButtons = Array.from(form.querySelectorAll("button"))
        .filter((button) => Dom.isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true" && !isStopButton(button));
      if (formButtons.length) {
        return formButtons[formButtons.length - 1];
      }
    }

    const iconButton = Array.from(document.querySelectorAll("button"))
      .filter((button) => Dom.isVisible(button) && !button.disabled && !isStopButton(button))
      .find((button) => button.querySelector("svg") && /send|arrow|paper/i.test(`${button.innerHTML} ${button.getAttribute("aria-label") || ""}`));
    if (iconButton) {
      return iconButton;
    }

    return Array.from(document.querySelectorAll("button"))
      .filter((button) => Dom.isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true" && !isStopButton(button))
      .find((button) => /send|enviar|submit/i.test(`${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`)) || null;
  }

  async function resolveVisualContext(payload) {
    if (payload && payload.visualContext) {
      return payload.visualContext;
    }
    if (!payload || !payload.visualContextKey || !Storage) {
      return null;
    }
    const visualContext = await Storage.get(payload.visualContextKey, null);
    if (!visualContext) {
      automationLog("visual:context-not-found-skipping", { visualContextKey: payload.visualContextKey });
      return null;
    }
    return visualContext;
  }

  function dataUrlToFile(dataUrl, name) {
    const parts = String(dataUrl || "").split(",");
    if (parts.length < 2) {
      throw new Error("dataUrl visual invalido.");
    }
    const mimeMatch = parts[0].match(/^data:([^;]+);base64$/i);
    const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const binary = atob(parts[1]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], name, { type: mime });
  }

  function visualFilesFromContext(visualContext) {
    const files = [];
    (visualContext.screenshots || []).slice(0, C.VISUAL_MAX_SCREENSHOTS || 10).forEach((shot, index) => {
      if (shot.dataUrl) {
        files.push(dataUrlToFile(shot.dataUrl, `projeto-ficha-screenshot-${index + 1}.jpg`));
      }
    });
    (visualContext.images || []).slice(0, C.VISUAL_MAX_CHAT_IMAGES || 8).forEach((image, index) => {
      if (image.dataUrl) {
        files.push(dataUrlToFile(image.dataUrl, `projeto-ficha-chat-image-${index + 1}.jpg`));
      }
    });
    return files;
  }

  function getFileInput() {
    return Array.from(document.querySelectorAll("input[type='file']"))
      .find((input) => {
        if (!(input instanceof HTMLInputElement) || input.disabled) {
          return false;
        }
        const accept = `${input.accept || ""}`.toLowerCase();
        return !accept || /image|png|jpeg|jpg|webp|\*/.test(accept);
      }) || null;
  }

  function findAttachmentButton() {
    return Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter((node) => node instanceof HTMLElement && Dom.isVisible(node))
      .filter((node) => !node.disabled && node.getAttribute("aria-disabled") !== "true")
      .find((node) => {
        const label = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`.toLowerCase();
        return /attach|anexar|arquivo|file|upload|imagem|image|adicionar|paperclip|clip/i.test(label);
      }) || null;
  }

  async function ensureFileInput() {
    let input = getFileInput();
    if (input) {
      return input;
    }
    const button = findAttachmentButton();
    if (button) {
      Dom.clickElement(button);
      await Dom.sleep(400);
    }
    input = await Dom.waitFor(() => getFileInput(), {
      timeoutMs: 8000,
      intervalMs: 350,
      message: "Input de arquivo do ChatGPT nao apareceu para anexar contexto visual."
    });
    return input;
  }

  async function attachVisualContextImages(jobId, payload) {
    const visualContext = await resolveVisualContext(payload);
    if (!visualContext) {
      return {
        ok: true,
        skipped: true,
        count: 0
      };
    }

    const files = visualFilesFromContext(visualContext);
    if (!files.length) {
      throw new Error("Contexto visual existe, mas nao contem imagens anexaveis.");
    }

    emitStatus(jobId, JOB_STATUS.SENDING_PROMPT, "Anexando screenshots e imagens do WhatsApp ao Projeto FICHA", {
      visual_files: files.length
    });
    automationLog("visual:attachments-start", {
      jobId,
      files: files.map((file) => ({ name: file.name, size: file.size, type: file.type }))
    });

    const input = await ensureFileInput();
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Dom.sleep(600);
    await Dom.waitForDomStable({
      timeoutMs: 12000,
      stableMs: 600
    });

    const result = {
      ok: input.files && input.files.length === files.length,
      count: files.length,
      inputFiles: input.files ? input.files.length : 0
    };
    automationLog(result.ok ? "VISUAL_ATTACHMENTS_ATTACHED" : "VISUAL_ATTACHMENTS_FAILED", result);
    emitStatus(jobId, JOB_STATUS.SENDING_PROMPT, result.ok ? "VISUAL_ATTACHMENTS_ATTACHED" : "VISUAL_ATTACHMENTS_FAILED", result);
    if (!result.ok) {
      throw new Error("Nao consegui anexar o contexto visual ao ChatGPT.");
    }
    return result;
  }

  async function sendPromptSafely(jobId, composer, prompt) {
    return withStepWatchdog(jobId, JOB_STATUS.SENDING_PROMPT, "Preenchendo e enviando prompt", async () => {
      const filled = await fillComposerSafely(composer, prompt);
      if (!filled) {
        dumpDomPartial("composer-fill-failed");
        throw new Error("Nao consegui preencher o prompt no campo do ChatGPT.");
      }

      const button = await Dom.waitFor(() => getSendButton(composer), {
        timeoutMs: 45000,
        intervalMs: 600,
        message: "Nao encontrei o botao de envio ativo do ChatGPT."
      });

      automationLog("prompt:sending", {
        tag: button.tagName,
        aria: button.getAttribute("aria-label") || "",
        testid: button.getAttribute("data-testid") || "",
        promptLength: prompt.length
      });
      Dom.clickElement(button);
      await Dom.sleep(700);

      if (readComposerText(composer).length > prompt.length * 0.8) {
        composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
        composer.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
      }
      return true;
    }, { attempts: 2, timeoutMs: C.STEP_WATCHDOG_MS });
  }

  function assistantNodes() {
    return Array.from(new Set(Dom.allBySelectors(document, C.SELECTORS.chatgptAssistantMessages)
      .filter((node) => Dom.isVisible(node) && Dom.getText(node).length > 0)
      .filter((node) => !node.closest("form"))));
  }

  function latestAssistantText() {
    const nodes = assistantNodes();
    return Dom.getText(nodes[nodes.length - 1]);
  }

  function isGenerating() {
    if (Dom.allBySelectors(document, C.SELECTORS.chatgptStopButton).some((button) => Dom.isVisible(button))) {
      return true;
    }
    if (Array.from(document.querySelectorAll("[aria-busy='true'], [data-state='loading']")).some((node) => Dom.isVisible(node))) {
      return true;
    }
    return /(?:generating|respondendo|gerando|stop generating|parar de gerar|thinking|pensando)/i.test(pageText());
  }

  async function waitStreamingComplete(jobId, previousText) {
    emitStatus(jobId, JOB_STATUS.WAITING_STREAM, "Aguardando inicio da resposta do ChatGPT");
    await Dom.waitFor(() => {
      const text = latestAssistantText();
      return text && text !== previousText && text.length > 12;
    }, {
      timeoutMs: C.STREAM_STALE_MS,
      intervalMs: 800,
      message: "O ChatGPT nao iniciou uma resposta dentro do tempo esperado."
    });

    emitStatus(jobId, JOB_STATUS.WAITING_STREAM, "Streaming iniciado");
    let lastText = "";
    let stableSince = 0;
    let lastChangeAt = Date.now();

    while (true) {
      const current = latestAssistantText();
      const generating = isGenerating();

      if (current && current !== lastText) {
        lastText = current;
        stableSince = 0;
        lastChangeAt = Date.now();
        emitStatus(jobId, JOB_STATUS.WAITING_STREAM, `Recebendo resposta (${current.length} caracteres)`, {
          response_length: current.length
        });
      } else if (current) {
        if (!stableSince) {
          stableSince = Date.now();
        }
        if (!generating && Date.now() - stableSince >= C.STREAM_STABLE_MS) {
          emitStatus(jobId, JOB_STATUS.CAPTURING_RESPONSE, "Resposta completa estabilizada", {
            response_length: current.length
          });
          return current;
        }
      }

      if (Date.now() - lastChangeAt > C.STREAM_STALE_MS) {
        if (lastText && !generating) {
          return lastText;
        }
        throw new Error("Streaming ficou sem progresso por tempo excessivo.");
      }

      await Dom.sleep(500);
    }
  }

  async function captureFinalResponse(jobId, previousText) {
    return withStepWatchdog(jobId, JOB_STATUS.CAPTURING_RESPONSE, "Capturando resposta final", async () => {
      const answer = await waitStreamingComplete(jobId, previousText);
      if (!answer || answer.length < 20) {
        dumpDomPartial("answer-too-short");
        throw new Error("A resposta capturada do ChatGPT ficou vazia ou curta demais.");
      }
      automationLog("answer:captured", { length: answer.length });
      return answer;
    }, { attempts: 1, timeoutMs: C.CHATGPT_TIMEOUT_MS });
  }

  async function waitStreamingCompleteForTest(jobId, previousText, diagnostics) {
    emitStatus(jobId, JOB_STATUS.WAITING_STREAM, "CHATGPT_AUTOMATION_TEST: aguardando streaming iniciar");
    await Dom.waitFor(() => {
      const text = latestAssistantText();
      if (text && text !== previousText && text.length > 0) {
        diagnostics.streamingStarted = true;
        diagnostics.streamingStartLength = text.length;
        return text;
      }
      return null;
    }, {
      timeoutMs: C.STREAM_STALE_MS,
      intervalMs: 800,
      message: "Streaming nao iniciou no CHATGPT_AUTOMATION_TEST."
    });

    diagnostics.streamingStarted = true;
    automationLog("STREAM_STARTED", diagnostics);
    emitStatus(jobId, JOB_STATUS.WAITING_STREAM, "STREAM_STARTED", {
      streamingStarted: true
    });

    let lastText = "";
    let stableSince = 0;
    let lastChangeAt = Date.now();

    while (true) {
      const current = latestAssistantText();
      const generating = isGenerating();
      diagnostics.streamActive = generating;

      if (current && current !== lastText) {
        lastText = current;
        stableSince = 0;
        lastChangeAt = Date.now();
        diagnostics.responseLength = current.length;
        emitStatus(jobId, JOB_STATUS.WAITING_STREAM, `CHATGPT_AUTOMATION_TEST: recebendo resposta (${current.length} caracteres)`, {
          response_length: current.length,
          streamingStarted: true,
          streamActive: generating
        });
      } else if (current) {
        if (!stableSince) {
          stableSince = Date.now();
        }
        if (!generating && Date.now() - stableSince >= C.STREAM_STABLE_MS) {
          diagnostics.responseReceived = current.length > 0;
          diagnostics.responseLength = current.length;
          emitStatus(jobId, JOB_STATUS.CAPTURING_RESPONSE, "CHATGPT_AUTOMATION_TEST: resposta estabilizada", {
            response_length: current.length,
            responseReceived: diagnostics.responseReceived
          });
          return current;
        }
      }

      if (Date.now() - lastChangeAt > C.STREAM_STALE_MS) {
        if (lastText && !generating) {
          diagnostics.responseReceived = true;
          diagnostics.responseLength = lastText.length;
          return lastText;
        }
        throw new Error("Streaming do CHATGPT_AUTOMATION_TEST ficou sem progresso.");
      }

      await Dom.sleep(900);
    }
  }

  function pressEnterToSend(composer) {
    if (!composer) {
      return false;
    }
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      which: 13,
      keyCode: 13
    }));
    composer.dispatchEvent(new KeyboardEvent("keypress", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      which: 13,
      keyCode: 13
    }));
    composer.dispatchEvent(new KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      which: 13,
      keyCode: 13
    }));
    return true;
  }

  async function runAutomationTest(payload) {
    const jobId = payload.jobId;
    const prompt = payload.prompt || C.CHATGPT_AUTOMATION_TEST_PROMPT || "TESTE AUTOMATICO";
    const diagnostics = {
      mode: payload.forceSendTest || C.FORCE_SEND_TEST ? "FORCE_SEND_TEST" : "CHATGPT_AUTOMATION_TEST",
      attempt: payload.attempt || 1,
      projectLoaded: false,
      newChatButtonFound: false,
      newChatClicked: false,
      composerFound: false,
      textInserted: false,
      sendButtonFound: false,
      clickExecuted: false,
      enterFallbackExecuted: false,
      streamingStarted: false,
      streamingFinished: false,
      streamActive: false,
      responseReceived: false,
      responseLength: 0
    };

    try {
      automationLog("test:start", {
        jobId,
        attempt: diagnostics.attempt,
        prompt,
        url: location.href
      });

      await waitForProjectReady(jobId);
      diagnostics.projectLoaded = true;
      emitStatus(jobId, JOB_STATUS.OPENING_PROJECT, "CHATGPT_AUTOMATION_TEST: projeto carregado", diagnostics);

      const previousText = latestAssistantText();
      const createChatResult = await diagnoseCreateChat(jobId, { requireComposer: true });
      diagnostics.createChat = createChatResult.diagnostics;
      diagnostics.newChatButtonFound = Boolean(diagnostics.createChat && diagnostics.createChat.scan && diagnostics.createChat.scan.best);
      diagnostics.newChatClicked = Boolean(diagnostics.createChat && diagnostics.createChat.clickExecuted);
      const composer = createChatResult.composer || await waitForComposer(jobId);
      diagnostics.composerFound = true;
      diagnostics.composer = describeElement(composer);
      automationLog("COMPOSER_FOUND", diagnostics);
      emitStatus(jobId, JOB_STATUS.WAITING_COMPOSER, "COMPOSER_FOUND", diagnostics);

      diagnostics.textInserted = await fillComposerSafely(composer, prompt);
      diagnostics.composerTextLength = readComposerText(composer).length;
      automationLog(diagnostics.textInserted ? "MESSAGE_INSERTED" : "MESSAGE_INSERT_FAILED", diagnostics);
      emitStatus(jobId, JOB_STATUS.SENDING_PROMPT, diagnostics.textInserted ? "MESSAGE_INSERTED" : "MESSAGE_INSERT_FAILED", diagnostics);
      if (!diagnostics.textInserted) {
        dumpDomPartial("automation-test-fill-failed");
        throw new Error("Texto TESTE AUTOMATICO nao entrou no composer.");
      }

      let button = null;
      try {
        button = await Dom.waitFor(() => getSendButton(composer), {
          timeoutMs: 8000,
          intervalMs: 500,
          message: "Botao enviar nao encontrado no CHATGPT_AUTOMATION_TEST."
        });
      } catch (error) {
        diagnostics.sendButtonError = error.message;
      }
      diagnostics.sendButtonFound = Boolean(button);
      diagnostics.sendButton = describeElement(button);
      automationLog(diagnostics.sendButtonFound ? "SEND_BUTTON_FOUND" : "SEND_BUTTON_NOT_FOUND", diagnostics);
      emitStatus(jobId, JOB_STATUS.SENDING_PROMPT, diagnostics.sendButtonFound ? "SEND_BUTTON_FOUND" : "SEND_BUTTON_NOT_FOUND", diagnostics);

      if (button) {
        diagnostics.clickExecuted = Dom.clickElement(button);
        automationLog("SEND_CLICKED", diagnostics);
        emitStatus(jobId, JOB_STATUS.SENDING_PROMPT, "SEND_CLICKED", diagnostics);
      } else {
        diagnostics.enterFallbackExecuted = pressEnterToSend(composer);
        automationLog("ENTER_SENT", diagnostics);
        emitStatus(jobId, JOB_STATUS.SENDING_PROMPT, "ENTER_SENT", diagnostics);
      }
      await Dom.sleep(1200);

      if (readComposerText(composer).includes(prompt)) {
        diagnostics.enterFallback = true;
        pressEnterToSend(composer);
        automationLog("test:enter-fallback", { jobId });
      }

      const answer = await waitStreamingCompleteForTest(jobId, previousText, diagnostics);
      diagnostics.streamingFinished = true;
      diagnostics.responseReceived = Boolean(answer && answer.length > 10);
      diagnostics.responseLength = answer ? answer.length : 0;
      diagnostics.answerPreview = answer ? answer.slice(0, 500) : "";
      automationLog("STREAM_FINISHED", diagnostics);
      emitStatus(jobId, JOB_STATUS.WAITING_STREAM, "STREAM_FINISHED", diagnostics);
      if (diagnostics.responseReceived) {
        automationLog("RESPONSE_CAPTURED", diagnostics);
        emitStatus(jobId, JOB_STATUS.CAPTURING_RESPONSE, "RESPONSE_CAPTURED", diagnostics);
      }

      const ok = Boolean(
        diagnostics.projectLoaded &&
        diagnostics.composerFound &&
        diagnostics.textInserted &&
        (diagnostics.clickExecuted || diagnostics.enterFallbackExecuted) &&
        diagnostics.streamingStarted &&
        diagnostics.streamingFinished &&
        diagnostics.responseReceived
      );

      automationLog("test:finished", {
        jobId,
        ok,
        diagnostics
      });

      return {
        ok,
        status: ok ? "AUTOMACAO OK" : "AUTOMACAO FALHOU",
        message: ok ? "AUTOMACAO OK" : "AUTOMACAO FALHOU",
        diagnostics,
        answer: answer || ""
      };
    } catch (error) {
      diagnostics.error = error.message;
      diagnostics.url = location.href;
      if (error.createChatDiagnostics) {
        diagnostics.createChat = error.createChatDiagnostics;
      }
      dumpDomPartial("automation-test-failed");
      automationLog("test:failed", {
        jobId,
        error: error.message,
        diagnostics
      });
      return {
        ok: false,
        status: "AUTOMACAO FALHOU",
        message: error.message || "AUTOMACAO FALHOU",
        diagnostics,
        answer: ""
      };
    }
  }

  async function inspectChatGPTPage(payload) {
    const jobId = payload && payload.jobId ? payload.jobId : "";
    await waitForProjectReady(jobId || "inspect");
    const scan = createChatScan();
    const composer = getComposer();
    const result = {
      ok: true,
      mode: "INSPECIONAR_CHATGPT",
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      isProject: isProjectUrl(),
      bodyTextLength: pageText().length,
      counts: {
        buttons: document.querySelectorAll("button").length,
        roleButtons: document.querySelectorAll("[role='button']").length,
        anchors: document.querySelectorAll("a").length,
        contenteditable: document.querySelectorAll("[contenteditable='true']").length,
        textarea: document.querySelectorAll("textarea").length
      },
      hasStillNoChats: /ainda sem chats/i.test(pageText()),
      hasNewChatInFicha: /novo chat em ficha/i.test(pageText()),
      composerFound: Boolean(composer),
      composer: describeElement(composer),
      composerCandidates: getComposerCandidates().slice(0, 8).map((item) => ({
        score: item.score,
        node: describeElement(item.node)
      })),
      createChatScan: sanitizeCreateChatScan(scan),
      bodyTextPreview: pageText().slice(0, 3000)
    };
    automationLog("inspect:chatgpt", {
      jobId,
      ...result
    });
    return result;
  }

  async function runAutomation(payload) {
    const jobId = payload.jobId;
    const prompt = payload.prompt;
    automationLog("automation:start", {
      jobId,
      attempt: payload.attempt,
      promptLength: prompt.length,
      url: location.href
    });

    await ensureProjectConversation(jobId);
    const previousText = latestAssistantText();
    const composer = await waitForComposer(jobId);
    const visualAttachmentResult = await attachVisualContextImages(jobId, payload);
    await sendPromptSafely(jobId, composer, prompt);
    const answer = await captureFinalResponse(jobId, previousText);

    return {
      ok: true,
      answer,
      visualAttachmentResult,
      manualFallback: false,
      message: "Resposta capturada do ChatGPT."
    };
  }

  globalThis.ProjetoFichaChatGPTAutomationEngine = {
    captureFinalResponse,
    ensureProjectConversation,
    getComposer,
    getComposerCandidates,
    getSendButton,
    isGenerating,
    isProjectUrl,
    inspectChatGPTPage,
    runAutomation,
    runAutomationTest,
    sendPromptSafely,
    waitForComposer,
    waitForProjectReady,
    waitStreamingComplete
  };
})();
