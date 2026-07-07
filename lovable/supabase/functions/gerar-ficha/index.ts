// Supabase Edge Function de referência para o gerador de orçamento/DANFE do projeto Lovable.
//
// A extensão "Projeto Ficha" (WhatsApp Web) faz POST para esta função enviando:
//   - prompt: texto comercial montado a partir da conversa (ANALISE.txt)
//   - conversation: mensagens limpas + nome/telefone do cliente
//   - images: screenshots e imagens do chat em base64 (data URLs)
//   - store_id / header X-Store-Id: loja ativa
//   - Authorization: Bearer <token> (a chave configurada na extensão)
//
// A função deve gerar o orçamento de acordo com a loja ativa, salvar o documento
// (PDF/DANFE) no storage e devolver { ok, ficha, download_url, download_id }.
//
// Deploy:
//   supabase functions deploy gerar-ficha --no-verify-jwt
// Configure os secrets:
//   supabase secrets set EXTENSION_API_TOKEN=... OPENAI_API_KEY=...
//
// Ajuste a parte de geração (generateOrcamento) para a sua regra de negócio real.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-store-id, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface ExtensionPayload {
  source?: string;
  job_id?: string;
  store_id?: string;
  client?: { name?: string; phone?: string };
  prompt?: string;
  conversation?: {
    client_name?: string;
    phone?: string;
    message_count?: number;
    messages?: Array<Record<string, unknown>>;
  };
  images?: Array<{ kind?: string; name?: string; dataUrl?: string }>;
  metrics?: Record<string, unknown>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Método não permitido." }, 405);
  }

  // 1) Autenticação simples por token compartilhado com a extensão.
  const expectedToken = Deno.env.get("EXTENSION_API_TOKEN");
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (expectedToken && token !== expectedToken) {
    return json({ ok: false, error: "Não autorizado." }, 401);
  }

  let payload: ExtensionPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "JSON inválido." }, 400);
  }

  const storeId = payload.store_id || req.headers.get("x-store-id") || "";
  if (!storeId) {
    return json({ ok: false, error: "Loja ativa (store_id) não informada." }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 2) Resolve a loja ativa (ajuste o nome da tabela conforme seu schema).
  const { data: loja, error: lojaErr } = await supabase
    .from("lojas")
    .select("*")
    .eq("id", storeId)
    .maybeSingle();
  if (lojaErr) {
    return json({ ok: false, error: `Erro buscando loja: ${lojaErr.message}` }, 500);
  }
  if (!loja) {
    return json({ ok: false, error: "Loja ativa não encontrada." }, 404);
  }

  // 3) Gera o orçamento/ficha. Troque por sua lógica real (IA, regras, tabela de preços).
  const ficha = await generateOrcamento(payload, loja);

  // 4) Gera o documento (PDF/DANFE) e sobe no storage para download.
  const fileName = `orcamentos/${storeId}/${payload.job_id || crypto.randomUUID()}.txt`;
  const documentBytes = new TextEncoder().encode(ficha);
  const { error: upErr } = await supabase.storage
    .from("orcamentos")
    .upload(fileName, documentBytes, { contentType: "text/plain", upsert: true });
  if (upErr) {
    // Ainda devolve a ficha em texto mesmo se o upload falhar.
    return json({ ok: true, ficha, download_url: "", warning: upErr.message });
  }

  const { data: signed } = await supabase.storage
    .from("orcamentos")
    .createSignedUrl(fileName, 60 * 60 * 24);

  return json({
    ok: true,
    ficha,
    download_url: signed?.signedUrl || "",
    download_id: fileName,
    store_id: storeId,
  });
});

// Substitua esta função pela sua geração real (chamada de IA, regras de preço, etc.).
async function generateOrcamento(
  payload: ExtensionPayload,
  loja: Record<string, unknown>,
): Promise<string> {
  const cliente = payload.client?.name || payload.conversation?.client_name || "CONFIRMAR";
  const telefone = payload.client?.phone || payload.conversation?.phone || "CONFIRMAR";

  // Exemplo: encaminhar o prompt da extensão para um modelo de IA.
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (openaiKey && payload.prompt) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: `Você gera fichas/orçamentos para a loja ${loja.nome ?? ""}.` },
            { role: "user", content: payload.prompt },
          ],
        }),
      });
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text) return text;
    } catch (_e) {
      // cai no fallback abaixo
    }
  }

  return [
    "📋 FICHA / ORÇAMENTO",
    `Loja: ${loja.nome ?? loja.id}`,
    `Cliente: ${cliente}`,
    `Telefone: ${telefone}`,
    `Mensagens analisadas: ${payload.conversation?.message_count ?? 0}`,
    `Imagens recebidas: ${payload.images?.length ?? 0}`,
    "",
    "(Implemente generateOrcamento com sua regra de negócio real.)",
  ].join("\n");
}
