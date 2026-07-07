(function () {
  if (globalThis.ProjetoFichaMaterialApiClient) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants;
  const Logger = globalThis.ProjetoFichaLogger;

  function log(message, data) {
    if (Logger && Logger.debug) {
      Logger.debug(`[material-api] ${message}`, data);
    }
  }

  function collectImages(visualContext) {
    const images = [];
    if (!visualContext) {
      return images;
    }
    const maxImages = (C && C.MATERIAL_API_MAX_IMAGES) || 12;
    (visualContext.screenshots || []).forEach((shot, index) => {
      if (shot && shot.dataUrl) {
        images.push({
          kind: "screenshot",
          name: `screenshot-${index + 1}.jpg`,
          dataUrl: shot.dataUrl
        });
      }
    });
    (visualContext.images || []).forEach((image, index) => {
      if (image && image.dataUrl) {
        images.push({
          kind: "chat-image",
          name: `chat-image-${index + 1}.jpg`,
          dataUrl: image.dataUrl
        });
      }
    });
    return images.slice(0, maxImages);
  }

  function pickString(obj, keys) {
    for (const key of keys) {
      const value = obj && obj[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  }

  function parseResponse(data) {
    if (!data || typeof data !== "object") {
      return {
        answer: typeof data === "string" ? data : "",
        downloadUrl: "",
        downloadId: ""
      };
    }
    const payload = data.data && typeof data.data === "object"
      ? { ...data, ...data.data }
      : data;
    return {
      answer: pickString(payload, ["ficha", "answer", "content", "text", "result", "orcamento", "quotation"]),
      downloadUrl: pickString(payload, ["download_url", "downloadUrl", "pdf_url", "pdfUrl", "file_url", "fileUrl", "danfe_url", "url"]),
      downloadId: pickString(payload, ["download_id", "downloadId", "orcamento_id", "orcamentoId", "quotation_id", "quotationId", "document_id", "id"])
    };
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function generate(params) {
    const settings = params.settings || {};
    const material = settings.materialApi || {};
    const endpoint = (material.endpoint || C.MATERIAL_API_PROXY_URL || "").trim();
    if (!endpoint) {
      throw new Error("Endpoint local da Material API nao configurado.");
    }

    const onStatus = typeof params.onStatus === "function"
      ? params.onStatus
      : function () {};
    const conversation = params.conversation || {};
    const images = collectImages(params.visualContext);
    const body = {
      source: "whatsapp-extension",
      version: C.VERSION || "1.0.0",
      job_id: params.jobId || "",
      store_id: material.storeId || "",
      client: {
        name: conversation.client_name || "",
        phone: conversation.phone || ""
      },
      prompt: params.prompt || "",
      conversation: {
        client_name: conversation.client_name || "",
        phone: conversation.phone || "",
        message_count: conversation.message_count || 0,
        messages: Array.isArray(conversation.messages) ? conversation.messages : [],
        preprocessing: conversation.preprocessing || null
      },
      images,
      metrics: conversation.visual_context && conversation.visual_context.metrics
        ? conversation.visual_context.metrics
        : {}
    };

    onStatus("Enviando contexto ao backend seguro da Material API...", {
      images: images.length
    });
    log("proxy-request", {
      endpoint,
      images: images.length,
      storeId: material.storeId || ""
    });

    let response;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }, material.timeoutMs || 120000);
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("Tempo esgotado aguardando o backend da Material API.");
      }
      throw new Error(`Falha acessando o backend local: ${error.message}`);
    }

    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (error) {
      data = rawText;
    }

    if (!response.ok) {
      const detail = data && typeof data === "object"
        ? data.detail || data.error || data.message
        : rawText;
      throw new Error(`Material API retornou erro ${response.status}: ${String(detail || "sem detalhes").slice(0, 400)}`);
    }

    const parsed = parseResponse(data);
    onStatus("Resposta recebida da Material API.", {
      has_download: Boolean(parsed.downloadUrl)
    });
    return {
      ok: Boolean(parsed.answer || parsed.downloadUrl),
      answer: parsed.answer,
      downloadUrl: parsed.downloadUrl,
      downloadId: parsed.downloadId,
      status: response.status,
      message: parsed.answer
        ? "Ficha gerada pela Material API."
        : "Material API respondeu sem texto de ficha.",
      raw: data
    };
  }

  globalThis.ProjetoFichaMaterialApiClient = {
    collectImages,
    generate,
    parseResponse
  };
})();
