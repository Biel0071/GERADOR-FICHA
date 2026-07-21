(function () {
  if (globalThis.ProjetoFichaPanel) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants;
  const Dom = globalThis.ProjetoFichaDom;
  const Logger = globalThis.ProjetoFichaLogger;
  const Settings = globalThis.ProjetoFichaSettings;

  let observer = null;
  let retryTimer = null;
  let elapsedTimer = null;
  let callbacks = {};
  let busy = false;
  let startedAt = 0;
  let lastConversation = null;
  let lastStatus = "aguardando";
  let lastDetail = "Aguardando conversa ativa.";
  let lastProgress = 0;
  let minimized = false;
  let recentLogs = [];
  let metrics = {
    prompt_length: 0,
    response_length: 0,
    tabId: "",
    retries: 0,
    warnings: 0
  };

  const STATUS_LABELS = {
    idle: "aguardando",
    capturing: "capturando",
    preprocessing: "preprocessando",
    opening_project: "abrindo Projeto FICHA",
    creating_chat: "criando conversa",
    waiting_composer: "aguardando campo",
    sending_prompt: "enviando prompt",
    waiting_stream: "aguardando IA",
    capturing_response: "capturando resposta",
    parsing: "interpretando ficha",
    rendering: "renderizando",
    completed: "ficha pronta",
    aguardando: "aguardando",
    capturando: "capturando conversa",
    limpando: "limpando conversa",
    opening_chatgpt: "abrindo projeto FICHA",
    sending_prompt: "enviando prompt",
    waiting_response: "aguardando resposta",
    returning: "ficha pronta",
    success: "ficha pronta",
    error: "erro",
    backend_offline: "backend offline"
  };

  function root() {
    return document.querySelector("[data-projeto-ficha-panel='true']");
  }

  function findHeaderAnchor() {
    const header = Dom.bySelectors(document, C.SELECTORS.whatsappHeader);
    if (header && Dom.isVisible(header)) {
      return header;
    }

    const headers = Array.from(document.querySelectorAll("header"))
      .filter((node) => Dom.isVisible(node));
    return headers.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 280 && rect.top < 120;
    }) || null;
  }

  function findConversationSurface() {
    const main = Dom.bySelectors(document, C.SELECTORS.whatsappMain);
    if (main && Dom.isVisible(main)) {
      return main;
    }

    const composer = document.querySelector("[contenteditable='true'][role='textbox'], footer [contenteditable='true']");
    const surface = composer && composer.closest("main, [role='main'], section, div");
    if (surface && Dom.isVisible(surface)) {
      return surface;
    }

    return null;
  }

  function hasConversationSurface() {
    return Boolean(findConversationSurface());
  }

  function updatePanelPosition() {
    const panel = root();
    if (!panel) {
      return;
    }

    const header = findHeaderAnchor();
    const surface = findConversationSurface();

    if (surface) {
      const surfaceRect = surface.getBoundingClientRect();
      const right = Math.max(12, Math.round(window.innerWidth - surfaceRect.right + 18));
      panel.style.setProperty("--pfixa-panel-right", `${right}px`);
      Logger.debug("painel alinhado a area da conversa", {
        right,
        surfaceWidth: Math.round(surfaceRect.width)
      });
    } else {
      panel.style.setProperty("--pfixa-panel-right", "18px");
    }

    if (header) {
      const rect = header.getBoundingClientRect();
      const top = Math.max(70, Math.round(rect.bottom + 10));
      panel.style.setProperty("--pfixa-panel-top", `${top}px`);
      Logger.debug("painel posicionado abaixo do header", { top, headerText: Dom.getText(header).slice(0, 80) });
      return;
    }

    panel.style.setProperty("--pfixa-panel-top", "82px");
    Logger.debug("painel usando posicao fallback");
  }

  function wireProviderControls(panel) {
    const select = panel.querySelector("[data-pfixa-provider]");
    const endpointInput = panel.querySelector("[data-pfixa-material-endpoint]");
    const storeInput = panel.querySelector("[data-pfixa-material-store]");
    const saveBtn = panel.querySelector("[data-pfixa-config-save]");
    const configStatus = panel.querySelector("[data-pfixa-config-status]");
    const tokenBadge = panel.querySelector("[data-pfixa-token-status]");
    const generateLabel = panel.querySelector("[data-pfixa-generate-label]");
    const tabs = panel.querySelectorAll("[data-pfixa-mode-tab]");
    const configs = panel.querySelectorAll("[data-pfixa-mode-config]");

    if (!Settings || !select) {
      return;
    }

    function setConfigStatus(message, tone) {
      if (configStatus) {
        configStatus.textContent = message || "";
        configStatus.dataset.tone = tone || "neutral";
      }
    }

    function applyMode(provider) {
      select.value = provider;
      tabs.forEach((tab) => {
        tab.classList.toggle("is-active", tab.dataset.pfixaModeTab === provider);
      });
      configs.forEach((cfg) => {
        cfg.classList.toggle("is-hidden", cfg.dataset.pfixaModeConfig !== provider);
      });
    }

    function updateGenerateLabel(materialReady) {
      if (generateLabel) {
        generateLabel.textContent = materialReady
          ? "Gerar ficha + orçamento / DANFE"
          : "Gerar ficha ChatGPT";
      }
    }

    Settings.get().then((settings) => {
      applyMode(settings.provider || C.DEFAULT_PROVIDER);
      if (endpointInput) endpointInput.value = settings.materialApi.endpoint || "";
      if (storeInput) storeInput.value = settings.materialApi.storeId || "";
      if (tokenBadge) {
        tokenBadge.textContent = "protegido no backend/.env";
        tokenBadge.dataset.tone = "success";
      }
      updateGenerateLabel(Settings.materialApiReady(settings));
    });

    // --- VPS Playwright Login Wire ---
    const vpsBadge = panel.querySelector("[data-pfixa-vps-session-badge]");
    const vpsStartBtn = panel.querySelector("[data-pfixa-vps-login-start]");
    const vpsOtpContainer = panel.querySelector("[data-pfixa-vps-otp-container]");
    const vpsOtpInput = panel.querySelector("[data-pfixa-vps-otp-input]");
    const vpsOtpSubmit = panel.querySelector("[data-pfixa-vps-otp-submit]");
    const vpsMsg = panel.querySelector("[data-pfixa-vps-login-msg]");

    function checkVpsSessionStatus() {
      try {
        chrome.runtime.sendMessage({ type: C.MESSAGE_TYPES.VPS_LOGIN_STATUS }, (response) => {
          if (chrome.runtime.lastError) {
            if (vpsBadge) { vpsBadge.textContent = "⚠️ Offline"; vpsBadge.dataset.tone = "warning"; }
            if (vpsMsg) { vpsMsg.textContent = "Recarregue a página do WhatsApp."; }
            return;
          }
          if (response && response.ok && response.data) {
            const data = response.data;
            if (data.session_exists) {
              if (vpsBadge) { vpsBadge.textContent = "🟢 Sessão Ativa"; vpsBadge.dataset.tone = "success"; }
              if (vpsMsg) { vpsMsg.textContent = "🟢 VPS logada via Playwright! Pronta para todas as extensões."; }
              if (vpsOtpContainer) { vpsOtpContainer.style.display = "none"; }
              if (vpsStartBtn && vpsStartBtn.parentElement) { vpsStartBtn.parentElement.style.display = "none"; }
            } else {
              if (vpsBadge) { vpsBadge.textContent = "🔴 Não Logada"; vpsBadge.dataset.tone = "error"; }
              if (vpsMsg) { vpsMsg.textContent = "Clique em 'Iniciar Login VPS' para iniciar via Playwright."; }
              if (vpsStartBtn && vpsStartBtn.parentElement) { vpsStartBtn.parentElement.style.display = "flex"; }
            }
          } else {
            if (vpsBadge) { vpsBadge.textContent = "⚠️ Offline"; vpsBadge.dataset.tone = "warning"; }
            if (vpsMsg) { vpsMsg.textContent = "Servidor VPS offline ou sem resposta."; }
          }
        });
      } catch (_) {}
    }

    const vpsEmailInput = panel.querySelector("[data-pfixa-vps-email-input]");

    if (vpsStartBtn) {
      vpsStartBtn.addEventListener("click", () => {
        const email = vpsEmailInput ? vpsEmailInput.value.trim() : "";
        if (vpsMsg) vpsMsg.textContent = "Iniciando Playwright na VPS...";
        if (vpsStartBtn) vpsStartBtn.disabled = true;

        const timer = setTimeout(() => {
          if (vpsStartBtn) vpsStartBtn.disabled = false;
          if (vpsMsg && vpsMsg.textContent.includes("Iniciando")) {
            vpsMsg.textContent = "⏱️ O servidor demorou a responder. Verifique seu e-mail ou clique para tentar novamente.";
          }
        }, 35000);

        chrome.runtime.sendMessage({ type: C.MESSAGE_TYPES.VPS_LOGIN_START, email }, (response) => {
          clearTimeout(timer);
          if (vpsStartBtn) vpsStartBtn.disabled = false;
          if (chrome.runtime.lastError || !response || !response.ok) {
            const err = (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Erro de conexão";
            if (vpsMsg) vpsMsg.textContent = `Erro de conexão com VPS: ${err}`;
            return;
          }
          const data = response.data || {};
          if (data.status === "waiting_code") {
            if (vpsOtpContainer) vpsOtpContainer.style.display = "flex";
            if (vpsBadge) { vpsBadge.textContent = "🟡 Aguardando OTP"; vpsBadge.dataset.tone = "warning"; }
            if (vpsMsg) vpsMsg.textContent = data.message || "Código enviado para o e-mail! Digite o código OTP abaixo:";
          } else if (data.status === "ok") {
            if (vpsOtpContainer) vpsOtpContainer.style.display = "none";
            checkVpsSessionStatus();
          } else {
            if (vpsMsg) vpsMsg.textContent = `⚠️ ${data.message || "Erro no login VPS"}`;
          }
        });
      });
    }

    const vpsOtpResend = panel.querySelector("[data-pfixa-vps-otp-resend]");

    if (vpsOtpSubmit) {
      vpsOtpSubmit.addEventListener("click", () => {
        const code = vpsOtpInput ? vpsOtpInput.value.trim() : "";
        if (!code) {
          if (vpsMsg) vpsMsg.textContent = "Por favor, digite o código OTP de 6 dígitos.";
          return;
        }
        if (vpsMsg) vpsMsg.textContent = "Enviando código OTP para a VPS...";
        if (vpsOtpSubmit) vpsOtpSubmit.disabled = true;
        chrome.runtime.sendMessage({ type: C.MESSAGE_TYPES.VPS_LOGIN_VERIFY, code }, (response) => {
          if (vpsOtpSubmit) vpsOtpSubmit.disabled = false;
          if (chrome.runtime.lastError || !response || !response.ok) {
            const err = (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Erro";
            if (vpsMsg) vpsMsg.textContent = `Erro enviando OTP: ${err}`;
            return;
          }
          const data = response.data || {};
          if (data.status === "ok") {
            if (vpsOtpContainer) vpsOtpContainer.style.display = "none";
            if (vpsOtpInput) vpsOtpInput.value = "";
            checkVpsSessionStatus();
          } else {
            if (vpsBadge) { vpsBadge.textContent = "🔴 Código Incorreto"; vpsBadge.dataset.tone = "error"; }
            if (vpsMsg) vpsMsg.textContent = `❌ ${data.message || "Código incorreto ou expirado"}`;
          }
        });
      });
    }

    if (vpsOtpResend) {
      vpsOtpResend.addEventListener("click", () => {
        if (vpsMsg) vpsMsg.textContent = "Solicitando novo código para o e-mail na VPS...";
        if (vpsOtpResend) vpsOtpResend.disabled = true;
        chrome.runtime.sendMessage({ type: C.MESSAGE_TYPES.VPS_LOGIN_RESEND }, (response) => {
          if (vpsOtpResend) vpsOtpResend.disabled = false;
          if (chrome.runtime.lastError || !response || !response.ok) {
            const err = (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Erro";
            if (vpsMsg) vpsMsg.textContent = `Erro reenviando código: ${err}`;
            return;
          }
          const data = response.data || {};
          if (vpsMsg) vpsMsg.textContent = data.message || "Novo código enviado! Verifique sua caixa de entrada.";
        });
      });
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const provider = tab.dataset.pfixaModeTab;
        applyMode(provider);
        Settings.set({ provider });
      });
    });

    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const endpoint = endpointInput ? endpointInput.value.trim() : "";
        if (endpoint && !/^https?:\/\//i.test(endpoint)) {
          setConfigStatus("Endpoint deve começar com http:// ou https://", "error");
          return;
        }
        Settings.set({
          materialApi: {
            endpoint,
            storeId: storeInput ? storeInput.value.trim() : ""
          }
        }).then(() => {
          setConfigStatus("Salvo. Token protegido no backend.", "success");
          Settings.get().then((s) => updateGenerateLabel(Settings.materialApiReady(s)));
        });
      });
    }

    checkVpsSessionStatus();
  }

  function createPanel() {
    const panel = document.createElement("aside");
    panel.className = "pfixa-panel";
    panel.dataset.projetoFichaPanel = "true";
    panel.setAttribute("aria-label", "Painel operacional Projeto Ficha");
    panel.innerHTML = `
      <div class="pfixa-panel-head">
        <div class="pfixa-panel-head-title">
          <span class="pfixa-panel-logo" aria-hidden="true">📋</span>
          <div>
            <p class="pfixa-panel-kicker">Projeto FICHA</p>
            <h2>GERAR FICHA</h2>
          </div>
        </div>
        <button class="pfixa-panel-min" type="button" data-pfixa-panel-min aria-label="Minimizar painel">−</button>
      </div>

      <div class="pfixa-panel-body">

        <div class="pfixa-panel-status" data-pfixa-panel-status="aguardando">
          <span data-pfixa-status-dot></span>
          <div class="pfixa-panel-status-text">
            <strong data-pfixa-status-label>aguardando</strong>
            <small data-pfixa-status-detail>Aguardando conversa ativa.</small>
          </div>
        </div>

        <div class="pfixa-progress" aria-label="Progresso">
          <span data-pfixa-progress-bar></span>
        </div>

        <dl class="pfixa-panel-metrics">
          <div class="pfixa-metric-wide">
            <dt>Cliente</dt>
            <dd data-pfixa-panel-client>—</dd>
          </div>
          <div>
            <dt>Msgs</dt>
            <dd data-pfixa-panel-count>0</dd>
          </div>
          <div>
            <dt>Tempo</dt>
            <dd data-pfixa-panel-elapsed>00:00</dd>
          </div>
        </dl>

        <div class="pfixa-mode-tabs">
          <button type="button" class="pfixa-mode-tab is-active" data-pfixa-mode-tab="chatgpt">
            <span class="pfixa-mode-tab-icon">💬</span>
            <span class="pfixa-mode-tab-label">Ficha ChatGPT</span>
            <span class="pfixa-mode-tab-sub">sempre ativa</span>
          </button>
          <button type="button" class="pfixa-mode-tab" data-pfixa-mode-tab="material_api">
            <span class="pfixa-mode-tab-icon">📊</span>
            <span class="pfixa-mode-tab-label">Orçamento / DANFE</span>
            <span class="pfixa-mode-tab-sub">adicional c/ token</span>
          </button>
        </div>

        <select id="pfixa-provider-select" data-pfixa-provider style="display:none">
          <option value="chatgpt">ChatGPT (conta logada)</option>
          <option value="material_api">Material API (site/ERP)</option>
        </select>

        <div class="pfixa-mode-config" data-pfixa-mode-config="chatgpt">
          <div class="pfixa-config-row">
            <span class="pfixa-config-label">Conversa ativa</span>
            <a class="pfixa-config-link" href="${C && C.CHATGPT_PROJECT_URL ? C.CHATGPT_PROJECT_URL : "https://chatgpt.com"}" target="_blank" rel="noopener noreferrer" title="Abrir conversa do Projeto FICHA">Ficha de Pedido ↗</a>
          </div>
          <div class="pfixa-vps-login-box" style="margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.04); border-radius: 6px; border: 1px solid rgba(0,0,0,0.08);">
            <div class="pfixa-config-row" style="margin-bottom: 4px;">
              <span class="pfixa-config-label"><strong>Sessão VPS Playwright</strong></span>
              <span class="pfixa-config-badge" data-pfixa-vps-session-badge>verificando...</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
              <input type="email" data-pfixa-vps-email-input placeholder="E-mail da conta ChatGPT" value="luukasgmct2033@hotmail.com" style="padding: 5px 8px; background: #ffffff !important; color: #111827 !important; border: 1px solid #9ca3af; border-radius: 4px; font-size: 12px; font-weight: 600;" />
              <button type="button" class="pfixa-btn pfixa-btn-sm" data-pfixa-vps-login-start style="width: 100%; font-weight: 700;">🤖 Iniciar Login VPS</button>
            </div>
            <div class="pfixa-vps-otp-row" data-pfixa-vps-otp-container style="display: none; margin-top: 6px; gap: 4px; flex-wrap: wrap;">
              <input type="text" data-pfixa-vps-otp-input placeholder="Código OTP (6 dígitos)" style="flex:1; min-width: 120px; padding: 6px 8px; background: #ffffff !important; color: #111827 !important; border: 1px solid #9ca3af; border-radius: 4px; font-size: 13px; font-weight: 700; text-align: center;" />
              <button type="button" class="pfixa-btn pfixa-btn-sm pfixa-btn-primary" data-pfixa-vps-otp-submit>Confirmar OTP</button>
              <button type="button" class="pfixa-btn pfixa-btn-sm" data-pfixa-vps-otp-resend title="Solicitar novo código OTP para o e-mail">🔁 Reenviar Código</button>
            </div>
            <small class="pfixa-config-status" data-pfixa-vps-login-msg style="display: block; margin-top: 4px; font-size: 11px;"></small>
          </div>
          <p class="pfixa-config-note" style="margin-top: 6px;">O Playwright roda na VPS com a sessão salva em <code>chatgpt_session.json</code> e atende todas as extensões conectadas.</p>
        </div>

        <div class="pfixa-mode-config is-hidden" data-pfixa-mode-config="material_api">
          <div class="pfixa-config-row">
            <span class="pfixa-config-label">Token</span>
            <span class="pfixa-config-badge" data-pfixa-token-status>backend/.env</span>
          </div>
          <label class="pfixa-config-field">
            <span>Endpoint do backend</span>
            <input type="url" data-pfixa-material-endpoint placeholder="http://209.50.241.22:8000/generate-order" />
          </label>
          <label class="pfixa-config-field">
            <span>ID da loja <em>(opcional)</em></span>
            <input type="text" data-pfixa-material-store placeholder="loja ativa" />
          </label>
          <button type="button" class="pfixa-btn pfixa-btn-save" data-pfixa-config-save>Salvar configuração</button>
          <small class="pfixa-config-status" data-pfixa-config-status></small>
          <p class="pfixa-config-note">O token fica protegido em <code>backend/.env</code> e nunca é salvo no Chrome.</p>
        </div>

        <div class="pfixa-panel-main-actions" style="display: flex; flex-direction: column; gap: 6px;">
          <button class="pfixa-btn pfixa-btn-primary" type="button" data-pfixa-panel-generate style="width: 100%; font-weight: 700; padding: 10px 12px; font-size: 13px;">
            <span data-pfixa-generate-label>📋 Gerar Ficha ChatGPT</span>
          </button>
          <button class="pfixa-btn" type="button" data-pfixa-panel-generate-material style="width: 100%; background: #0f766e; color: #ffffff; font-weight: 700; padding: 9px 12px; font-size: 13px; border: none; border-radius: 6px; cursor: pointer;">
            <span>📊 Gerar Orçamento / DANFE</span>
          </button>
          <button class="pfixa-btn pfixa-btn-ghost" type="button" data-pfixa-panel-regenerate style="margin-top: 2px;">Regerar Ficha</button>
        </div>

        <div class="pfixa-panel-result-actions is-hidden" data-pfixa-result-actions>
          <button class="pfixa-btn pfixa-btn-result-copy" type="button" data-pfixa-panel-copy-ficha>
            📋 Copiar ficha
          </button>
          <a class="pfixa-btn pfixa-btn-result-download is-hidden" data-pfixa-panel-download target="_blank" rel="noopener noreferrer">
            ⬇ Baixar orçamento / DANFE
          </a>
        </div>

        <div class="pfixa-panel-secondary-actions">
          <button class="pfixa-btn pfixa-btn-sm" type="button" data-pfixa-panel-history>Histórico</button>
          <button class="pfixa-btn pfixa-btn-sm" type="button" data-pfixa-panel-copy>Copiar última</button>
          <button class="pfixa-btn pfixa-btn-sm" type="button" data-pfixa-panel-logs>Logs</button>
        </div>

        <details class="pfixa-panel-tools">
          <summary>Ferramentas de debug</summary>
          <div class="pfixa-panel-tools-body">
            <button class="pfixa-btn pfixa-btn-sm" type="button" data-pfixa-panel-test-chatgpt>Testar ChatGPT</button>
            <button class="pfixa-btn pfixa-btn-sm" type="button" data-pfixa-panel-inspect-chatgpt>Inspecionar DOM</button>
          </div>
        </details>

        <details class="pfixa-panel-logbox" open>
          <summary>Últimos logs</summary>
          <ol data-pfixa-panel-logs-list></ol>
        </details>

        <dl class="pfixa-panel-details">
          <div><dt>Prompt</dt><dd data-pfixa-panel-prompt>0</dd></div>
          <div><dt>Resposta</dt><dd data-pfixa-panel-response>0</dd></div>
          <div><dt>Tab</dt><dd data-pfixa-panel-tab>-</dd></div>
          <div><dt>Retries</dt><dd data-pfixa-panel-retries>0</dd></div>
          <div><dt>Warns</dt><dd data-pfixa-panel-warnings>0</dd></div>
        </dl>

      </div>
    `;

    panel.querySelector("[data-pfixa-panel-min]").addEventListener("click", () => {
      minimized = !minimized;
      panel.classList.toggle("is-minimized", minimized);
      panel.querySelector("[data-pfixa-panel-min]").textContent = minimized ? "+" : "−";
    });

    const genChatGptBtn = panel.querySelector("[data-pfixa-panel-generate]");
    if (genChatGptBtn) {
      genChatGptBtn.addEventListener("click", () => {
        if (!busy && callbacks.onGenerate) {
          if (Settings) {
            Settings.set({ provider: "chatgpt" }).then(() => callbacks.onGenerate());
          } else {
            callbacks.onGenerate();
          }
        }
      });
    }

    const genMaterialBtn = panel.querySelector("[data-pfixa-panel-generate-material]");
    if (genMaterialBtn) {
      genMaterialBtn.addEventListener("click", () => {
        if (!busy && callbacks.onGenerate) {
          if (Settings) {
            Settings.set({ provider: "material_api" }).then(() => callbacks.onGenerate());
          } else {
            callbacks.onGenerate();
          }
        }
      });
    }
    panel.querySelector("[data-pfixa-panel-test-chatgpt]").addEventListener("click", () => {
      if (!busy && callbacks.onTestChatGPT) {
        callbacks.onTestChatGPT();
      }
    });
    panel.querySelector("[data-pfixa-panel-inspect-chatgpt]").addEventListener("click", () => {
      if (!busy && callbacks.onInspectChatGPT) {
        callbacks.onInspectChatGPT();
      }
    });
    panel.querySelector("[data-pfixa-panel-regenerate]").addEventListener("click", () => {
      if (!busy && callbacks.onRegenerate) {
        callbacks.onRegenerate();
      }
    });
    panel.querySelector("[data-pfixa-panel-logs]").addEventListener("click", () => {
      if (callbacks.onOpenLogs) {
        callbacks.onOpenLogs();
      }
    });
    panel.querySelector("[data-pfixa-panel-copy]").addEventListener("click", () => {
      if (callbacks.onCopyLast) {
        callbacks.onCopyLast();
      }
    });
    panel.querySelector("[data-pfixa-panel-copy-ficha]").addEventListener("click", () => {
      if (callbacks.onCopyLast) {
        callbacks.onCopyLast();
      }
    });
    panel.querySelector("[data-pfixa-panel-history]").addEventListener("click", () => {
      if (callbacks.onHistory) {
        callbacks.onHistory();
      }
    });

    wireProviderControls(panel);

    document.body.appendChild(panel);
    Logger.debug("painel operacional injetado", { url: location.href });
    return panel;
  }

  function ensurePanel() {
    if (!document.body) {
      return null;
    }

    let panel = root();
    if (!panel || !document.body.contains(panel)) {
      panel = createPanel();
      renderAll();
    } else if (document.body.lastElementChild !== panel && !document.body.lastElementChild.classList.contains("pfixa-overlay")) {
      document.body.appendChild(panel);
    }

    panel.style.setProperty("z-index", "2147483647", "important");
    panel.classList.toggle("has-conversation", hasConversationSurface());
    updatePanelPosition();
    return panel;
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = String(Math.floor(total / 60)).padStart(2, "0");
    const seconds = String(total % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function setText(panel, selector, value) {
    const node = panel.querySelector(selector);
    if (node) {
      node.textContent = value;
    }
  }

  function renderStatus() {
    const panel = ensurePanel();
    if (!panel) {
      return;
    }
    const label = STATUS_LABELS[lastStatus] || lastStatus || "aguardando";
    const statusNode = panel.querySelector("[data-pfixa-panel-status]");
    statusNode.dataset.pfixaPanelStatus = lastStatus;
    setText(panel, "[data-pfixa-status-label]", label);
    setText(panel, "[data-pfixa-status-detail]", lastDetail || "");

    const progress = Math.max(0, Math.min(100, Number(lastProgress) || 0));
    const bar = panel.querySelector("[data-pfixa-progress-bar]");
    if (bar) {
      bar.style.width = `${progress}%`;
    }
  }

  function renderConversation() {
    const panel = ensurePanel();
    if (!panel) {
      return;
    }
    const conversation = lastConversation || {};
    setText(panel, "[data-pfixa-panel-client]", conversation.client_name || "CONFIRMAR");
    const count = conversation.captured_message_count
      ? `${conversation.message_count || 0}/${conversation.captured_message_count}`
      : String(conversation.message_count || 0);
    setText(panel, "[data-pfixa-panel-count]", count);
  }

  function renderElapsed() {
    const panel = root();
    if (!panel) {
      return;
    }
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    setText(panel, "[data-pfixa-panel-elapsed]", formatElapsed(elapsed));
  }

  function renderBusy() {
    const panel = ensurePanel();
    if (!panel) {
      return;
    }
    panel.classList.toggle("is-busy", busy);
    panel.querySelectorAll("[data-pfixa-panel-generate], [data-pfixa-panel-test-chatgpt], [data-pfixa-panel-inspect-chatgpt], [data-pfixa-panel-regenerate], [data-pfixa-panel-copy-ficha], [data-pfixa-mode-tab]").forEach((button) => {
      button.disabled = busy;
    });
  }

  function renderMetrics() {
    const panel = ensurePanel();
    if (!panel) {
      return;
    }
    setText(panel, "[data-pfixa-panel-prompt]", String(metrics.prompt_length || 0));
    setText(panel, "[data-pfixa-panel-response]", String(metrics.response_length || 0));
    setText(panel, "[data-pfixa-panel-tab]", metrics.tabId ? String(metrics.tabId) : "-");
    setText(panel, "[data-pfixa-panel-retries]", String(metrics.retries || 0));
    setText(panel, "[data-pfixa-panel-warnings]", String(metrics.warnings || 0));
  }

  function renderLogs() {
    const panel = ensurePanel();
    if (!panel) {
      return;
    }
    const list = panel.querySelector("[data-pfixa-panel-logs-list]");
    list.textContent = "";
    const visibleLogs = recentLogs.slice(0, 5);
    if (!visibleLogs.length) {
      const item = document.createElement("li");
      item.textContent = "Sem logs ainda.";
      list.appendChild(item);
      return;
    }

    visibleLogs.forEach((entry) => {
      const item = document.createElement("li");
      const time = entry.time ? new Date(entry.time).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
      item.innerHTML = `<span>${time}</span><strong>${entry.status || "info"}</strong><em>${entry.message || ""}</em>`;
      list.appendChild(item);
    });
  }

  function renderAll() {
    renderStatus();
    renderConversation();
    renderElapsed();
    renderBusy();
    renderMetrics();
    renderLogs();
  }

  async function refreshDownloadLink() {
    const panel = root();
    if (!panel) {
      return;
    }
    const resultActions = panel.querySelector("[data-pfixa-result-actions]");
    const downloadLink = panel.querySelector("[data-pfixa-panel-download]");

    try {
      const lastFicha = await Logger.getLastFicha();
      const lastDownload = await Storage.get(C.STORAGE_KEYS.LAST_DOWNLOAD, null);
      const hasFicha = Boolean(lastFicha && lastFicha.answer);
      const hasDownload = Boolean(lastDownload && lastDownload.downloadUrl);

      if (resultActions) {
        resultActions.classList.toggle("is-hidden", !hasFicha && !hasDownload);
      }

      if (downloadLink) {
        if (hasDownload) {
          downloadLink.href = lastDownload.downloadUrl;
          downloadLink.textContent = `⬇ Orçamento / DANFE`;
          downloadLink.classList.remove("is-hidden");
        } else {
          downloadLink.removeAttribute("href");
          downloadLink.classList.add("is-hidden");
        }
      }
    } catch (error) {
      if (resultActions) resultActions.classList.add("is-hidden");
      if (downloadLink) downloadLink.classList.add("is-hidden");
    }
  }

  async function refreshLogs() {
    recentLogs = await Logger.getLogs(8);
    renderLogs();
  }

  async function addLog(entry) {
    const log = await Logger.add(entry || {});
    recentLogs.unshift(log);
    recentLogs = recentLogs.slice(0, 8);
    renderLogs();
    return log;
  }

  function setStatus(status, detail, progress) {
    lastStatus = status || "aguardando";
    lastDetail = detail || "";
    if (Number.isFinite(progress)) {
      lastProgress = progress;
    }
    Logger.debug("status painel", { status: lastStatus, detail: lastDetail, progress: lastProgress });
    renderStatus();
    if (status === "completed" || status === "success") {
      refreshDownloadLink();
    }
  }

  function setConversation(conversation) {
    lastConversation = conversation || null;
    metrics.warnings = conversation && Array.isArray(conversation.capture_warnings) ? conversation.capture_warnings.length : metrics.warnings;
    renderConversation();
    renderMetrics();
  }

  function setMetrics(nextMetrics) {
    const next = nextMetrics || {};
    metrics = {
      ...metrics,
      ...next
    };
    if (next.tabId !== undefined) {
      metrics.tabId = next.tabId || "";
    }
    if (next.attempt !== undefined) {
      metrics.retries = Math.max(metrics.retries || 0, Math.max(0, Number(next.attempt) - 1));
    }
    renderMetrics();
  }

  function setBusy(nextBusy) {
    busy = Boolean(nextBusy);
    if (busy) {
      startedAt = Date.now();
      clearInterval(elapsedTimer);
      elapsedTimer = setInterval(renderElapsed, 1000);
    } else {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    renderBusy();
    renderElapsed();
  }

  function start(nextCallbacks) {
    callbacks = nextCallbacks || {};
    ensurePanel();
    refreshLogs();
    refreshDownloadLink();

    if (observer) {
      observer.disconnect();
    }
    clearInterval(retryTimer);

    const scheduleEnsure = (() => {
      let timer = null;
      return () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          ensurePanel();
          renderAll();
        }, 250);
      };
    })();

    observer = new MutationObserver((mutations) => {
      const panelRemoved = mutations.some((mutation) =>
        Array.from(mutation.removedNodes).some((node) =>
          node.nodeType === Node.ELEMENT_NODE &&
          (node.matches && node.matches("[data-projeto-ficha-panel='true']") ||
            node.querySelector && node.querySelector("[data-projeto-ficha-panel='true']"))
        )
      );
      if (panelRemoved) {
        Logger.debug("painel removido do DOM; reinjetando");
      }
      scheduleEnsure();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    retryTimer = setInterval(() => {
      ensurePanel();
      renderAll();
    }, 2500);

    Logger.debug("observador do painel iniciado");
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearInterval(retryTimer);
    clearInterval(elapsedTimer);
  }

  globalThis.ProjetoFichaPanel = {
    addLog,
    ensurePanel,
    refreshDownloadLink,
    refreshLogs,
    setBusy,
    setConversation,
    setMetrics,
    setStatus,
    start,
    stop
  };

})();
