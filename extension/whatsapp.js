(function () {
  if (globalThis.ProjetoFichaWhatsApp) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants;
  const Dom = globalThis.ProjetoFichaDom;
  const Logger = globalThis.ProjetoFichaLogger;

  function getMainRoot() {
    return Dom.bySelectors(document, C.SELECTORS.whatsappMain) || document.body;
  }

  function getHeader() {
    return Dom.bySelectors(document, C.SELECTORS.whatsappHeader);
  }

  function getMessageSignature(message) {
    return `${message.author || ""}|${message.time || ""}|${Dom.normalizeText(message.text).toLowerCase()}`;
  }

  function cleanPhone(value) {
    const raw = String(value || "");
    const match = raw.match(/(?:\+?\d[\d\s().-]{8,}\d)/);
    if (!match) {
      return "";
    }
    const digits = match[0].replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) {
      return "";
    }
    return digits;
  }

  function extractPhoneFromText(text) {
    const candidates = String(text || "").match(/(?:\+?\d[\d\s().-]{8,}\d)/g) || [];
    for (const candidate of candidates) {
      const cleaned = cleanPhone(candidate);
      if (cleaned) {
        return cleaned;
      }
    }
    return "";
  }

  function extractClientName() {
    const header = getHeader();
    if (!header) {
      return "CONFIRMAR";
    }

    const titleCandidates = [
      "span[title]",
      "[data-testid='conversation-info-header-chat-title']",
      "h1",
      "[role='button'] span[dir='auto']",
      "span[dir='auto']"
    ];

    for (const selector of titleCandidates) {
      const node = header.querySelector(selector);
      const title = node ? node.getAttribute("title") : "";
      const text = Dom.normalizeText(title || (node && node.textContent));
      if (text && !/online|digitando|visto por ultimo|clique para/i.test(text)) {
        return text;
      }
    }

    const fallback = Dom.normalizeText(header.textContent).split("\n")[0];
    return fallback || "CONFIRMAR";
  }

  function extractHeaderPhone() {
    const header = getHeader();
    if (!header) {
      return "";
    }
    const titleText = Array.from(header.querySelectorAll("[title]"))
      .map((node) => node.getAttribute("title"))
      .join(" ");
    return extractPhoneFromText(`${titleText} ${header.textContent || ""}`);
  }

  function directionFromNode(node) {
    const outbound = node.closest(".message-out, [class*='message-out']");
    const inbound = node.closest(".message-in, [class*='message-in']");
    if (outbound) {
      return "atendente";
    }
    if (inbound) {
      return "cliente";
    }

    const aria = `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`;
    if (/voce|você|you:/i.test(aria)) {
      return "atendente";
    }
    return "cliente";
  }

  function extractTime(node) {
    const prePlain = node.querySelector("[data-pre-plain-text]");
    const preText = prePlain ? prePlain.getAttribute("data-pre-plain-text") : "";
    const preMatch = preText && preText.match(/^\[([^\]]+)]/);
    if (preMatch) {
      return Dom.normalizeText(preMatch[1]);
    }

    const metaSelectors = [
      "[data-testid='msg-meta']",
      "span[aria-label*=':']",
      "span[aria-label*='AM']",
      "span[aria-label*='PM']"
    ];

    for (const selector of metaSelectors) {
      const meta = node.querySelector(selector);
      const label = meta ? meta.getAttribute("aria-label") : "";
      const text = Dom.normalizeText(label || (meta && meta.textContent));
      const match = text.match(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b/i);
      if (match) {
        return match[0];
      }
    }

    const fallback = Dom.normalizeText(node.textContent);
    const match = fallback.match(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b/i);
    return match ? match[0] : "";
  }

  function stripMessageMeta(text) {
    return Dom.normalizeText(text)
      .replace(/\n?\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b\s*$/i, "")
      .replace(/\n?(?:encaminhada|forwarded)\s*$/i, "")
      .replace(/\n?(?:editada|edited)\s*$/i, "")
      .trim();
  }

  function extractMessageText(node) {
    const selectable = Array.from(node.querySelectorAll("span.selectable-text, .copyable-text"))
      .map((item) => Dom.getText(item))
      .filter(Boolean);

    if (selectable.length) {
      return stripMessageMeta(selectable.join("\n"));
    }

    const prePlain = node.querySelector("[data-pre-plain-text]");
    if (prePlain) {
      const text = Dom.getText(prePlain);
      if (text) {
        return stripMessageMeta(text);
      }
    }

    const aria = Dom.normalizeText(node.getAttribute("aria-label"));
    if (aria && aria.length > 2) {
      return stripMessageMeta(aria);
    }

    return stripMessageMeta(Dom.getText(node));
  }

  function isLikelyMessage(node, text) {
    if (!text || text.length < 1) {
      return false;
    }
    if (/^\d{1,2}:\d{2}$/.test(text)) {
      return false;
    }
    if (/^(hoje|ontem|today|yesterday)$/i.test(text)) {
      return false;
    }
    return Boolean(
      node.querySelector("span.selectable-text, .copyable-text, [data-pre-plain-text]") ||
      node.closest(".message-in, .message-out, [class*='message-in'], [class*='message-out']")
    );
  }

  function collectMessages(round) {
    const root = getMainRoot();
    const nodes = Dom.allBySelectors(root, C.SELECTORS.whatsappMessageContainers);
    const messages = [];
    const seen = new Set();

    nodes.forEach((node, index) => {
      const text = extractMessageText(node);
      if (!isLikelyMessage(node, text)) {
        return;
      }

      const time = extractTime(node);
      const author = directionFromNode(node);
      const key = `${author}|${time}|${text}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);

      messages.push({
        author,
        direction: author,
        text,
        time,
        index,
        capture_round: round || 0
      });
    });

    Logger.debug("mensagens capturadas do DOM", {
      candidates: nodes.length,
      messages: messages.length
    });
    return messages;
  }

  function findMessageScrollContainer() {
    const root = getMainRoot();
    const candidates = Array.from(root.querySelectorAll("div, section"))
      .filter((node) => {
        if (!Dom.isVisible(node)) {
          return false;
        }
        if (node.closest("[data-projeto-ficha-panel='true'], .pfixa-overlay")) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        const hasScroll = node.scrollHeight > node.clientHeight + 180;
        const hasMessages = node.querySelector(C.SELECTORS.whatsappMessageContainers.join(","));
        return hasScroll && hasMessages && rect.height > 220 && rect.width > 280;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight);

    return candidates[0] || null;
  }

  function mergeMessages(snapshots) {
    const byKey = new Map();
    const flattened = snapshots.flat();

    for (const message of flattened) {
      const key = getMessageSignature(message);
      const existing = byKey.get(key);
      if (!existing || (message.capture_round || 0) > (existing.capture_round || 0)) {
        byKey.set(key, message);
      }
    }

    return Array.from(byKey.values())
      .sort((a, b) => {
        const roundDiff = (b.capture_round || 0) - (a.capture_round || 0);
        if (roundDiff !== 0) {
          return roundDiff;
        }
        return (a.index || 0) - (b.index || 0);
      })
      .map((message, originalIndex) => ({
        ...message,
        original_index: originalIndex
      }));
  }

  async function collectMessagesWithHistory(options) {
    const rounds = (options && options.historyRounds) || C.HISTORY_SCROLL_ROUNDS || 8;
    const delay = (options && options.historyDelayMs) || C.HISTORY_SCROLL_DELAY_MS || 450;
    const scrollContainer = findMessageScrollContainer();
    const snapshots = [collectMessages(0)];

    if (!scrollContainer || rounds <= 0) {
      return {
        messages: mergeMessages(snapshots),
        scroll_used: false,
        rounds_completed: 0
      };
    }

    const originalTop = scrollContainer.scrollTop;
    let lastTop = originalTop;
    let stagnantRounds = 0;

    Logger.debug("iniciando scroll inteligente do historico", {
      rounds,
      originalTop,
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight
    });

    for (let round = 1; round <= rounds; round += 1) {
      const nextTop = Math.max(0, scrollContainer.scrollTop - Math.max(320, scrollContainer.clientHeight * 0.85));
      scrollContainer.scrollTop = nextTop;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      await Dom.sleep(delay);
      const snapshot = collectMessages(round);
      snapshots.push(snapshot);
      if (options && typeof options.onProgress === "function") {
        try {
          options.onProgress({
            round,
            rounds,
            messages: mergeMessages(snapshots).length
          });
        } catch (error) {
          Logger.debug("callback de progresso da captura falhou", error.message);
        }
      }

      if (Math.abs(scrollContainer.scrollTop - lastTop) < 4) {
        stagnantRounds += 1;
      } else {
        stagnantRounds = 0;
      }
      lastTop = scrollContainer.scrollTop;

      if (scrollContainer.scrollTop <= 0 || stagnantRounds >= 2) {
        break;
      }
    }

    scrollContainer.scrollTop = originalTop;
    scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));

    return {
      messages: mergeMessages(snapshots),
      scroll_used: true,
      rounds_completed: snapshots.length - 1
    };
  }

  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function getChatCaptureRect() {
    const root = getMainRoot();
    const rootRect = root.getBoundingClientRect();
    const header = getHeader();
    const footer = root.querySelector("footer");
    const scrollContainer = findMessageScrollContainer();
    const scrollRect = scrollContainer ? scrollContainer.getBoundingClientRect() : rootRect;
    const headerBottom = header ? header.getBoundingClientRect().bottom : rootRect.top;
    const footerTop = footer ? footer.getBoundingClientRect().top : rootRect.bottom;

    const left = clampNumber(Math.max(rootRect.left, scrollRect.left), 0, window.innerWidth);
    const right = clampNumber(Math.min(rootRect.right, scrollRect.right), 0, window.innerWidth);
    const top = clampNumber(Math.max(scrollRect.top, headerBottom, 0), 0, window.innerHeight);
    const bottom = clampNumber(Math.min(scrollRect.bottom, footerTop, window.innerHeight), 0, window.innerHeight);

    return {
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      right,
      bottom
    };
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Nao foi possivel carregar screenshot para recorte."));
      image.src = dataUrl;
    });
  }

  async function cropScreenshotToChat(dataUrl, rect) {
    const image = await loadImage(dataUrl);
    const scaleX = image.naturalWidth / Math.max(1, window.innerWidth);
    const scaleY = image.naturalHeight / Math.max(1, window.innerHeight);
    const sourceX = clampNumber(Math.round(rect.left * scaleX), 0, image.naturalWidth - 1);
    const sourceY = clampNumber(Math.round(rect.top * scaleY), 0, image.naturalHeight - 1);
    const sourceWidth = clampNumber(Math.round(rect.width * scaleX), 1, image.naturalWidth - sourceX);
    const sourceHeight = clampNumber(Math.round(rect.height * scaleY), 1, image.naturalHeight - sourceY);
    const targetWidth = Math.min(C.VISUAL_MAX_WIDTH || 1280, sourceWidth);
    const targetHeight = Math.max(1, Math.round(sourceHeight * (targetWidth / sourceWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
    const quality = typeof C.VISUAL_JPEG_QUALITY === "number" ? C.VISUAL_JPEG_QUALITY : 0.7;
    return {
      dataUrl: canvas.toDataURL("image/jpeg", quality),
      width: targetWidth,
      height: targetHeight,
      source_rect: {
        x: sourceX,
        y: sourceY,
        width: sourceWidth,
        height: sourceHeight
      }
    };
  }

  async function withOwnUiHidden(callback) {
    const nodes = Array.from(document.querySelectorAll("[data-projeto-ficha-panel='true'], .pfixa-overlay"));
    const previous = nodes.map((node) => ({
      node,
      visibility: node.style.visibility
    }));
    previous.forEach((item) => {
      item.node.style.visibility = "hidden";
    });
    await Dom.sleep(80);
    try {
      return await callback();
    } finally {
      previous.forEach((item) => {
        item.node.style.visibility = item.visibility;
      });
    }
  }

  function desiredVisualCaptureCount(scrollContainer) {
    if (!scrollContainer) {
      return 1;
    }
    const screens = Math.ceil(scrollContainer.scrollHeight / Math.max(1, scrollContainer.clientHeight));
    return clampNumber(screens, C.VISUAL_MIN_SCREENSHOTS || 3, C.VISUAL_MAX_SCREENSHOTS || 10);
  }

  function buildVisualScrollPositions(scrollContainer, desiredCount) {
    if (!scrollContainer) {
      return Array.from({ length: C.VISUAL_MIN_SCREENSHOTS || 3 }, () => 0);
    }
    const maxTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    if (maxTop < 24) {
      return Array.from({ length: C.VISUAL_MIN_SCREENSHOTS || 3 }, () => scrollContainer.scrollTop || 0);
    }
    const count = Math.max(1, desiredCount || 1);
    const step = Math.max(320, scrollContainer.clientHeight * 0.9);
    const captureSpan = Math.min(maxTop, step * Math.max(1, count - 1));
    const start = Math.max(0, maxTop - captureSpan);
    const positions = [];

    if (count === 1 || maxTop === start) {
      positions.push(maxTop);
    } else {
      for (let index = 0; index < count; index += 1) {
        positions.push(Math.round(start + ((maxTop - start) * index) / Math.max(1, count - 1)));
      }
    }

    return Array.from(new Set(positions)).sort((a, b) => a - b);
  }

  async function imageElementToDataUrl(image) {
    if (!image || !(image instanceof HTMLImageElement)) {
      return null;
    }
    const rect = image.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) {
      return null;
    }
    const label = `${image.alt || ""} ${image.title || ""}`.toLowerCase();
    if (/emoji|avatar|profile|perfil|sticker|figurinha/.test(label) && rect.width < 180 && rect.height < 180) {
      return null;
    }
    if (!image.complete) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1200);
        image.addEventListener("load", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        image.addEventListener("error", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    if (!image.naturalWidth || !image.naturalHeight) {
      return null;
    }
    const targetWidth = Math.min(C.VISUAL_MAX_WIDTH || 1280, image.naturalWidth);
    const targetHeight = Math.max(1, Math.round(image.naturalHeight * (targetWidth / image.naturalWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    return {
      dataUrl: canvas.toDataURL("image/jpeg", typeof C.VISUAL_JPEG_QUALITY === "number" ? C.VISUAL_JPEG_QUALITY : 0.7),
      width: targetWidth,
      height: targetHeight
    };
  }

  async function collectVisibleChatImages(limit) {
    const root = getMainRoot();
    const nodes = Dom.allBySelectors(root, C.SELECTORS.whatsappMessageContainers);
    const images = [];
    for (const node of nodes) {
      const imageNodes = Array.from(node.querySelectorAll("img"));
      for (const image of imageNodes) {
        if (images.length >= limit) {
          return images;
        }
        const rect = image.getBoundingClientRect();
        if (!Dom.isVisible(image) || rect.width < 80 || rect.height < 80) {
          continue;
        }
        const messageText = extractMessageText(node);
        try {
          const rendered = await imageElementToDataUrl(image);
          if (!rendered) {
            continue;
          }
          images.push({
            id: Dom.makeId("chat-image"),
            author: directionFromNode(node),
            time: extractTime(node),
            caption: messageText,
            width: rendered.width,
            height: rendered.height,
            dataUrl: rendered.dataUrl,
            source: "whatsapp_message_image",
            captured_at: new Date().toISOString()
          });
        } catch (error) {
          images.push({
            id: Dom.makeId("chat-image"),
            author: directionFromNode(node),
            time: extractTime(node),
            caption: messageText,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            dataUrl: "",
            source: "whatsapp_message_image",
            error: error.message,
            captured_at: new Date().toISOString()
          });
        }
      }
    }
    return images;
  }

  function collectVisibleAudioHints() {
    const root = getMainRoot();
    const nodes = Dom.allBySelectors(root, C.SELECTORS.whatsappMessageContainers);
    return nodes
      .filter((node) => node.querySelector("audio, [aria-label*='audio' i], [aria-label*='voz' i], [aria-label*='voice' i]"))
      .map((node) => ({
        id: Dom.makeId("audio"),
        author: directionFromNode(node),
        time: extractTime(node),
        transcription: "",
        status: "TRANSCRICAO_NAO_DISPONIVEL_NO_BROWSER",
        captured_at: new Date().toISOString()
      }))
      .slice(0, 12);
  }

  function extractClientFilledInfo(messages) {
    const clientText = (messages || [])
      .filter((message) => message.author === "cliente")
      .map((message) => message.text)
      .join("\n");
    const cpf = (clientText.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/) || [])[0] || "";
    const email = (clientText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || "";
    const phones = Array.from(new Set((clientText.match(/(?:\+?\d[\d\s().-]{8,}\d)/g) || [])
      .map(cleanPhone)
      .filter(Boolean)));
    const addressLines = clientText
      .split("\n")
      .map((line) => Dom.normalizeText(line))
      .filter((line) => /\b(?:rua|r\.|avenida|av\.|bairro|numero|n[ºo]|cep|quadra|lote|condominio|apto|casa)\b/i.test(line))
      .slice(-6);
    const deliveryDates = clientText
      .split("\n")
      .map((line) => Dom.normalizeText(line))
      .filter((line) => /\b(?:entrega|entregar|retirada|retirar|amanha|amanh[ãa]|hoje|\d{1,2}\/\d{1,2})\b/i.test(line))
      .slice(-6);

    return {
      cpf,
      email,
      phones,
      address_lines: addressLines,
      delivery_lines: deliveryDates
    };
  }

  function buildVisualContextManifest(visualContext) {
    const context = visualContext || {};
    return {
      version: context.version || C.VISUAL_CONTEXT_VERSION,
      captured_at: context.captured_at || "",
      metrics: context.metrics || {
        screenshot_count: (context.screenshots || []).length,
        image_count: (context.images || []).length,
        audio_count: (context.audio_transcriptions || []).length
      },
      screenshots: (context.screenshots || []).map((item) => ({
        id: item.id,
        width: item.width,
        height: item.height,
        scrollTop: item.scrollTop,
        captured_at: item.captured_at,
        bytes_estimate: item.dataUrl ? Math.round(item.dataUrl.length * 0.75) : 0
      })),
      images: (context.images || []).map((item) => ({
        id: item.id,
        author: item.author,
        time: item.time,
        caption: item.caption,
        width: item.width,
        height: item.height,
        has_data_url: Boolean(item.dataUrl),
        source: item.source,
        error: item.error || ""
      })),
      audio_transcriptions: context.audio_transcriptions || [],
      client_filled_info: context.client_filled_info || {},
      priorities: context.priorities || {},
      anti_error_mode: true,
      warnings: context.warnings || []
    };
  }

  async function captureVisualContext(options) {
    const requestScreenshot = options && options.requestScreenshot;
    const onProgress = options && options.onProgress;
    const warnings = [];
    const scrollContainer = findMessageScrollContainer();
    const originalTop = scrollContainer ? scrollContainer.scrollTop : 0;
    const desiredCount = desiredVisualCaptureCount(scrollContainer);
    const positions = buildVisualScrollPositions(scrollContainer, desiredCount);
    const screenshots = [];
    const imageMap = new Map();
    let audioTranscriptions = [];

    if (!requestScreenshot) {
      warnings.push("Captura visual indisponivel: background nao forneceu captureVisibleTab.");
    }

    try {
      for (let index = 0; index < positions.length; index += 1) {
        if (scrollContainer) {
          scrollContainer.scrollTop = positions[index];
          scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
          await Dom.sleep(650);
        }

        if (typeof onProgress === "function") {
          onProgress({
            index: index + 1,
            total: positions.length,
            scrollTop: scrollContainer ? scrollContainer.scrollTop : 0
          });
        }

        if (requestScreenshot) {
          try {
            const rect = getChatCaptureRect();
            const response = await withOwnUiHidden(() => requestScreenshot({
              index: index + 1,
              total: positions.length,
              rect,
              scrollTop: scrollContainer ? scrollContainer.scrollTop : 0
            }));
            const dataUrl = typeof response === "string" ? response : response && response.dataUrl;
            if (!dataUrl) {
              throw new Error("Background nao retornou dataUrl do screenshot.");
            }
            const cropped = await cropScreenshotToChat(dataUrl, rect);
            screenshots.push({
              id: Dom.makeId("chat-shot"),
              index: index + 1,
              total: positions.length,
              scrollTop: scrollContainer ? scrollContainer.scrollTop : 0,
              width: cropped.width,
              height: cropped.height,
              rect,
              source_rect: cropped.source_rect,
              dataUrl: cropped.dataUrl,
              format: "image/jpeg",
              quality: C.VISUAL_JPEG_QUALITY || 0.7,
              captured_at: new Date().toISOString()
            });
          } catch (error) {
            warnings.push(`Falha ao capturar tela ${index + 1}: ${error.message}`);
          }
        }

        const visibleImages = await collectVisibleChatImages(C.VISUAL_MAX_CHAT_IMAGES || 8);
        visibleImages.forEach((image) => {
          const key = `${image.author}|${image.time}|${image.caption}|${image.width}|${image.height}`;
          if (!imageMap.has(key)) {
            imageMap.set(key, image);
          }
        });
        audioTranscriptions = audioTranscriptions.concat(collectVisibleAudioHints());
      }
    } finally {
      if (scrollContainer) {
        scrollContainer.scrollTop = originalTop;
        scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    }

    if (!screenshots.length) {
      warnings.push("Nenhuma screenshot do chat foi capturada. A geracao visual deve ser interrompida.");
    }
    if (positions.length < (C.VISUAL_MIN_SCREENSHOTS || 3)) {
      warnings.push("Conversa visivel coube em menos de 3 telas unicas; foram salvas apenas telas distintas.");
    }
    if (audioTranscriptions.length) {
      warnings.push("Audios detectados, mas transcricao automatica local ainda nao esta disponivel.");
    }

    const messages = options && Array.isArray(options.messages) && options.messages.length
      ? options.messages
      : collectMessages(0);
    const visualContext = {
      version: C.VISUAL_CONTEXT_VERSION,
      captured_at: new Date().toISOString(),
      screenshots,
      images: Array.from(imageMap.values()).slice(0, C.VISUAL_MAX_CHAT_IMAGES || 8),
      audio_transcriptions: audioTranscriptions
        .filter((item, index, list) => list.findIndex((other) => `${other.author}|${other.time}` === `${item.author}|${item.time}`) === index),
      client_filled_info: extractClientFilledInfo(messages),
      priorities: {
        alta: ["Nome", "CPF", "Endereco", "Telefone", "E-mail", "Data de entrega"],
        media: ["Produto", "Modelo", "Cor", "Quantidade"],
        baixa: ["Saudacoes", "figurinhas", "mensagens sem relacao com venda", "conversas paralelas"]
      },
      anti_error_mode: {
        ignore: ["visto por ultimo", "online", "digitando", "aria-label", "ids do DOM", "labels internas", "elementos da interface"]
      },
      metrics: {
        screenshot_count: screenshots.length,
        image_count: imageMap.size,
        audio_count: audioTranscriptions.length,
        requested_screens: positions.length,
        max_width: C.VISUAL_MAX_WIDTH || 1280,
        jpeg_quality: C.VISUAL_JPEG_QUALITY || 0.7
      },
      warnings
    };

    Logger.debug("contexto visual capturado", buildVisualContextManifest(visualContext));
    return visualContext;
  }

  function buildConversationFromMessages(allMessages, options, captureMeta) {
    const maxMessages = (options && options.maxMessages) || C.MAX_MESSAGES;
    const clientName = extractClientName();
    const messages = allMessages.slice(-maxMessages);
    const headerPhone = extractHeaderPhone();
    const bodyPhone = extractPhoneFromText(messages.map((message) => message.text).join(" "));
    const warnings = [];

    if (!messages.length) {
      warnings.push("Nenhuma mensagem foi encontrada no DOM carregado do WhatsApp.");
    }
    if (allMessages.length > messages.length) {
      warnings.push(`Captura limitada as ultimas ${messages.length} mensagens carregadas no DOM.`);
    }
    if (!headerPhone && !bodyPhone) {
      warnings.push("Telefone nao ficou visivel no cabecalho nem nas mensagens capturadas.");
    }

    const conversation = {
      client_name: clientName,
      phone: headerPhone || bodyPhone || "",
      chat_title: clientName,
      messages,
      message_count: messages.length,
      captured_at: new Date().toISOString(),
      capture_strategy: captureMeta && captureMeta.scroll_used ? "whatsapp_dom_scroll_history" : "whatsapp_dom_loaded_messages",
      capture_rounds: captureMeta && captureMeta.rounds_completed ? captureMeta.rounds_completed : 0,
      capture_warnings: warnings,
      context: {
        page_url: location.href,
        title: document.title
      }
    };
    Logger.debug("conversa estruturada", conversation);
    return conversation;
  }

  function captureConversation(options) {
    return buildConversationFromMessages(collectMessages(0).map((message, originalIndex) => ({
      ...message,
      original_index: originalIndex
    })), options, { scroll_used: false, rounds_completed: 0 });
  }

  async function captureConversationDeep(options) {
    const capture = await collectMessagesWithHistory(options || {});
    return buildConversationFromMessages(capture.messages, options, capture);
  }

  function getComposer() {
    const selectors = [
      "footer div[contenteditable='true'][role='textbox']",
      "footer [contenteditable='true']",
      "[data-testid='conversation-compose-box-input']",
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true'][data-tab]",
      "[role='textbox'][contenteditable='true']"
    ];
    const candidates = Dom.allBySelectors(document, selectors)
      .filter((node) => node instanceof HTMLElement)
      .filter((node) => Dom.isVisible(node))
      .filter((node) => !node.closest("[data-projeto-ficha-panel='true'], .pfixa-overlay"))
      .map((node) => ({
        node,
        rect: node.getBoundingClientRect()
      }))
      .filter((item) => item.rect.width > 160 && item.rect.height > 20)
      .sort((a, b) => b.rect.bottom - a.rect.bottom);
    return candidates[0] ? candidates[0].node : null;
  }

  function dispatchComposerEvents(composer, value) {
    composer.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value
    }));
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    composer.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  }

  async function fillComposer(text) {
    const value = String(text || "").trim();
    if (!value) {
      return {
        ok: false,
        error: "Ficha vazia para inserir no WhatsApp."
      };
    }

    const composer = getComposer();
    if (!composer) {
      return {
        ok: false,
        error: "Composer do WhatsApp nao encontrado."
      };
    }

    try {
      composer.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      composer.focus();
      composer.click();

      const selection = window.getSelection();
      if (selection && composer.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      if (document.execCommand) {
        document.execCommand("insertText", false, value);
      } else {
        Dom.setNativeValue(composer, value);
      }
      dispatchComposerEvents(composer, value);
      await Dom.sleep(250);

      const insertedText = Dom.normalizeText(composer.innerText || composer.textContent || "");
      return {
        ok: insertedText.length >= Math.min(20, value.length),
        length: insertedText.length,
        error: insertedText ? "" : "Texto nao apareceu no composer do WhatsApp."
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message
      };
    }
  }

  globalThis.ProjetoFichaWhatsApp = {
    buildVisualContextManifest,
    captureConversation,
    captureConversationDeep,
    captureVisualContext,
    extractClientName,
    extractPhoneFromText,
    fillComposer,
    getComposer
  };
})();
