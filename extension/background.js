try {
  importScripts(
    "utils/constants.js",
    "utils/storage.js",
    "utils/logger.js",
    "utils/conversationNormalizer.js",
    "utils/preprocess.js",
    "utils/responseParser.js",
    "utils/prompt.js",
    "utils/settings.js",
    "utils/materialApiClient.js"
  );
} catch (error) {
  console.error("Projeto Ficha: falha carregando utilitarios do background", error);
}

const C = globalThis.ProjetoFichaConstants;
const Storage = globalThis.ProjetoFichaStorage;
const Prompt = globalThis.ProjetoFichaPrompt;
const Logger = globalThis.ProjetoFichaLogger;
const Settings = globalThis.ProjetoFichaSettings;
const MaterialApiClient = globalThis.ProjetoFichaMaterialApiClient;
const activeJobs = new Map();

function chromeCallback(fn, context, args) {
  return new Promise((resolve, reject) => {
    fn.call(context, ...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function tabsCreate(options) {
  return chromeCallback(chrome.tabs.create, chrome.tabs, [options]);
}

function tabsRemove(tabId) {
  return chromeCallback(chrome.tabs.remove, chrome.tabs, [tabId]);
}

function tabsGet(tabId) {
  return chromeCallback(chrome.tabs.get, chrome.tabs, [tabId]);
}

function tabsUpdate(tabId, options) {
  return chromeCallback(chrome.tabs.update, chrome.tabs, [tabId, options]);
}

function tabsQuery(queryInfo) {
  return chromeCallback(chrome.tabs.query, chrome.tabs, [queryInfo]);
}

function tabsSendMessage(tabId, message) {
  return chromeCallback(chrome.tabs.sendMessage, chrome.tabs, [tabId, message]);
}

function captureVisibleTab(windowId, options) {
  return chromeCallback(chrome.tabs.captureVisibleTab, chrome.tabs, [windowId, options || {}]);
}

function executeScript(tabId, files) {
  return chromeCallback(chrome.scripting.executeScript, chrome.scripting, [{
    target: { tabId },
    files
  }]);
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || "Tempo esgotado.")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sendStatus(tabId, status, detail, extra) {
  try {
    await tabsSendMessage(tabId, {
      type: C.MESSAGE_TYPES.STATUS,
      status,
      detail: detail || "",
      extra: extra || {}
    });
  } catch (error) {
    console.debug("Projeto Ficha: status nao entregue", error);
  }
}

function safePortPost(port, payload) {
  if (!port) {
    return false;
  }
  try {
    port.postMessage(payload);
    return true;
  } catch (error) {
    Logger.debug("porta desconectada ao enviar mensagem", {
      type: payload && payload.type,
      error: error.message
    });
    return false;
  }
}

async function updateActiveJob(jobId, patch) {
  const current = activeJobs.get(jobId) || {};
  const next = {
    ...current,
    ...patch,
    jobId,
    updated_at: new Date().toISOString()
  };
  activeJobs.set(jobId, next);
  await Storage.set(C.STORAGE_KEYS.ACTIVE_JOB, next);
  return next;
}

async function transitionJob(jobId, status, detail, extra) {
  const current = await getActiveJob(jobId) || {};
  const now = new Date().toISOString();
  const previousStatus = current.status || null;
  const previousStartedAt = current.current_step_started_at || current.updated_at || now;
  const stepDurations = { ...(current.step_durations || {}) };

  if (previousStatus && previousStatus !== status && previousStartedAt) {
    const duration = Date.now() - new Date(previousStartedAt).getTime();
    stepDurations[previousStatus] = (stepDurations[previousStatus] || 0) + Math.max(0, duration);
  }

  return updateActiveJob(jobId, {
    status,
    detail: detail || "",
    current_step_started_at: previousStatus === status ? previousStartedAt : now,
    step_durations: stepDurations,
    timeline: [
      ...((current.timeline || []).slice(-40)),
      {
        status,
        detail: detail || "",
        time: now,
        extra: extra || {}
      }
    ],
    extra: extra || {}
  });
}

async function getActiveJob(jobId) {
  if (activeJobs.has(jobId)) {
    return activeJobs.get(jobId);
  }
  const stored = await Storage.get(C.STORAGE_KEYS.ACTIVE_JOB, null);
  if (stored && stored.jobId === jobId) {
    activeJobs.set(jobId, stored);
    return stored;
  }
  return null;
}

async function clearActiveJob(jobId) {
  activeJobs.delete(jobId);
  const current = await Storage.get(C.STORAGE_KEYS.ACTIVE_JOB, null);
  if (current && current.jobId === jobId) {
    await Storage.set(C.STORAGE_KEYS.ACTIVE_JOB, null);
  }
}

async function setChatGPTTabId(jobId, tabId, metadata) {
  const patch = {
    chatgpt: {
      tabId,
      assigned_at: new Date().toISOString(),
      ...(metadata || {})
    }
  };
  await updateActiveJob(jobId, patch);
  Logger.debug("tabId do Projeto FICHA persistido no ACTIVE_JOB", {
    jobId,
    tabId
  });
  await Logger.add({
    status: "tab_persisted",
    message: "tabId do Projeto FICHA persistido.",
    metadata: { jobId, tabId }
  });
  return tabId;
}

async function getChatGPTTabId(jobId) {
  const job = await getActiveJob(jobId);
  const tabId = job && job.chatgpt && Number.isFinite(job.chatgpt.tabId)
    ? job.chatgpt.tabId
    : null;
  Logger.debug("tabId do Projeto FICHA recuperado", {
    jobId,
    tabId
  });
  if (tabId) {
    await Logger.add({
      status: "tab_recovered",
      message: "tabId do Projeto FICHA recuperado do estado.",
      metadata: { jobId, tabId }
    });
  }
  return tabId;
}

function createEmitter(port, whatsappTabId, jobId) {
  return async (status, detail, extra) => {
    const payload = {
      type: C.MESSAGE_TYPES.GENERATE_PORT_STATUS,
      jobId,
      status,
      detail: detail || "",
      extra: extra || {},
      time: new Date().toISOString()
    };
    const deliveredByPort = safePortPost(port, payload);
    await transitionJob(jobId, status, detail, extra || {});
    if (!deliveredByPort && whatsappTabId) {
      await sendStatus(whatsappTabId, status, detail, extra || {});
    }
    await Logger.add({
      status,
      message: detail || status,
      metadata: {
        jobId,
        ...payload.extra
      }
    });
  };
}

async function postBackend(path, payload) {
  try {
    const response = await fetch(`${C.BACKEND_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function checkBackendHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`${C.BACKEND_URL}/health`, {
      method: "GET",
      signal: controller.signal
    });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForTabComplete(tabId, timeoutMs) {
  return withTimeout((async () => {
    while (true) {
      const tab = await tabsGet(tabId);
      if (tab.status === "complete") {
        return tab;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  })(), timeoutMs || 45000, "ChatGPT demorou para carregar.");
}

async function createBackgroundProjectTab(jobId, whatsappTabId) {
  let created;
  try {
    created = await tabsCreate({
      url: C.CHATGPT_PROJECT_URL,
      active: false,
      autoDiscardable: false,
      openerTabId: whatsappTabId
    });
  } catch (_e) {
    created = await tabsCreate({
      url: C.CHATGPT_PROJECT_URL,
      active: false,
      openerTabId: whatsappTabId
    });
  }
  Logger.debug("aba inativa do Projeto FICHA criada", {
    jobId,
    tabId: created.id,
    active: created.active,
    url: C.CHATGPT_PROJECT_URL
  });
  await Logger.add({
    status: "tab_created",
    message: "Aba inativa do Projeto FICHA criada.",
    metadata: {
      jobId,
      tabId: created.id,
      active: created.active,
      url: C.CHATGPT_PROJECT_URL
    }
  });
  return setChatGPTTabId(jobId, created.id, {
    url: C.CHATGPT_PROJECT_URL,
    active: Boolean(created.active),
    created_at: new Date().toISOString()
  });
}

async function setTabNonDiscardable(tabId, jobId) {
  try {
    const tab = await tabsUpdate(tabId, { autoDiscardable: false });
    await Logger.add({
      status: "tab_non_discardable",
      message: "Aba do ChatGPT marcada como nao descartavel.",
      metadata: { jobId, tabId }
    });
    return tab;
  } catch (error) {
    Logger.debug("nao foi possivel desativar autoDiscardable", {
      jobId,
      tabId,
      error: error.message
    });
    await Logger.add({
      status: "tab_non_discardable_failed",
      message: "Chrome nao aceitou autoDiscardable=false para a aba de teste.",
      error: error.message,
      metadata: { jobId, tabId }
    });
    return null;
  }
}

async function createAutomationTestTab(jobId, whatsappTabId) {
  let created = null;
  try {
    created = await tabsCreate({
      url: C.CHATGPT_PROJECT_URL,
      active: false,
      openerTabId: whatsappTabId,
      autoDiscardable: false
    });
  } catch (error) {
    Logger.debug("tabs.create sem suporte a autoDiscardable; criando fallback", {
      jobId,
      error: error.message
    });
    created = await tabsCreate({
      url: C.CHATGPT_PROJECT_URL,
      active: false,
      openerTabId: whatsappTabId
    });
  }

  await setChatGPTTabId(jobId, created.id, {
    mode: "CHATGPT_AUTOMATION_TEST",
    url: C.CHATGPT_PROJECT_URL,
    active: Boolean(created.active),
    created_at: new Date().toISOString()
  });
  await setTabNonDiscardable(created.id, jobId);
  await Logger.add({
    status: "automation_test_tab_created",
    message: "Aba inativa criada para FORCE_SEND_TEST.",
    metadata: {
      jobId,
      tabId: created.id,
      url: C.CHATGPT_PROJECT_URL
    }
  });
  return created.id;
}

async function captureChatGptScreenshotForDiagnostics(tabId, jobId, reason) {
  if (!tabId) {
    return { ok: false, error: "tabId ausente para screenshot." };
  }

  let previousActive = null;
  try {
    const targetTab = await tabsGet(tabId);
    const activeTabs = await tabsQuery({ active: true, currentWindow: true });
    previousActive = activeTabs && activeTabs[0] ? activeTabs[0] : null;

    await tabsUpdate(tabId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const dataUrl = await captureVisibleTab(targetTab.windowId, { format: "png" });
    const screenshot = {
      jobId,
      tabId,
      reason: reason || "",
      captured_at: new Date().toISOString(),
      dataUrl
    };
    await Storage.set(C.STORAGE_KEYS.LAST_CHATGPT_SCREENSHOT, screenshot);
    await Logger.add({
      status: "chatgpt_screenshot",
      message: "Screenshot do ChatGPT salvo em chrome.storage.local.",
      metadata: {
        jobId,
        tabId,
        reason: reason || "",
        data_url_length: dataUrl ? dataUrl.length : 0
      }
    });
    return {
      ok: true,
      length: dataUrl ? dataUrl.length : 0,
      storageKey: C.STORAGE_KEYS.LAST_CHATGPT_SCREENSHOT
    };
  } catch (error) {
    await Logger.add({
      status: "chatgpt_screenshot_failed",
      message: "Nao foi possivel capturar screenshot do ChatGPT.",
      error: error.message,
      metadata: { jobId, tabId, reason: reason || "" }
    });
    return {
      ok: false,
      error: error.message
    };
  } finally {
    if (previousActive && previousActive.id && previousActive.id !== tabId) {
      try {
        await tabsUpdate(previousActive.id, { active: true });
      } catch (error) {
        Logger.debug("nao foi possivel restaurar aba ativa apos screenshot", {
          jobId,
          error: error.message
        });
      }
    }
  }
}

async function closeAutomationTab(jobId, reason) {
  const tabId = await getChatGPTTabId(jobId);
  if (!tabId) {
    Logger.debug("cleanup sem tabId para fechar", { jobId, reason });
    await Logger.add({
      status: "cleanup",
      message: "Cleanup executado sem tabId ativo.",
      metadata: { jobId, reason: reason || "" }
    });
    return;
  }
  try {
    await tabsRemove(tabId);
    Logger.debug("aba temporaria do ChatGPT fechada", { jobId, tabId, reason });
    await Logger.add({
      status: "tab_closed",
      message: "Aba temporaria do Projeto FICHA fechada.",
      metadata: { jobId, tabId, reason: reason || "" }
    });
    const job = await getActiveJob(jobId);
    await updateActiveJob(jobId, {
      chatgpt: {
        ...(job && job.chatgpt ? job.chatgpt : {}),
        tabId: null,
        closed_at: new Date().toISOString(),
        close_reason: reason || ""
      }
    });
  } catch (error) {
    Logger.debug("nao foi possivel fechar aba temporaria", { jobId, tabId, error: error.message });
    await Logger.add({
      status: "tab_close_error",
      message: "Nao foi possivel fechar a aba temporaria.",
      error: error.message,
      metadata: { jobId, tabId }
    });
  }
}

async function cleanupChatGPTTab(jobId, options) {
  const keepTab = Boolean(options && options.keepTab);
  const reason = options && options.reason ? options.reason : "cleanup";
  const tabId = await getChatGPTTabId(jobId);
  await Logger.add({
    status: "cleanup",
    message: keepTab ? "Cleanup executado mantendo aba para debug." : "Cleanup executado fechando aba temporaria.",
    metadata: { jobId, tabId, keepTab, reason }
  });
  if (keepTab) {
    const job = await getActiveJob(jobId);
    await updateActiveJob(jobId, {
      chatgpt: {
        ...(job && job.chatgpt ? job.chatgpt : {}),
        tabId,
        debug_tab_kept: true,
        keep_reason: reason,
        kept_at: new Date().toISOString()
      },
      debug_tab_kept: true,
      detail: "Aba do ChatGPT mantida aberta para debug."
    });
    return tabId;
  }
  await closeAutomationTab(jobId, reason);
  return null;
}

async function ensureChatGptContentScript(tabId) {
  await executeScript(tabId, [
    "utils/constants.js",
    "utils/dom.js",
    "utils/storage.js",
    "utils/logger.js",
    "utils/conversationNormalizer.js",
    "utils/preprocess.js",
    "utils/responseParser.js",
    "utils/prompt.js",
    "chatgptAutomationEngine.js",
    "chatgpt.js"
  ]);
}

// ChatGPT via backend (Playwright no Chrome do Gabriel) â€” funciona de qualquer perfil Chrome.
async function runChatGptViaBackend(payload, emit) {
  await emit(C.JOB_STATUS.OPENING_PROJECT, "Abrindo FICHA PEDIDO no Chrome do Gabriel via backend...");
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), C.CHATGPT_TIMEOUT_MS + 30000);
    response = await fetch(`${C.BACKEND_URL}/generate-chatgpt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        job_id: payload.jobId || "",
        prompt: payload.prompt || "",
        conversation: payload.conversation || {}
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Tempo esgotado aguardando o backend gerar a ficha ChatGPT.");
    }
    throw new Error(`Falha conectando ao backend local: ${error.message}`);
  }

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

  if (!response.ok) {
    const detail = data && data.detail ? data.detail : text;
    throw new Error(`Backend ChatGPT retornou erro ${response.status}: ${String(detail).slice(0, 300)}`);
  }

  const answer = data && data.answer ? String(data.answer) : "";
  if (!answer) {
    throw new Error("Backend ChatGPT respondeu sem texto de ficha.");
  }
  await emit(C.JOB_STATUS.CAPTURING_RESPONSE, `Ficha recebida do ChatGPT (${answer.length} caracteres).`, {
    answer_length: answer.length
  });
  return { ok: true, answer };
}

// Material API path: no tab automation; the local backend adds the secret token.
async function runMaterialApiGeneration(jobId, payload, emit) {
  if (!MaterialApiClient) {
    throw new Error("Cliente Material API nao carregado no background.");
  }
  await emit(C.JOB_STATUS.SENDING_PROMPT, "Enviando requisicao para o gerador Material API...", {
    prompt_length: payload.prompt ? payload.prompt.length : 0
  });

  let visualContext = null;
  if (payload.visualContextKey) {
    visualContext = await Storage.get(payload.visualContextKey, null);
  }
  if (!visualContext && payload.conversation && payload.conversation.visual_context) {
    visualContext = payload.conversation.visual_context;
  }

  await emit(C.JOB_STATUS.WAITING_STREAM, "Aguardando geracao do orcamento/DANFE na Material API...");
  const result = await MaterialApiClient.generate({
    jobId,
    prompt: payload.prompt,
    conversation: payload.conversation,
    visualContext,
    settings: payload.settings,
    options: payload.options,
    onStatus: (detail, extra) => {
      emit(C.JOB_STATUS.WAITING_STREAM, detail, extra || {});
    }
  });

  await emit(C.JOB_STATUS.CAPTURING_RESPONSE, result.message || "Resposta recebida da Material API.", {
    has_download: Boolean(result.downloadUrl)
  });
  return result;
}

async function runChatGptAutomation(tabId, payload) {
  await waitForTabComplete(tabId, 60000);
  await ensureChatGptContentScript(tabId);

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      Logger.debug("enviando comando para content script do ChatGPT", {
        tabId,
        attempt,
        jobId: payload.jobId
      });
      return await withTimeout(
        tabsSendMessage(tabId, {
          type: C.MESSAGE_TYPES.CHATGPT_RUN,
          payload: {
            ...payload,
            attempt
          }
        }),
        C.CHATGPT_TIMEOUT_MS,
        "Tempo esgotado aguardando resposta do ChatGPT."
      );
    } catch (error) {
      lastError = error;
      Logger.debug("falha ao falar com aba do ChatGPT; tentando reinjetar", {
        attempt,
        error: error.message
      });
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      await ensureChatGptContentScript(tabId);
    }
  }
  throw lastError || new Error("Nao foi possivel iniciar automacao do ChatGPT.");
}

async function runChatGptAutomationTest(tabId, payload) {
  await waitForTabComplete(tabId, 60000);
  await ensureChatGptContentScript(tabId);

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      Logger.debug("executando FORCE_SEND_TEST", {
        tabId,
        attempt,
        jobId: payload.jobId
      });
      await Logger.add({
        status: "automation_test_attempt",
        message: `FORCE_SEND_TEST tentativa ${attempt}.`,
        metadata: { jobId: payload.jobId, tabId, attempt }
      });

      return await withTimeout(
        tabsSendMessage(tabId, {
          type: C.MESSAGE_TYPES.CHATGPT_AUTOMATION_TEST_RUN,
          payload: {
            ...payload,
            prompt: C.CHATGPT_AUTOMATION_TEST_PROMPT,
            attempt,
            forceSendTest: true
          }
        }),
        C.CHATGPT_TIMEOUT_MS,
        "Tempo esgotado no FORCE_SEND_TEST."
      );
    } catch (error) {
      lastError = error;
      Logger.debug("FORCE_SEND_TEST falhou; reinjetando content script", {
        tabId,
        attempt,
        error: error.message
      });
      await Logger.add({
        status: "automation_test_retry",
        message: "Falha comunicando com a aba do ChatGPT; reinjetando script.",
        error: error.message,
        metadata: { jobId: payload.jobId, tabId, attempt }
      });
      await new Promise((resolve) => setTimeout(resolve, 900 * attempt));
      await ensureChatGptContentScript(tabId);
    }
  }

  throw lastError || new Error("Nao foi possivel executar FORCE_SEND_TEST.");
}

