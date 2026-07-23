from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any


@asynccontextmanager
async def _async_timeout(seconds: float):
    """Compatível com Python 3.9+ (asyncio.timeout só existe no 3.11+)."""
    if sys.version_info >= (3, 11):
        async with asyncio.timeout(seconds):
            yield
    else:
        loop = asyncio.get_event_loop()
        task = asyncio.current_task()
        handle = loop.call_later(seconds, task.cancel)
        try:
            yield
        except asyncio.CancelledError:
            raise asyncio.TimeoutError()
        finally:
            handle.cancel()

CHATGPT_PROJECT_URL = os.getenv(
    "CHATGPT_PROJECT_URL",
    "https://chatgpt.com/g/g-p-6a5fc590af1c81918c49fa7a9083972d-ficha-pedido/project",
)
CHATGPT_PROJECT_ID = "6a5fc590af1c81918c49fa7a9083972d"
CHATGPT_EMAIL = os.getenv("CHATGPT_EMAIL", "")
CHATGPT_PASSWORD = os.getenv("CHATGPT_PASSWORD", "")
SESSION_FILE = Path(os.getenv("CHATGPT_SESSION_FILE", "/root/gerar-ficha/backend/chatgpt_session.json"))
CHATGPT_TIMEOUT_MS = int(os.getenv("CHATGPT_TIMEOUT_MS", "180000"))
STREAM_STABLE_MS = int(os.getenv("STREAM_STABLE_MS", "1800"))
HEADLESS = os.getenv("CHATGPT_HEADLESS", "true").lower() == "true"

# Caminho para Chromium do sistema (usado em AlmaLinux/RHEL onde o Playwright não consegue baixar)
SYSTEM_CHROMIUM = os.getenv(
    "CHROMIUM_EXECUTABLE",
    "/usr/bin/chromium-browser" if os.path.exists("/usr/bin/chromium-browser") else ""
)

def _chromium_launch_kwargs() -> dict:
    """Retorna kwargs para pw.chromium.launch(), usando binário do sistema se necessário."""
    args = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--window-size=1280,720",
        "--start-maximized",
        "--disable-web-security",
        "--allow-running-insecure-content",
    ]
    # Na VPS com Xvfb usamos headless=False para passar Cloudflare
    display = os.getenv("DISPLAY", "")
    use_headless = HEADLESS and not display
    kwargs: dict = {"headless": use_headless, "args": args}
    if SYSTEM_CHROMIUM and os.path.exists(SYSTEM_CHROMIUM):
        kwargs["executable_path"] = SYSTEM_CHROMIUM
    return kwargs

# Estado global do login (login interativo via endpoint /login/*)
_login_state: dict[str, Any] = {"status": "idle", "page": None, "browser": None, "context": None}
_login_lock = asyncio.Lock()
_login_timeout_seconds = 120  # Timeout máximo para operação de login


class ChatGPTError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def session_exists() -> bool:
    if not SESSION_FILE.exists() or SESSION_FILE.stat().st_size < 100:
        return False
    try:
        data = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
        cookies = data.get("cookies", [])
        # Exigir obrigatoriamente cookie de autenticação real do ChatGPT (session-token ou access_token)
        return any("session-token" in c.get("name", "").lower() or "access_token" in c.get("name", "").lower() for c in cookies)
    except Exception:
        return False


async def _wait_for(fn, *, timeout_ms: int, interval_ms: int = 600, message: str = "Timeout") -> Any:
    deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
    while True:
        try:
            result = fn()
            if asyncio.iscoroutine(result):
                result = await result
        except Exception:
            result = None
        if result:
            return result
        if asyncio.get_event_loop().time() > deadline:
            raise ChatGPTError(message, status_code=504)
        await asyncio.sleep(interval_ms / 1000)


async def _save_session(context) -> None:
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    await context.storage_state(path=str(SESSION_FILE))


async def _create_context(browser) -> Any:
    if session_exists():
        try:
            return await browser.new_context(storage_state=str(SESSION_FILE))
        except Exception:
            pass
    return await browser.new_context()


async def _load_session(context) -> bool:
    return session_exists()


# ─── Login interativo (chamado pelos endpoints /login/*) ────────────────────

import logging
_log = logging.getLogger("chatgpt_login")
_log.setLevel(logging.DEBUG)
if not _log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s %(message)s"))
    _log.addHandler(_handler)


