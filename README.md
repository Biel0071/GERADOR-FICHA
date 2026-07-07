# Projeto Ficha - WhatsApp Web + Material API + ChatGPT

Extensao Chrome Manifest V3 para capturar a conversa atual do WhatsApp Web e gerar a ficha pela Material API com token protegido no backend ou pelo Projeto FICHA no ChatGPT.

A interface principal e um painel operacional flutuante no topo direito da conversa. Ele nao e inserido dentro do header do WhatsApp, o que ajuda a coexistir com CRMs, sidebars, widgets e outras extensoes.

O ChatGPT roda em uma aba temporaria inativa criada pelo `chrome.tabs`. A extensao nao ativa essa aba e nao troca a tela do usuario; ao final, a aba temporaria e fechada. O Chrome nao permite carregar o ChatGPT autenticado em um `offscreen document` de extensao por causa das restricoes de paginas de terceiros, entao a estrategia pratica e segura e a aba inativa em background.

A comunicacao longa usa `chrome.runtime.connect` com `Port`, em vez de um `sendMessage` unico. Isso reduz perda de contexto em operacoes demoradas do Manifest V3 e permite progresso em tempo real.

O fluxo usa uma maquina de estados persistida em `chrome.storage.local`: `idle`, `capturing`, `preprocessing`, `opening_project`, `creating_chat`, `waiting_composer`, `sending_prompt`, `waiting_stream`, `capturing_response`, `parsing`, `rendering`, `completed` e `error`. Cada transicao registra timestamp, detalhe, metadados e duracao acumulada no `ACTIVE_JOB`.

Importante: no modo ChatGPT este projeto nao usa OpenAI API, nao pede `OPENAI_API_KEY` e nao consome tokens por API. A geracao acontece dentro do ChatGPT web, no perfil do Chrome em que o usuario ja esta logado.

## Gerador selecionavel: Material API ou ChatGPT

O provedor padrao agora e `Material API (site/ERP)`. O fluxo fica assim:

1. A extensao captura e limpa a conversa, screenshots e imagens.
2. A extensao envia o payload somente para `http://127.0.0.1:8000/generate-order`.
3. O backend le `MATERIAL_API_TOKEN` de `backend/.env`.
4. O backend adiciona `Authorization: Bearer <token>` e encaminha a requisicao ao endpoint HTTPS configurado em `MATERIAL_API_URL`.
5. A resposta volta para o modal, clipboard e composer do WhatsApp.

O token nunca e salvo em `chrome.storage.local`, nunca aparece no painel e nunca e enviado diretamente pelo content script. O seletor ainda oferece `ChatGPT (conta logada)` como fallback.

Importante: `https://materialdecontrucao.online/` e a pagina publica da loja, nao um endpoint de geracao. O projeto Supabase identificado no site nao possui atualmente uma funcao publica `gerar-ficha`; portanto, configure em `MATERIAL_API_URL` a URL HTTPS real que recebera o POST. A Edge Function de referencia continua em `lovable/supabase/functions/gerar-ficha/index.ts`.

## Estrutura

```text
extension/
  manifest.json
  background.js
  content.js
  inject.js
  whatsapp.js
  chatgptAutomationEngine.js
  chatgpt.js
  popup.js
  popup.css
  utils/
  icons/
backend/
  main.py
  requirements.txt
  .env.example
  services/
  logs/
tests/
  fixtures/
```

## Como instalar a extensao

1. Abra o Chrome em `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione a pasta `extension`.
5. Abra `https://web.whatsapp.com` e entre na sua conta.
6. Abra `https://chatgpt.com` no mesmo perfil do Chrome e confirme que esta logado.

Ao abrir o WhatsApp Web, o painel `📋 GERAR FICHA` aparece automaticamente no topo direito da area da conversa.

## Como usar