async function runChatGptInspect(tabId, payload) {
  await waitForTabComplete(tabId, 60000);
  await ensureChatGptContentScript(tabId);
  return withTimeout(
    tabsSendMessage(tabId, {
      type: C.MESSAGE_TYPES.CHATGPT_INSPECT_RUN,
      payload
    }),
    C.PROJECT_READY_TIMEOUT_MS,
    "Tempo esgotado inspecionando o ChatGPT."
  );
}

async function findReusableChatGptTab(jobId) {
  const stored = await Storage.get(C.STORAGE_KEYS.ACTIVE_JOB, null);
  const storedTabId = stored && stored.chatgpt && Number.isFinite(stored.chatgpt.tabId)
    ? stored.chatgpt.tabId
    : null;
  if (storedTabId) {
    try {
      await tabsGet(storedTabId);
      await setChatGPTTabId(jobId, storedTabId, {
        mode: "INSPECIONAR_CHATGPT",
        reused_from_job: stored.jobId || ""
      });
      return storedTabId;
    } catch (error) {
      Logger.debug("aba ChatGPT armazenada nao esta mais disponivel", {
        jobId,
        storedTabId,
        error: error.message
      });
    }
  }

  const tabs = await tabsQuery({ url: "https://chatgpt.com/*" });
  const projectTab = (tabs || []).find((tab) => tab.url && (
    tab.url.includes(C.CHATGPT_PROJECT_ID) || tab.url.includes(C.CHATGPT_CONVERSATION_ID)
  ));
  if (projectTab && projectTab.id) {
    await setChatGPTTabId(jobId, projectTab.id, {
      mode: "INSPECIONAR_CHATGPT",
      reused_project_tab: true
    });
    return projectTab.id;
  }

  return null;
}

