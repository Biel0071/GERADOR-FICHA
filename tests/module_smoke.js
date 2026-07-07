const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function load(file) {
  eval(fs.readFileSync(path.join(root, file), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

global.chrome = {
  runtime: {
    getURL(file) {
      return `chrome-extension://test/${file}`;
    }
  },
  storage: {
    local: {
      get(keys, cb) {
        cb({});
      },
      set(value, cb) {
        cb && cb();
      }
    }
  }
};

[
  "extension/utils/constants.js",
  "extension/utils/dom.js",
  "extension/utils/storage.js",
  "extension/utils/logger.js",
  "extension/utils/conversationNormalizer.js",
  "extension/utils/preprocess.js",
  "extension/utils/responseParser.js",
  "extension/utils/prompt.js"
].forEach(load);

const conversation = {
  client_name: "Joao",
  phone: "31999999999",
  messages: [
    { author: "cliente", text: "boa tarde boa tarde", time: "09:00" },
    { author: "cliente", text: "ok", time: "09:01" },
    { author: "cliente", text: "10 sacos de cimento cp ii para entrega", time: "09:02" },
    { author: "cliente", text: "10 sacos de cimento cp ii para entrega", time: "09:02" },
    { author: "cliente", text: "Meu CPF 123.456.789-10 e o endereco e Rua A 123", time: "09:03" }
  ]
};

const normalized = ProjetoFichaConversationNormalizer.normalizeConversation(conversation);
assert(normalized.messages.length === 3, `normalizer removeu quantidade inesperada: ${normalized.messages.length}`);
assert(normalized.erp_context.itens.length >= 1, "normalizer nao priorizou itens");
assert(normalized.erp_context.contato.length >= 1, "normalizer nao priorizou CPF/contato");

const fallbackPrompt = ProjetoFichaPrompt.buildERPStylePrompt(normalized);
assert(fallbackPrompt.includes("FICHA DE PEDIDO"), "prompt ERP fallback nao tem formato obrigatorio");
assert(fallbackPrompt.length < 2600, `prompt ERP grande demais: ${fallbackPrompt.length}`);

const commercialPrompt = ProjetoFichaPrompt.buildFichaPrompt(normalized);
assert(commercialPrompt.includes("👤 Cliente"), "prompt principal nao usa ANALISE.txt comercial");
assert(commercialPrompt.includes("📦 Produtos"), "prompt principal sem bloco Produtos comercial");
assert(commercialPrompt.includes("CONTEXTO VISUAL"), "prompt principal sem contexto visual");
assert(commercialPrompt.includes("Confiança do Preço"), "prompt principal sem confianca de preco");
assert(commercialPrompt.includes("Não use o formato simples"), "prompt principal nao bloqueia formato simples");

const parsed = ProjetoFichaResponseParser.parseResponse(`
👤 Cliente
Joao

🪪 CPF
123.456.789-10

📞 Telefone
31999999999

📅 Data da Entrega
CONFIRMAR

🚚 Endereço
Rua A 123

📍 Referência
CONFIRMAR

📧 E-mail
CONFIRMAR

📦 Produtos
- 10x Cimento CPII

💰 Valores
CONFIRMAR

📊 Confiança do Preço
MÉDIA

💵 Total Geral
CONFIRMAR

💳 Condições de Pagamento
PIX

⏱️ Prazo
Retirada

⚠️ Pendências
- Confirmar cidade

✅ Score de Confiança
80% Faltando e-mail
`);

assert(parsed.cliente === "Joao", "parser cliente falhou");
assert(parsed.itens.length === 1, "parser itens falhou");
assert(parsed.pendencias.length === 1, "parser pendencias falhou");
assert(parsed.data_entrega === "CONFIRMAR", "parser data entrega falhou");
assert(parsed.pagamento === "PIX", "parser pagamento comercial falhou");
assert(parsed.confianca_preco === "MÉDIA", "parser confianca preco falhou");
assert(parsed.score_confianca.includes("80%"), "parser score confianca falhou");

const formatted = ProjetoFichaResponseParser.formatCommercialFicha(parsed, conversation);
assert(formatted.includes("👤 Cliente"), "formatter sem Cliente comercial");
assert(formatted.includes("💳 Condições de Pagamento"), "formatter sem pagamento comercial");
assert(formatted.includes("📊 Confiança do Preço"), "formatter sem confianca de preco");
assert(formatted.includes("✅ Score de Confiança"), "formatter sem score de confianca");
assert(!formatted.includes("Cliente:"), "formatter nao deve usar formato simples Cliente:");
const validation = ProjetoFichaResponseParser.validateCommercialFicha(parsed, conversation);
assert(validation.ok, `validacao comercial falhou: ${validation.missing.join(",")}`);

const engineSource = fs.readFileSync(path.join(root, "extension/chatgptAutomationEngine.js"), "utf8");
[
  "waitForProjectReady",
  "ensureProjectConversation",
  "waitForComposer",
  "sendPromptSafely",
  "waitStreamingComplete",
  "captureFinalResponse",
  "createChatScan",
  "diagnoseCreateChat",
  "inspectChatGPTPage",
  "pressEnterToSend",
  "withStepWatchdog"
].forEach((name) => assert(engineSource.includes(`function ${name}`), `engine sem ${name}`));

assert(engineSource.includes("textarea"), "engine sem selector textarea");
assert(engineSource.includes("ProseMirror"), "engine sem fallback ProseMirror");
assert(engineSource.includes("contenteditable"), "engine sem fallback contenteditable");
assert(engineSource.includes("STREAM_STABLE_MS"), "engine sem estabilidade de streaming");
assert(engineSource.includes("FORCE_SEND_TEST"), "engine sem modo FORCE_SEND_TEST");
assert(engineSource.includes("COMPOSER_FOUND"), "engine sem log COMPOSER_FOUND");
assert(engineSource.includes("MESSAGE_INSERTED"), "engine sem log MESSAGE_INSERTED");
assert(engineSource.includes("SEND_BUTTON_FOUND"), "engine sem log SEND_BUTTON_FOUND");
assert(engineSource.includes("SEND_CLICKED"), "engine sem log SEND_CLICKED");
assert(engineSource.includes("STREAM_STARTED"), "engine sem log STREAM_STARTED");
assert(engineSource.includes("STREAM_FINISHED"), "engine sem log STREAM_FINISHED");
assert(engineSource.includes("RESPONSE_CAPTURED"), "engine sem log RESPONSE_CAPTURED");
assert(engineSource.includes("attachVisualContextImages"), "engine sem anexacao visual");
assert(engineSource.includes("VISUAL_ATTACHMENTS_ATTACHED"), "engine sem log visual anexado");

const contentSource = fs.readFileSync(path.join(root, "extension/content.js"), "utf8");
[
  "PARSER_SUCCESS",
  "FICHA_FORMATTED",
  "CLIPBOARD_UPDATED",
  "WHATSAPP_FILLED"
].forEach((token) => assert(contentSource.includes(token), `content sem log ${token}`));
assert(contentSource.includes("VISUAL_HISTORY_SAVED"), "content sem historico visual");

const backgroundSource = fs.readFileSync(path.join(root, "extension/background.js"), "utf8");
assert(backgroundSource.includes("PROMPT_SENT"), "background sem log PROMPT_SENT");
assert(backgroundSource.includes("RESPONSE_RECEIVED"), "background sem log RESPONSE_RECEIVED");
assert(backgroundSource.includes("runMaterialApiGeneration"), "background sem Material API");
assert(backgroundSource.includes("ProjetoFichaMaterialApiClient"), "background sem cliente Material API");

console.log("Module smoke OK");
