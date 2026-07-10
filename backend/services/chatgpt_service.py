from __future__ import annotations

import asyncio
import os
import re
from typing import Any

CHROME_USER_DATA = os.getenv(
    "CHROME_USER_DATA",
    r"C:\Users\Dell\AppData\Local\Google\Chrome\User Data",
)
CHROME_PROFILE = os.getenv("CHROME_PROFILE", "Default")
CHATGPT_PROJECT_URL = os.getenv(
    "CHATGPT_PROJECT_URL",
    "https://chatgpt.com/g/g-p-6a50feebc29481919b4dcaa0936ec203-ficha-pedido/project",
)
CHATGPT_PROJECT_ID = "6a50feebc29481919b4dcaa0936ec203"
CHATGPT_TIMEOUT_MS = int(os.getenv("CHATGPT_TIMEOUT_MS", "180000"))
STREAM_STABLE_MS = int(os.getenv("STREAM_STABLE_MS", "1800"))


class ChatGPTError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _is_project_url(url: str) -> bool:
    return CHATGPT_PROJECT_ID in url


async def _wait_for(condition, *, timeout_ms: int, interval_ms: int = 500, message: str = "Timeout") -> Any:
    deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
    while True:
        result = await condition() if asyncio.iscoroutinefunction(condition) else condition()
        if result:
            return result
        if asyncio.get_event_loop().time() > deadline:
            raise ChatGPTError(message, status_code=504)
        await asyncio.sleep(interval_ms / 1000)


async def generate_ficha(prompt: str, job_id: str = "") -> dict[str, Any]:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise ChatGPTError(
            "Playwright nao instalado. Execute: pip install playwright && playwright install chromium",
            status_code=503,
        )

    async with async_playwright() as pw:
        # Launch with Gabriel's Chrome profile (persistent context)
        try:
            context = await pw.chromium.launch_persistent_context(
                user_data_dir=CHROME_USER_DATA,
                channel="chrome",
                headless=False,
                args=[
                    f"--profile-directory={CHROME_PROFILE}",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-background-timer-throttling",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding",
                ],
            )
        except Exception as e:
            raise ChatGPTError(
                f"Nao foi possivel abrir o Chrome do Gabriel: {e}",
                status_code=503,
            ) from e

        try:
            # Find or open the FICHA PEDIDO project page
            page = None
            for p in context.pages:
                if _is_project_url(p.url):
                    page = p
                    break

            if page is None:
                page = await context.new_page()

            await page.goto(CHATGPT_PROJECT_URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(2)

            # Check logged in
            content = await page.content()
            if "login" in page.url.lower() or "auth" in page.url.lower():
                raise ChatGPTError(
                    "ChatGPT nao esta logado no perfil do Gabriel.",
                    status_code=401,
                )

            # Click "Novo chat em FICHA PEDIDO" if on project page
            if "/project" in page.url:
                new_chat_btn = await page.query_selector(
                    'button:has-text("Novo chat"), a:has-text("Novo chat"), '
                    '[aria-label*="Novo chat"], [aria-label*="new chat"]'
                )
                if new_chat_btn:
                    await new_chat_btn.click()
                    await asyncio.sleep(1.5)

            # Wait for composer (text input)
            composer = await _wait_for(
                lambda: page.query_selector(
                    'div[contenteditable="true"], textarea[placeholder], #prompt-textarea'
                ),
                timeout_ms=30000,
                message="Compositor do ChatGPT nao apareceu.",
            )

            # Capture text before sending (to detect new response)
            previous_text = await _get_latest_assistant_text(page)

            # Fill composer and send
            await composer.click()
            await composer.fill("")
            await page.keyboard.type(prompt, delay=0)
            await asyncio.sleep(0.3)
            await page.keyboard.press("Enter")

            # Wait for response to start and complete
            answer = await _wait_for_response(page, previous_text)

            return {
                "ok": True,
                "answer": answer,
                "provider": "chatgpt_playwright",
                "job_id": job_id,
            }

        finally:
            # Close only the page we opened, not the whole context (keep user's session)
            try:
                if page and not page.is_closed():
                    await page.close()
            except Exception:
                pass
            await context.close()


async def _get_latest_assistant_text(page) -> str:
    try:
        elements = await page.query_selector_all(
            '[data-message-author-role="assistant"], .markdown, [class*="assistant"]'
        )
        texts = []
        for el in elements:
            t = await el.inner_text()
            if t and len(t.strip()) > 5:
                texts.append(t.strip())
        return texts[-1] if texts else ""
    except Exception:
        return ""


async def _is_generating(page) -> bool:
    try:
        # Stop button visible = still generating
        stop = await page.query_selector(
            'button[aria-label*="Stop"], button[aria-label*="Parar"], '
            'button[data-testid*="stop"], [aria-busy="true"]'
        )
        if stop:
            visible = await stop.is_visible()
            if visible:
                return True
        text = await page.inner_text("body")
        return bool(re.search(r"stop generating|parar de gerar|thinking|pensando|gerando", text, re.I))
    except Exception:
        return False


async def _wait_for_response(page, previous_text: str) -> str:
    deadline = asyncio.get_event_loop().time() + CHATGPT_TIMEOUT_MS / 1000

    # Wait for a new response to appear
    await _wait_for(
        lambda: _new_response_appeared(page, previous_text),
        timeout_ms=60000,
        interval_ms=800,
        message="ChatGPT nao iniciou resposta dentro do tempo esperado.",
    )

    # Wait for streaming to complete
    last_text = ""
    stable_since = 0.0
    last_change = asyncio.get_event_loop().time()

    while True:
        current = await _get_latest_assistant_text(page)
        generating = await _is_generating(page)
        now = asyncio.get_event_loop().time()

        if current and current != last_text:
            last_text = current
            stable_since = 0.0
            last_change = now
        elif current and not generating:
            if stable_since == 0.0:
                stable_since = now
            if now - stable_since >= STREAM_STABLE_MS / 1000:
                return current

        if now > deadline:
            if last_text:
                return last_text
            raise ChatGPTError("Tempo esgotado aguardando resposta do ChatGPT.")

        if now - last_change > 60:
            if last_text:
                return last_text
            raise ChatGPTError("ChatGPT ficou sem progresso por tempo excessivo.")

        await asyncio.sleep(0.5)


async def _new_response_appeared(page, previous_text: str) -> bool:
    current = await _get_latest_assistant_text(page)
    return bool(current and current != previous_text and len(current) > 12)