async function handleChatGptInspect(message, sender) {
  const whatsappTabId = message.whatsappTabId || (sender && sender.tab && sender.tab.id);
  const jobId = message.jobId || `chatgpt-inspect-${Date.now()}`;
  let tabId = null;

  try {
    tabId = await findReusableChatGptTab(jobId);
    if (!tabId) {
      tabId = await createAutomationTestTab(jobId, whatsappTabId);
    }

    await updateActiveJob(jobId, {
      mode: "INSPECIONAR_CHATGPT",
      status: C.JOB_STATUS.OPENING_PROJECT,
      detail: "Inspecionando ChatGPT.",
      whatsappTabId,
      started_at: new Date().toISOString()
    });

    if (whatsappTabId) {
      await sendStatus(whatsappTabId, C.JOB_STATUS.OPENING_PROJECT, "Inspecionando DOM do ChatGPT.", { tabId });
    }

    const result = await runChatGptInspect(tabId, { jobId });
    const response = {
      ...(result || {}),
      ok: Boolean(result && result.ok),
      tabId
    };

    await Storage.append(C.STORAGE_KEYS.DIAGNOSTICS, {
      type: "INSPECIONAR_CHATGPT",
      jobId,
      tabId,
      result: response,
      time: new Date().toISOString()
    }, 30);
    await Logger.add({
      status: "chatgpt_inspect",
      message: `URL: ${response.url || "-"} | Titulo: ${response.title || "-"} | Botoes: ${response.counts ? response.counts.buttons : 0} | Contenteditable: ${response.counts ? response.counts.contenteditable : 0} | Textarea: ${response.counts ? response.counts.textarea : 0}`,
      metadata: response
    });
    await updateActiveJob(jobId, {
      status: C.JOB_STATUS.COMPLETED,
      detail: "Inspecao ChatGPT concluida.",
      completed_at: new Date().toISOString()
    });
    return response;
  } catch (error) {
    await Logger.add({
      status: "chatgpt_inspect_error",
      message: "Falha ao inspecionar ChatGPT.",
      error: error.message,
      metadata: { jobId, tabId }
    });
    await updateActiveJob(jobId, {
      status: C.JOB_STATUS.ERROR,
      detail: error.message,
      completed_at: new Date().toISOString()
    });
    return {
      ok: false,
      error: error.message,
      message: error.message,
      tabId
    };
  }
}

