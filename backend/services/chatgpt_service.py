from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

CHATGPT_PROJECT_URL = os.getenv(
    "CHATGPT_PROJECT_URL",
    "https://chatgpt.com/g/g-p-6a50feebc29481919b4dcaa0936ec203-ficha-pedido/project",
)
CHATGPT_PROJECT_ID = "6a50feebc29481919b4dcaa0936ec203"
CHATGPT_EMAIL = os.getenv("CHATGPT_EMAIL", "")
CHATGPT_PASSWORD = os.getenv("CHATGPT_PASSWORD", "")
SESSION_FILE = Path(os.getenv("CHATGPT_SESSION_FILE", "/root/gerar-ficha/backend/chatgpt_session.json"))
CHATGPT_TIMEOUT_MS = int(os.getenv("CHATGPT_TIMEOUT_MS", "180000"))
STREAM_STABLE_MS = int(os.getenv("STREAM_STABLE_MS", "1800"))
HEADLESS = os.getenv("CHATGPT_HEADLESS", "true").lower() == "true"

# Estado global do login (login interativo via endpoint /login/*)
_login_state: dict[str, Any] = {"status": "idle", "page": None, "browser": None, "context": None}
_login_lock = asyncio.Lock()


class ChatGPTError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def session_exists() -> bool:
    return SESSION_FILE.exists() and SESSION_FILE.stat().st_size > 10


async def _wait_for(fn, *, timeout_ms: int, interval_ms: int = 600, message: str = "Timeout") -> Any:
    deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
    while True:
        try:
            result = await fn() if asyncio.iscoroutinefunction(fn) else fn()
        except Exception:
            result = None
        if result:
            return result
        if asyncio.get_event_loop().time() > deadline:
            raise ChatGPTError(message, status_code=504)
        await asyncio.sleep(interval_ms / 1000)


async def _save_session(context) -> None:
    cookies = await context.cookies()
    storage = await context.storage_state()
    data = {"cookies": cookies, "storage": storage}
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSION_FILE.write_text(json.dumps(data))


async def _load_session(context) -> bool:
    if not session_exists():
        return False
    try:
        data = json.loads(SESSION_FILE.read_text())
        if data.get("storage"):
            await context.add_cookies(data["storage"].get("cookies", []))
        elif data.get("cookies"):
            await context.add_cookies(data["cookies"])
        return True
    except Exception:
        return False


# ─── Login interativo (chamado pelos endpoints /login/*) ────────────────────