async def start_login(email: str = "", force: bool = False) -> dict[str, Any]:
    """Inicia o processo de login no ChatGPT com e-mail fornecido ou configurado. Retorna status."""
    global _login_state
    target_email = email.strip() or CHATGPT_EMAIL.strip() or os.getenv("CHATGPT_EMAIL", "").strip()
    if not target_email:
        return {"status": "error", "message": "Informe o e-mail para realizar o login no ChatGPT."}

    # Se login anterior travou ou está em estado inválido, limpar agressivamente
    if _login_state.get("status") in ("logging_in", "waiting_code") and force:
        _log.info("Force reset: limpando estado anterior (%s)", _login_state.get("status"))
        try:
            if _login_state.get("browser"):
                await _login_state["browser"].close()
        except Exception:
            pass
        _login_state.update({"status": "idle", "page": None, "browser": None, "context": None})

    steps_completed = []

    try:
        async with _async_timeout(_login_timeout_seconds):
            async with _login_lock:
                # Fechar qualquer browser ou página anterior para garantir envio de um NOVO código OTP
                if _login_state.get("browser"):
                    _log.info("Fechando browser anterior")
                    try:
                        await _login_state["browser"].close()
                    except Exception:
                        pass
                    _login_state.update({"status": "idle", "page": None, "browser": None, "context": None})

                try:
                    from playwright.async_api import async_playwright
                except ImportError:
                    raise ChatGPTError("Playwright não instalado no servidor.", status_code=503)

                _log.info("[1/8] Abrindo browser Chromium...")
                steps_completed.append("browser_opened")
                pw = await async_playwright().__aenter__()
                browser = await pw.chromium.launch(**_chromium_launch_kwargs())
                context = await browser.new_context()
                page = await context.new_page()

                _login_state.update({"status": "logging_in", "page": page, "browser": browser, "context": context, "pw": pw})

                try:
                    _log.info("[2/8] Navegando para https://chatgpt.com/auth/login ...")
                    await page.goto("https://chatgpt.com/auth/login", wait_until="domcontentloaded", timeout=45000)
                    await asyncio.sleep(4)
                    steps_completed.append("page_loaded")
                    _log.info("[2/8] Página carregada. URL atual: %s", page.url)

                    # Clicar em "Log in" se a landing page tiver o botão
                    _log.info("[3/8] Procurando botão 'Log in'...")
                    login_btn = await page.query_selector('button:has-text("Log in"), a:has-text("Log in"), [data-testid="login-button"], a[href*="login"]')
                    if login_btn and await login_btn.is_visible():
                        await login_btn.click()
                        await asyncio.sleep(3)
                        steps_completed.append("login_btn_clicked")
                        _log.info("[3/8] Botão 'Log in' clicado. URL: %s", page.url)
                    else:
                        _log.info("[3/8] Botão 'Log in' não encontrado (pode já estar na tela de e-mail)")
                        steps_completed.append("login_btn_skipped")

                    # Preencher e-mail com múltiplos seletores
                    _log.info("[4/8] Procurando campo de e-mail...")
                    email_input = await _wait_for(
                        lambda: page.query_selector(
                            'input[type="email"], input[name="email"], input[autocomplete="email"], '
                            'input[autocomplete="username"], input[id*="email"], input[placeholder*="email"]'
                        ),
                        timeout_ms=25000, message="Campo de e-mail do ChatGPT não encontrado."
                    )
                    await email_input.fill(target_email)
                    await asyncio.sleep(0.5)
                    steps_completed.append("email_filled")
                    _log.info("[4/8] E-mail preenchido: %s", target_email)

                    _log.info("[5/8] Clicando 'Continue'...")
                    continue_btn = await page.query_selector('button[type="submit"], button:has-text("Continue"), button:has-text("Continuar")')
                    if continue_btn and await continue_btn.is_visible():
                        await continue_btn.click()
                    else:
                        await page.keyboard.press("Enter")
                    await asyncio.sleep(4)
                    steps_completed.append("continue_clicked")
                    _log.info("[5/8] Continue clicado. URL: %s", page.url)

                    # Se o OpenAI pedir senha, ou botão de enviar código temporário
                    _log.info("[6/8] Procurando botão 'Send code' / 'Email a code'...")
                    send_code_btn = await page.query_selector(
                        'button:has-text("Send code"), button:has-text("Send temporary code"), '
                        'button:has-text("Email a code"), button:has-text("Enviar código"), '
                        'button:has-text("Email temporary code"), button:has-text("Continue with login code"), '
                        'button:has-text("Send me a code"), a:has-text("Send temporary code")'
                    )
                    if send_code_btn and await send_code_btn.is_visible():
                        await send_code_btn.click()
                        await asyncio.sleep(4)
                        steps_completed.append("send_code_clicked")
                        _log.info("[6/8] Botão 'Send code' clicado!")
                    else:
                        _log.info("[6/8] Botão 'Send code' não encontrado (verificando senha ou OTP direto)")
                        steps_completed.append("send_code_skipped")

                    # Preencher senha se o campo for solicitado
                    pass_input = await page.query_selector('input[type="password"]')
                    if pass_input and await pass_input.is_visible() and CHATGPT_PASSWORD:
                        _log.info("[6b/8] Campo de senha detectado, preenchendo...")
                        await pass_input.fill(CHATGPT_PASSWORD)
                        await page.keyboard.press("Enter")
                        await asyncio.sleep(4)
                        steps_completed.append("password_filled")

                    # Verificar se já caiu no prompt do código OTP
                    _log.info("[7/8] Verificando se página pede OTP...")
                    page_text = await page.inner_text("body")
                    needs_code = any(w in page_text.lower() for w in [
                        "verify", "verificar", "código", "code", "enter the code",
                        "check your email", "confirme", "autenticação", "otp",
                        "6-digit", "sent you", "enviamos", "check your inbox", "sign in with a temporary code"
                    ])

                    _log.info("[7/8] needs_code=%s, url=%s", needs_code, page.url)
                    _log.info("[7/8] page_text (primeiros 300 chars): %s", page_text[:300].replace('\n', ' '))

                    if needs_code or "auth" in page.url or "login" in page.url:
                        _login_state["status"] = "waiting_code"
                        steps_completed.append("waiting_code")
                        _log.info("[8/8] ✅ OTP disparado! Aguardando código do usuário.")
                        return {
                            "status": "waiting_code",
                            "message": f"Novo código OTP disparado para {target_email}! Verifique o e-mail.",
                            "steps": steps_completed
                        }

                    if "chatgpt.com" in page.url and "auth" not in page.url:
                        await _save_session(context)
                        _login_state["status"] = "idle"
                        steps_completed.append("already_logged_in")
                        _log.info("[8/8] ✅ Já estava logado! Sessão salva.")
                        return {
                            "status": "ok",
                            "message": "Login concluído com sucesso. Sessão salva.",
                            "steps": steps_completed
                        }

                    _login_state["status"] = "waiting_code"
                    steps_completed.append("waiting_code_fallback")
                    _log.info("[8/8] Fallback: assumindo OTP disparado.")
                    return {
                        "status": "waiting_code",
                        "message": f"Código OTP disparado para {target_email}.",
                        "steps": steps_completed
                    }

                except Exception as e:
                    _login_state["status"] = "error"
                    _log.error("Erro no login: %s (steps: %s)", str(e), steps_completed)
                    try:
                        await browser.close()
                    except Exception:
                        pass
                    _login_state.update({"page": None, "browser": None, "context": None})
                    return {
                        "status": "error",
                        "message": f"Erro abrindo login no ChatGPT: {e}",
                        "steps": steps_completed
                    }
    except asyncio.TimeoutError:
        _login_state["status"] = "idle"
        _log.error("Timeout no login (steps: %s)", steps_completed)
        try:
            if _login_state.get("browser"):
                await _login_state["browser"].close()
        except Exception:
            pass
        _login_state.update({"page": None, "browser": None, "context": None})
        return {
            "status": "error",
            "message": "Login anterior travou e foi resetado. Tente novamente em 5 segundos.",
            "steps": steps_completed
        }


