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
            pdf_endpoint="https://example.test/pdf",
            token="secret",
            store_id="",
            timeout_seconds=30,
            allowed_hosts=("materialdecontrucao.online",),
        )
        with self.assertRaises(MaterialApiError):
            validate_endpoint(settings)


class MaterialApiClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_creates_quotation_and_fetches_pdf_url(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["x-api-key"], "backend-secret")
            self.assertNotIn("authorization", request.headers)
            if request.method == "POST":
                self.assertEqual(request.url.path, "/functions/v1/api-quotation")
                self.assertEqual(request.headers["content-type"], "application/json")
                body = request.read().decode("utf-8")
                self.assertIn('"store_id":"store-1"', body.replace(" ", ""))
                return httpx.Response(200, json={"ok": True, "id": "quote-123"})

            self.assertEqual(request.method, "GET")
            self.assertEqual(request.url.path, "/functions/v1/api-quotation-pdf")
            self.assertEqual(request.url.params.get("id"), "quote-123")
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "pdf_url": "https://materialdecontrucao.online/orcamentos/quote-123.pdf",
                },
            )

        settings = MaterialApiSettings(
            endpoint="https://flkionbmkuqgkudjjuqk.supabase.co/functions/v1/api-quotation",
            pdf_endpoint="https://flkionbmkuqgkudjjuqk.supabase.co/functions/v1/api-quotation-pdf",
            token="backend-secret",
            store_id="store-1",
            timeout_seconds=30,
            allowed_hosts=("flkionbmkuqgkudjjuqk.supabase.co",),
        )
        client = MaterialApiClient(
            settings=settings,
            transport=httpx.MockTransport(handler),
        )
        result = await client.generate({"job_id": "job-1"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["download_id"], "quote-123")
        self.assertEqual(
            result["download_url"],
            "https://materialdecontrucao.online/orcamentos/quote-123.pdf",
        )


if __name__ == "__main__":
    unittest.main()