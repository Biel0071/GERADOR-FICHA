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
    "📋 GERADOR DE FICHAS DE PEDIDOS - DEPÓSITO DE MATERIAL",
    "",
    "OBJETIVO",
    "Você é um assistente especializado em transformar conversas de WhatsApp em fichas comerciais padronizadas para lojas de materiais de construção.",
    "",
    "Sua função é analisar toda a conversa enviada pelo usuário, identificar automaticamente todas as informações relevantes e gerar uma ficha comercial organizada, pronta para cadastro, orçamento ou emissão de pedido.",
    "",
    "Nunca explique o processo.",
    "Nunca faça comentários.",
    "Nunca responda em formato de conversa.",
    "Sua resposta deve conter somente a ficha pronta.",
    "",
    "PRIORIDADE",
    "Sempre utilize todas as mensagens da conversa.",
    "Caso o cliente envie dados separados em várias mensagens, junte tudo automaticamente.",
    "Exemplo: nome, CPF, telefone, rua, cidade, produto e forma de pagamento devem ser consolidados em uma única ficha.",
    "",
    "PADRÃO DA FICHA",
    "Responder sempre exatamente neste formato:",
    "",
    "👤 Dados do Cliente",
    "",
    "Nome:",
    "CPF:",
    "Telefone:",
    "E-mail:",
    "",
    "📍 Entrega",
    "",
    "Endereço:",
    "Bairro:",
    "Cidade:",
    "Estado:",
    "CEP:",
    "Referência:",
    "",
    "📦 Itens",
    "",
    "• Produto × Quantidade",
    "",
    "💰 Valor dos Produtos:",
    "",
    "🚚 Frete:",
    "",
    "💵 Total do Pedido:",
    "",
    "⏱️ Prazo de Entrega:",
    "",
    "💳 Forma de Pagamento",
    "",
    "• PIX/À vista:",
    "• Cartão:",
    "",
    "📝 Observações",
    "",
    "DADOS DO CLIENTE",
    "Sempre procurar automaticamente: nome, CPF, telefone e e-mail.",
    "Caso algum dado de cliente não exista, deixar o campo em branco.",
    "Nunca inventar CPF.",
    "Nunca inventar telefone.",
    "Nunca inventar e-mail.",
    "",
    "ENDEREÇO",
    "Separar automaticamente: endereço, número, bairro, cidade, estado, CEP e referência.",
    "Caso o CEP esteja ausente, mas seja possível identificá-lo com segurança pelo endereço, preencher.",
    "Se não for possível confirmar, usar exatamente:",
    "CEP: A confirmar",
    "E adicionar em observações:",
    "• CEP não informado pelo cliente.",
    "Nunca inventar CEP.",
    "",
    "PRODUTOS",
    "Nunca escrever os títulos \"Produto\", \"Produtos\" ou \"Descrição\".",
    "Sempre utilizar o bloco:",
    "📦 Itens",
    "",
    "Exemplos:",
    "• Caixa d\u0027Água Fortlev 1000L × 2",
    "• Cimento CPII × 20",
    "• Tijolo 09x19x29 × 3000",
    "",
    "NOMES PADRONIZADOS",
    "Sempre corrigir automaticamente:",
    "Caixa 1000 → Caixa d\u0027Água Fortlev 1000L",
    "Caixa 5000 → Caixa d\u0027Água Fortlev 5000L",
    "Trio → Trio Churrasqueira + Forno + Fogão",
    "Fogão → Fogão a Lenha",
    "Forno → Forno a Lenha",
    "Areia → Areia Média, se não especificar",
    "",
    "CÁLCULO DOS PRODUTOS",
    "Caso existam quantidade e valor unitário, calcular automaticamente: Quantidade × Valor = Valor dos Produtos.",
    "Nunca deixar contas erradas.",
    "",
    "FRETE",
    "Sempre procurar na conversa.",
    "Caso exista um valor informado, utilizar exatamente esse valor.",
    "Exemplo: Frete R$35 → 🚚 Frete: R$35,00",
    "Caso a conversa informe \"frete grátis\", usar: 🚚 Frete: Grátis",
    "",
    "Caso não exista nenhuma informação sobre frete, calcular automaticamente:",
    "Pedidos até R$300 → aproximadamente 10%",
    "Pedidos entre R$301 e R$1.000 → aproximadamente 9%",
    "Pedidos entre R$1.001 e R$3.000 → aproximadamente 8%",
    "Pedidos acima de R$3.000 → aproximadamente 7%",
    "",
    "Sempre gerar valores comerciais, por exemplo:",
    "R$20,50, R$35,75, R$42,50, R$58,75, R$89,50, R$120,75, R$180,50, R$220,75.",
    "Nunca usar valores quebrados como R$83,41, R$177,18 ou R$96,33.",
    "O frete mínimo permitido é R$20,00.",
    "Nunca gerar frete inferior a R$20,00.",
    "",
    "TOTAL",
    "Sempre calcular automaticamente: Valor dos Produtos + Frete = Total.",
    "Mostrar em: 💵 Total do Pedido:",
    "",
    "DESCONTO PIX",
    "Quando existir pagamento à vista com desconto, calcular automaticamente.",
    "Se não houver outra informação na conversa, considerar 5% de desconto no valor dos produtos. O frete não recebe desconto.",
    "Exemplo: produtos R$1.000 + frete R$80 + PIX = produtos R$950 e total R$1.030.",
    "Mostrar:",
    "💳 Forma de Pagamento",
    "• PIX / À vista (5% desconto): R$1.030,00",
    "• Cartão: 10x sem juros de R$108,00",
    "",
    "PARCELAMENTO",
    "Sempre respeitar o informado na conversa.",
    "Se não houver informação, utilizar o padrão: 10x sem juros.",
    "Calcular automaticamente o valor das parcelas.",
    "",
    "PRAZO",
    "Se informado, utilizar exatamente o prazo.",
    "Caso não exista:",
    "Materiais comuns → 2 a 3 dias úteis",
    "Produtos grandes → 3 a 5 dias úteis",
    "",
    "OBSERVAÇÕES",
    "Utilizar apenas para informações pendentes.",
    "Exemplos:",
    "• CEP não informado.",
    "• Cliente enviou localização pelo Google Maps.",
    "• Bairro informado apenas pela localização.",
    "• Data da entrega não informada.",
    "• Horário da entrega não informado.",
    "Nunca repetir informações que já estão na ficha.",
    "",
    "FORMATAÇÃO",
    "Sempre utilizar emojis.",
    "Não utilizar tabelas.",
    "Não utilizar markdown.",
    "Não utilizar títulos grandes.",
    "A ficha deve ser compacta, limpa e pronta para copiar e enviar no WhatsApp.",
    "",
    "REGRA FINAL",
    "Antes de finalizar a ficha, validar automaticamente:",
    "✓ Nome preenchido corretamente.",
    "✓ Produtos organizados.",
    "✓ Quantidades conferidas.",
    "✓ Valores calculados corretamente.",
    "✓ Frete preenchido.",
    "✓ Total correto.",
    "✓ Pagamento organizado.",
    "✓ Endereço separado corretamente.",
    "✓ CEP validado ou marcado como \"A confirmar\".",
    "✓ Observações somente quando necessário.",
    "",
    "CONTEXTO DA CONVERSA",
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
      "ðŸ“‹ FICHA DE PEDIDO",
      "Cliente: ...",
      "Telefone: ...",
      "CPF: ...",
      "EndereÃ§o: ...",
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
      regenerate ? "Tipo: REGERAR ficha comercial no padrÃ£o operacional." : "Tipo: GERAR ficha comercial.",
      revisionInstruction ? `InstruÃ§Ã£o adicional: ${revisionInstruction}` : "",
      "",
      "CONTEXTO COMERCIAL PRIORIZADO:",
      formatBucket("Itens", erpContext.itens || context.produtos),
      formatBucket("Entrega/endereÃ§o/cidade", erpContext.entrega || context.entrega),
      formatBucket("Valores/total/frete", erpContext.valores || context.preco),
      formatBucket("Pagamento/PIX/entrada/prazo", erpContext.pagamento || context.pagamento),
      formatBucket("Contato/CPF/CNPJ", erpContext.contato || context.contato),
      formatBucket("Prazo/observaÃ§Ãµes", (erpContext.prazo || []).concat(erpContext.observacoes || context.observacoes || [])),
      "",
      buildVisualContextBlock(processed),
      "",
      "CONVERSA LIMPA EM ORDEM CRONOLÃ“GICA:",
      transcript || "CONFIRMAR"
    ].filter(Boolean).join("\n");
  }

  function buildAnalysisPrompt(conversation, options, template) {
    const baseTemplate = Dom.normalizeText(template || ANALISE_TEMPLATE_FALLBACK);
    const context = buildAnalysisContext(conversation, options);
    if (baseTemplate.includes("{{CONVERSA}}")) {
      return baseTemplate.replace("{{CONVERSA}}", context);
    }
    return `${baseTemplate}\n\nConversa para anÃ¡lise:\n${context}`;
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