1. Abra o chat do cliente no WhatsApp Web.
2. Clique em `Gerar ficha` no painel operacional.
3. A extensao tenta carregar mais historico por scroll DOM, captura mensagens e restaura a posicao.
4. A extensao captura contexto visual da area do chat: screenshots recortados, imagens visiveis enviadas no chat e metadados de audio quando houver.
5. A conversa e limpa: remove duplicacoes, ruido, spam, emojis isolados e prioriza negociacao.
6. No provedor padrao `Material API`, a extensao envia o contexto ao backend local, que autentica e chama o endpoint remoto.
7. No fallback `ChatGPT`, uma aba temporaria inativa do Projeto FICHA e aberta e recebe o prompt/imagens.
8. Quando a resposta chega, a ficha aparece no modal do WhatsApp.
9. A ficha e copiada automaticamente e, quando `AUTO_INSERT_WHATSAPP` estiver ativo, fica preenchida no composer do WhatsApp sem envio automatico.

Se a interface do ChatGPT mudar, bloquear envio automatico ou exigir login, o painel mostra erro e o usuario permanece no WhatsApp.

Em caso de falha da automacao, a aba temporaria do ChatGPT fica aberta para debug por padrao.

## Painel operacional

O painel mostra:

- Status atual: aguardando, capturando conversa, limpando conversa, abrindo projeto FICHA, enviando prompt, aguardando resposta, ficha pronta ou erro.
- Nome do cliente detectado.
- Quantidade de mensagens capturadas.
- Tempo da operacao.
- Progresso visual.
- Ultimos logs da extensao.

Botoes:

- `Gerar ficha`: captura, limpa e usa o provedor selecionado: Material API ou ChatGPT.
- `Regerar`: usa o ultimo contexto capturado.
- `Abrir logs`: abre o modal com historico local.
- `Copiar ultima ficha`: copia a ultima ficha salva em `chrome.storage.local`.

## Backend da Material API