async function handleChatGptAutomationTest(message, sender) {
  const whatsappTabId = message.whatsappTabId || (sender && sender.tab && sender.tab.id);
  if (!whatsappTabId) {
    throw new Error("Nao foi possivel identificar a aba do WhatsApp para exibir o diagnostico.");
  }

  const jobId = message.jobId || `chatgpt-test-${Date.now()}`;
  const startedAt = Date.now();
  let testTabId = null;

  const emit = async (status, detail, extra) => {
    const metadata = {
      jobId,
      mode: "CHATGPT_AUTOMATION_TEST",
      ...(extra || {})
    };
    await transitionJob(jobId, status, detail, metadata);
    await sendStatus(whatsappTabId, status, detail, metadata);
    await Logger.add({
      status,
      message: detail || status,
      metadata
    });
  };

  await updateActiveJob(jobId, {
    mode: "CHATGPT_AUTOMATION_TEST",
    status: C.JOB_STATUS.IDLE,
    detail: "Diagnostico ChatGPT iniciado.",
    whatsappTabId,
    started_at: new Date().toISOString()
  });

  try {
    await emit(C.JOB_STATUS.OPENING_PROJECT, "FORCE_SEND_TEST: abrindo Projeto FICHA.");
    testTabId = await createAutomationTestTab(jobId, whatsappTabId);
    await emit(C.JOB_STATUS.OPENING_PROJECT, "Aguardando Projeto FICHA carregar.", { tabId: testTabId });

    const result = await runChatGptAutomationTest(testTabId, { jobId });
    const diagnostics = result && result.diagnostics ? result.diagnostics : {};
    const ok = Boolean(result && result.ok);
    const statusText = ok ? "AUTOMACAO OK" : "AUTOMACAO FALHOU";

    if (!ok && diagnostics.createChat) {
      diagnostics.screenshot = await captureChatGptScreenshotForDiagnostics(testTabId, jobId, "create_chat_failed");
    }

    await emit(ok ? C.JOB_STATUS.COMPLETED : C.JOB_STATUS.ERROR, statusText, {
      tabId: testTabId,
      response_length: diagnostics.responseLength || 0,
      diagnostics
    });

    await Storage.append(C.STORAGE_KEYS.DIAGNOSTICS, {
      type: "CHATGPT_AUTOMATION_TEST",
      ok,
      jobId,
      tabId: testTabId,
      duration_ms: Date.now() - startedAt,
      diagnostics,
      answer_preview: result && result.answer ? String(result.answer).slice(0, 500) : "",
      time: new Date().toISOString()
    }, 30);

    const keepTab = !ok || C.DEBUG_CHATGPT_AUTOMATION;
    await cleanupChatGPTTab(jobId, {
      keepTab,
      reason: ok ? "automation_test_ok" : "automation_test_failed"
    });

    await updateActiveJob(jobId, {
      completed_at: new Date().toISOString(),
      diagnostics,
      result_status: statusText
    });

    return {
      ok,
      jobId,
      message: result && result.message ? result.message : statusText,
      diagnostics,
      answer: result && result.answer ? result.answer : "",
      chatgpt: {
        tabId: testTabId,
        kept_open: keepTab
      },
      duration_ms: Date.now() - startedAt
    };
  } catch (error) {
    const diagnostics = {
      error: error.message,
      tabId: testTabId
    };
    if (testTabId) {
      diagnostics.screenshot = await captureChatGptScreenshotForDiagnostics(testTabId, jobId, "automation_test_exception");
    }
    await emit(C.JOB_STATUS.ERROR, `AUTOMACAO FALHOU: ${error.message}`, {
      tabId: testTabId,
      diagnostics
    });
    await Storage.append(C.STORAGE_KEYS.DIAGNOSTICS, {
      type: "CHATGPT_AUTOMATION_TEST",
      ok: false,
      jobId,
      tabId: testTabId,
      duration_ms: Date.now() - startedAt,
      diagnostics,
      time: new Date().toISOString()
    }, 30);
    if (testTabId) {
      await cleanupChatGPTTab(jobId, {
        keepTab: true,
        reason: "automation_test_exception"
      });
    }
    await updateActiveJob(jobId, {
      status: C.JOB_STATUS.ERROR,
      detail: error.message,
      completed_at: new Date().toISOString(),
      diagnostics
    });
    return {
      ok: false,
      jobId,
      error: error.message,
      message: error.message,
      diagnostics,
      chatgpt: {
        tabId: testTabId,
        kept_open: Boolean(testTabId)
      },
      duration_ms: Date.now() - startedAt
    };
  }
}

