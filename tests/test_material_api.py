from __future__ import annotations

import sys
import unittest
from pathlib import Path

import httpx


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from services.material_api_service import (  # noqa: E402
    MaterialApiClient,
    MaterialApiError,
    MaterialApiSettings,
    normalize_response,
    validate_endpoint,
)


class MaterialApiUnitTests(unittest.TestCase):
    def test_normalize_response(self) -> None:
        result = normalize_response(
            {
                "ok": True,
                "data": {
                    "ficha": "FICHA PRONTA",
                    "download_url": "https://example.test/ficha.pdf",
                    "id": "ficha-1",
                },
            }
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["ficha"], "FICHA PRONTA")
        self.assertEqual(result["download_id"], "ficha-1")

    def test_rejects_unlisted_host(self) -> None:
        settings = MaterialApiSettings(
            endpoint="https://example.test/generate",
            token="secret",
            api_key="",
            store_id="",
            timeout_seconds=30,
            allowed_hosts=("materialdecontrucao.online",),
        )
        with self.assertRaises(MaterialApiError):
            validate_endpoint(settings)


class MaterialApiClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_token_only_from_backend(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(
                request.headers["authorization"],
                "Bearer backend-secret",
            )
            self.assertEqual(request.headers["apikey"], "supabase-anon")
            self.assertEqual(request.headers["x-store-id"], "store-1")
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "ficha": "FICHA API",
                    "download_url": "",
                },
            )

        settings = MaterialApiSettings(
            endpoint="https://materialdecontrucao.online/api/gerar-ficha",
            token="backend-secret",
            api_key="",
            store_id="store-1",
            timeout_seconds=30,
            allowed_hosts=("materialdecontrucao.online",),
        )
        client = MaterialApiClient(
            settings=settings,
            transport=httpx.MockTransport(handler),
        )
        result = await client.generate({"job_id": "job-1"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["ficha"], "FICHA API")


if __name__ == "__main__":
    unittest.main()
