from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from services.logging_service import append_jsonl
from services.material_api_service import MaterialApiClient, MaterialApiError
import asyncio
from services.chatgpt_service import (
    ChatGPTError, generate_ficha, start_login, submit_login_code, session_exists, refresh_keep_alive, resend_login_code
)

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    def load_dotenv() -> bool:
        return False

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
LOG_DIR = BASE_DIR / "logs"

app = FastAPI(
    title="Projeto Ficha Material API Backend",
    description="Proxy seguro da Material API, health check, logs e diagnosticos da extensao.",
    version="1.1.0",
)

@app.on_event("startup")
async def startup_event() -> None:
    async def keep_alive_loop():
        while True:
            await asyncio.sleep(43200)  # Executa a cada 12 horas
            try:
                await refresh_keep_alive()
            except Exception:
                pass
    asyncio.create_task(keep_alive_loop())

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class EventPayload(BaseModel):
    type: str = Field(..., min_length=1, max_length=120)
    level: str = Field(default="info", max_length=20)
    message: str = Field(default="", max_length=2000)
    metadata: dict[str, Any] = Field(default_factory=dict)


class GenerateFichaPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    job_id: str = Field(default="", max_length=160)
    prompt: str = Field(default="", max_length=100_000)
    conversation: dict[str, Any] = Field(default_factory=dict)


class GenerateOrderPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    source: str = Field(default="whatsapp-extension", max_length=80)
    version: str = Field(default="1.0.0", max_length=40)
    job_id: str = Field(default="", max_length=160)
    store_id: str = Field(default="", max_length=160)
    client: dict[str, Any] = Field(default_factory=dict)
    prompt: str = Field(default="", max_length=100_000)
    conversation: dict[str, Any] = Field(default_factory=dict)
    images: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    metrics: dict[str, Any] = Field(default_factory=dict)

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.get("/login/status")
async def login_status() -> dict[str, Any]:
    return {
        "ok": True,
        "session_exists": session_exists(),
        "time": now_iso(),
    }


@app.post("/login/start")
async def login_start() -> dict[str, Any]:
    """Inicia login ChatGPT. Se pedir código 2FA, retorna status=waiting_code."""
    result = await start_login()
    if result.get("status") == "error":
        raise HTTPException(status_code=502, detail=result.get("message", "Erro no login."))
    return result


@app.post("/login/verify")
async def login_verify(request: Request) -> dict[str, Any]:
    """Envia o código de verificação 2FA para completar o login."""
    body = await request.json()
    code = str(body.get("code", "")).strip()
    if not code:
        raise HTTPException(status_code=400, detail="Informe o campo 'code' com o código recebido.")
    result = await submit_login_code(code)
    if result.get("status") == "error":
        raise HTTPException(status_code=502, detail=result.get("message", "Código inválido."))
    return result


@app.post("/login/resend")
async def login_resend() -> dict[str, Any]:
    """Reenvia ou solicita um novo código OTP no ChatGPT."""
    result = await resend_login_code()
    if result.get("status") == "error":
        raise HTTPException(status_code=502, detail=result.get("message", "Erro reenviando código."))
    return result


@app.get("/health")
async def health() -> dict[str, Any]:
    material_status = MaterialApiClient().public_status()
    return {
        "ok": True,
        "service": "projeto-ficha-backend",
        "version": app.version,
        "time": now_iso(),
        "openai_api": False,
        "material_api": material_status,
    }


@app.get("/material-api/status")
async def material_api_status() -> dict[str, Any]:
    return {
        "ok": True,
        "material_api": MaterialApiClient().public_status(),
        "time": now_iso(),
    }


@app.post("/generate-chatgpt")
async def generate_chatgpt(
    payload: GenerateFichaPayload,
    request: Request,
) -> dict[str, Any]:
    started_at = now_iso()
    try:
        result = await generate_ficha(
            prompt=payload.prompt,
            job_id=payload.job_id,
        )
    except ChatGPTError as error:
        append_jsonl(
            LOG_DIR,
            "chatgpt.log.jsonl",
            {
                "received_at": started_at,
                "job_id": payload.job_id,
                "event": "chatgpt_failed",
                "error": str(error),
                "status_code": error.status_code,
            },
        )
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error

    append_jsonl(
        LOG_DIR,
        "chatgpt.log.jsonl",
        {
            "received_at": started_at,
            "completed_at": now_iso(),
            "job_id": payload.job_id,
            "event": "chatgpt_completed",
            "answer_length": len(result.get("answer", "")),
        },
    )
    return result


@app.post("/generate-order")
async def generate_order(
    payload: GenerateOrderPayload,
    request: Request,
) -> dict[str, Any]:
    started_at = now_iso()
    client = MaterialApiClient()
    try:
        result = await client.generate(payload.model_dump(exclude_none=True))
    except MaterialApiError as error:
        append_jsonl(
            LOG_DIR,
            "material-api.log.jsonl",
            {
                "received_at": started_at,
                "client_host": request.client.host if request.client else None,
                "job_id": payload.job_id,
                "event": "material_api_failed",
                "error": str(error),
                "status_code": error.status_code,
            },
        )
        raise HTTPException(
            status_code=error.status_code,
            detail=str(error),
        ) from error

    append_jsonl(
        LOG_DIR,
        "material-api.log.jsonl",
        {
            "received_at": started_at,
            "completed_at": now_iso(),
            "client_host": request.client.host if request.client else None,
            "job_id": payload.job_id,
            "event": "material_api_completed",
            "upstream_status": result.get("upstream_status"),
            "has_ficha": bool(result.get("ficha")),
            "has_download": bool(result.get("download_url")),
            "image_count": len(payload.images),
        },
    )
    return result


@app.post("/logs")
async def logs(payload: EventPayload, request: Request) -> dict[str, Any]:
    append_jsonl(
        LOG_DIR,
        "extension.log.jsonl",
        {
            "received_at": now_iso(),
            "client_host": request.client.host if request.client else None,
            **payload.model_dump(),
        },
    )
    return {"ok": True}


@app.post("/diagnostics")
async def diagnostics(payload: EventPayload, request: Request) -> dict[str, Any]:
    append_jsonl(
        LOG_DIR,
        "diagnostics.log.jsonl",
        {
            "received_at": now_iso(),
            "client_host": request.client.host if request.client else None,
            **payload.model_dump(),
        },
    )
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("BACKEND_HOST", "0.0.0.0"),
        port=int(os.getenv("BACKEND_PORT", "8000")),
        reload=False,
    )