async def submit_login_code(code: str) -> dict[str, Any]:
    """Envia o código de verificação OTP durante o login."""
    global _login_state
    if _login_state["status"] != "waiting_code" or not _login_state.get("page"):
        return {"status": "error", "message": "Nenhum login aguardando código."}

    page = _login_state["page"]
    context = _login_state["context"]
    try:
        # Procurar campo de código OTP (múltiplos seletores incluindo OpenAI Auth0 UI)
        code_input = await _wait_for(
            lambda: page.query_selector(
                'input[id="code"], input[name="code"], input[autocomplete="one-time-code"], '
                'input[inputmode="numeric"], input[placeholder*="código"], input[placeholder*="code"], '
                'input[type="text"], input[type="tel"], input[type="number"]'
            ),
            timeout_ms=15000, message="Campo de código OTP da OpenAI não encontrado."
        )

        try:
            await code_input.focus()
            await code_input.click(click_count=3)
        except Exception:
            pass
        await code_input.fill(code.strip())
        await asyncio.sleep(0.5)

        # Tentar clicar botão "Continuar" / "Continue" / "Verify"
        confirm_btn = await page.query_selector(
            'button[type="submit"], button:has-text("Continuar"), button:has-text("Continue"), '
            'button:has-text("Verify"), button:has-text("Confirmar")'
        )
        if confirm_btn and await confirm_btn.is_visible():
            await confirm_btn.click()
        else:
            await page.keyboard.press("Enter")

        await asyncio.sleep(5)

        # Aguardar redirecionamento ou navegar direto ao projeto para testar autenticação
        try:
            await page.goto(CHATGPT_PROJECT_URL, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(5)
        except Exception:
            pass

        current_url = page.url
        composer = await page.query_selector('#prompt-textarea, div[contenteditable="true"], textarea')
        is_authenticated = composer is not None or ("/project" in current_url or CHATGPT_PROJECT_ID in current_url)

        if is_authenticated and "auth" not in current_url and "login" not in current_url:
            await _save_session(context)
            _login_state["status"] = "idle"
            return {"status": "ok", "message": "Login no Projeto FICHA verificado e sessão salva com sucesso!"}
        else:
            SESSION_FILE.unlink(missing_ok=True)
            _login_state["status"] = "error"
            return {"status": "error", "message": f"Código OTP incorreto ou expirado. URL: {current_url}. Tente novamente."}

    except Exception as e:
        _login_state["status"] = "error"
        return {"status": "error", "message": str(e)}
    finally:
        if _login_state["status"] in ("idle", "error"):
            try:
                await _login_state["browser"].close()
            except Exception:
                pass


async def resend_login_code() -> dict[str, Any]:
    """Clica no botão 'Reenviar código' da página do ChatGPT se existente, ou reinicia o processo de login."""
    global _login_state
    if _login_state.get("page"):
        try:
            page = _login_state["page"]
            resend_btn = await page.query_selector(
                'button:has-text("Resend"), button:has-text("Reenviar"), '
                'a:has-text("Resend"), a:has-text("Reenviar"), '
                'button:has-text("Resend code"), button:has-text("Reenviar código")'
            )
            if resend_btn and await resend_btn.is_visible():
                await resend_btn.click()
                await asyncio.sleep(2)
                _login_state["status"] = "waiting_code"
                return {"status": "waiting_code", "message": "Novo código de verificação solicitado via ChatGPT."}
        except Exception:
            pass

    # Se a página fechou ou o botão não apareceu, limpa e força novo start_login()
    _login_state["status"] = "idle"
    if _login_state.get("browser"):
        try:
            await _login_state["browser"].close()
        except Exception:
            pass
        _login_state["browser"] = None
        _login_state["page"] = None

    return await start_login()


async def refresh_keep_alive() -> bool:
    """Abre o ChatGPT com a sessão salva a cada 12h para renovar os cookies e manter a conta ativa."""
    if not session_exists():
        return False
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(**_chromium_launch_kwargs())
            context = await browser.new_context()
            has_session = await _load_session(context)
            if not has_session:
                await browser.close()
                return False
            page = await context.new_page()
            await page.goto("https://chatgpt.com", wait_until="domcontentloaded", timeout=45000)
            await asyncio.sleep(5)
            await _save_session(context)
            await page.close()
            await browser.close()
            return True
    except Exception:
        return False


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
        browser = await pw.chromium.launch(**_chromium_launch_kwargs())
        context = await _create_context(browser)

        page = await context.new_page()
        try:
            await page.goto(CHATGPT_PROJECT_URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(2)

            # Verificar se está logado
            current_url = page.url
            if "auth" in current_url or "login" in current_url:
                SESSION_FILE.unlink(missing_ok=True)
                raise ChatGPTError("Sessão expirada. Refaça o login via /login/start.", status_code=401)

            # Clicar em "Novo chat" se estiver na página do projeto
            if "/project" in page.url or CHATGPT_PROJECT_ID in page.url:
                new_chat = await page.query_selector(
                    'a[href*="/new"], button:has-text("Novo chat"), button:has-text("New chat"), '
                    '[aria-label*="Novo chat"], [aria-label*="new chat"]'
                )
                if new_chat:
                    try:
                        await new_chat.click()
                        await asyncio.sleep(1.5)
                    except Exception:
                        pass

            # Aguardar compositor
            try:
                composer = await _wait_for(
                    lambda: page.query_selector('#prompt-textarea, div[contenteditable="true"], textarea'),
                    timeout_ms=15000, message="Compositor do ChatGPT não apareceu."
                )
            except ChatGPTError:
                # Se o compositor não apareceu, verificar se caiu na tela de login
                login_btn = await page.query_selector('button:has-text("Log in"), a:has-text("Log in"), a[href*="login"]')
                if login_btn or "auth" in page.url or "login" in page.url:
                    SESSION_FILE.unlink(missing_ok=True)
                    raise ChatGPTError("Sessão expirada. Refaça o login via /login/start.", status_code=401)
                raise

            prev_text = await _get_latest_assistant_text(page)

            # Digitar prompt e enviar (usando fill/eval para evitar travamento com texto longo)
            try:
                await composer.fill(prompt)
            except Exception:
                await composer.click()
                await page.evaluate("""([el, text]) => {
                    el.innerText = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }""", [composer, prompt])

            await asyncio.sleep(0.5)

            send_btn = await page.query_selector('button[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Enviar"], button[data-testid="fruitjuice-send-button"]')
            if send_btn and await send_btn.is_enabled():
                await send_btn.click()
            else:
                await composer.press("Enter")

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
