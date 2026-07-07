(function () {
  if (globalThis.ProjetoFichaPrompt) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants || {};
  const Dom = globalThis.ProjetoFichaDom || {
    normalizeText: (value) => String(value || "").trim()
  };
  const Preprocess = globalThis.ProjetoFichaPreprocess;

  const ANALISE_TEMPLATE_FALLBACK = [
    "Você é o analista comercial do Projeto FICHA para pedidos de material de construção.",
    "Analise a conversa abaixo com texto + screenshots anexados + imagens do chat e gere uma ficha comercial pronta para copiar no WhatsApp.",
    "",
    "Regras obrigatórias:",
    "- Use somente dados informados na conversa.",
    "- Nunca invente cliente, CPF, telefone, endereço, referência, e-mail, produto, valor, prazo ou pagamento.",
    "- Quando faltar qualquer dado, escreva CONFIRMAR.",
    "- Priorize as mensagens mais recentes.",
    "- Detecte alterações de pedido, quantidade, valor, frete, retirada, entrega, entrada, PIX, prazo e observações.",
    "- Prioridade alta: nome, CPF, endereço, telefone, e-mail e data de entrega.",
    "- Prioridade média: produto, modelo, cor e quantidade.",
    "- Analise imagens anexadas para identificar produto, cor, modelo, valor anunciado, promoção e parcelamento.",
    "- Cruze valores do texto, imagens e vendedor. Gere Confiança do Preço como ALTA, MÉDIA ou BAIXA.",
    "- Gere Score de Confiança em percentual com motivo curto.",
    "- Ignore metadados e interface do WhatsApp.",
    "- Não explique a análise.",
    "- Não retorne JSON.",
    "- Não use o formato simples \"Cliente:\", \"Produtos:\" ou \"Frete:\".",
    "",
    "Formato obrigatório da resposta:",
    "",
    "👤 Cliente",
    "CONFIRMAR",
    "",
    "🪪 CPF",
    "CONFIRMAR",
    "",
    "📞 Telefone",
    "CONFIRMAR",
    "",
    "📅 Data da Entrega",
    "CONFIRMAR",
    "",
    "🚚 Endereço",
    "CONFIRMAR",
    "",
    "📍 Referência",
    "CONFIRMAR",
    "",
    "📧 E-mail",
    "CONFIRMAR",
    "",
    "📦 Produtos",
    "- CONFIRMAR",
    "",
    "💰 Valores",
    "CONFIRMAR",
    "",
    "📊 Confiança do Preço",
    "CONFIRMAR",
    "",
    "💵 Total Geral",
    "CONFIRMAR",
    "",
    "💳 Condições de Pagamento",
    "CONFIRMAR",
    "",
    "⏱️ Prazo",
    "CONFIRMAR",
    "",
    "⚠️ Pendências",
    "- CONFIRMAR",
    "",
    "✅ Score de Confiança",
    "CONFIRMAR",
    "",
    "Conversa para análise:",
    "{{CONVERSA}}"
  ].join("\n");

  function authorLabel(message) {
    return message.author === "atendente" ? "ATENDENTE" : "CLIENTE";
  }

  function buildMessageTranscript(messages) {
    return (messages || []).map((message, index) => {
      const time = message.time ? ` ${message.time}` : "";
      return `${index + 1}.${time} ${authorLabel(message)}: ${Dom.normalizeText(message.text)}`;
    }).join("\n");
  }

  function formatBucket(title, values) {
    const list = (values || []).filter(Boolean).slice(-8);
    if (!list.length) {
      return `${title}: CONFIRMAR`;
    }
    return `${title}:\n${list.map((value) => `- ${value}`).join("\n")}`;
  }

  function buildVisualContextBlock(conversation) {
    const visual = conversation && conversation.visual_context ? conversation.visual_context : null;
    if (!visual || !visual.metrics) {
      return [
        "CONTEXTO VISUAL:",
        "- NAO CAPTURADO"
      ].join("\n");
    }

    const info = visual.client_filled_info || {};
    const imageLines = (visual.images || []).slice(0, 8).map((image) => {
      const caption = image.caption ? ` legenda="${image.caption}"` : "";
      return `- ${image.id || "imagem"} ${image.width || 0}x${image.height || 0}${caption}`;
    });
    const screenshotLines = (visual.screenshots || []).slice(0, 10).map((shot, index) => {
      return `- tela ${index + 1}: ${shot.width || 0}x${shot.height || 0}, scrollTop=${shot.scrollTop || 0}`;
    });
    const audioLines = (visual.audio_transcriptions || []).map((audio) => {
      return `- ${audio.time || ""} ${audio.author || ""}: ${audio.transcription || audio.status || "CONFIRMAR"}`;
    });

    return [
      "CONTEXTO VISUAL HIBRIDO:",
      "Use texto + screenshots anexados + imagens do chat para decidir. Nao baseie a ficha apenas no texto extraido.",
      `Screenshots anexados: ${visual.metrics.screenshot_count || 0}`,
      `Imagens do chat anexadas: ${visual.metrics.image_count || 0}`,
      `Audios detectados/transcritos: ${visual.metrics.audio_count || 0}`,
      "Prioridade alta: nome, CPF, endereco, telefone, e-mail, data de entrega.",
      "Prioridade media: produto, modelo, cor, quantidade.",
      "Prioridade baixa: saudacoes, figurinhas, conversas paralelas e mensagens sem venda.",
      "Modo anti-erro: ignore visto por ultimo, online, digitando, aria-label, IDs/classes do DOM e elementos de interface do WhatsApp.",
      "",
      "TELAS CAPTURADAS:",
      screenshotLines.length ? screenshotLines.join("\n") : "- CONFIRMAR",
      "",
      "IMAGENS DO CHAT:",
      imageLines.length ? imageLines.join("\n") : "- CONFIRMAR",
      "",
      "AUDIOS:",
      audioLines.length ? audioLines.join("\n") : "- CONFIRMAR",
      "",
      "INFORMACOES PREENCHIDAS PELO CLIENTE:",
      `CPF detectado: ${info.cpf || "CONFIRMAR"}`,
      `E-mail detectado: ${info.email || "CONFIRMAR"}`,
      `Telefones detectados: ${(info.phones || []).join(", ") || "CONFIRMAR"}`,
      formatBucket("Linhas de endereco", info.address_lines || []),
      formatBucket("Linhas de entrega/data", info.delivery_lines || []),
      "",
      "Antes da ficha final, faca internamente um resumo CLIENTE, PRODUTO, VALORES, ENTREGA, PAGAMENTO e PENDENCIAS.",
      "Ao cruzar valores do texto, imagem e vendedor, gere CONFIANCA DO PRECO como ALTA, MEDIA ou BAIXA.",
      "Gere SCORE DE CONFIANCA em percentual e motivo curto, por exemplo: 95% Dados completos ou 72% Faltando endereco e e-mail.",
      visual.warnings && visual.warnings.length ? `Avisos visuais: ${visual.warnings.join(" | ")}` : ""
    ].filter(Boolean).join("\n");
  }

  function buildERPStylePrompt(conversation, options) {
    const processed = Preprocess && !conversation.preprocessing
      ? Preprocess.processConversation(conversation, { maxMessages: C.MAX_CLEAN_MESSAGES })
      : conversation;
    const regenerate = Boolean(options && options.regenerate);
    const revisionInstruction = Dom.normalizeText(options && options.revisionInstruction);
    const clientName = processed.client_name || "CONFIRMAR";
    const phone = processed.phone || "CONFIRMAR";
    const context = processed.commercial_context || {};
    const transcript = buildMessageTranscript(processed.messages);
    const preprocessing = processed.preprocessing || {};

    const erpContext = processed.erp_context || {};

    return [
      "Projeto FICHA. Gere ficha ERP compacta de pedido de material de construcao.",
      "Use somente dados informados. Nunca invente. Campo ausente = CONFIRMAR.",
      "Priorize mensagens recentes e detecte alteracao de pedido, valor, entrada/PIX, frete separado, retirada e prazo.",
      "Responda somente no formato abaixo, sem comentarios extras:",
      "",
      "📋 FICHA DE PEDIDO",
      "Cliente: ...",
      "Telefone: ...",
      "CPF: ...",
      "Endereço: ...",
      "Cidade: ...",
      "Produtos:",
      "- qtd + unidade + produto + detalhe",
      "Frete: ...",
      "Pagamento: ...",
      "Entrega: ...",
      "Total: ...",
      "Pendencias:",
      "- ...",
      "Resumo operacional: ...",
      "",
      `Cliente detectado: ${clientName}`,
      `Telefone detectado: ${phone}`,
      `Mensagens usadas: ${preprocessing.selected_count || (processed.messages || []).length} de ${preprocessing.original_count || processed.original_message_count || (processed.messages || []).length}`,
      regenerate ? "Tipo: REGERAR ficha mais limpa e operacional." : "Tipo: GERAR ficha.",
      revisionInstruction ? `Instrucao adicional: ${revisionInstruction}` : "",
      "",
      "CONTEXTO COMERCIAL PRIORIZADO:",
      formatBucket("Itens", erpContext.itens || context.produtos),
      formatBucket("Entrega/endereco/cidade", erpContext.entrega || context.entrega),
      formatBucket("Valores/total/frete", erpContext.valores || context.preco),
      formatBucket("Pagamento/PIX/entrada/prazo", erpContext.pagamento || context.pagamento),
      formatBucket("Contato/CPF/CNPJ", erpContext.contato || context.contato),
      formatBucket("Prazo/observacoes", (erpContext.prazo || []).concat(erpContext.observacoes || context.observacoes || [])),
      "",
      buildVisualContextBlock(processed),
      "",
      "CONVERSA LIMPA EM ORDEM:",
      transcript || "CONFIRMAR"
    ].filter(Boolean).join("\n");
  }

  function buildAnalysisContext(conversation, options) {
    const processed = Preprocess && !conversation.preprocessing
      ? Preprocess.processConversation(conversation, { maxMessages: C.MAX_CLEAN_MESSAGES })
      : conversation;
    const regenerate = Boolean(options && options.regenerate);
    const revisionInstruction = Dom.normalizeText(options && options.revisionInstruction);
    const clientName = processed.client_name || "CONFIRMAR";
    const phone = processed.phone || "CONFIRMAR";
    const context = processed.commercial_context || {};
    const erpContext = processed.erp_context || {};
    const preprocessing = processed.preprocessing || {};
    const transcript = buildMessageTranscript(processed.messages);

    return [
      `Cliente detectado: ${clientName}`,
      `Telefone detectado: ${phone}`,
      `Mensagens usadas: ${preprocessing.selected_count || (processed.messages || []).length} de ${preprocessing.original_count || processed.original_message_count || (processed.messages || []).length}`,
      regenerate ? "Tipo: REGERAR ficha comercial no padrão operacional." : "Tipo: GERAR ficha comercial.",
      revisionInstruction ? `Instrução adicional: ${revisionInstruction}` : "",
      "",
      "CONTEXTO COMERCIAL PRIORIZADO:",
      formatBucket("Itens", erpContext.itens || context.produtos),
      formatBucket("Entrega/endereço/cidade", erpContext.entrega || context.entrega),
      formatBucket("Valores/total/frete", erpContext.valores || context.preco),
      formatBucket("Pagamento/PIX/entrada/prazo", erpContext.pagamento || context.pagamento),
      formatBucket("Contato/CPF/CNPJ", erpContext.contato || context.contato),
      formatBucket("Prazo/observações", (erpContext.prazo || []).concat(erpContext.observacoes || context.observacoes || [])),
      "",
      buildVisualContextBlock(processed),
      "",
      "CONVERSA LIMPA EM ORDEM CRONOLÓGICA:",
      transcript || "CONFIRMAR"
    ].filter(Boolean).join("\n");
  }

  function buildAnalysisPrompt(conversation, options, template) {
    const baseTemplate = Dom.normalizeText(template || ANALISE_TEMPLATE_FALLBACK);
    const context = buildAnalysisContext(conversation, options);
    if (baseTemplate.includes("{{CONVERSA}}")) {
      return baseTemplate.replace("{{CONVERSA}}", context);
    }
    return `${baseTemplate}\n\nConversa para análise:\n${context}`;
  }

  async function loadAnalysisTemplate() {
    try {
      if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.getURL !== "function" || typeof fetch !== "function") {
        return ANALISE_TEMPLATE_FALLBACK;
      }
      const response = await fetch(chrome.runtime.getURL(C.ANALISE_PROMPT_PATH || "prompts/ANALISE.txt"));
      if (!response.ok) {
        return "";
      }
      return await response.text();
    } catch (error) {
      return "";
    }
  }

  async function buildFichaPromptAsync(conversation, options) {
    const template = await loadAnalysisTemplate();
    if (template) {
      return buildAnalysisPrompt(conversation, options, template);
    }
    return buildERPStylePrompt(conversation, options);
  }

  function buildFichaPrompt(conversation, options) {
    return buildAnalysisPrompt(conversation, options, ANALISE_TEMPLATE_FALLBACK);
  }

  function linesAfterHeading(text, headings) {
    const normalized = String(text || "").replace(/\r\n/g, "\n");
    const escaped = headings.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const regex = new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n\\s*[A-Z][A-Za-z ]{1,36}:|$)`, "i");
    const match = normalized.match(regex);
    if (!match) {
      return [];
    }
    return match[1]
      .split("\n")
      .map((line) => Dom.normalizeText(line.replace(/^[-*]\s*/, "")))
      .filter(Boolean);
  }

  function sectionText(text, headings) {
    return linesAfterHeading(text, headings).join("\n");
  }

  function parseFichaSections(text) {
    if (globalThis.ProjetoFichaResponseParser) {
      return globalThis.ProjetoFichaResponseParser.toFichaSections(text);
    }
    const answer = String(text || "");
    const products = linesAfterHeading(answer, ["Produtos", "Produto"]);
    let missingInfo = linesAfterHeading(answer, ["Pendencias", "Informacoes faltantes"]);

    if (!missingInfo.length) {
      missingInfo = answer
        .split("\n")
        .map((line) => Dom.normalizeText(line))
        .filter((line) => /CONFIRMAR/i.test(line));
    }

    return {
      products,
      missing_info: missingInfo,
      summary: sectionText(answer, ["Resumo operacional", "Resumo"]) || "",
      questions: linesAfterHeading(answer, ["Perguntas para confirmar", "Perguntas"]),
      raw_text: answer
    };
  }

  globalThis.ProjetoFichaPrompt = {
    buildAnalysisPrompt,
    buildERPStylePrompt,
    buildFichaPrompt,
    buildFichaPromptAsync,
    parseFichaSections
  };
})();
