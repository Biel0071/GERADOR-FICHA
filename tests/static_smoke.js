const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function listFiles(dir, predicate) {
  const absolute = path.join(root, dir);
  const found = [];
  for (const item of fs.readdirSync(absolute, { withFileTypes: true })) {
    const full = path.join(absolute, item.name);
    const relative = path.relative(root, full).replace(/\\/g, "/");
    if (item.isDirectory()) {
      found.push(...listFiles(relative, predicate));
    } else if (!predicate || predicate(relative)) {
      found.push(relative);
    }
  }
  return found;
}

const requiredFiles = [
  "extension/manifest.json",
  "extension/background.js",
  "extension/content.js",
  "extension/inject.js",
  "extension/whatsapp.js",
  "extension/chatgpt.js",
  "extension/popup.js",
  "extension/popup.css",
  "extension/utils/logger.js",
  "extension/utils/preprocess.js",
  "extension/utils/conversationNormalizer.js",
  "extension/utils/responseParser.js",
  "extension/utils/settings.js",
  "extension/utils/materialApiClient.js",
  "extension/prompts/ANALISE.txt",
  "extension/chatgptAutomationEngine.js",
  "backend/main.py",
  "backend/services/logging_service.py",
  "backend/services/material_api_service.py",
  "README.md"
];

for (const file of requiredFiles) {
  assert(fs.existsSync(path.join(root, file)), `Arquivo obrigatorio ausente: ${file}`);
}

const manifest = JSON.parse(read("extension/manifest.json"));
assert(manifest.manifest_version === 3, "Manifest precisa ser V3.");
assert(manifest.permissions.includes("storage"), "Permissao storage ausente.");
assert(manifest.permissions.includes("tabs"), "Permissao tabs ausente.");
assert(manifest.host_permissions.includes("https://web.whatsapp.com/*"), "Host WhatsApp ausente.");
assert(manifest.host_permissions.includes("https://chatgpt.com/*"), "Host ChatGPT ausente.");
assert(manifest.host_permissions.includes("https://materialdecontrucao.online/*"), "Host Material API ausente.");
assert(manifest.host_permissions.includes("http://209.50.241.22:8000/*"), "Host VPS ausente.");
assert(!manifest.host_permissions.includes("https://*/*"), "Permissao HTTPS ampla nao deve ser usada.");
assert(manifest.content_scripts.length >= 2, "Content scripts de WhatsApp e ChatGPT devem existir.");

for (const file of listFiles("extension", (relative) => relative.endsWith(".js"))) {
  new vm.Script(read(file), { filename: file });
}

const codeFiles = [
  ...listFiles("extension", (relative) => /\.(js|json|css)$/.test(relative)),
  ...listFiles("backend", (relative) => /\.py$/.test(relative))
];

const combinedCode = codeFiles.map(read).join("\n");
const forbidden = [
  "OPENAI_API_KEY",
  "api.openai.com",
  "new OpenAI(",
  "openai.chat",
  "responses.create",
  "chatgptTabId",
  "chatGptTabId",
  "chatGPTTabId"
];

for (const token of forbidden) {
  assert(!combinedCode.includes(token), `Codigo nao deve usar OpenAI API: ${token}`);
}

const extensionCode = listFiles("extension", (relative) => /\.js$/.test(relative)).map(read).join("\n");
assert(!extensionCode.includes("Authorization"), "Token nao deve ser enviado por nenhum codigo da extensao.");
assert(read("backend/services/material_api_service.py").includes("MATERIAL_API_TOKEN"), "Backend sem token Material API.");

console.log("Static smoke OK");