No modo `Material API`, o backend e obrigatorio porque protege o token e funciona como proxy para o site/ERP. Ele nao chama OpenAI API.

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
uvicorn main:app --reload
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/material-api/status
```

O status informa apenas se endpoint e token estao configurados; o segredo nunca e retornado.

```dotenv
MATERIAL_API_URL=https://seu-endpoint-https/gerar-ficha
MATERIAL_API_TOKEN=seu-token-secreto
MATERIAL_API_KEY=chave-apikey-quando-o-provedor-exigir
MATERIAL_STORE_ID=id-da-loja
```

Se o backend estiver offline ou sem token, o modo Material API informa erro amigavel. O modo ChatGPT continua disponivel como fallback.

## O que a captura tenta ler

- Nome do cliente ou titulo do chat
- Telefone quando visivel no cabecalho ou nas mensagens
- Mensagens carregadas no DOM
- Horarios quando expostos pelo WhatsApp Web
- Direcao da mensagem: cliente ou atendente
- Screenshots da area da conversa, em JPEG 70%, limitados a 1280px de largura
- Imagens enviadas no chat quando renderizadas pelo WhatsApp Web
- Audios detectados, com aviso quando nao houver transcricao local disponivel
- Informacoes preenchidas pelo cliente, como CPF, e-mail, telefone, endereco e linhas de entrega
- Avisos de captura, por exemplo telefone nao visivel ou historico limitado

O WhatsApp Web virtualiza parte do historico. Por isso, a extensao tenta rolar o container de mensagens algumas vezes por DOM, coleta snapshots, remove duplicatas e restaura a posicao original. Se mensagens antigas nao forem expostas pelo DOM, a extensao usa o melhor contexto disponivel.

## Contexto visual V1

Ao clicar em `Gerar ficha`, a extensao salva um pacote visual em `chrome.storage.local`:

- `projetoFicha.lastVisualContext`: ultimo pacote completo com screenshots e imagens.
- `projetoFicha.lastVisualContext.<jobId>`: pacote visual usado em uma geracao especifica.
- `projetoFicha.visualHistory`: historico de auditoria com conversa usada, manifesto visual, ficha e data da geracao.

O prompt recebe um manifesto leve com contagem de telas, imagens, audios e informacoes detectadas. A automacao do ChatGPT le o pacote completo pelo storage e tenta anexar screenshots/imagens antes de enviar o prompt. Se nenhum screenshot for capturado, a geracao e interrompida para evitar ficha baseada apenas em texto.

O prompt orienta o Projeto FICHA a cruzar valor do texto, imagem e vendedor, gerar `📊 Confiança do Preço` como ALTA/MEDIA/BAIXA e exibir `✅ Score de Confiança` com percentual e motivo curto.

## Pre-processamento

Antes de enviar ao Projeto FICHA, a conversa passa por limpeza local:

- Remove mensagens vazias, repetidas, emojis isolados e respostas curtas sem valor operacional, como `ok`.
- Compacta repeticoes, por exemplo `boa tarde boa tarde` vira `boa tarde`.
- Deduplica mensagens iguais.
- Prioriza linhas com produto, quantidade, preco, frete, entrega, endereco, prazo, pagamento e observacoes.
- Envia o `ANALISE.txt` como prompt principal, com contexto comercial agrupado e manifesto visual. O prompt ERP compacto fica apenas como fallback.

Arquivos principais:

- `extension/utils/conversationNormalizer.js`: remove ruido, deduplica e prioriza itens, entrega, valores, CPF/telefone/endereco e mensagens recentes.
- `extension/prompts/ANALISE.txt`: prompt comercial principal usado na geração da ficha.
- `extension/utils/prompt.js`: monta o prompt a partir do `ANALISE.txt`; o `buildERPStylePrompt()` fica apenas como fallback.
- `extension/utils/responseParser.js`: converte a resposta em JSON estruturado.
- `extension/chatgptAutomationEngine.js`: controla readiness, nova conversa, composer, envio seguro, streaming e captura final.

## Regras do prompt

O prompt enviado ao Projeto FICHA exige:

- Nao inventar endereco, telefone, cidade, quantidade, produto, prazo, valor ou frete.
- Usar `CONFIRMAR` quando faltar informacao.
- Identificar produtos, quantidades, entrega, frete, observacoes e perguntas faltantes.
- Priorizar mensagens recentes quando o pedido mudar.
- Considerar texto, screenshots e imagens anexadas do chat.
- Gerar `Confiança do Preço` e `Score de Confiança`.
- Responder em formato pronto para copiar.

## Limitacoes conhecidas

- ChatGPT e WhatsApp Web nao oferecem uma API DOM publica e estavel.
- Seletores podem precisar de ajuste se alguma interface mudar.
- A automacao exige que o usuario esteja logado no WhatsApp Web e no ChatGPT no mesmo perfil do Chrome.
- A extensao nao usa coordenadas de mouse, `pyautogui` ou automacao de tela.

## Logs e debug

Logs locais ficam em `chrome.storage.local` na chave `projetoFicha.operationLogs`. A ultima ficha fica em `projetoFicha.lastFicha`, o historico de fichas em `projetoFicha.fichaHistory`, e o historico de prompts compactos em `projetoFicha.promptHistory`.

O modo debug esta ativo em `extension/utils/constants.js`:

```js
DEBUG: true
```

O modo detalhado da automacao do ChatGPT tambem fica em `extension/utils/constants.js`:

```js
DEBUG_CHATGPT_AUTOMATION: false
DEBUG_KEEP_FAILED_TAB: true
```

Com `DEBUG_CHATGPT_AUTOMATION: true`, a aba temporaria nao fecha automaticamente e a extensao registra dumps parciais do DOM no console. Com `DEBUG_KEEP_FAILED_TAB: true`, falhas mantem a aba aberta para inspecao. O console do Chrome mostra eventos detalhados de injecao do painel, captura da conversa, abertura do ChatGPT, textarea encontrada, envio do prompt, streaming e captura da resposta.

O engine usa watchdog por etapa (`STEP_WATCHDOG_MS`) e retries locais para evitar travamento em hydration, composer, envio e captura.

## Validacao local

Checks rapidos:

```powershell
node tests/static_smoke.js
node tests/module_smoke.js
python -m py_compile backend/main.py backend/services/logging_service.py
```

Smoke manual recomendado:

1. Carregue `extension/` em `chrome://extensions`.
2. Rode o backend opcional, se quiser logs.
3. Abra WhatsApp Web e ChatGPT logados.
4. Clique em `📋 Gerar Ficha`.
5. Confira a aba do ChatGPT e o modal no WhatsApp.
