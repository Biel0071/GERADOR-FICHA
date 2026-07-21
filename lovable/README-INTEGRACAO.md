# Integracao Material API / VPS

A extensao nao guarda token no Chrome. O fluxo correto e:

```text
WhatsApp Web
  -> extensao Chrome
  -> POST http://209.50.241.22:8000/generate-order
  -> backend Python na VPS
  -> POST MATERIAL_API_URL com header x-api-key
  -> GET MATERIAL_API_PDF_URL?id=<orcamento_id>
  -> retorna download_url para a extensao
```

## Variaveis do backend

Configure em `/root/gerar-ficha/backend/.env` na VPS:

```dotenv
BACKEND_HOST=0.0.0.0
BACKEND_PORT=8000

MATERIAL_API_URL=https://flkionbmkuqgkudjjuqk.supabase.co/functions/v1/api-quotation
MATERIAL_API_PDF_URL=https://flkionbmkuqgkudjjuqk.supabase.co/functions/v1/api-quotation-pdf
MATERIAL_API_TOKEN=seu-token-secreto
MATERIAL_STORE_ID=
MATERIAL_API_TIMEOUT_SECONDS=120
MATERIAL_ALLOWED_HOSTS=materialdecontrucao.online,flkionbmkuqgkudjjuqk.supabase.co
```

`MATERIAL_API_TOKEN` e enviado pelo backend como `x-api-key`. Ele nunca deve ser salvo na extensao.

## Contrato esperado do endpoint

### Criar orcamento

`POST MATERIAL_API_URL`

Headers:

```http
x-api-key: <MATERIAL_API_TOKEN>
Content-Type: application/json
Accept: application/json
```

Body principal recebido da extensao:

```json
{
  "source": "whatsapp-extension",
  "job_id": "job-123",
  "store_id": "loja-1",
  "client": {
    "name": "Joao",
    "phone": "31999999999"
  },
  "prompt": "contexto comercial compactado",
  "conversation": {
    "client_name": "Joao",
    "phone": "31999999999",
    "messages": []
  },
  "images": []
}
```

Resposta minima esperada:

```json
{
  "ok": true,
  "id": "orcamento-123"
}
```

Tambem sao aceitos aliases como `download_id`, `quotation_id`, `orcamento_id` ou `document_id`.

### Buscar PDF/DANFE

`GET MATERIAL_API_PDF_URL?id=<orcamento_id>`

Resposta minima esperada:

```json
{
  "ok": true,
  "pdf_url": "https://materialdecontrucao.online/orcamentos/orcamento-123.pdf"
}
```

Tambem sao aceitos aliases como `download_url`, `downloadUrl`, `file_url`, `danfe_url` ou `url`.

## Validacao rapida

```bash
curl http://209.50.241.22:8000/health
curl http://209.50.241.22:8000/material-api/status
```

Se `configured` vier `false`, falta configurar `MATERIAL_API_URL` ou `MATERIAL_API_TOKEN` no `.env` da VPS.