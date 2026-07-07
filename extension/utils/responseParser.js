(function () {
  if (globalThis.ProjetoFichaResponseParser) {
    return;
  }

  const Dom = globalThis.ProjetoFichaDom || {
    normalizeText: (value) => String(value || "").trim()
  };

  const FIELD_DEFINITIONS = [
    { key: "cliente", heading: "👤 Cliente", aliases: ["Cliente"] },
    { key: "cpf", heading: "🪪 CPF", aliases: ["CPF", "CNPJ"] },
    { key: "telefone", heading: "📞 Telefone", aliases: ["Telefone", "Contato"] },
    { key: "data_entrega", heading: "📅 Data da Entrega", aliases: ["Data da Entrega", "Data de Entrega", "Data entrega"] },
    { key: "endereco", heading: "🚚 Endereço", aliases: ["Endereço", "Endereco", "EndereÃ§o"] },
    { key: "referencia", heading: "📍 Referência", aliases: ["Referência", "Referencia", "ReferÃªncia", "Ponto de referência", "Ponto de referencia"] },
    { key: "email", heading: "📧 E-mail", aliases: ["E-mail", "Email"] },
    { key: "itens", heading: "📦 Produtos", aliases: ["Produtos", "Produto", "Itens", "Item"] },
    { key: "valores", heading: "💰 Valores", aliases: ["Valores", "Valor", "Frete"] },
    { key: "confianca_preco", heading: "📊 Confiança do Preço", aliases: ["Confiança do Preço", "Confianca do Preco", "CONFIANÇA DO PREÇO", "Confianca Preco"] },
    { key: "total", heading: "💵 Total Geral", aliases: ["Total Geral", "Total", "Valor total"] },
    { key: "pagamento", heading: "💳 Condições de Pagamento", aliases: ["Condições de Pagamento", "Condicoes de Pagamento", "CondiÃ§Ãµes de Pagamento", "Pagamento"] },
    { key: "prazo", heading: "⏱️ Prazo", aliases: ["Prazo", "Entrega"] },
    { key: "pendencias", heading: "⚠️ Pendências", aliases: ["Pendências", "Pendencias", "PendÃªncias", "Confirmar", "Informações faltantes", "Informacoes faltantes"] },
    { key: "score_confianca", heading: "✅ Score de Confiança", aliases: ["Score de Confiança", "Score de Confianca", "SCORE DE CONFIANÇA", "Score"] },
    { key: "resumo", heading: "Resumo", aliases: ["Resumo", "Resumo operacional"] }
  ];

  const FIELD_BY_KEY = FIELD_DEFINITIONS.reduce((acc, item) => {
    acc[item.key] = item;
    return acc;
  }, {});

  function stripDecorations(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function normalizeHeading(value) {
    return Dom.normalizeText(String(value || "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[:：]\s*$/, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase());
  }

  function aliasesFor(definition) {
    return [definition.heading, ...(definition.aliases || [])].map(normalizeHeading);
  }

  function detectHeading(line) {
    const clean = Dom.normalizeText(String(line || "").replace(/^[-*•]\s*/, ""));
    if (!clean) {
      return null;
    }

    for (const definition of FIELD_DEFINITIONS) {
      const aliases = aliasesFor(definition);
      for (const alias of aliases) {
        const normalized = normalizeHeading(clean);
        if (normalized === alias) {
          return { key: definition.key, value: "" };
        }
        if (normalized.startsWith(`${alias}:`)) {
          return { key: definition.key, value: Dom.normalizeText(clean.slice(clean.indexOf(":") + 1)) };
        }
        const plainAlias = alias.replace(/[^\p{L}\p{N}\s]/gu, "").trim();
        if (plainAlias && normalized.startsWith(`${plainAlias}:`)) {
          return { key: definition.key, value: Dom.normalizeText(clean.slice(clean.indexOf(":") + 1)) };
        }
      }
    }

    return null;
  }

  function extractSections(text) {
    const sections = {};
    let currentKey = "";

    for (const rawLine of stripDecorations(text).split("\n")) {
      const line = Dom.normalizeText(rawLine);
      const heading = detectHeading(line);
      if (heading) {
        currentKey = heading.key;
        sections[currentKey] = sections[currentKey] || [];
        if (heading.value) {
          sections[currentKey].push(heading.value);
        }
        continue;
      }

      if (currentKey && line) {
        sections[currentKey].push(line);
      }
    }

    return sections;
  }

  function sectionValue(sections, key) {
    return Dom.normalizeText((sections[key] || [])
      .map((line) => line.replace(/^[-*•]\s*/, ""))
      .join("\n"));
  }

  function parseList(value) {
    return String(value || "")
      .split("\n")
      .map((line) => Dom.normalizeText(line.replace(/^[-*•]\s*/, "")))
      .filter(Boolean);
  }

  function fallbackConfirmLines(answer) {
    return answer
      .split("\n")
      .map((line) => Dom.normalizeText(line))
      .filter((line) => /CONFIRMAR/i.test(line));
  }

  function parseResponse(text) {
    const answer = stripDecorations(text);
    const sections = extractSections(answer);
    const parsed = {
      cliente: sectionValue(sections, "cliente") || "CONFIRMAR",
      telefone: sectionValue(sections, "telefone") || "CONFIRMAR",
      cpf: sectionValue(sections, "cpf") || "CONFIRMAR",
      data_entrega: sectionValue(sections, "data_entrega") || "CONFIRMAR",
      endereco: sectionValue(sections, "endereco") || "CONFIRMAR",
      referencia: sectionValue(sections, "referencia") || "CONFIRMAR",
      email: sectionValue(sections, "email") || "CONFIRMAR",
      itens: parseList(sectionValue(sections, "itens")),
      valores: sectionValue(sections, "valores") || "CONFIRMAR",
      confianca_preco: sectionValue(sections, "confianca_preco") || "CONFIRMAR",
      total: sectionValue(sections, "total") || "CONFIRMAR",
      frete: sectionValue(sections, "valores") || "CONFIRMAR",
      pagamento: sectionValue(sections, "pagamento") || "CONFIRMAR",
      prazo: sectionValue(sections, "prazo") || "CONFIRMAR",
      entrega: sectionValue(sections, "data_entrega") || sectionValue(sections, "prazo") || "CONFIRMAR",
      pendencias: parseList(sectionValue(sections, "pendencias")),
      score_confianca: sectionValue(sections, "score_confianca") || "",
      resumo: sectionValue(sections, "resumo") || "",
      raw_text: answer,
      sections
    };

    if (!parsed.pendencias.length) {
      parsed.pendencias = fallbackConfirmLines(answer);
    }

    return parsed;
  }

  function isConfirm(value) {
    return !Dom.normalizeText(value) || /^CONFIRMAR$/i.test(Dom.normalizeText(value));
  }

  function ensurePendencias(parsed) {
    const pendencias = [...(parsed.pendencias || [])].filter(Boolean);
    [
      ["cpf", "Confirmar CPF"],
      ["data_entrega", "Confirmar data da entrega"],
      ["endereco", "Confirmar endereço"],
      ["referencia", "Confirmar referência"],
      ["email", "Confirmar e-mail"],
      ["valores", "Confirmar valores"],
      ["total", "Confirmar total geral"],
      ["pagamento", "Confirmar condições de pagamento"],
      ["prazo", "Confirmar prazo"]
    ].forEach(([key, label]) => {
      if (isConfirm(parsed[key]) && !pendencias.some((item) => item.toLowerCase() === label.toLowerCase())) {
        pendencias.push(label);
      }
    });
    return pendencias.length ? pendencias : ["CONFIRMAR"];
  }

  function listBlock(items) {
    const values = (items || []).filter(Boolean);
    if (!values.length) {
      return "- CONFIRMAR";
    }
    return values.map((item) => `- ${item.replace(/^[-*•]\s*/, "")}`).join("\n");
  }

  function joinHumanList(items) {
    const values = (items || []).filter(Boolean);
    if (!values.length) {
      return "";
    }
    if (values.length === 1) {
      return values[0];
    }
    return `${values.slice(0, -1).join(", ")} e ${values[values.length - 1]}`;
  }

  function estimateScore(parsed, client, phone) {
    const checks = [
      ["cliente", client],
      ["telefone", phone],
      ["cpf", parsed.cpf],
      ["endereco", parsed.endereco],
      ["email", parsed.email],
      ["data de entrega", parsed.data_entrega],
      ["produto", (parsed.itens || []).some((item) => item && !/^CONFIRMAR$/i.test(item)) ? "ok" : ""],
      ["pagamento", parsed.pagamento],
      ["total", parsed.total]
    ];
    const missing = checks
      .filter(([, value]) => isConfirm(value))
      .map(([label]) => label);
    const score = Math.max(0, Math.round(((checks.length - missing.length) / checks.length) * 100));
    return `${score}% ${missing.length ? `Faltando ${joinHumanList(missing)}` : "Dados completos"}`;
  }

  function formatCommercialFicha(parsedInput, conversation) {
    const parsed = parsedInput && parsedInput.raw_text ? parsedInput : parseResponse(parsedInput || "");
    const client = !isConfirm(parsed.cliente)
      ? parsed.cliente
      : conversation && conversation.client_name ? conversation.client_name : "CONFIRMAR";
    const phone = !isConfirm(parsed.telefone)
      ? parsed.telefone
      : conversation && conversation.phone ? conversation.phone : "CONFIRMAR";
    const pendencias = ensurePendencias({ ...parsed, cliente: client, telefone: phone });

    return [
      FIELD_BY_KEY.cliente.heading,
      client || "CONFIRMAR",
      "",
      FIELD_BY_KEY.cpf.heading,
      parsed.cpf || "CONFIRMAR",
      "",
      FIELD_BY_KEY.telefone.heading,
      phone || "CONFIRMAR",
      "",
      FIELD_BY_KEY.data_entrega.heading,
      parsed.data_entrega || "CONFIRMAR",
      "",
      FIELD_BY_KEY.endereco.heading,
      parsed.endereco || "CONFIRMAR",
      "",
      FIELD_BY_KEY.referencia.heading,
      parsed.referencia || "CONFIRMAR",
      "",
      FIELD_BY_KEY.email.heading,
      parsed.email || "CONFIRMAR",
      "",
      FIELD_BY_KEY.itens.heading,
      listBlock(parsed.itens),
      "",
      FIELD_BY_KEY.valores.heading,
      parsed.valores || "CONFIRMAR",
      "",
      FIELD_BY_KEY.confianca_preco.heading,
      parsed.confianca_preco || "CONFIRMAR",
      "",
      FIELD_BY_KEY.total.heading,
      parsed.total || "CONFIRMAR",
      "",
      FIELD_BY_KEY.pagamento.heading,
      parsed.pagamento || "CONFIRMAR",
      "",
      FIELD_BY_KEY.prazo.heading,
      parsed.prazo || "CONFIRMAR",
      "",
      FIELD_BY_KEY.pendencias.heading,
      listBlock(pendencias),
      "",
      FIELD_BY_KEY.score_confianca.heading,
      parsed.score_confianca || estimateScore(parsed, client, phone)
    ].join("\n");
  }

  function validateCommercialFicha(textOrParsed, conversation) {
    const parsed = typeof textOrParsed === "string" ? parseResponse(textOrParsed) : textOrParsed;
    const formatted = typeof textOrParsed === "string" ? textOrParsed : formatCommercialFicha(parsed, conversation);
    const missing = [];
    if (!/👤\s*Cliente/i.test(formatted) || isConfirm(parsed.cliente) && !(conversation && conversation.client_name)) {
      missing.push("CLIENTE");
    }
    if (!/📞\s*Telefone/i.test(formatted)) {
      missing.push("TELEFONE");
    }
    const hasProduct = (parsed.itens || []).some((item) => item && !/^CONFIRMAR$/i.test(item));
    if (!/📦\s*Produtos/i.test(formatted) || !hasProduct) {
      missing.push("PRODUTO");
    }
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
      missing_info: parsed.pendencias,
      summary: parsed.score_confianca || parsed.prazo || parsed.valores || "",
      questions: parsed.pendencias,
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