async def start_login() -> dict[str, Any]:
    """Inicia o processo de login no ChatGPT. Retorna status."""
    global _login_state
    async with _login_lock:
        if _login_state["status"] in ("waiting_code", "logging_in"):
            return {"status": _login_state["status"], "message": "Login já em andamento."}

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise ChatGPTError("Playwright não instalado.", status_code=503)

        pw = await async_playwright().__aenter__()
        browser = await pw.chromium.launch(headless=HEADLESS, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = await browser.new_context()
        page = await context.new_page()

        _login_state.update({"status": "logging_in", "page": page, "browser": browser, "context": context, "pw": pw})

        try:
            await page.goto("https://chatgpt.com/auth/login", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)

            # Clicar em "Log in"
            login_btn = await page.query_selector('button:has-text("Log in"), a:has-text("Log in"), [data-testid="login-button"]')
            if login_btn:
                await login_btn.click()
                await asyncio.sleep(1.5)

            # Preencher email
            email_input = await _wait_for(
                lambda: page.query_selector('input[type="email"], input[name="email"], input[autocomplete="email"]'),
                timeout_ms=15000, message="Campo de email não encontrado."
            )
            await email_input.fill(CHATGPT_EMAIL)
            await page.keyboard.press("Enter")
            await asyncio.sleep(1.5)

            # Preencher senha
            pass_input = await _wait_for(
                lambda: page.query_selector('input[type="password"]'),
                timeout_ms=10000, message="Campo de senha não encontrado."
            )
            await pass_input.fill(CHATGPT_PASSWORD)
            await page.keyboard.press("Enter")
            await asyncio.sleep(3)

            # Verificar se pediu código de verificação
            page_text = await page.inner_text("body")
            needs_code = any(w in page_text.lower() for w in [
                "verify", "verificar", "código", "code", "enter the code",
                "check your email", "confirme", "autenticação"
            ])

            if needs_code:
                _login_state["status"] = "waiting_code"
                return {"status": "waiting_code", "message": "Código de verificação necessário. Informe o código recebido no email/SMS."}

            # Sem 2FA — verificar se logou
            if "chatgpt.com" in page.url and "auth" not in page.url:
                await _save_session(context)
                _login_state["status"] = "idle"
                return {"status": "ok", "message": "Login concluído com sucesso. Sessão salva."}

            _login_state["status"] = "waiting_code"
            return {"status": "waiting_code", "message": "Aguardando código ou próxima etapa."}

        except Exception as e:
            _login_state["status"] = "error"
            return {"status": "error", "message": str(e)}


async def submit_login_code(code: str) -> dict[str, Any]:
    """Envia o código de verificação 2FA durante o login."""
    global _login_state
    if _login_state["status"] != "waiting_code" or not _login_state.get("page"):
        return {"status": "error", "message": "Nenhum login aguardando código."}

    page = _login_state["page"]
    context = _login_state["context"]
    try:
        # Procurar campo de código OTP
        code_input = await _wait_for(
            lambda: page.query_selector('input[type="text"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'),
            timeout_ms=8000, message="Campo de código não encontrado."
        )
        await code_input.fill(code.strip())
        await page.keyboard.press("Enter")
        await asyncio.sleep(4)

        # Verificar se logou
        if "chatgpt.com" in page.url and "auth" not in page.url:
            await _save_session(context)
            _login_state["status"] = "idle"
            return {"status": "ok", "message": "Login com código concluído. Sessão salva."}

        # Tentar navegar ao projeto para confirmar
        await page.goto("https://chatgpt.com", wait_until="domcontentloaded", timeout=15000)
        await asyncio.sleep(2)
        page_text = await page.inner_text("body")
        if "log in" not in page_text.lower():
            await _save_session(context)
            _login_state["status"] = "idle"
            return {"status": "ok", "message": "Sessão confirmada e salva."}

        return {"status": "error", "message": "Código aceito mas login não confirmado. Tente novamente."}
    except Exception as e:
        _login_state["status"] = "error"
        return {"status": "error", "message": str(e)}
    finally:
        # Fechar browser do login após sucesso
        if _login_state["status"] in ("idle", "error"):
            try:
                await _login_state["browser"].close()
            except Exception:
                pass


# ─── Geração de ficha (chamado pelo endpoint /generate-chatgpt) ─────────────

async def generate_ficha(prompt: str, job_id: str = "") -> dict[str, Any]:
    if not session_exists():
        raise ChatGPTError(
            "Sessão ChatGPT não encontrada. Faça login via POST /login/start primeiro.",
            status_code=401,
        )

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        raise ChatGPTError("Playwright não instalado.", status_code=503)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=HEADLESS,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-timer-throttling"]
        )
        context = await browser.new_context()

        # Carregar sessão salva
        loaded = await _load_session(context)
        if not loaded:
            await browser.close()
            raise ChatGPTError("Erro ao carregar sessão. Refaça o login.", status_code=401)

        page = await context.new_page()
        try:
            await page.goto(CHATGPT_PROJECT_URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(2)

            # Verificar se está logado
            if "auth" in page.url or "login" in page.url:
                await browser.close()
                SESSION_FILE.unlink(missing_ok=True)
                raise ChatGPTError("Sessão expirada. Refaça o login via /login/start.", status_code=401)

            # Clicar em "Novo chat" se estiver na página do projeto
            if "/project" in page.url or CHATGPT_PROJECT_ID in page.url:
                new_chat = await page.query_selector(
                    'a[href*="/new"], button:has-text("Novo chat"), button:has-text("New chat"), '
                    '[aria-label*="Novo chat"], [aria-label*="new chat"]'
                )
                if new_chat:
                    await new_chat.click()
                    await asyncio.sleep(1.5)

            # Aguardar compositor
            composer = await _wait_for(
                lambda: page.query_selector('#prompt-textarea, div[contenteditable="true"], textarea'),
                timeout_ms=30000, message="Compositor do ChatGPT não apareceu."
            )

            prev_text = await _get_latest_assistant_text(page)

            # Digitar prompt e enviar
            await composer.click()
            await page.keyboard.type(prompt, delay=0)
            await asyncio.sleep(0.3)

            send_btn = await page.query_selector('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Enviar"]')
            if send_btn and await send_btn.is_enabled():
                await send_btn.click()
            else:
                await page.keyboard.press("Enter")

            # Aguardar resposta completa
            answer = await _wait_for_response(page, prev_text)

            # Salvar sessão atualizada
            await _save_session(context)

            return {"ok": True, "answer": answer, "provider": "chatgpt_vps", "job_id": job_id}

        finally:
            try:
                await page.close()
            except Exception:
                pass
            await browser.close()


async def _get_latest_assistant_text(page) -> str:
    try:
        els = await page.query_selector_all('[data-message-author-role="assistant"]')
        if not els:
            els = await page.query_selector_all('.markdown, [class*="assistant-message"]')
        texts = []
        for el in els:
            t = await el.inner_text()
            if t and len(t.strip()) > 5:
                texts.append(t.strip())
        return texts[-1] if texts else ""
    except Exception:
        return ""


async def _is_generating(page) -> bool:
    try:
        stop = await page.query_selector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Parar"]')
        if stop and await stop.is_visible():
            return True
        text = await page.inner_text("body")
        return bool(re.search(r"stop generating|parar de gerar|thinking|pensando", text, re.I))
    except Exception:
        return False


async def _wait_for_response(page, previous_text: str) -> str:
    deadline = asyncio.get_event_loop().time() + CHATGPT_TIMEOUT_MS / 1000

    # Aguardar início da resposta
    await _wait_for(
        lambda: _new_response_started(page, previous_text),
        timeout_ms=60000, interval_ms=800,
        message="ChatGPT não iniciou resposta no tempo esperado."
    )

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
            if not stable_since:
                stable_since = now
            if now - stable_since >= STREAM_STABLE_MS / 1000:
                return current

        if now > deadline:
            if last_text:
                return last_text
            raise ChatGPTError("Tempo esgotado aguardando resposta.")

        if now - last_change > 60:
            if last_text:
                return last_text
            raise ChatGPTError("ChatGPT parou sem responder.")

        await asyncio.sleep(0.5)


async def _new_response_started(page, previous_text: str) -> bool:
    current = await _get_latest_assistant_text(page)
    return bool(current and current != previous_text and len(current) > 10)
