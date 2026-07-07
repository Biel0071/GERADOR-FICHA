(function () {
  // Projeto Ficha constants
  if (globalThis.ProjetoFichaConstants) {
    return;
  }

  const MESSAGE_TYPES = {
    GENERATE: "PROJETO_FICHA_GENERATE",
    GENERATE_PORT_START: "PROJETO_FICHA_GENERATE_PORT_START",
    GENERATE_PORT_STATUS: "PROJETO_FICHA_GENERATE_PORT_STATUS",
    GENERATE_PORT_RESULT: "PROJETO_FICHA_GENERATE_PORT_RESULT",
    GENERATE_PORT_ERROR: "PROJETO_FICHA_GENERATE_PORT_ERROR",
    STATUS: "PROJETO_FICHA_STATUS",
    RESULT: "PROJETO_FICHA_RESULT",
    ERROR: "PROJETO_FICHA_ERROR",
    CHATGPT_RUN: "PROJETO_FICHA_CHATGPT_RUN",
    CHATGPT_RESULT: "PROJETO_FICHA_CHATGPT_RESULT",
    CHATGPT_AUTOMATION_TEST: "PROJETO_FICHA_CHATGPT_AUTOMATION_TEST",
    CHATGPT_AUTOMATION_TEST_RUN: "PROJETO_FICHA_CHATGPT_AUTOMATION_TEST_RUN",
    CHATGPT_INSPECT: "PROJETO_FICHA_CHATGPT_INSPECT",
    CHATGPT_INSPECT_RUN: "PROJETO_FICHA_CHATGPT_INSPECT_RUN",
    CHATGPT_AUTOMATION_STATUS: "PROJETO_FICHA_CHATGPT_AUTOMATION_STATUS",
    CAPTURE_VISIBLE_TAB: "PROJETO_FICHA_CAPTURE_VISIBLE_TAB",
    GET_SETTINGS: "PROJETO_FICHA_GET_SETTINGS",
    SET_SETTINGS: "PROJETO_FICHA_SET_SETTINGS"
  };

  const PROVIDERS = {
    CHATGPT: "chatgpt",
    MATERIAL_API: "material_api",
    LOVABLE: "lovable"
  };

  const JOB_STATUS = {
    IDLE: "idle",
    CAPTURING: "capturing",
    PREPROCESSING: "preprocessing",
    OPENING_PROJECT: "opening_project",
    CREATING_CHAT: "creating_chat",
    WAITING_COMPOSER: "waiting_composer",
    SENDING_PROMPT: "sending_prompt",
    WAITING_STREAM: "waiting_stream",
    CAPTURING_RESPONSE: "capturing_response",
    PARSING: "parsing",
    RENDERING: "rendering",
    COMPLETED: "completed",
    ERROR: "error"
  };

  const STORAGE_KEYS = {
    ACTIVE_JOB: "projetoFicha.activeJob",
    LAST_CONVERSATION: "projetoFicha.lastConversation",
    LAST_PROMPT: "projetoFicha.lastPrompt",
    LAST_RESPONSE: "projetoFicha.lastResponse",
    LAST_FICHA: "projetoFicha.lastFicha",
    LAST_GENERATED_FICHA: "lastGeneratedFicha",
    LAST_GENERATED_FICHA_META: "projetoFicha.lastGeneratedFichaMeta",
    LAST_VISUAL_CONTEXT: "projetoFicha.lastVisualContext",
    VISUAL_HISTORY: "projetoFicha.visualHistory",
    LAST_CHATGPT_SCREENSHOT: "projetoFicha.lastChatGptScreenshot",
    FICHA_HISTORY: "projetoFicha.fichaHistory",
    PROMPT_HISTORY: "projetoFicha.promptHistory",
    OPERATION_LOGS: "projetoFicha.operationLogs",
    RUN_HISTORY: "projetoFicha.runHistory",
    DIAGNOSTICS: "projetoFicha.diagnostics",
    SETTINGS: "projetoFicha.settings",
    LAST_DOWNLOAD: "projetoFicha.lastDownload"
  };

  const SELECTORS = {
    whatsappHeader: [
      "#main header",
      "[role='main'] header",
      "div[role='application'] header",
      "main header",
      "[data-testid='conversation-header']",
      "[data-testid='conversation-info-header']"
    ],
    whatsappMain: [
      "#main",
      "[role='main']",
      "main",
      "[data-testid='conversation-panel-wrapper']"
    ],
    whatsappMessageContainers: [
      "[data-testid='msg-container']",
      "div.message-in",
      "div.message-out",
      "div[class*='message-in']",
      "div[class*='message-out']",
      "#main div[role='row']"
    ],
    chatgptComposer: [
      "textarea[data-testid='prompt-textarea']",
      "textarea#prompt-textarea",
      "div#prompt-textarea[contenteditable='true']",
      "div[contenteditable='true'][role='textbox']",
      "div.ProseMirror[contenteditable='true']",
      "[data-lexical-editor='true']",
      "form textarea",
      "form [contenteditable='true']",
      "main textarea",
      "main [contenteditable='true']",
      "textarea",
      "[contenteditable='true']"
    ],
    chatgptSendButton: [
      "button[data-testid='send-button']",
      "button[data-testid='composer-send-button']",
      "button[aria-label='Send prompt']",
      "button[aria-label*='Send']",
      "button[aria-label*='Enviar']",
      "form button[type='submit']"
    ],
    chatgptStopButton: [
      "button[data-testid='stop-button']",
      "button[aria-label*='Stop']",
      "button[aria-label*='Parar']"
    ],
    chatgptAssistantMessages: [
      "[data-message-author-role='assistant']",
      "[data-testid*='conversation-turn'] [data-message-author-role='assistant']",
      "[data-testid*='conversation-turn'] article",
      "article [data-message-author-role='assistant']",
      "main [data-testid*='conversation-turn'] [data-message-author-role='assistant']",
      "main article"
    ]
  };

  globalThis.ProjetoFichaConstants = Object.freeze({
    VERSION: "1.1.0",
    DEBUG: true,
    DEBUG_CHATGPT_AUTOMATION: false,
    DEBUG_KEEP_FAILED_TAB: true,
    DEBUG_PREFIX: "[Projeto Ficha]",
    PORT_GENERATE: "projetoFicha.generate",
    FORCE_SEND_TEST: true,
    AUTO_INSERT_WHATSAPP: true,
    ANALISE_PROMPT_PATH: "prompts/ANALISE.txt",
    CHATGPT_AUTOMATION_TEST_PROMPT: "TESTE AUTOMATICO",
    CHATGPT_PROJECT_URL: "https://chatgpt.com/g/g-p-67ffc98923b8819185618d02e7ae7fe2/c/69c12838-6d94-832a-94d5-31987282ab80",
    CHATGPT_PROJECT_ID: "67ffc98923b8819185618d02e7ae7fe2",
    CHATGPT_CONVERSATION_ID: "69c12838-6d94-832a-94d5-31987282ab80",
    BACKEND_URL: "http://127.0.0.1:8000",
    DEFAULT_PROVIDER: "material_api",
    MATERIAL_API_PROXY_URL: "http://127.0.0.1:8000/generate-order",
    MATERIAL_API_DEFAULTS: Object.freeze({
      endpoint: "http://127.0.0.1:8000/generate-order",
      storeId: "",
      timeoutMs: 120000
    }),
    MATERIAL_API_MAX_IMAGES: 12,
    MAX_MESSAGES: 90,
    MAX_CLEAN_MESSAGES: 55,
    HISTORY_SCROLL_ROUNDS: 8,
    HISTORY_SCROLL_DELAY_MS: 450,
    PROJECT_READY_TIMEOUT_MS: 120000,
    PROJECT_HYDRATION_DELAY_MS: 1800,
    COMPOSER_RETRY_ATTEMPTS: 6,
    COMPOSER_RETRY_DELAY_MS: 1200,
    DOM_STABLE_FOR_MS: 2000,
    STEP_WATCHDOG_MS: 60000,
    STEP_RETRY_ATTEMPTS: 2,
    STREAM_STABLE_MS: 4000,
    STREAM_STALE_MS: 60000,
    CHATGPT_TIMEOUT_MS: 180000,
    CHATGPT_STABLE_TEXT_MS: 6500,
    VISUAL_CONTEXT_VERSION: "visual-context-v1",
    VISUAL_MIN_SCREENSHOTS: 3,
    VISUAL_MAX_SCREENSHOTS: 10,
    VISUAL_MAX_WIDTH: 1280,
    VISUAL_JPEG_QUALITY: 0.7,
    VISUAL_MAX_CHAT_IMAGES: 8,
    VISUAL_HISTORY_LIMIT: 12,
    MESSAGE_TYPES,
    PROVIDERS,
    JOB_STATUS,
    STORAGE_KEYS,
    SELECTORS
  });
})();
