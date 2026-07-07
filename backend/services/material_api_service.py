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
    pdf_endpoint: str
    token: str
    store_id: str
    timeout_seconds: float
    allowed_hosts: tuple[str, ...]

    @classmethod
    def from_env(cls) -> "MaterialApiSettings":
        endpoint = os.getenv("MATERIAL_API_URL", "").strip()
        pdf_endpoint = os.getenv(
            "MATERIAL_API_PDF_URL",
            endpoint.replace("/api-quotation", "/api-quotation-pdf") if endpoint else "",
        ).strip()
        token = os.getenv("MATERIAL_API_TOKEN", "").strip()
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
            pdf_endpoint=pdf_endpoint,
            token=token,
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
            "endpoint_configured": bool(self.settings.endpoint),
            "pdf_endpoint_configured": bool(self.settings.pdf_endpoint),
            "endpoint_host": endpoint_host(self.settings.endpoint),
            "store_id_configured": bool(self.settings.store_id),
        }

    def _build_headers(self) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Projeto-Ficha/1.1",
            "x-api-key": self.settings.token,
        }

    async def _http_post(self, client: httpx.AsyncClient, url: str, json_body: Any) -> Any:
        try:
            response = await client.post(url, headers=self._build_headers(), json=json_body)
        except httpx.TimeoutException as error:
            raise MaterialApiError("Tempo esgotado aguardando a Material API.") from error
        except httpx.HTTPError as error:
            raise MaterialApiError(f"Falha de rede ao acessar a Material API: {error}") from error

        try:
            data: Any = response.json()
        except ValueError:
            data = response.text

        if response.is_error:
            detail = ""
            if isinstance(data, dict):
                detail = str(data.get("error") or data.get("message") or data.get("detail") or "")
            elif isinstance(data, str):
                detail = data
            detail = detail.strip()[:400] or response.reason_phrase
            raise MaterialApiError(
                f"Material API retornou HTTP {response.status_code}: {detail}",
                status_code=502,
            )
        return data

    async def _http_get(self, client: httpx.AsyncClient, url: str, params: dict) -> Any:
        headers = {k: v for k, v in self._build_headers().items() if k != "Content-Type"}
        try:
            response = await client.get(url, headers=headers, params=params)
        except httpx.TimeoutException as error:
            raise MaterialApiError("Tempo esgotado buscando PDF na Material API.") from error
        except httpx.HTTPError as error:
            raise MaterialApiError(f"Falha de rede buscando PDF: {error}") from error

        try:
            data: Any = response.json()
        except ValueError:
            data = response.text

        if response.is_error:
            detail = ""
            if isinstance(data, dict):
                detail = str(data.get("error") or data.get("message") or data.get("detail") or "")
            elif isinstance(data, str):
                detail = data
            detail = detail.strip()[:400] or response.reason_phrase
            raise MaterialApiError(
                f"Material API PDF retornou HTTP {response.status_code}: {detail}",
                status_code=502,
            )
        return data

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

        timeout = httpx.Timeout(self.settings.timeout_seconds)
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            # Step 1: create quotation → get ID
            quotation_data = await self._http_post(client, self.settings.endpoint, body)

            quotation_id = ""
            if isinstance(quotation_data, dict):
                nested = quotation_data.get("data")
                lookup = {**quotation_data, **nested} if isinstance(nested, dict) else quotation_data
                quotation_id = first_string(lookup, DOWNLOAD_ID_FIELDS)

            if not quotation_id:
                raise MaterialApiError(
                    "Material API nao retornou ID do orcamento para buscar PDF."
                )

            # Step 2: fetch PDF URL using quotation ID
            pdf_data = await self._http_get(
                client,
                self.settings.pdf_endpoint,
                {"id": quotation_id},
            )

        pdf_url = ""
        if isinstance(pdf_data, dict):
            nested = pdf_data.get("data")
            lookup = {**pdf_data, **nested} if isinstance(nested, dict) else pdf_data
            pdf_url = first_string(lookup, DOWNLOAD_URL_FIELDS)
            if not pdf_url:
                # Some APIs return the URL directly in a "url" or "pdf_url" at root
                pdf_url = first_string(pdf_data, DOWNLOAD_URL_FIELDS)
        elif isinstance(pdf_data, str) and pdf_data.startswith("http"):
            pdf_url = pdf_data

        if not pdf_url:
            raise MaterialApiError(
                "Material API nao retornou URL de download do PDF/DANFE."
            )

        return {
            "ok": True,
            "ficha": "",
            "download_url": pdf_url,
            "download_id": quotation_id,
            "provider": "material_api",
            "upstream_status": 200,
        }
