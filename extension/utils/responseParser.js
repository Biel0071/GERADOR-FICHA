(function () {
  if (globalThis.ProjetoFichaResponseParser) {
    return;
  }

  const Dom = globalThis.ProjetoFichaDom || {
    normalizeText: (value) => String(value || "").trim()
  };

  const EMPTY_STRUCT = Object.freeze({
    nome: "",
    cpf: "",
    telefone: "",
    email: "",
    endereco: "",
    bairro: "",
    cidade: "",
    estado: "",
    cep: "",
    referencia: "",
    itens: [],
    valor_produtos: "",
    frete: "",
    total_pedido: "",
    prazo_entrega: "",
    pix: "",
    cartao: "",
    observacoes: []
  });

  function stripDecorations(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function normalize(value) {
    return Dom.normalizeText(String(value || "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[:：]\s*$/, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase());
  }

  function cleanValue(value) {
    return Dom.normalizeText(String(value || "").replace(/^[-*•]\s*/, ""));
  }

  function isBlank(value) {
    const clean = cleanValue(value);
    return !clean || /^confirmar$/i.test(clean) || /^a confirmar$/i.test(clean);
  }

  function sectionName(line) {
    const n = normalize(line);
    if (/dados do cliente|cliente$/.test(n)) return "cliente";
    if (/entrega|endereco/.test(n) && !/prazo/.test(n)) return "entrega";
    if (/itens|produtos|produto/.test(n)) return "itens";
    if (/forma de pagamento|condicoes de pagamento|pagamento/.test(n)) return "pagamento";
    if (/observacoes|pendencias|informacoes faltantes/.test(n)) return "observacoes";
    return "";
  }

  const FIELD_ALIASES = [
    ["nome", ["nome", "cliente"]],
    ["cpf", ["cpf", "cnpj"]],
    ["telefone", ["telefone", "contato", "celular"]],
    ["email", ["e-mail", "email"]],
    ["endereco", ["endereco", "rua", "logradouro"]],
    ["bairro", ["bairro"]],
    ["cidade", ["cidade"]],
    ["estado", ["estado", "uf"]],
    ["cep", ["cep"]],
    ["referencia", ["referencia", "ponto de referencia"]],
    ["valor_produtos", ["valor dos produtos", "valores", "valor"]],
    ["frete", ["frete"]],
    ["total_pedido", ["total do pedido", "total geral", "total"]],
    ["prazo_entrega", ["prazo de entrega", "prazo"]],
    ["pix", ["pix/a vista", "pix / a vista", "pix", "a vista", "à vista"]],
    ["cartao", ["cartao", "cartão"]]
  ];

  function parseKeyValue(line) {
    const match = String(line || "").match(/^\s*(?:[-*•]\s*)?([^:：]{2,80})[:：]\s*(.*)$/);
    if (!match) return null;
    const key = normalize(match[1]);
    const value = cleanValue(match[2]);
    for (const [field, aliases] of FIELD_ALIASES) {
      if (aliases.some((alias) => key === normalize(alias))) {
        return { field, value };
      }
    }
    return null;
  }

  function parseResponse(text) {
    const answer = stripDecorations(text);
    const parsed = {
      ...EMPTY_STRUCT,
      itens: [],
      observacoes: [],
      raw_text: answer,
      sections: {}
    };

    let section = "";
    for (const rawLine of answer.split("\n")) {
      const line = Dom.normalizeText(rawLine);
      if (!line) continue;

      const nextSection = sectionName(line);
      if (nextSection && !parseKeyValue(line)) {
        section = nextSection;
        parsed.sections[section] = parsed.sections[section] || [];
        continue;
      }

      const pair = parseKeyValue(line);
      if (pair) {
        if (pair.field === "pix" || pair.field === "cartao") {
          parsed[pair.field] = pair.value;
        } else if (pair.value || !(pair.field in parsed)) {
          parsed[pair.field] = pair.value;
        }
        continue;
      }

      if (section === "itens") {
        const item = cleanValue(line);
        if (item && !/^produto\s*[×x]\s*quantidade$/i.test(item)) {
          parsed.itens.push(item);
        }
        continue;
      }

      if (section === "pagamento") {
        const payment = cleanValue(line);
        if (/pix|vista/i.test(payment) && !parsed.pix) parsed.pix = payment.replace(/^pix\s*\/\s*à?\s*vista\s*:?\s*/i, "");
        else if (/cart[aã]o|\d+x/i.test(payment) && !parsed.cartao) parsed.cartao = payment.replace(/^cart[aã]o\s*:?\s*/i, "");
        continue;
      }

      if (section === "observacoes") {
        parsed.observacoes.push(cleanValue(line));
      }
    }

    // Backward compatibility with the previous commercial pattern.
    if (!parsed.nome) parsed.nome = valueAfterOldHeading(answer, ["👤 Cliente", "Cliente"]);
    if (!parsed.cpf) parsed.cpf = valueAfterOldHeading(answer, ["🪪 CPF", "CPF"]);
    if (!parsed.telefone) parsed.telefone = valueAfterOldHeading(answer, ["📞 Telefone", "Telefone"]);
    if (!parsed.email) parsed.email = valueAfterOldHeading(answer, ["📧 E-mail", "E-mail", "Email"]);
    if (!parsed.endereco) parsed.endereco = valueAfterOldHeading(answer, ["🚚 Endereço", "Endereço", "Endereco"]);
    if (!parsed.referencia) parsed.referencia = valueAfterOldHeading(answer, ["📍 Referência", "Referência", "Referencia"]);
    if (!parsed.prazo_entrega) parsed.prazo_entrega = valueAfterOldHeading(answer, ["⏱️ Prazo", "Prazo"]);
    if (!parsed.total_pedido) parsed.total_pedido = valueAfterOldHeading(answer, ["💵 Total Geral", "Total Geral", "Total"]);
    if (!parsed.itens.length) parsed.itens = listAfterOldHeading(answer, ["📦 Produtos", "Produtos", "Itens"]);

    // Legacy keys kept for existing UI code.
    parsed.cliente = parsed.nome;
    parsed.data_entrega = parsed.prazo_entrega;
    parsed.email = parsed.email;
    parsed.valores = parsed.valor_produtos;
    parsed.total = parsed.total_pedido;
    parsed.pagamento = [parsed.pix ? `PIX/À vista: ${parsed.pix}` : "", parsed.cartao ? `Cartão: ${parsed.cartao}` : ""].filter(Boolean).join("\n");
    parsed.prazo = parsed.prazo_entrega;
    parsed.entrega = parsed.endereco;
    parsed.pendencias = parsed.observacoes;
    parsed.score_confianca = "";
    parsed.resumo = "";

    return parsed;
  }

  function valueAfterOldHeading(answer, headings) {
    const lines = stripDecorations(answer).split("\n");
    const aliases = headings.map(normalize);
    for (let i = 0; i < lines.length; i += 1) {
      const line = Dom.normalizeText(lines[i]);
      const pair = parseKeyValue(line);
      if (pair && aliases.includes(normalize(line.split(/[:：]/)[0]))) {
        return pair.value;
      }
      if (aliases.includes(normalize(line))) {
        for (let j = i + 1; j < lines.length; j += 1) {
          const value = cleanValue(lines[j]);
          if (value) return value;
        }
      }
    }
    return "";
  }

  function listAfterOldHeading(answer, headings) {
    const lines = stripDecorations(answer).split("\n");
    const aliases = headings.map(normalize);
    const items = [];
    let active = false;
    for (const raw of lines) {
      const line = Dom.normalizeText(raw);
      if (!line) continue;
      if (aliases.includes(normalize(line))) {
        active = true;
        continue;
      }
      if (active && sectionName(line)) break;
      if (active) items.push(cleanValue(line));
    }
    return items.filter(Boolean);
  }

  function valueOrBlank(value) {
    return isBlank(value) ? "" : cleanValue(value);
  }

  function cepValue(parsed) {
    return isBlank(parsed.cep) ? "A confirmar" : cleanValue(parsed.cep);
  }

  function listBlock(items) {
    const values = (items || []).map(cleanValue).filter(Boolean);
    if (!values.length) return "";
    return values.map((item) => `• ${item.replace(/^•\s*/, "")}`).join("\n");
  }

  function ensureObservacoes(parsed) {
    const notes = (parsed.observacoes || []).map(cleanValue).filter(Boolean);
    if (isBlank(parsed.cep) && !notes.some((item) => /cep/i.test(item))) {
      notes.push("CEP não informado pelo cliente.");
    }
    return notes;
  }

  function formatCommercialFicha(parsedInput, conversation) {
    const parsed = parsedInput && parsedInput.raw_text ? parsedInput : parseResponse(parsedInput || "");
    const nome = valueOrBlank(parsed.nome || parsed.cliente) || (conversation && conversation.client_name ? conversation.client_name : "");
    const telefone = valueOrBlank(parsed.telefone) || (conversation && conversation.phone ? conversation.phone : "");
    const observacoes = ensureObservacoes(parsed);

    return [
      "👤 Dados do Cliente",
      "",
      `Nome: ${nome}`,
      `CPF: ${valueOrBlank(parsed.cpf)}`,
      `Telefone: ${telefone}`,
      `E-mail: ${valueOrBlank(parsed.email)}`,
      "",
      "📍 Entrega",
      "",
      `Endereço: ${valueOrBlank(parsed.endereco)}`,
      `Bairro: ${valueOrBlank(parsed.bairro)}`,
      `Cidade: ${valueOrBlank(parsed.cidade)}`,
      `Estado: ${valueOrBlank(parsed.estado)}`,
      `CEP: ${cepValue(parsed)}`,
      `Referência: ${valueOrBlank(parsed.referencia)}`,
      "",
      "📦 Itens",
      "",
      listBlock(parsed.itens),
      "",
      `💰 Valor dos Produtos: ${valueOrBlank(parsed.valor_produtos || parsed.valores)}`,
      "",
      `🚚 Frete: ${valueOrBlank(parsed.frete)}`,
      "",
      `💵 Total do Pedido: ${valueOrBlank(parsed.total_pedido || parsed.total)}`,
      "",
      `⏱️ Prazo de Entrega: ${valueOrBlank(parsed.prazo_entrega || parsed.prazo)}`,
      "",
      "💳 Forma de Pagamento",
      "",
      `• PIX/À vista: ${valueOrBlank(parsed.pix)}`,
      `• Cartão: ${valueOrBlank(parsed.cartao)}`,
      "",
      "📝 Observações",
      listBlock(observacoes)
    ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function validateCommercialFicha(textOrParsed, conversation) {
    const parsed = typeof textOrParsed === "string" ? parseResponse(textOrParsed) : textOrParsed;
    const formatted = typeof textOrParsed === "string" ? textOrParsed : formatCommercialFicha(parsed, conversation);
    const missing = [];
    const nameOk = !isBlank(parsed.nome || parsed.cliente) || Boolean(conversation && conversation.client_name);
    if (!/👤\s*Dados do Cliente/i.test(formatted) || !nameOk) missing.push("CLIENTE");
    if (!/📦\s*Itens/i.test(formatted) || !(parsed.itens || []).some((item) => !isBlank(item))) missing.push("PRODUTO");
    if (!/🚚\s*Frete:/i.test(formatted)) missing.push("FRETE");
    if (!/💵\s*Total do Pedido:/i.test(formatted)) missing.push("TOTAL");
    return {
      ok: missing.length === 0,
      missing,
      parsed,
      formatted
    };
  }

  function toFichaSections(text) {
    const parsed = parseResponse(text);
    return {
      products: parsed.itens,
      missing_info: parsed.observacoes,
      summary: [parsed.valor_produtos, parsed.frete, parsed.total_pedido].filter(Boolean).join(" | "),
      questions: parsed.observacoes,
      structured: parsed,
      raw_text: parsed.raw_text
    };
  }

  globalThis.ProjetoFichaResponseParser = {
    formatCommercialFicha,
    parseResponse,
    toFichaSections,
    validateCommercialFicha
  };
})();