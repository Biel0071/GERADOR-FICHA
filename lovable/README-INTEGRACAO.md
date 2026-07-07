# Material API: integracao segura com o projeto Lovable/Supabase

A extensao envia conversa, prompt e imagens para o backend local. O backend adiciona o token secreto e encaminha a requisicao ao endpoint configurado do projeto `materialdecontrucao.online`.

## Fluxo

```text
WhatsApp Web
  -> extensao Chrome (sem token)
  -> POST http://127.0.0.1:8000/generate-order
  -> backend Python adiciona Authorization/apikey
  -> MATERIAL_API_URL
  -> ficha + URL de download
```

O token nunca deve ser salvo em `chrome.storage.local` nem no `manifest.json`.

## Configuracao

Crie `backend/.env` a partir de `.env.example`:

```dotenv
MATERIAL_API_URL=https://seu-endpoint-https/gerar-ficha
MATERIAL_API_TOKEN=seu-token-secreto
MATERIAL_API_KEY=chave-apikey-quando-o-provedor-exigir
MATERIAL_STORE_ID=id-da-loja
MATERIAL_API_TIMEOUT_SECONDS=120
MATERIAL_ALLOWED_HOSTS=materialdecontrucao.online,flkionbmkuqgkudjjuqk.supabase.co
```

- `MATERIAL_API_TOKEN`: enviado apenas pelo backend como `Authorization: Bearer ...`.
- `MATERIAL_API_KEY`: enviado como header `apikey`. Quando vazio, o backend usa o token.
- `MATERIAL_ALLOWED_HOSTS`: allowlist contra envio acidental do token para outro dominio.

## Estado atual do site

O dominio `https://materialdecontrucao.online/` e a interface publica da loja. O site usa o projeto Supabase `flkionbmkuqgkudjjuqk.supabase.co`.

Na verificacao de 26/06/2026, `functions/v1/gerar-ficha` retornava `404`. Portanto, e necessario:

1. Implantar `supabase/functions/gerar-ficha/index.ts` no projeto correto; ou
2. Informar em `MATERIAL_API_URL` outro endpoint HTTPS compativel.

## Contrato encaminhado pelo backend

### Requisicao

```json
{
  "source": "whatsapp-extension",
  "version": "1.1.0",
  "job_id": "ficha-...",
  "store_id": "loja-123",
  "client": {
    "name": "Cliente",
    "phone": "31999999999"
  },
  "prompt": "analise comercial",
  "conversation": {
    "client_name": "Cliente",
    "phone": "31999999999",
    "message_count": 42,
    "messages": [],
    "preprocessing": {}
  },
  "images": [
    {
      "kind": "screenshot",
      "name": "screenshot-1.jpg",
      "dataUrl": "data:image/jpeg;base64,..."
    }
  ],
  "metrics": {}
}
```

Headers enviados ao endpoint remoto:

```text
Authorization: Bearer <MATERIAL_API_TOKEN>
apikey: <MATERIAL_API_KEY, quando configurada>
X-Store-Id: <store_id>
Content-Type: application/json
```

### Resposta recomendada

```json
{
  "ok": true,
  "ficha": "texto da ficha/orcamento",
  "download_url": "https://.../orcamento.pdf",
  "download_id": "orcamentos/loja-123/ficha.pdf"
}
```

O proxy tambem aceita aliases como `answer`, `content`, `text`, `result`, `orcamento`, `quotation`, `pdf_url` e `document_id`.

## Diagnostico

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/material-api/status
```

Os endpoints de diagnostico informam apenas se o token esta configurado. O valor secreto nunca e retornado.