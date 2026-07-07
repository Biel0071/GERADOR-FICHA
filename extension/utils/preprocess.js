(function () {
  if (globalThis.ProjetoFichaPreprocess) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants || { MAX_CLEAN_MESSAGES: 55 };
  const Dom = globalThis.ProjetoFichaDom || {
    normalizeText: (value) => String(value || "").trim()
  };
  const Logger = globalThis.ProjetoFichaLogger || { debug: () => {} };

  const COMMERCIAL_PATTERNS = [
    /\b(cimento|cp\s?ii|cp\s?iii|argamassa|rejunte|cal|gesso)\b/i,
    /\b(areia|brita|pedra|cascalho|po de pedra|p[oó] de pedra)\b/i,
    /\b(tijolo|bloco|telha|madeira|tabua|t[aá]bua|porta|janela)\b/i,
    /\b(ferro|ferragem|vergalhao|vergalh[aã]o|malha|coluna|trelica|treli[cç]a)\b/i,
    /\b(caixa d[' ]?agua|caixa d[\u2019']agua|caixa de agua|caixa d[aá]gua)\b/i,
    /\b(qtd|quantidade|saco|sacos|metro|metros|m2|m3|unidade|un|barra|barras|milheiro)\b/i,
    /\b(preco|pre[cç]o|valor|orcamento|or[cç]amento|total|desconto)\b/i,
    /\b(frete|entrega|entregar|retirada|retirar|endereco|endere[cç]o|bairro|cidade|obra)\b/i,
    /\b(pagamento|pagar|pix|cartao|cart[aã]o|dinheiro|boleto|parcelar|prazo)\b/i,
    /\b(urgente|hoje|amanha|amanh[aã]|manh[aã]|tarde|observacao|observa[cç][aã]o)\b/i,
    /\b\d+([,.]\d+)?\s?(sacos?|m2|m3|metros?|un|unid|barras?|kg|ton|milheiro)?\b/i
  ];

  const NOISE_PATTERNS = [
    /^ok$/i,
    /^okay$/i,
    /^blz$/i,
    /^beleza$/i,
    /^bom$/i,
    /^ta$/i,
    /^t[aá]$/i,
    /^sim$/i,
    /^nao$/i,
    /^n[aã]o$/i,
    /^👍+$/,
    /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u
  ];

  function normalizeForKey(text) {
    return Dom.normalizeText(text)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s.,/-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function collapseRepeatedWords(text) {
    const normalized = Dom.normalizeText(text);
    const words = normalized.split(/\s+/);
    if (words.length < 2) {
      return normalized;
    }

    const half = Math.floor(words.length / 2);
    for (let size = half; size >= 1; size -= 1) {
      const first = words.slice(0, size).join(" ").toLowerCase();
      const second = words.slice(size, size * 2).join(" ").toLowerCase();
      if (first && first === second && words.length === size * 2) {
        return words.slice(0, size).join(" ");
      }
    }

    const compact = [];
    for (const word of words) {
      if (compact[compact.length - 1] !== word) {
        compact.push(word);
      }
    }
    return compact.join(" ");
  }

  function cleanMessageText(text) {
    return collapseRepeatedWords(
      Dom.normalizeText(text)
        .replace(/https?:\/\/\S+/gi, "")
        .replace(/\b(?:imagem|video|audio|documento) omitido\b/gi, "")
        .replace(/\b(?:image|video|audio|document) omitted\b/gi, "")
        .replace(/\s+/g, " ")
    );
  }

  function isNoise(text) {
    const cleaned = cleanMessageText(text);
    if (!cleaned || cleaned.length < 2) {
      return true;
    }
    return NOISE_PATTERNS.some((pattern) => pattern.test(cleaned));
  }

  function scoreMessage(text) {
    const cleaned = cleanMessageText(text);
    let score = 0;
    for (const pattern of COMMERCIAL_PATTERNS) {
      if (pattern.test(cleaned)) {
        score += 1;
      }
    }
    if (/\?/.test(cleaned)) {
      score += 1;
    }
    if (cleaned.length > 120) {
      score += 1;
    }
    return score;
  }

  function classifyMessage(text) {
    const cleaned = cleanMessageText(text);
    const tags = [];
    if (/\b(cimento|areia|brita|tijolo|bloco|telha|ferro|ferragem|argamassa|cal|caixa|madeira)\b/i.test(cleaned)) {
      tags.push("produto");
    }
    if (/\b(qtd|quantidade|saco|sacos|metro|metros|m2|m3|unidade|un|barra|barras|\d+)\b/i.test(cleaned)) {
      tags.push("quantidade");
    }
    if (/\b(preco|pre[cç]o|valor|orcamento|or[cç]amento|total|desconto)\b/i.test(cleaned)) {
      tags.push("preco");
    }
    if (/\b(frete|entrega|entregar|retirada|endereco|endere[cç]o|bairro|cidade|obra)\b/i.test(cleaned)) {
      tags.push("entrega");
    }
    if (/\b(pagamento|pix|cartao|cart[aã]o|dinheiro|boleto|parcelar|prazo)\b/i.test(cleaned)) {
      tags.push("pagamento");
    }
    return tags;
  }

  function dedupeMessages(messages) {
    const keyed = new Map();
    const cleaned = [];

    (messages || []).forEach((message, originalIndex) => {
      const text = cleanMessageText(message.text);
      if (isNoise(text)) {
        return;
      }
      const key = `${message.author || ""}|${normalizeForKey(text)}`;
      const next = {
        ...message,
        text,
        original_index: Number.isFinite(message.original_index) ? message.original_index : originalIndex,
        priority_score: scoreMessage(text),
        tags: classifyMessage(text)
      };
      keyed.set(key, next);
    });

    for (const message of keyed.values()) {
      cleaned.push(message);
    }

    cleaned.sort((a, b) => (a.original_index || 0) - (b.original_index || 0));
    return cleaned;
  }

  function selectMessages(messages, limit) {
    const max = limit || C.MAX_CLEAN_MESSAGES || 55;
    if (messages.length <= max) {
      return messages;
    }

    const recent = messages.slice(-Math.ceil(max * 0.62));
    const recentKeys = new Set(recent.map((message) => message.original_index));
    const relevantOlder = messages
      .slice(0, -recent.length)
      .filter((message) => message.priority_score > 0)
      .slice(-Math.floor(max * 0.38));

    return [...relevantOlder, ...recent]
      .filter((message, index, list) => {
        if (recentKeys.has(message.original_index)) {
          return true;
        }
        return list.findIndex((item) => item.original_index === message.original_index) === index;
      })
      .sort((a, b) => (a.original_index || 0) - (b.original_index || 0))
      .slice(-max);
  }

  function buildCommercialContext(messages) {
    const buckets = {
      produtos: [],
      entrega: [],
      pagamento: [],
      preco: [],
      observacoes: []
    };

    for (const message of messages) {
      const line = `${message.author === "atendente" ? "ATENDENTE" : "CLIENTE"}: ${message.text}`;
      if (message.tags.includes("produto") || message.tags.includes("quantidade")) {
        buckets.produtos.push(line);
      }
      if (message.tags.includes("entrega")) {
        buckets.entrega.push(line);
      }
      if (message.tags.includes("pagamento")) {
        buckets.pagamento.push(line);
      }
      if (message.tags.includes("preco")) {
        buckets.preco.push(line);
      }
      if (message.priority_score > 0 && buckets.observacoes.length < 8) {
        buckets.observacoes.push(line);
      }
    }

    return Object.fromEntries(
      Object.entries(buckets).map(([key, values]) => [key, values.slice(-10)])
    );
  }

  function processConversation(conversation, options) {
    if (globalThis.ProjetoFichaConversationNormalizer) {
      return globalThis.ProjetoFichaConversationNormalizer.normalizeConversation(conversation, options || {});
    }
    const originalMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const deduped = dedupeMessages(originalMessages);
    const selected = selectMessages(deduped, options && options.maxMessages);
    const priorityCount = selected.filter((message) => message.priority_score > 0).length;

    const processed = {
      ...conversation,
      captured_message_count: originalMessages.length,
      original_message_count: originalMessages.length,
      clean_message_count: selected.length,
      message_count: selected.length,
      removed_message_count: Math.max(0, originalMessages.length - selected.length),
      messages: selected,
      commercial_context: buildCommercialContext(selected),
      preprocessing: {
        original_count: originalMessages.length,
        deduped_count: deduped.length,
        selected_count: selected.length,
        removed_count: Math.max(0, originalMessages.length - selected.length),
        priority_count: priorityCount,
        strategy: "dedupe_noise_priority_recent"
      }
    };

    Logger.debug("conversa preprocessada", processed.preprocessing);
    return processed;
  }

  globalThis.ProjetoFichaPreprocess = {
    cleanMessageText,
    isNoise,
    processConversation,
    scoreMessage
  };
})();
