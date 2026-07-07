(function () {
  if (globalThis.ProjetoFichaContentStarted) {
    return;
  }
  globalThis.ProjetoFichaContentStarted = true;

  const C = globalThis.ProjetoFichaConstants;
  const Dom = globalThis.ProjetoFichaDom;
  const WhatsApp = globalThis.ProjetoFichaWhatsApp;
  const Preprocess = globalThis.ProjetoFichaPreprocess;
  const Popup = globalThis.ProjetoFichaPopup;
  const Panel = globalThis.ProjetoFichaPanel;
  const Logger = globalThis.ProjetoFichaLogger;
  const Storage = globalThis.ProjetoFichaStorage;
  const ResponseParser = globalThis.ProjetoFichaResponseParser;
  const JOB_STATUS = C.JOB_STATUS;

  let running = false;
  let lastConversation = null;
  let previewTimer = null;
  const completedJobIds = new Set();

  const STATUS_PROGRESS = {
    idle: 0,
    capturing: 10,
    preprocessing: 22,
    opening_project: 34,
    creating_chat: 42,
    waiting_composer: 50,
    sending_prompt: 60,
    waiting_stream: 74,
    capturing_response: 84,
    parsing: 91,
    rendering: 96,
    completed: 100,
    aguardando: 0,
    capturando: 12,
    limpando: 22,
    backend_offline: 18,
    opening_chatgpt: 28,
    waiting_response: 72,
    returning: 92,
    success: 100,
    error: 100
  };

  function isExtensionContextAlive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function captureVisibleWhatsAppTab() {
    const response = await sendRuntimeMessage({
      type: C.MESSAGE_TYPES.CAPTURE_VISIBLE_TAB,
      format: "png"
    });
    if (!response || !response.ok || !response.dataUrl) {
      throw new Error(response && response.error ? response.error : "Falha capturando screenshot da conversa.");
    }
    return response.dataUrl;
  }

  function runBackgroundJob(message) {
    if (!isExtensionContextAlive()) {
      return Promise.reject(new Error("Contexto da extensao foi invalidado. Recarregue a aba do WhatsApp e tente novamente."));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let port = null;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            if (port) {
              port.disconnect();
            }
          } catch (error) {
            Logger.debug("falha ao desconectar porta apos timeout", error.message);
          }
          reject(new Error("Tempo esgotado aguardando o background finalizar a ficha."));
        }
      }, C.CHATGPT_TIMEOUT_MS + C.PROJECT_READY_TIMEOUT_MS + 30000);

      function finish(fn, value) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          if (port) {
            port.disconnect();
          }
        } catch (error) {
          Logger.debug("porta ja desconectada", error.message);
        }
        fn(value);
      }

      try {
        port = chrome.runtime.connect({ name: C.PORT_GENERATE });
        port.onMessage.addListener((payload) => {
          if (!payload || payload.jobId !== message.jobId) {
            return;
          }
          if (payload.type === C.MESSAGE_TYPES.GENERATE_PORT_STATUS) {
            const detail = payload.detail || payload.status || "";
            setStatus(payload.status || "aguardando", detail);
            Panel.setMetrics(payload.extra || {});
            Panel.addLog({
              status: payload.status || "info",
              client: lastConversation && lastConversation.client_name ? lastConversation.client_name : "",
              message: detail,
              metadata: payload.extra || {}
            });
            return;
          }
          if (payload.type === C.MESSAGE_TYPES.GENERATE_PORT_RESULT) {
            finish(resolve, payload.result);
            return;
          }
          if (payload.type === C.MESSAGE_TYPES.GENERATE_PORT_ERROR) {
            finish(reject, new Error(payload.error || "Falha no background."));
          }
        });
        port.onDisconnect.addListener(() => {
          if (settled) {
            return;
          }
          const error = chrome.runtime.lastError;
          Logger.debug("porta de geracao desconectada no content", error && error.message);
          finish(reject, new Error("Conexao com o background foi interrompida. Se voce recarregou a extensao, recarregue tambem a aba do WhatsApp."));
        });
        port.postMessage({
          ...message,
          type: C.MESSAGE_TYPES.GENERATE_PORT_START
        });
      } catch (error) {
        finish(reject, new Error(error.message && /context invalidated/i.test(error.message)
          ? "Contexto da extensao foi invalidado. Recarregue a aba do WhatsApp e tente novamente."
          : error.message || "Falha criando conexao com o background."));
      }
    });
  }

  function validateConversation(conversation) {
    if (!conversation || !Array.isArray(conversation.messages) || !conversation.messages.length) {
      throw new Error("Nao encontrei mensagens carregadas nessa conversa. Abra o chat e tente novamente.");
    }
  }

  function setStatus(status, detail) {
    const progress = STATUS_PROGRESS[status] === undefined ? undefined : STATUS_PROGRESS[status];
    Panel.setStatus(status, detail, progress);
    Popup.setStatus(detail || status || "", status === JOB_STATUS.ERROR || status === "error" ? "error" : status === JOB_STATUS.COMPLETED || status === "success" ? "success" : status === "backend_offline" ? "warning" : "loading");
  }

  async function persistLocalStage(jobId, status, detail, extra) {
    const current = await Storage.get(C.STORAGE_KEYS.ACTIVE_JOB, {});
    const now = new Date().toISOString();
    await Storage.set(C.STORAGE_KEYS.ACTIVE_JOB, {
      ...(current || {}),
      jobId,
      status,
      detail: detail || "",
      updated_at: now,
      current_step_started_at: current && current.status === status && current.current_step_started_at ? current.current_step_started_at : now,
      timeline: [
        ...(((current && current.timeline) || []).slice(-40)),
        { status, detail: detail || "", time: now, extra: extra || {} }
      ],
      extra: extra || {}
    });
  }

  async function copyText(value) {
    if (!value) {
      throw new Error("Nao existe ficha salva para copiar.");
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  }

  async function copyLastFicha() {
    try {
      const lastFicha = await Logger.getLastFicha();
      if (!lastFicha || !lastFicha.answer) {
        throw new Error("Ainda nao existe uma ficha gerada nesta extensao.");
      }
      await copyText(lastFicha.answer);
      Panel.setStatus("success", "Ultima ficha copiada.", 100);
      await Panel.addLog({
        status: "copied",
        client: lastFicha.client || "",
        message: "Ultima ficha copiada pelo painel."
      });
    } catch (error) {
      Panel.setStatus("error", error.message, 100);
      await Panel.addLog({
        status: "error",
        message: "Falha ao copiar ultima ficha.",
        error: error.message
      });
    }
  }

  function prepareCommercialFicha(answer, conversation) {
    if (!ResponseParser) {
      return {
        structured: null,
        formatted: answer || "",
        validation: { ok: Boolean(answer), missing: [] }
      };
    }
    const structured = ResponseParser.parseResponse(answer || "");
    const formatted = ResponseParser.formatCommercialFicha
      ? ResponseParser.formatCommercialFicha(structured, conversation)
      : answer || "";
    const validation = ResponseParser.validateCommercialFicha
      ? ResponseParser.validateCommercialFicha(structured, conversation)
      : { ok: Boolean(formatted), missing: [] };
    return {
      structured,
      formatted,
      validation
    };
  }

  async function persistGeneratedFicha(fichaFinal, conversation, metadata) {
    await Storage.set(C.STORAGE_KEYS.LAST_GENERATED_FICHA, fichaFinal);
    await Storage.set(C.STORAGE_KEYS.LAST_GENERATED_FICHA_META, {
      ficha: fichaFinal,
      conversation,
      metadata: metadata || {},
      saved_at: new Date().toISOString()
    });
    await Logger.saveLastFicha({
      answer: fichaFinal,
      conversation,
      downloadUrl: metadata && metadata.downloadUrl ? metadata.downloadUrl : "",
      downloadId: metadata && metadata.downloadId ? metadata.downloadId : "",
      provider: metadata && metadata.provider ? metadata.provider : "",
      metadata
    });
  }

  function visualContextStorageKey(jobId) {
    return `${C.STORAGE_KEYS.LAST_VISUAL_CONTEXT}.${jobId}`;
  }

  async function attachVisualContextToConversation(jobId, conversation) {
    if (!WhatsApp.captureVisualContext) {
      await Panel.addLog({
        status: "VISUAL_SKIPPED",
        client: conversation.client_name,
        message: "Captura visual nao disponivel; gerando sem screenshots."
      });
      return conversation;
    }

    setStatus(JOB_STATUS.CAPTURING, "Capturando contexto visual da conversa...");
    await Panel.addLog({
      status: "VISUAL_CAPTURE_STARTED",
      client: conversation.client_name,
      message: "VISUAL_CAPTURE_STARTED"
    });

    let visualContext = null;
    try {
      visualContext = await WhatsApp.captureVisualContext({
        messages: conversation.messages || [],
        requestScreenshot: async () => ({ dataUrl: await captureVisibleWhatsAppTab() }),
        onProgress: (progress) => {
          setStatus(JOB_STATUS.CAPTURING, `Capturando tela ${progress.index}/${progress.total} do chat...`);
          Panel.setMetrics({
            visual_progress: `${progress.index}/${progress.total}`
          });
        }
      });
    } catch (captureError) {
      await Panel.addLog({
        status: "VISUAL_CAPTURE_WARN",
        client: conversation.client_name,
        message: `Captura visual falhou (continuando sem imagens): ${captureError.message}`
      });
      return conversation;
    }

    if (!visualContext || !visualContext.screenshots || !visualContext.screenshots.length) {
      await Panel.addLog({
        status: "VISUAL_CAPTURE_WARN",
        client: conversation.client_name,
        message: "Nenhum screenshot capturado; gerando ficha apenas com texto da conversa."
      });
      return conversation;
    }

    const key = visualContextStorageKey(jobId);
    const manifest = WhatsApp.buildVisualContextManifest
      ? WhatsApp.buildVisualContextManifest(visualContext)
      : {
        metrics: {
          screenshot_count: visualContext.screenshots.length,
          image_count: (visualContext.images || []).length
        },
        warnings: visualContext.warnings || []
      };

    try {
      await Storage.set(key, visualContext);
      await Storage.set(C.STORAGE_KEYS.LAST_VISUAL_CONTEXT, visualContext);
    } catch (storageError) {
      await Panel.addLog({
        status: "VISUAL_STORAGE_WARN",
        client: conversation.client_name,
        message: `Nao foi possivel persistir contexto visual (continuando): ${storageError.message}`
      });
      return conversation;
    }

    await Panel.addLog({
      status: "VISUAL_CONTEXT_READY",
      client: conversation.client_name,
      message: "VISUAL_CONTEXT_READY",
      metadata: {
        key,
        metrics: manifest.metrics,
        warnings: manifest.warnings
      }
    });
    Panel.setMetrics({
      visual_screenshots: manifest.metrics ? manifest.metrics.screenshot_count : visualContext.screenshots.length,
      visual_images: manifest.metrics ? manifest.metrics.image_count : (visualContext.images || []).length,
      visual_audio: manifest.metrics ? manifest.metrics.audio_count : (visualContext.audio_transcriptions || []).length
    });

    return {
      ...conversation,
      visual_context_key: key,
      visual_context: manifest
    };
  }

  async function persistVisualHistory(fichaFinal, conversation, metadata) {
    const visualManifest = conversation && conversation.visual_context ? conversation.visual_context : {};
    const entry = {
      jobId: metadata && metadata.jobId ? metadata.jobId : "",
      client_name: conversation && conversation.client_name ? conversation.client_name : "",
      generated_at: new Date().toISOString(),
      visual_context_key: conversation && conversation.visual_context_key ? conversation.visual_context_key : "",
      visual_manifest: visualManifest,
      conversation_used: {
        message_count: conversation && conversation.message_count ? conversation.message_count : 0,
        messages: conversation && Array.isArray(conversation.messages) ? conversation.messages : []
      },
      ficha: fichaFinal,
      metadata: metadata || {}
    };
    await Storage.append(C.STORAGE_KEYS.VISUAL_HISTORY, entry, C.VISUAL_HISTORY_LIMIT || 12);
    await Panel.addLog({
      status: "VISUAL_HISTORY_SAVED",
      client: entry.client_name,
      message: "VISUAL_HISTORY_SAVED",
      metadata: {
        jobId: entry.jobId,
        visual_context_key: entry.visual_context_key,
        metrics: visualManifest.metrics || {}
      }
    });
  }

  async function copyGeneratedFicha(fichaFinal, conversation, metadata) {
    await copyText(fichaFinal);
    await Storage.set(C.STORAGE_KEYS.LAST_GENERATED_FICHA, fichaFinal);
    await Storage.set(C.STORAGE_KEYS.LAST_GENERATED_FICHA_META, {
      ficha: fichaFinal,
      conversation,
      metadata: metadata || {},
      copied_at: new Date().toISOString()
    });
    await Panel.addLog({
      status: "CLIPBOARD_UPDATED",
      client: conversation && conversation.client_name ? conversation.client_name : "",
      message: "CLIPBOARD_UPDATED",
      metadata
    });
    if (Popup.toast) {
      Popup.toast("FICHA COPIADA");
    }
  }

  async function fillWhatsAppWithFicha(fichaFinal, conversation, metadata) {
    if (!C.AUTO_INSERT_WHATSAPP) {
      return { ok: false, skipped: true };
    }
    const result = WhatsApp.fillComposer
      ? await WhatsApp.fillComposer(fichaFinal)
      : { ok: false, error: "Preenchimento do WhatsApp nao esta disponivel." };
    await Panel.addLog({
      status: result.ok ? "WHATSAPP_FILLED" : "WHATSAPP_FILL_FAILED",
      client: conversation && conversation.client_name ? conversation.client_name : "",
      message: result.ok ? "WHATSAPP_FILLED" : (result.error || "Falha ao preencher WhatsApp."),
      metadata: {
        ...(metadata || {}),
        result
      }
    });
    return result;
  }

  async function openLogs() {
    const logs = await Logger.getLogs(50);
    Popup.showLogs(logs, lastConversation);
    Panel.setStatus("aguardando", "Logs abertos no modal.", STATUS_PROGRESS.aguardando);
  }

  async function openHistory() {
    const fichas = await Storage.get(C.STORAGE_KEYS.FICHA_HISTORY, []);
    Popup.showHistory(Array.isArray(fichas) ? fichas.slice().reverse() : [], lastConversation);
    Panel.setStatus("aguardando", "Historico de fichas aberto.", STATUS_PROGRESS.aguardando);
  }

  async function restoreJobState() {
    try {
      const activeJob = await Storage.get(C.STORAGE_KEYS.ACTIVE_JOB, null);
      if (activeJob && activeJob.status && activeJob.status !== JOB_STATUS.COMPLETED && activeJob.status !== "success") {
        Panel.setStatus(activeJob.status, activeJob.detail || "Job em andamento no background.", STATUS_PROGRESS[activeJob.status] || 50);
        await Panel.addLog({
          status: "restore",
          client: activeJob.client_name || "",
          message: `Estado recuperado: ${activeJob.status}.`,
          metadata: activeJob
        });
      }

      const lastResponse = await Storage.get(C.STORAGE_KEYS.LAST_RESPONSE, null);
      if (!lastResponse || (!lastResponse.answer && !lastResponse.downloadUrl) || !lastResponse.captured_at) {
        return;
      }

      const ageMs = Date.now() - new Date(lastResponse.captured_at).getTime();
      const maxAgeMs = lastResponse.downloadUrl ? 8 * 60 * 60 * 1000 : 30 * 60 * 1000;
      if (ageMs > maxAgeMs) {
        return;
      }

      const recovered = {
        ok: true,
        jobId: lastResponse.jobId,
        answer: lastResponse.answer || "",
        downloadUrl: lastResponse.downloadUrl || "",
        downloadId: lastResponse.downloadId || "",
        provider: lastResponse.provider || "",
        conversation: lastResponse.conversation || lastConversation || {},
        message: "Ficha recuperada do storage apos reload."
      };
      lastConversation = recovered.conversation;
      Panel.setConversation(recovered.conversation);
      Popup.showResult(recovered, await Logger.getLogs(12));
      Panel.setStatus(JOB_STATUS.COMPLETED, "Ficha recuperada apos reload.", 100);
    } catch (error) {
      Logger.debug("nao foi possivel restaurar estado do job", error.message);
    }
  }

  function capturePreview() {
    if (running) {
      return;
    }
    try {
      const conversation = WhatsApp.captureConversation({ maxMessages: 12 });
      if (conversation && (conversation.client_name !== "CONFIRMAR" || conversation.message_count > 0)) {
        lastConversation = {
          ...lastConversation,
          ...conversation
        };
        Panel.setConversation(conversation);
        Panel.setStatus("aguardando", "Aguardando comando.", 0);
      } else {
        Panel.setStatus("aguardando", "Aguardando conversa ativa.", 0);
      }
    } catch (error) {
      Logger.debug("preview da conversa ainda indisponivel", error.message);
      Panel.setStatus("aguardando", "Aguardando conversa ativa.", 0);
    }
  }

  async function testChatGPTAutomation() {
    if (running) {
      Panel.setStatus("opening_project", "Ja existe uma operacao em andamento.", 34);
      return;
    }

    const startedAt = Date.now();
    const jobId = Dom.makeId("chatgpt-test");
    running = true;
    Panel.setBusy(true);

    try {
      setStatus(JOB_STATUS.OPENING_PROJECT, "FORCE_SEND_TEST: abrindo Projeto FICHA...");
      await Panel.addLog({
        status: "chatgpt_test",
        message: "Iniciando FORCE_SEND_TEST."
      });

      const result = await sendRuntimeMessage({
        type: C.MESSAGE_TYPES.CHATGPT_AUTOMATION_TEST,
        jobId
      });

      const diagnostics = result && result.diagnostics ? result.diagnostics : {};
      Panel.setMetrics({
        tabId: result && result.chatgpt ? result.chatgpt.tabId : "",
        response_length: diagnostics.responseLength || 0,
        retries: diagnostics.attempt ? Math.max(0, Number(diagnostics.attempt) - 1) : 0
      });

      if (!result || !result.ok) {
        throw new Error(result && (result.message || result.error) ? (result.message || result.error) : "AUTOMACAO FALHOU");
      }

      Panel.setStatus("success", "AUTOMACAO OK", 100);
      await Panel.addLog({
        status: "automation_ok",
        duration_ms: Date.now() - startedAt,
        message: "AUTOMACAO OK",
        metadata: diagnostics
      });
    } catch (error) {
      Panel.setStatus("error", `AUTOMACAO FALHOU: ${error.message}`, 100);
      await Panel.addLog({
        status: "automation_failed",
        duration_ms: Date.now() - startedAt,
        message: "AUTOMACAO FALHOU",
        error: error.message
      });
    } finally {
      running = false;
      Panel.setBusy(false);
      Panel.refreshLogs();
    }
  }

  async function inspectChatGPT() {
    if (running) {
      Panel.setStatus("opening_project", "Ja existe uma operacao em andamento.", 34);
      return;
    }

    const startedAt = Date.now();
    const jobId = Dom.makeId("chatgpt-inspect");
    running = true;
    Panel.setBusy(true);

    try {
      Panel.setStatus(JOB_STATUS.OPENING_PROJECT, "Inspecionando Projeto FICHA...", 34);
      await Panel.addLog({
        status: "chatgpt_inspect",
        message: "Iniciando INSPECIONAR CHATGPT."
      });

      const result = await sendRuntimeMessage({
        type: C.MESSAGE_TYPES.CHATGPT_INSPECT,
        jobId
      });

      if (!result || !result.ok) {
        throw new Error(result && (result.error || result.message) ? (result.error || result.message) : "Falha ao inspecionar ChatGPT.");
      }

      const counts = result.counts || {};
      const message = `URL: ${result.url || "-"} | Titulo: ${result.title || "-"} | Botoes: ${counts.buttons || 0} | Contenteditable: ${counts.contenteditable || 0} | Textarea: ${counts.textarea || 0}`;
      Panel.setStatus("success", "Inspecao ChatGPT concluida.", 100);
      Panel.setMetrics({
        tabId: result.tabId || "",
        response_length: result.bodyTextLength || 0
      });
      await Panel.addLog({
        status: "chatgpt_inspect",
        duration_ms: Date.now() - startedAt,
        message,
        metadata: result
      });
    } catch (error) {
      Panel.setStatus("error", `Falha na inspecao: ${error.message}`, 100);
      await Panel.addLog({
        status: "chatgpt_inspect_error",
        duration_ms: Date.now() - startedAt,
        message: "Falha em INSPECIONAR CHATGPT.",
        error: error.message
      });
    } finally {
      running = false;
      Panel.setBusy(false);
      Panel.refreshLogs();
    }
  }

  async function generateFicha(options) {
    if (running) {
      Panel.setStatus("capturando", "Ja existe uma geracao em andamento.", 12);
      return;
    }

    const startedAt = Date.now();
    running = true;
    Panel.setBusy(true);

    try {
      const jobId = Dom.makeId("ficha");
      setStatus(JOB_STATUS.CAPTURING, "Capturando conversa do WhatsApp...");
      await persistLocalStage(jobId, JOB_STATUS.CAPTURING, "Capturando conversa do WhatsApp.");
      await Panel.addLog({ status: "capturando", message: "Inicio da captura de conversa." });

      let capturedConversation = options && options.regenerate && lastConversation
        ? lastConversation
        : await WhatsApp.captureConversationDeep({
          maxMessages: C.MAX_MESSAGES,
          historyRounds: C.HISTORY_SCROLL_ROUNDS,
          onProgress: (progress) => {
            setStatus(JOB_STATUS.CAPTURING, `Carregando historico: rodada ${progress.round}/${progress.rounds}, ${progress.messages} mensagens.`);
            Panel.setMetrics({ warnings: lastConversation && lastConversation.capture_warnings ? lastConversation.capture_warnings.length : 0 });
          }
        });
      validateConversation(capturedConversation);
      if (!(options && options.regenerate && capturedConversation.visual_context_key)) {
        capturedConversation = await attachVisualContextToConversation(jobId, capturedConversation);
      }
      Panel.setConversation(capturedConversation);
      Logger.debug("conversa capturada", capturedConversation);

      await Panel.addLog({
        status: "capturada",
        client: capturedConversation.client_name,
        message: `${capturedConversation.message_count} mensagens capturadas.`,
        metadata: {
          phone: capturedConversation.phone || "",
          warnings: capturedConversation.capture_warnings || [],
          capture_rounds: capturedConversation.capture_rounds || 0
        }
      });

      setStatus(JOB_STATUS.PREPROCESSING, "Limpando duplicacoes e priorizando negociacao...");
      await persistLocalStage(jobId, JOB_STATUS.PREPROCESSING, "Limpando duplicacoes e priorizando negociacao.");
      const conversation = capturedConversation.preprocessing
        ? capturedConversation
        : Preprocess.processConversation(capturedConversation, {
          maxMessages: C.MAX_CLEAN_MESSAGES
        });
      lastConversation = conversation;
      Panel.setConversation(conversation);
      await Panel.addLog({
        status: "limpando",
        client: conversation.client_name,
        message: `${conversation.clean_message_count} mensagens limpas de ${conversation.captured_message_count}.`,
        metadata: conversation.preprocessing
      });

      Popup.showLoading(conversation);
      setStatus(JOB_STATUS.PREPROCESSING, "Contexto limpo. Montando ANALISE.txt comercial...");

      let response = await runBackgroundJob({
        type: C.MESSAGE_TYPES.GENERATE,
        jobId,
        conversation,
        visualContextKey: conversation.visual_context_key || "",
        options: {
          regenerate: Boolean(options && options.regenerate),
          revisionInstruction: options && options.revisionInstruction ? options.revisionInstruction : ""
        }
      });

      let prepared = null;
      if (response && response.manualFallback) {
        Popup.showManualFallback(response, await Logger.getLogs(12));
        setStatus(JOB_STATUS.ERROR, "Automacao parcial: prompt pronto no ChatGPT.");
        await Panel.addLog({
          status: "fallback_manual",
          client: conversation.client_name,
          duration_ms: Date.now() - startedAt,
          message: response.message || "Prompt preparado para envio manual."
        });
        return;
      }

      if (!response || !response.ok) {
        throw new Error(response && (response.error || response.message) ? (response.error || response.message) : "Nao foi possivel gerar a ficha.");
      }

      setStatus(JOB_STATUS.PARSING, "Interpretando resposta do Projeto FICHA...");
      prepared = prepareCommercialFicha(response.answer || "", conversation);
      await Panel.addLog({
        status: "PARSER_SUCCESS",
        client: conversation.client_name,
        message: "PARSER_SUCCESS",
        metadata: {
          jobId: response.jobId,
          missing: prepared.validation ? prepared.validation.missing : []
        }
      });

      if (prepared.validation && !prepared.validation.ok && !(options && options.validationRetry)) {
        setStatus(JOB_STATUS.SENDING_PROMPT, `Ficha incompleta (${prepared.validation.missing.join(", ")}). Regenerando automaticamente...`);
        await Panel.addLog({
          status: "validation_retry",
          client: conversation.client_name,
          message: `Regeneracao automatica solicitada: ${prepared.validation.missing.join(", ")}.`,
          metadata: {
            jobId,
            missing: prepared.validation.missing
          }
        });
        response = await runBackgroundJob({
          type: C.MESSAGE_TYPES.GENERATE,
          jobId: Dom.makeId("ficha-retry"),
          conversation,
          visualContextKey: conversation.visual_context_key || "",
          options: {
            regenerate: true,
            validationRetry: true,
            revisionInstruction: `A resposta anterior nao passou na validacao comercial. Gere novamente usando obrigatoriamente os blocos com emojis e preenchendo CLIENTE, TELEFONE e PRODUTO quando houver dados na conversa. Campos ausentes devem ficar como CONFIRMAR. Problemas detectados: ${prepared.validation.missing.join(", ")}.`
          }
        });
        if (!response || !response.ok) {
          throw new Error(response && (response.error || response.message) ? (response.error || response.message) : "Regeneracao automatica falhou.");
        }
        prepared = prepareCommercialFicha(response.answer || "", conversation);
        await Panel.addLog({
          status: "PARSER_SUCCESS",
          client: conversation.client_name,
          message: "PARSER_SUCCESS",
          metadata: {
            jobId: response.jobId,
            regenerated: true,
            missing: prepared.validation ? prepared.validation.missing : []
          }
        });
      }

      if (prepared.validation && !prepared.validation.ok) {
        throw new Error(`Ficha incompleta apos regeneracao: ${prepared.validation.missing.join(", ")}.`);
      }

      const fichaFinal = prepared.formatted || response.answer || "";
      response = {
        ...response,
        answer: fichaFinal,
        formattedAnswer: fichaFinal,
        structured: prepared.structured
      };
      Panel.setMetrics({
        response_length: fichaFinal.length,
        prompt_length: response.prompt ? response.prompt.length : 0
      });
      await persistLocalStage(jobId, JOB_STATUS.PARSING, "Interpretando resposta do Projeto FICHA.", {
        response_length: fichaFinal.length
      });
      await Panel.addLog({
        status: "FICHA_FORMATTED",
        client: conversation.client_name,
        message: "FICHA_FORMATTED",
        metadata: {
          jobId: response.jobId,
          length: fichaFinal.length
        }
      });

      setStatus(JOB_STATUS.RENDERING, "Renderizando ficha no painel...");
      await persistGeneratedFicha(fichaFinal, conversation, {
        jobId: response.jobId,
        structured: prepared.structured,
        validation: prepared.validation,
        visual_context_key: conversation.visual_context_key || "",
        visual_context: conversation.visual_context || null,
        downloadUrl: response.downloadUrl || "",
        downloadId: response.downloadId || "",
        provider: response.provider || ""
      });
      await persistVisualHistory(fichaFinal, conversation, {
        jobId: response.jobId,
        structured: prepared.structured,
        validation: prepared.validation
      });
      Popup.showResult(response, await Logger.getLogs(12));
      await copyGeneratedFicha(fichaFinal, conversation, {
        jobId: response.jobId,
        structured: prepared.structured
      });
      await fillWhatsAppWithFicha(fichaFinal, conversation, {
        jobId: response.jobId
      });
      await Panel.addLog({
        status: "success",
        client: conversation.client_name,
        duration_ms: Date.now() - startedAt,
        message: "Ficha recebida do Projeto FICHA."
      });

      completedJobIds.add(response.jobId);
      setStatus(JOB_STATUS.COMPLETED, "Ficha copiada e preenchida no WhatsApp.");
    } catch (error) {
      Logger.debug("erro no fluxo de geracao", error);
      await Panel.addLog({
        status: "error",
        client: lastConversation && lastConversation.client_name ? lastConversation.client_name : "",
        duration_ms: Date.now() - startedAt,
        message: "Falha ao gerar ficha.",
        error: error.message
      });
      Popup.showError(error.message, lastConversation, await Logger.getLogs(12));
      setStatus(JOB_STATUS.ERROR, error.message);
    } finally {
      running = false;
      Panel.setBusy(false);
      Panel.refreshLogs();
    }
  }

  Popup.init({
    onRegenerate: () => generateFicha({ regenerate: true }),
    onOpenLogs: openLogs,
    onHistory: openHistory
  });

  Panel.start({
    onGenerate: () => generateFicha({ regenerate: false }),
    onTestChatGPT: testChatGPTAutomation,
    onInspectChatGPT: inspectChatGPT,
    onRegenerate: () => generateFicha({ regenerate: true }),
    onOpenLogs: openLogs,
    onCopyLast: copyLastFicha,
    onHistory: openHistory
  });

  capturePreview();
  restoreJobState();
  clearInterval(previewTimer);
  previewTimer = setInterval(capturePreview, 4000);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) {
      return false;
    }
    if (message.type === C.MESSAGE_TYPES.GENERATE_PORT_RESULT && message.result) {
      if (running) {
        return false;
      }
      const response = message.result;
      if (response && response.jobId && completedJobIds.has(response.jobId)) {
        return false;
      }
      if (response && response.ok) {
        Logger.saveLastFicha({
          answer: response.answer,
          conversation: response.conversation,
          metadata: { jobId: response.jobId }
        });
        Popup.showResult(response);
        setStatus(JOB_STATUS.COMPLETED, "Ficha recebida do background.");
      }
      return false;
    }
    if (message.type === C.MESSAGE_TYPES.GENERATE_PORT_ERROR) {
      Popup.showError(message.error, lastConversation);
      setStatus(JOB_STATUS.ERROR, message.error || "Falha no background.");
      return false;
    }
    if (message.type !== C.MESSAGE_TYPES.STATUS) {
      return false;
    }
    const detail = message.detail || message.status || "";
    const status = message.status || "aguardando";
    setStatus(status, detail);
    Panel.setMetrics(message.extra || {});
    Panel.addLog({
      status,
      client: lastConversation && lastConversation.client_name ? lastConversation.client_name : "",
      message: detail
    });
    return false;
  });

  Logger.debug("content script inicializado");
})();
