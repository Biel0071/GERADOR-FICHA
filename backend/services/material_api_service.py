from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx


ANSWER_FIELDS = (
    "ficha",
    "answer",
    "content",
    "text",
    "result",
    "orcamento",
    "quotation",
)
DOWNLOAD_URL_FIELDS = (
    "download_url",
    "downloadUrl",
    "pdf_url",
    "pdfUrl",
    "file_url",
    "fileUrl",
    "danfe_url",
    "url",
)
DOWNLOAD_ID_FIELDS = (
    "download_id",
    "downloadId",
    "orcamento_id",
    "orcamentoId",
    "quotation_id",
    "quotationId",
    "document_id",
    "id",
)


class MaterialApiError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class MaterialApiSettings:
    endpoint: str
    token: str
    api_key: str
    store_id: str
    timeout_seconds: float
    allowed_hosts: tuple[str, ...]

    @classmethod
    def from_env(cls) -> "MaterialApiSettings":
        endpoint = os.getenv("MATERIAL_API_URL", "").strip()
        token = os.getenv("MATERIAL_API_TOKEN", "").strip()
        api_key = os.getenv("MATERIAL_API_KEY", "").strip()
        store_id = os.getenv("MATERIAL_STORE_ID", "").strip()
        allowed = os.getenv(
            "MATERIAL_ALLOWED_HOSTS",
            "materialdecontrucao.online,flkionbmkuqgkudjjuqk.supabase.co",
        )
        allowed_hosts = tuple(
            host.strip().lower()
            for host in allowed.split(",")
            if host.strip()
        )
        try:
            timeout_seconds = float(
                os.getenv("MATERIAL_API_TIMEOUT_SECONDS", "120")
            )
        except ValueError:
            timeout_seconds = 120.0

        return cls(
            endpoint=endpoint,
            token=token,
            api_key=api_key,
            store_id=store_id,
            timeout_seconds=max(5.0, min(timeout_seconds, 300.0)),
            allowed_hosts=allowed_hosts,
        )

    @property
    def configured(self) -> bool:
        return bool(self.endpoint and self.token)


def endpoint_host(endpoint: str) -> str:
    return (urlparse(endpoint).hostname or "").lower()


def validate_endpoint(settings: MaterialApiSettings) -> None:
    parsed = urlparse(settings.endpoint)
    if parsed.scheme != "https":
        raise MaterialApiError(
            "MATERIAL_API_URL deve usar HTTPS.",
            status_code=503,
        )
    host = endpoint_host(settings.endpoint)
    if not host or host not in settings.allowed_hosts:
        raise MaterialApiError(
            f"Host da API nao permitido: {host or 'ausente'}.",
            status_code=503,
        )


def first_string(payload: dict[str, Any], fields: tuple[str, ...]) -> str:
    for field in fields:
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def normalize_response(data: Any) -> dict[str, Any]:
    if isinstance(data, str):
        return {
            "ok": bool(data.strip()),
            "ficha": data.strip(),
            "download_url": "",
            "download_id": "",
        }
    if not isinstance(data, dict):
        return {
            "ok": False,
            "ficha": "",
            "download_url": "",
            "download_id": "",
        }

    nested = data.get("data")
    payload = {**data, **nested} if isinstance(nested, dict) else data
    ficha = first_string(payload, ANSWER_FIELDS)
    download_url = first_string(payload, DOWNLOAD_URL_FIELDS)
    download_id = first_string(payload, DOWNLOAD_ID_FIELDS)
    return {
        "ok": bool(payload.get("ok", ficha or download_url)),
        "ficha": ficha,
        "download_url": download_url,
        "download_id": download_id,
        "provider": "material_api",
    }


class MaterialApiClient:
    def __init__(
        self,
        settings: MaterialApiSettings | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings or MaterialApiSettings.from_env()
        self.transport = transport

    def public_status(self) -> dict[str, Any]:
        return {
            "configured": self.settings.configured,
            "token_configured": bool(self.settings.token),
            "api_key_configured": bool(self.settings.api_key),
            "endpoint_configured": bool(self.settings.endpoint),
            "endpoint_host": endpoint_host(self.settings.endpoint),
            "store_id_configured": bool(self.settings.store_id),
        }

    async def generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.configured:
            raise MaterialApiError(
                "Material API nao configurada. Defina MATERIAL_API_URL e "
                "MATERIAL_API_TOKEN no backend/.env.",
                status_code=503,
            )
        validate_endpoint(self.settings)

        body = dict(payload)
        if self.settings.store_id and not body.get("store_id"):
            body["store_id"] = self.settings.store_id

        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.settings.token}",
            "Content-Type": "application/json",
            "User-Agent": "Projeto-Ficha/1.1",
        }
        api_key = self.settings.api_key or self.settings.token
        if api_key:
            headers["apikey"] = api_key
        if body.get("store_id"):
            headers["X-Store-Id"] = str(body["store_id"])

        timeout = httpx.Timeout(self.settings.timeout_seconds)
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                follow_redirects=False,
                transport=self.transport,
            ) as client:
                response = await client.post(
                    self.settings.endpoint,
                    headers=headers,
                    json=body,
                )
        except httpx.TimeoutException as error:
            raise MaterialApiError(
                "Tempo esgotado aguardando a Material API."
            ) from error
        except httpx.HTTPError as error:
            raise MaterialApiError(
                f"Falha de rede ao acessar a Material API: {error}"
            ) from error

        try:
            response_data: Any = response.json()
        except ValueError:
            response_data = response.text

        if response.is_error:
            detail = ""
            if isinstance(response_data, dict):
                detail = str(
                    response_data.get("error")
                    or response_data.get("message")
                    or response_data.get("detail")
                    or ""
                )
            elif isinstance(response_data, str):
                detail = response_data
            detail = detail.strip()[:400] or response.reason_phrase
            raise MaterialApiError(
                f"Material API retornou HTTP {response.status_code}: {detail}",
                status_code=502,
            )

        result = normalize_response(response_data)
        if not result["ok"]:
            raise MaterialApiError(
                "Material API respondeu sem ficha ou arquivo de orcamento."
            )
        result["upstream_status"] = response.status_code
        return result
