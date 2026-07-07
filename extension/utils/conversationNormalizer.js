(function () {
  if (globalThis.ProjetoFichaConversationNormalizer) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants || { MAX_CLEAN_MESSAGES: 55 };
  const Dom = globalThis.ProjetoFichaDom || {
    normalizeText: (value) => String(value || "").trim()
  };
  const Logger = globalThis.ProjetoFichaLogger || { debug: () => {} };

  const ARTIFACT_PATTERNS = [
    /\b(?:mensagem apagada|message deleted)\b/gi,
    /\b(?:imagem|video|vídeo|audio|áudio|documento) omitido\b/gi,
    /\b(?:image|video|audio|document) omitted\b/gi,
    /\b(?:encaminhada|forwarded|editada|edited)\b/gi,
    /\b(?:clique para baixar|click to download)\b/gi,
    /\b(?:reagir|responder|copiar|mais op[cç][oõ]es)\b/gi
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
    /^n[aã]o$/i,
    /^obg$/i,
    /^obrigad[oa]$/i,
    /^valeu$/i,
    /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u
  ];

  const PRIORITY_PATTERNS = {
    item: /\b(cimento|cp\s?ii|cp\s?iii|argamassa|rejunte|cal|gesso|areia|brita|pedra|cascalho|tijolo|bloco|telha|ferro|ferragem|vergalh[aã]o|malha|coluna|treli[cç]a|caixa d['’ ]?[aá]gua|madeira|porta|janela)\b/i,
    quantidade: /\b(qtd|quantidade|saco|sacos|metro|metros|m2|m3|unidade|un|barra|barras|kg|ton|milheiro|\d+([,.]\d+)?)\b/i,
    valor: /\b(pre[cç]o|valor|or[cç]amento|total|desconto|entrada|sinal|r\$|\d+[,.]\d{2})\b/i,
    pagamento: /\b(pagamento|pix|cart[aã]o|dinheiro|boleto|parcelar|prazo|entrada|sinal)\b/i,
    entrega: /\b(frete|entrega|entregar|retirada|retirar|endereco|endere[cç]o|bairro|cidade|obra|rua|avenida|av\.|n[uú]mero|cep)\b/i,
    contato: /\b(\d{2}\s?\d{4,5}[-\s]?\d{4}|\d{3}\.?\d{3}\.?\d{3}-?\d{2}|cpf|cnpj)\b/i,
    prazo: /\b(hoje|amanh[aã]|urgente|manh[aã]|tarde|noite|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b/i,
    observacao: /\b(obs|observa[cç][aã]o|prefer[eê]ncia|confirmar|alterar|trocar|mudou|cancelar)\b/i
  };

  function normalizeForKey(text) {
    return Dom.normalizeText(text)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s.,/@-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function collapseRepeatedWords(text) {
    const words = Dom.normalizeText(text).split(/\s+/).filter(Boolean);
    if (words.length < 2) {
      return words.join(" ");
    }

    const half = Math.floor(words.length / 2);
    for (let size = half; size >= 1; size -= 1) {
      const left = words.slice(0, size).join(" ").toLowerCase();
      const right = words.slice(size, size * 2).join(" ").toLowerCase();
      if (left && left === right && words.length === size * 2) {
        return words.slice(0, size).join(" ");
      }
    }

    return words.filter((word, index) => index === 0 || word !== words[index - 1]).join(" ");
  }

  function cleanMessageText(text) {
    let value = Dom.normalizeText(text)
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b\s*$/i, "");
    for (const pattern of ARTIFACT_PATTERNS) {
      value = value.replace(pattern, " ");
    }
    return collapseRepeatedWords(value.replace(/\s+/g, " "));
  }

  function isNoiseMessage(text) {
    const cleaned = cleanMessageText(text);
    if (!cleaned || cleaned.length < 2) {
      return true;
    }
    return NOISE_PATTERNS.some((pattern) => pattern.test(cleaned));
  }

  function extractTags(text) {
    const tags = [];
    for (const [tag, pattern] of Object.entries(PRIORITY_PATTERNS)) {
      if (pattern.test(text)) {
        tags.push(tag);
      }
    }
    return tags;
  }

  function scoreMessage(text, index, total) {
    const tags = extractTags(text);
    let score = tags.length * 3;
    if (/\?/.test(text)) {
      score += 1;
    }
    if (text.length > 80) {
      score += 1;
    }
    if (index >= total * 0.65) {
      score += 2;
    }
    return score;
  }

  function dedupe(messages) {
    const byKey = new Map();
    const total = (messages || []).length;

    (messages || []).forEach((message, index) => {
      const text = cleanMessageText(message.text);
      if (isNoiseMessage(text)) {
        return;
      }
      const key = `${message.author || ""}|${normalizeForKey(text)}`;
      const next = {
        ...message,
        text,
        original_index: Number.isFinite(message.original_index) ? message.original_index : index,
        priority_score: scoreMessage(text, index, total),
        tags: extractTags(text)
      };
      byKey.set(key, next);
    });

    return Array.from(byKey.values()).sort((a, b) => (a.original_index || 0) - (b.original_index || 0));
  }

  function selectRelevant(messages, limit) {
    const max = limit || C.MAX_CLEAN_MESSAGES || 55;
    if (messages.length <= max) {
      return messages;
    }

    const recentCount = Math.ceil(max * 0.65);
    const recent = messages.slice(-recentCount);
    const recentIndexes = new Set(recent.map((message) => message.original_index));
    const importantOlder = messages
      .slice(0, -recentCount)
      .filter((message) => message.priority_score >= 3)
      .sort((a, b) => {
        const scoreDiff = b.priority_score - a.priority_score;
        return scoreDiff || (a.original_index || 0) - (b.original_index || 0);
      })
      .slice(0, max - recent.length);

    return [...importantOlder, ...recent]
      .filter((message, index, list) => recentIndexes.has(message.original_index) || list.findIndex((item) => item.original_index === message.original_index) === index)
      .sort((a, b) => (a.original_index || 0) - (b.original_index || 0));
  }

  function bucketContext(messages) {
    const buckets = {
      itens: [],
      entrega: [],
      valores: [],
      pagamento: [],
      contato: [],
      prazo: [],
      observacoes: []
    };

    for (const message of messages) {
      const line = `${message.author === "atendente" ? "ATENDENTE" : "CLIENTE"}: ${message.text}`;
      if (message.tags.includes("item") || message.tags.includes("quantidade")) {
        buckets.itens.push(line);
      }
      if (message.tags.includes("entrega")) {
        buckets.entrega.push(line);
      }
      if (message.tags.includes("valor")) {
        buckets.valores.push(line);
      }
      if (message.tags.includes("pagamento")) {
        buckets.pagamento.push(line);
      }
      if (message.tags.includes("contato")) {
        buckets.contato.push(line);
      }
      if (message.tags.includes("prazo")) {
        buckets.prazo.push(line);
      }
      if (message.priority_score > 0) {
        buckets.observacoes.push(line);
      }
    }

    return Object.fromEntries(
      Object.entries(buckets).map(([key, values]) => [key, values.slice(-10)])
    );
  }

  function normalizeConversation(conversation, options) {
    const originalMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const deduped = dedupe(originalMessages);
    const selected = selectRelevant(deduped, options && options.maxMessages);
    const priorityCount = selected.filter((message) => message.priority_score > 0).length;
    const context = bucketContext(selected);

    const normalized = {
      ...conversation,
      captured_message_count: originalMessages.length,
      original_message_count: originalMessages.length,
      clean_message_count: selected.length,
      message_count: selected.length,
      removed_message_count: Math.max(0, originalMessages.length - selected.length),
      messages: selected,
      commercial_context: {
        produtos: context.itens,
        entrega: context.entrega,
        preco: context.valores,
        pagamento: context.pagamento,
        observacoes: context.observacoes,
        contato: context.contato,
        prazo: context.prazo
      },
      erp_context: context,
      preprocessing: {
        original_count: originalMessages.length,
        deduped_count: deduped.length,
        selected_count: selected.length,
        removed_count: Math.max(0, originalMessages.length - selected.length),
        priority_count: priorityCount,
        strategy: "progressive_dedupe_noise_recent_commercial_priority"
      }
    };

    Logger.debug("conversationNormalizer:normalizado", normalized.preprocessing);
    return normalized;
  }

  globalThis.ProjetoFichaConversationNormalizer = {
    cleanMessageText,
    dedupe,
    extractTags,
    isNoiseMessage,
    normalizeConversation,
    scoreMessage,
    selectRelevant
  };
})();
