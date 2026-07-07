(function () {
  if (globalThis.ProjetoFichaPopup) {
    return;
  }

  const Prompt = globalThis.ProjetoFichaPrompt;
  const Logger = globalThis.ProjetoFichaLogger;
  let overlay = null;
  let callbacks = {};
  let lastPayload = null;

  function createRoot() {
    if (overlay) {
      return overlay;
    }

    overlay = document.createElement("div");
    overlay.className = "pfixa-overlay pfixa-hidden";
    overlay.innerHTML = `
      <section class="pfixa-modal" role="dialog" aria-modal="true" aria-label="Ficha de pedido">
        <header class="pfixa-header">
          <div>
            <p class="pfixa-kicker">📋 Projeto FICHA</p>
            <h2>Resultado da geração</h2>
          </div>
          <button class="pfixa-icon-btn" type="button" data-pfixa-close aria-label="Fechar">×</button>
        </header>

        <div class="pfixa-status" data-pfixa-status>
          Pronto para gerar.
        </div>

        <div class="pfixa-grid">
          <section class="pfixa-editor">
            <label for="pfixa-textarea">Ficha — edite se necessário antes de copiar</label>
            <textarea id="pfixa-textarea" data-pfixa-textarea spellcheck="true"></textarea>
          </section>

          <aside class="pfixa-side">
            <section>
              <h3>Status</h3>
              <p class="pfixa-ai-status" data-pfixa-ai-status>Aguardando.</p>
            </section>

            <section>
              <h3>Cliente</h3>
              <dl class="pfixa-client">
                <div><dt>Nome</dt><dd data-pfixa-client-name>—</dd></div>
                <div><dt>Telefone</dt><dd data-pfixa-client-phone>—</dd></div>
                <div><dt>Mensagens</dt><dd data-pfixa-message-count>0</dd></div>
              </dl>
            </section>

            <section>
              <h3>Produtos detectados</h3>
              <ul class="pfixa-list" data-pfixa-products></ul>
            </section>

            <section>
              <h3>Pendências</h3>
              <ul class="pfixa-list" data-pfixa-missing></ul>
            </section>

            <section>
              <h3>Score / Resumo</h3>
              <p class="pfixa-summary" data-pfixa-summary>—</p>
            </section>

            <section>
              <h3>Logs</h3>
              <ol class="pfixa-modal-logs" data-pfixa-modal-logs></ol>
            </section>
          </aside>
        </div>

        <footer class="pfixa-actions">
          <button class="pfixa-secondary" type="button" data-pfixa-open-history>📂 Histórico</button>
          <button class="pfixa-secondary" type="button" data-pfixa-open-logs>Logs</button>
          <button class="pfixa-secondary" type="button" data-pfixa-regenerate>Regenerar</button>
          <a class="pfixa-primary pfixa-download pfixa-hidden" data-pfixa-download target="_blank" rel="noopener noreferrer">⬇ Baixar DANFE</a>
          <button class="pfixa-primary" type="button" data-pfixa-copy>Copiar ficha</button>
        </footer>
      </section>
    `;

    overlay.querySelector("[data-pfixa-close]").addEventListener("click", hide);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        hide();
      }
    });
    overlay.querySelector("[data-pfixa-copy]").addEventListener("click", copyCurrentText);
    overlay.querySelector("[data-pfixa-regenerate]").addEventListener("click", () => {
      if (callbacks.onRegenerate) {
        callbacks.onRegenerate(lastPayload);
      }
    });
    overlay.querySelector("[data-pfixa-open-logs]").addEventListener("click", () => {
      if (callbacks.onOpenLogs) {
        callbacks.onOpenLogs();
      }
    });
    overlay.querySelector("[data-pfixa-open-history]").addEventListener("click", () => {
      if (callbacks.onHistory) {
        callbacks.onHistory();
      }
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function show() {
    createRoot().classList.remove("pfixa-hidden");
  }

  function hide() {
    if (overlay) {
      overlay.classList.add("pfixa-hidden");
    }
  }

  function setText(selector, value) {
    const node = createRoot().querySelector(selector);
    if (node) {
      node.textContent = value || "";
    }
  }

  function setStatus(message, tone) {
    const node = createRoot().querySelector("[data-pfixa-status]");
    node.textContent = message || "";
    node.dataset.tone = tone || "neutral";
    setText("[data-pfixa-ai-status]", message || "Aguardando.");
  }

  function setTextarea(value) {
    const textarea = createRoot().querySelector("[data-pfixa-textarea]");
    textarea.value = value || "";
  }

  function toast(message) {
    const root = createRoot();
    let node = root.querySelector("[data-pfixa-toast]");
    if (!node) {
      node = document.createElement("div");
      node.dataset.pfixaToast = "true";
      node.className = "pfixa-toast";
      root.appendChild(node);
    }
    node.textContent = message || "";
    node.classList.add("is-visible");
    clearTimeout(node._pfixaTimer);
    node._pfixaTimer = setTimeout(() => {
      node.classList.remove("is-visible");
    }, 2600);
  }

  function renderList(selector, items, emptyText) {
    const list = createRoot().querySelector(selector);
    list.textContent = "";
    const values = (items || []).filter(Boolean);
    if (!values.length) {
      const item = document.createElement("li");
      item.className = "pfixa-empty";
      item.textContent = emptyText;
      list.appendChild(item);
      return;
    }

    values.slice(0, 12).forEach((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      list.appendChild(item);
    });
  }

  function renderLogs(logs) {
    const list = createRoot().querySelector("[data-pfixa-modal-logs]");
    list.textContent = "";
    const values = (logs || []).slice(0, 20);
    if (!values.length) {
      const item = document.createElement("li");
      item.className = "pfixa-empty";
      item.textContent = "Sem logs salvos.";
      list.appendChild(item);
      return;
    }

    values.forEach((entry) => {
      const item = document.createElement("li");
      const time = entry.time ? new Date(entry.time).toLocaleString("pt-BR") : "";
      item.innerHTML = `<span>${time}</span><strong>${entry.status || "info"}</strong><em>${entry.message || entry.error || ""}</em>`;
      list.appendChild(item);
    });
  }

  function renderConversation(conversation) {
    setText("[data-pfixa-client-name]", conversation && conversation.client_name ? conversation.client_name : "CONFIRMAR");
    setText("[data-pfixa-client-phone]", conversation && conversation.phone ? conversation.phone : "CONFIRMAR");
    const count = conversation && conversation.captured_message_count
      ? `${conversation.message_count || 0}/${conversation.captured_message_count}`
      : String(conversation && conversation.message_count ? conversation.message_count : 0);
    setText("[data-pfixa-message-count]", count);
  }

  async function copyCurrentText() {
    const textarea = createRoot().querySelector("[data-pfixa-textarea]");
    const value = textarea.value;
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Ficha copiada para a area de transferencia.", "success");
      if (Logger) {
        await Logger.add({ status: "copied", message: "Ficha copiada pelo modal." });
      }
    } catch (error) {
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      setStatus("Ficha copiada usando fallback do navegador.", "success");
    }
  }

  function showLoading(conversation, logs) {
    lastPayload = { conversation };
    show();
    renderConversation(conversation);
    setTextarea("Aguardando resposta do Projeto FICHA...");
    renderList("[data-pfixa-products]", [], "Aguardando produtos.");
    renderList("[data-pfixa-missing]", [], "Aguardando pendencias.");
    renderLogs(logs || []);
    setText("[data-pfixa-summary]", "Capturando e enviando conversa para o gerador.");
    setDownload("");
    setStatus("Gerando ficha...", "loading");
  }

  function setDownload(url) {
    const link = createRoot().querySelector("[data-pfixa-download]");
    if (!link) {
      return;
    }
    if (url) {
      link.href = url;
      link.classList.remove("pfixa-hidden");
    } else {
      link.removeAttribute("href");
      link.classList.add("pfixa-hidden");
    }
  }

  function showResult(payload, logs) {
    const answer = payload && payload.answer ? payload.answer : "";
    const conversation = payload && payload.conversation ? payload.conversation : {};
    const parsed = Prompt.parseFichaSections(answer);
    lastPayload = payload;

    show();
    renderConversation(conversation);
    setTextarea(answer || (payload && payload.downloadUrl ? "Orçamento gerado. Use o botão Baixar." : "Nenhuma ficha foi capturada."));
    renderList("[data-pfixa-products]", parsed.products, "Nenhum produto estruturado detectado.");
    renderList("[data-pfixa-missing]", parsed.missing_info, "Nenhuma pendencia destacada.");
    renderLogs(logs || []);
    setText("[data-pfixa-summary]", parsed.summary || "Resumo nao identificado na resposta.");
    setDownload(payload && payload.downloadUrl ? payload.downloadUrl : "");
    const providerLabel = payload && payload.provider === "material_api" ? " (Material API)" : "";
    setStatus(`Ficha gerada com sucesso.${providerLabel}`, "success");
  }

  function showManualFallback(payload, logs) {
    const prompt = payload && payload.prompt ? payload.prompt : "";
    const conversation = payload && payload.conversation ? payload.conversation : {};
    lastPayload = payload;

    show();
    renderConversation(conversation);
    setTextarea(prompt);
    renderList("[data-pfixa-products]", [], "Envio automatico nao concluido.");
    renderList("[data-pfixa-missing]", [
      "Confira a aba do ChatGPT: o prompt ficou pronto para envio manual.",
      payload && payload.message ? payload.message : "A UI do ChatGPT pode ter mudado."
    ], "Sem pendencias.");
    renderLogs(logs || []);
    setText("[data-pfixa-summary]", "Fallback manual ativado. Envie o prompt no Projeto FICHA e cole a resposta aqui se quiser editar/copiar pelo modal.");
    setStatus("Automacao parcial: prompt preparado para envio manual.", "warning");
  }

  function showError(message, conversation, logs) {
    show();
    if (conversation) {
      renderConversation(conversation);
    }
    setTextarea("");
    renderList("[data-pfixa-products]", [], "Nao foi possivel gerar a ficha.");
    renderList("[data-pfixa-missing]", [message || "Erro inesperado."], "Erro nao identificado.");
    renderLogs(logs || []);
    setText("[data-pfixa-summary]", "Revise se o WhatsApp e o ChatGPT estao logados e tente novamente.");
    setStatus(message || "Falha ao gerar ficha.", "error");
  }

  function showLogs(logs, conversation) {
    show();
    renderConversation(conversation || {});
    setTextarea((logs || []).map((entry) => {
      const time = entry.time ? new Date(entry.time).toLocaleString("pt-BR") : "";
      const duration = entry.duration_ms ? ` (${entry.duration_ms}ms)` : "";
      const error = entry.error ? ` | erro: ${entry.error}` : "";
      return `[${time}] ${entry.status || "info"}${duration} - ${entry.message || ""}${error}`;
    }).join("\n"));
    renderList("[data-pfixa-products]", [], "Visualizacao de logs.");
    renderList("[data-pfixa-missing]", [], "Visualizacao de logs.");
    renderLogs(logs || []);
    setText("[data-pfixa-summary]", "Historico local salvo em chrome.storage.local.");
    setStatus("Logs locais carregados.", "success");
  }

  function showHistory(fichas, conversation) {
    show();
    if (conversation) {
      renderConversation(conversation);
    }

    const root = createRoot();
    const textarea = root.querySelector("[data-pfixa-textarea]");
    const productsList = root.querySelector("[data-pfixa-products]");
    const missingList = root.querySelector("[data-pfixa-missing]");
    const summaryEl = root.querySelector("[data-pfixa-summary]");
    const downloadLink = root.querySelector("[data-pfixa-download]");

    if (downloadLink) {
      downloadLink.removeAttribute("href");
      downloadLink.classList.add("pfixa-hidden");
    }

    const entries = Array.isArray(fichas) ? fichas : [];

    if (!entries.length) {
      textarea.value = "Nenhuma ficha salva ainda. Gere a primeira ficha pelo painel.";
      renderList("[data-pfixa-products]", [], "Nenhuma ficha no histórico.");
      renderList("[data-pfixa-missing]", [], "");
      setText("[data-pfixa-summary]", "O histórico salva até 30 fichas.");
      setStatus("Histórico vazio.", "neutral");
      return;
    }

    const container = document.createElement("div");
    container.className = "pfixa-history";

    entries.forEach((entry, index) => {
      const item = document.createElement("div");
      item.className = "pfixa-history-item";

      const date = entry.saved_at ? new Date(entry.saved_at).toLocaleString("pt-BR") : "";
      const clientLabel = entry.client || "Cliente desconhecido";
      const phoneLabel = entry.phone ? ` · ${entry.phone}` : "";
      const providerLabel = entry.provider === "material_api" ? " · Material API" : entry.provider === "chatgpt" ? " · ChatGPT" : "";
      const hasDownload = Boolean(entry.downloadUrl);
      const hasAnswer = Boolean(entry.answer);

      item.innerHTML = `
        <div class="pfixa-history-meta">
          <strong>${clientLabel}${phoneLabel}${providerLabel}</strong>
          <span>${date}</span>
        </div>
        <div class="pfixa-history-actions">
          ${hasAnswer ? `<button type="button" class="pfixa-secondary pfixa-history-copy" data-index="${index}">Copiar ficha</button>` : ""}
          ${hasAnswer ? `<button type="button" class="pfixa-secondary pfixa-history-view" data-index="${index}">Ver ficha</button>` : ""}
          ${hasDownload ? `<a class="pfixa-primary pfixa-history-download" href="${entry.downloadUrl}" target="_blank" rel="noopener noreferrer">⬇ Baixar DANFE</a>` : ""}
          ${!hasAnswer && !hasDownload ? `<span class="pfixa-empty">Sem dados disponíveis</span>` : ""}
        </div>
      `;

      container.appendChild(item);
    });

    textarea.value = `${entries.length} ficha(s) salva(s). Clique em "Ver ficha" para carregar no editor.`;
    productsList.textContent = "";
    productsList.appendChild(container);
    missingList.textContent = "";
    summaryEl.textContent = `Histórico local salvo no Chrome. Fichas com DANFE ficam disponíveis por 8 horas.`;
    setStatus(`${entries.length} ficha(s) no histórico.`, "success");

    container.addEventListener("click", async (event) => {
      const copyBtn = event.target.closest("[data-index].pfixa-history-copy");
      const viewBtn = event.target.closest("[data-index].pfixa-history-view");

      if (copyBtn) {
        const idx = Number(copyBtn.dataset.index);
        const entry = entries[idx];
        if (!entry || !entry.answer) {
          return;
        }
        try {
          await navigator.clipboard.writeText(entry.answer);
        } catch (error) {
          const ta = document.createElement("textarea");
          ta.value = entry.answer;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setStatus(`Ficha de ${entry.client || "cliente"} copiada.`, "success");
        if (Logger) {
          Logger.add({ status: "copied", message: `Ficha do histórico copiada: ${entry.client || ""} ${entry.saved_at || ""}` });
        }
      }

      if (viewBtn) {
        const idx = Number(viewBtn.dataset.index);
        const entry = entries[idx];
        if (!entry || !entry.answer) {
          return;
        }
        textarea.value = entry.answer;
        if (downloadLink) {
          if (entry.downloadUrl) {
            downloadLink.href = entry.downloadUrl;
            downloadLink.classList.remove("pfixa-hidden");
          } else {
            downloadLink.removeAttribute("href");
            downloadLink.classList.add("pfixa-hidden");
          }
        }
        setStatus(`Ficha de ${entry.client || "cliente"} carregada no editor.`, "success");
      }
    });
  }

  function init(nextCallbacks) {
    callbacks = nextCallbacks || {};
    createRoot();
  }

  globalThis.ProjetoFichaPopup = {
    hide,
    init,
    renderLogs,
    setStatus,
    showError,
    showHistory,
    showLoading,
    showLogs,
    showManualFallback,
    showResult,
    toast
  };
})();