async function handleGenerate(message, sender, emitFromPort) {
  const whatsappTabId = message.whatsappTabId || (sender && sender.tab && sender.tab.id);
  if (!whatsappTabId) {
    throw new Error("Nao foi possivel identificar a aba do WhatsApp.");
  }

  const conversation = message.conversation;
  const options = message.options || {};
  const jobId = message.jobId || `job-${Date.now()}`;
  const emit = emitFromPort || createEmitter(null, whatsappTabId, jobId);
  const visualContextKey = message.visualContextKey || conversation.visual_context_key || "";
  const prompt = Prompt.buildFichaPromptAsync
    ? await Prompt.buildFichaPromptAsync(conversation, options)
    : Prompt.buildFichaPrompt(conversation, options);
  Logger.debug("background recebeu pedido de geracao", {
    jobId,
    client: conversation.client_name,
    messages: conversation.message_count
  });

  await transitionJob(jobId, C.JOB_STATUS.IDLE, "Job recebido no background.", {
    whatsappTabId,
    client_name: conversation.client_name,
    message_count: conversation.message_count
  });
  await updateActiveJob(jobId, {
    detail: "Job recebido no background.",
    whatsappTabId,
    started_at: new Date().toISOString(),
    client_name: conversation.client_name,
    message_count: conversation.message_count
  });

  await Storage.set(C.STORAGE_KEYS.LAST_CONVERSATION, conversation);
  await Storage.set(C.STORAGE_KEYS.LAST_PROMPT, prompt);
  await Logger.savePrompt({
    prompt,
    conversation,
    metadata: {
      jobId,
      prompt_length: prompt.length,
      preprocessing: conversation.preprocessing || null,
      visual_context_key: visualContextKey,
      visual_metrics: conversation.visual_context && conversation.visual_context.metrics ? conversation.visual_context.metrics : {}
    }
  });
  await Logger.add({
    status: "PROMPT_SENT",
    client: conversation.client_name,
    message: "PROMPT_SENT",
    metadata: {
      jobId,
      prompt_length: prompt.length,
      prompt_source: prompt.includes("GERADOR DE FICHAS DE PEDIDOS") ? "ANALISE.txt" : "ERP_FALLBACK"
    }
  });
  if (visualContextKey || conversation.visual_context) {
    await Logger.add({
      status: "VISUAL_CONTEXT_READY",
      client: conversation.client_name,
      message: "VISUAL_CONTEXT_READY",
      metadata: {
        jobId,
        visual_context_key: visualContextKey,
        metrics: conversation.visual_context && conversation.visual_context.metrics ? conversation.visual_context.metrics : {}
      }
    });
  }
  await Storage.append(C.STORAGE_KEYS.RUN_HISTORY, {
    jobId,
    client_name: conversation.client_name,
    message_count: conversation.message_count,
    started_at: new Date().toISOString()
  }, 30);

  const backendOnline = await checkBackendHealth();
  if (!backendOnline) {
    await emit(C.JOB_STATUS.OPENING_PROJECT, "Backend opcional offline; seguindo sem logs locais.");
  } else {
    postBackend("/logs", {
      type: "generate_started",
      level: "info",
      message: "Geracao iniciada pela extensao",
      metadata: {
        jobId,
        client_name: conversation.client_name,
        message_count: conversation.message_count
      }
    });
  }

  // ChatGPT ficha always runs. Material API also runs if configured.
  const settings = Settings ? await Settings.get() : null;
  const materialApiConfigured = Boolean(Settings && Settings.materialApiReady(settings));

  await emit(C.JOB_STATUS.SENDING_PROMPT, "Preparando geraÃ§Ã£o da ficha...", {
    prompt_length: prompt.length,
    material_api: materialApiConfigured
  });

  // Silent emitter for Material API â€” logs but does not override main status bar
  const materialEmit = async (status, detail, extra) => {
    await Logger.add({
      status,
      message: detail,
      metadata: { jobId, mode: "material_api", ...(extra || {}) }
    });
  };

  // Função ChatGPT: backend Playwright na VPS (processa 100% no servidor sem abrir abas locais)
  const runChatGpt = async () => {
    try {
      return await runChatGptViaBackend({ jobId, prompt, conversation }, emit);
    } catch (err) {
      if (err && err.message) {
        throw err;
      }
      throw new Error(`Falha no servidor VPS: ${err}`);
    }
  };

  // Run ChatGPT + Material API em paralelo
  const [chatGptSettled, materialSettled] = await Promise.allSettled([
    runChatGpt(),
    materialApiConfigured
      ? runMaterialApiGeneration(jobId, { prompt, conversation, visualContextKey, settings, options }, materialEmit)
      : Promise.resolve(null)
  ]);

  const chatGptResult = chatGptSettled.status === "fulfilled" ? chatGptSettled.value : null;
  const materialResult = materialSettled.status === "fulfilled" ? materialSettled.value : null;
  const chatGptError = chatGptSettled.status === "rejected" ? chatGptSettled.reason : null;

  // Cleanup ChatGPT tab (sÃ³ existe no modo fallback de aba direta)
  const chatGptOk = Boolean(chatGptResult && chatGptResult.ok);
  const fallbackTabId = await getChatGPTTabId(jobId);
  if (fallbackTabId) {
    const keepTab = C.DEBUG_CHATGPT_AUTOMATION || (!chatGptOk && C.DEBUG_KEEP_FAILED_TAB);
    const cleanupTabId = await cleanupChatGPTTab(jobId, {
      keepTab,
      reason: chatGptOk ? "success" : "chatgpt_failed"
    });
    if (keepTab) {
      await emit("debug", "Aba do ChatGPT mantida aberta para debug.", { tabId: cleanupTabId });
    }
  }

  // If ChatGPT failed and no material result, throw the ChatGPT error
  if (!chatGptResult && !materialResult) {
    throw chatGptError || new Error("Geracao falhou: ChatGPT e Material API nao retornaram resultado.");
  }

  // ChatGPT answer is the ficha text; Material API contributes download links
  const responseText = (chatGptResult && chatGptResult.answer) ? chatGptResult.answer : "";
  const downloadUrl = (materialResult && materialResult.downloadUrl) ? materialResult.downloadUrl : "";
  const downloadId = (materialResult && materialResult.downloadId) ? materialResult.downloadId : "";

  if (chatGptError) {
    await Logger.add({
      status: "chatgpt_partial_fail",
      client: conversation.client_name,
      message: `ChatGPT falhou mas Material API gerou resultado. Erro ChatGPT: ${chatGptError.message}`,
      metadata: { jobId }
    });
  }
  if (materialSettled.status === "rejected") {
    await Logger.add({
      status: "material_api_partial_fail",
      client: conversation.client_name,
      message: `Material API falhou mas ChatGPT gerou ficha. Erro: ${materialSettled.reason && materialSettled.reason.message ? materialSettled.reason.message : "desconhecido"}`,
      metadata: { jobId }
    });
  }

  await Logger.add({
    status: "RESPONSE_RECEIVED",
    client: conversation.client_name,
    message: "RESPONSE_RECEIVED",
    metadata: {
      jobId,
      response_length: responseText.length,
      has_download: Boolean(downloadUrl),
      chatgpt_ok: chatGptOk,
      material_ok: Boolean(materialResult),
      visual_attachment: chatGptResult && chatGptResult.visualAttachmentResult ? chatGptResult.visualAttachmentResult : null
    }
  });
  await Storage.set(C.STORAGE_KEYS.LAST_RESPONSE, {
    jobId,
    answer: responseText,
    conversation,
    provider: C.PROVIDERS.CHATGPT,
    downloadUrl,
    downloadId,
    materialApiOk: Boolean(materialResult),
    visualAttachmentResult: chatGptResult && chatGptResult.visualAttachmentResult ? chatGptResult.visualAttachmentResult : null,
    manualFallback: Boolean(chatGptResult && chatGptResult.manualFallback),
    captured_at: new Date().toISOString()
  });
  if (downloadUrl || downloadId) {
    await Storage.set(C.STORAGE_KEYS.LAST_DOWNLOAD, {
      jobId,
      downloadUrl,
      downloadId,
      client_name: conversation.client_name || "",
      created_at: new Date().toISOString()
    });
  }

  await emit(C.JOB_STATUS.RENDERING, "Ficha capturada. Preparando resultado no WhatsApp.");

  const overallOk = chatGptOk || Boolean(materialResult);
  const result = {
    ok: overallOk,
    jobId,
    prompt,
    conversation,
    answer: responseText,
    provider: C.PROVIDERS.CHATGPT,
    downloadUrl,
    downloadId,
    materialApiOk: Boolean(materialResult),
    manualFallback: Boolean(chatGptResult && chatGptResult.manualFallback),
    chatgpt: { tabId: null, closed: true },
    visualAttachmentResult: chatGptResult && chatGptResult.visualAttachmentResult ? chatGptResult.visualAttachmentResult : null,
    backgroundTabClosed: true,
    message: chatGptResult && chatGptResult.message ? chatGptResult.message : (materialResult && materialResult.message ? materialResult.message : "")
  };
  await transitionJob(jobId, overallOk ? C.JOB_STATUS.COMPLETED : C.JOB_STATUS.ERROR, result.message, {
    answer_length: responseText.length
  });
  await updateActiveJob(jobId, { completed_at: new Date().toISOString() });
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === C.MESSAGE_TYPES.CAPTURE_VISIBLE_TAB) {
    (async () => {
      const tab = sender && sender.tab ? sender.tab : null;
      if (!tab || !tab.windowId) {
        throw new Error("Nao foi possivel identificar a janela ativa para captura visual.");
      }
      const dataUrl = await captureVisibleTab(tab.windowId, {
        format: message.format || "png"
      });
      sendResponse({
        ok: true,
        dataUrl,
        tabId: tab.id,
        windowId: tab.windowId,
        captured_at: new Date().toISOString()
      });
    })().catch((error) => {
      Logger.debug("falha capturando aba visivel do WhatsApp", {
        error: error.message
      });
      sendResponse({
        ok: false,
        error: error.message || "Falha capturando screenshot da conversa."
      });
    });
    return true;
  }

  if (message && message.type === C.MESSAGE_TYPES.CHATGPT_AUTOMATION_STATUS) {
    (async () => {
      const jobId = message.jobId;
      if (!jobId) {
        return;
      }
      const job = await getActiveJob(jobId);
      await transitionJob(jobId, message.status || C.JOB_STATUS.OPENING_PROJECT, message.detail || "", message.extra || {});
      await Logger.add({
        status: message.status || "chatgpt",
        message: message.detail || "Status da automacao ChatGPT.",
        metadata: {
          jobId,
          ...(message.extra || {})
        }
      });
      if (job && job.whatsappTabId) {
        await sendStatus(job.whatsappTabId, message.status, message.detail, message.extra || {});
      }
    })().finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message && message.type === C.MESSAGE_TYPES.CHATGPT_AUTOMATION_TEST) {
    handleChatGptAutomationTest(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Falha inesperada no CHATGPT_AUTOMATION_TEST.",
          message: error.message || "Falha inesperada no CHATGPT_AUTOMATION_TEST."
        });
      });
    return true;
  }

  if (message && message.type === C.MESSAGE_TYPES.CHATGPT_INSPECT) {
    handleChatGptInspect(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Falha inesperada em INSPECIONAR CHATGPT.",
          message: error.message || "Falha inesperada em INSPECIONAR CHATGPT."
        });
      });
    return true;
  }

  if (message && message.type === C.MESSAGE_TYPES.VPS_LOGIN_STATUS) {
    fetch(`${C.BACKEND_URL}/login/status`)
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message && message.type === C.MESSAGE_TYPES.VPS_LOGIN_START) {
    fetch(`${C.BACKEND_URL}/login/start`, { method: "POST" })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message && message.type === C.MESSAGE_TYPES.VPS_LOGIN_VERIFY) {
    fetch(`${C.BACKEND_URL}/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: message.code })
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message && message.type === C.MESSAGE_TYPES.VPS_LOGIN_RESEND) {
    fetch(`${C.BACKEND_URL}/login/resend`, { method: "POST" })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (!message || message.type !== C.MESSAGE_TYPES.GENERATE) {
    return false;
  }

  handleGenerate(message, sender)
    .then((result) => sendResponse(result))
    .catch(async (error) => {
      const tabId = sender && sender.tab && sender.tab.id;
      if (tabId) {
        await sendStatus(tabId, "error", error.message);
      }
      postBackend("/diagnostics", {
        type: "generate_failed",
        level: "error",
        message: error.message,
        metadata: {
          stack: error.stack
        }
      });
      sendResponse({
        ok: false,
        error: error.message || "Falha inesperada gerando ficha."
      });
    });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== C.PORT_GENERATE) {
    return;
  }

  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    Logger.debug("porta de geracao desconectada", {
      error: chrome.runtime.lastError && chrome.runtime.lastError.message
    });
  });

  port.onMessage.addListener((message) => {
    if (!message || message.type !== C.MESSAGE_TYPES.GENERATE_PORT_START) {
      return;
    }

    const whatsappTabId = port.sender && port.sender.tab && port.sender.tab.id;
    const jobId = message.jobId || `job-${Date.now()}`;
    const emit = createEmitter(port, whatsappTabId, jobId);

    handleGenerate({
      ...message,
      jobId,
      whatsappTabId
    }, port.sender, emit)
      .then(async (result) => {
        if (whatsappTabId) {
          try {
            await tabsSendMessage(whatsappTabId, {
              type: C.MESSAGE_TYPES.GENERATE_PORT_RESULT,
              jobId,
              result
            });
          } catch (error) {
            Logger.debug("resultado nao entregue via tab", { jobId, error: error.message });
          }
        }
        safePortPost(port, {
          type: C.MESSAGE_TYPES.GENERATE_PORT_RESULT,
          jobId,
          result
        });
        await clearActiveJob(jobId);
      })
      .catch(async (error) => {
        const payload = {
          type: C.MESSAGE_TYPES.GENERATE_PORT_ERROR,
          jobId,
          error: error.message || "Falha inesperada gerando ficha."
        };
        if (!disconnected) {
          safePortPost(port, payload);
        }
        await updateActiveJob(jobId, {
          status: "error",
          detail: payload.error,
          completed_at: new Date().toISOString()
        });
        if (whatsappTabId) {
          await sendStatus(whatsappTabId, "error", payload.error);
          try {
            await tabsSendMessage(whatsappTabId, payload);
          } catch (sendError) {
            Logger.debug("erro nao entregue via tab", { jobId, error: sendError.message });
          }
        }
        postBackend("/diagnostics", {
          type: "generate_failed",
          level: "error",
          message: payload.error,
          metadata: {
            jobId,
            stack: error.stack
          }
        });
      });
  });
});
