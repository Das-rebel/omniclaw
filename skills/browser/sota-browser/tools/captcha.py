"""
SOTA Browser — Local CAPTCHA Solver Tool

Open-source, self-hosted CAPTCHA solving using local browsers.
No paid API required — uses Playwright + free speech-to-text.

Supports:
- Cloudflare Turnstile (local browser solving)
- reCAPTCHA v2 (audio challenge + free STT)
- Simple image CAPTCHAs (Pillow OCR)
- IUAM (Under Attack Mode) cookies

Based on D3-vin/Turnstile-Solver-NEW architecture.

Usage:
    # Start local solver server
    python -m tools.captcha --server --port 8765

    # Or use tools directly after connecting to browser:
    solver = LocalCaptchaSolver(manager)
    result = await solver.solve_turnstile(page_url)
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("sota-browser.captcha")

SCHEMAS = [
    {
        "name": "captcha_solve_turnstile",
        "description": "Solve Cloudflare Turnstile CAPTCHA locally using a stealth browser. "
                       "No paid API required — uses Playwright to click through the challenge. "
                       "Navigate to the Turnstile page first, then call this tool.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "page_url": {
                    "type": "string",
                    "description": "URL of the page containing the Turnstile challenge"
                },
                "site_key": {
                    "type": "string",
                    "description": "Turnstile sitekey (data-sitekey attribute). Auto-detected if not provided."
                },
                "timeout": {
                    "type": "number",
                    "default": 30,
                    "description": "Max seconds to wait for solution"
                }
            }
        }
    },
    {
        "name": "captcha_solve_recaptcha_v2",
        "description": "Solve reCAPTCHA v2 using the audio challenge method. "
                       "Plays audio, records it, transcribes with free speech-to-text (CMU Sphinx or vosk). "
                       "No paid service needed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "page_url": {
                    "type": "string",
                    "description": "URL of the page with reCAPTCHA v2"
                },
                "site_key": {
                    "type": "string",
                    "description": "reCAPTCHA sitekey. Auto-detected if not provided."
                }
            }
        }
    },
    {
        "name": "captcha_check_status",
        "description": "Check if a CAPTCHA challenge is currently visible on the page. "
                       "Returns the detected CAPTCHA type and sitekey.",
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "captcha_start_solver_server",
        "description": "Start a local CAPTCHA solver REST API server. "
                       "The server listens on a port and accepts solving requests. "
                       "Run this in background, then use captcha_solve_remote to submit jobs.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "port": {
                    "type": "number",
                    "default": 8765,
                    "description": "Port for the solver server"
                },
                "browser": {
                    "type": "string",
                    "default": "chromium",
                    "description": "Browser to use: chromium, firefox, webkit"
                },
                "headless": {
                    "type": "boolean",
                    "default": True,
                    "description": "Run browser in headless mode"
                }
            }
        }
    },
    {
        "name": "botright_solve_captcha",
        "description": "Solve CAPTCHA using Botright's built-in solver. "
                       "FREE solving - no external API needed. "
                       "Supports: reCaptcha (~50-80%), hCaptcha (~90%), GeeTest (~100% for sliders). "
                       "Requires: pip install botright && BrowserManager(use_botright=True).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "captcha_type": {
                    "type": "string",
                    "enum": ["recaptcha", "hcaptcha", "geetest"],
                    "default": "recaptcha",
                    "description": "Type of CAPTCHA to solve"
                }
            }
        }
    }
]


# ---------------------------------------------------------------------------
# Local CAPTCHA Solver
# ---------------------------------------------------------------------------

class LocalCaptchaSolver:
    """
    Self-hosted CAPTCHA solver using Playwright browsers.

    No external paid API needed — solves locally using:
    - Turnstile: Click-through with stealth browser
    - reCAPTCHA v2: Audio challenge + free STT (CMU Sphinx/vosk)
    - Simple CAPTCHAs: Pillow OCR
    """

    def __init__(self, manager=None, browser_type: str = "chromium"):
        self.manager = manager
        self.browser_type = browser_type
        self._browser = None
        self._context = None
        self._page = None

    async def start_browser(self, headless: bool = True) -> bool:
        """Start a dedicated solving browser."""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            return False

        self._playwright = await async_playwright().start()
        self._browser = await getattr(self._playwright, self.browser_type).launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ]
        )
        self._context = await self._browser.new_context(
            viewport={"width": 800, "height": 600},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
            )
        )
        self._page = await self._context.new_page()
        return True

    async def stop_browser(self):
        """Stop the solving browser."""
        if self._page:
            await self._page.close()
        if self._context:
            await self._context.close()
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()

    async def solve_turnstile(self, page_url: str, site_key: str = None,
                             timeout: int = 30) -> Dict[str, Any]:
        """
        Solve Cloudflare Turnstile by navigating to page and clicking through challenge.

        Returns dict with:
        - success: bool
        - token: str (Turnstile token)
        - error: str (if failed)
        """
        if not self._page:
            if not await self.start_browser():
                return {"success": False, "error": "Failed to start browser"}

        try:
            # Navigate to page
            await self._page.goto(page_url, wait_until="domcontentloaded", timeout=timeout * 1000)
            await asyncio.sleep(2)

            # Auto-detect sitekey if not provided
            if not site_key:
                site_key = await self._page.evaluate("""
                    () => {
                        const el = document.querySelector('[data-sitekey]') ||
                                   document.querySelector('.cf-turnstile') ||
                                   document.querySelector('iframe[src*="challenges.cloudflare.com"]');
                        return el ? el.getAttribute('data-sitekey') : null;
                    }
                """)

            # Find and click Turnstile checkbox
            turnstile_frame = None
            for frame in self._page.frames:
                if "challenges.cloudflare.com" in frame.url:
                    turnstile_frame = frame
                    break

            if turnstile_frame:
                # Try clicking the challenge
                try:
                    # Find the turnstile container and click it
                    await self._page.evaluate("""
                        () => {
                            const container = document.querySelector('.cf-turnstile') ||
                                            document.querySelector('#turnstile-wrapper');
                            if (container) container.scrollIntoView();
                        }
                    """)
                    await asyncio.sleep(1)

                    # Click the iframe or challenge button
                    challenge_clicked = await turnstile_frame.evaluate("""
                        () => {
                            // Find the challenge form
                            const label = document.querySelector('label');
                            if (label) { label.click(); return true; }
                            // Or find the checkbox
                            const input = document.querySelector('input[type="checkbox"]');
                            if (input) { input.click(); return true; }
                            return false;
                        }
                    """)
                    if challenge_clicked:
                        await asyncio.sleep(5)

                except Exception as e:
                    pass

            # Wait for Turnstile to complete
            start_time = time.time()
            token = None

            while time.time() - start_time < timeout:
                # Check for success token in page
                token = await self._page.evaluate("""
                    () => {
                        // Check for Turnstile success
                        const input = document.querySelector('input[name="cf-turnstile-response"]');
                        if (input) return input.value;

                        // Check for cloudflare success cookie
                        const cookies = document.cookie.split(';');
                        for (let c of cookies) {
                            if (c.trim().startsWith('cf_clearance=')) {
                                return 'cookie:' + c.trim();
                            }
                        }
                        return null;
                    }
                """)

                if token and token.startswith('cookie:'):
                    # Got cf_clearance cookie
                    return {
                        "success": True,
                        "token": token,
                        "type": "cf_clearance",
                        "duration": round(time.time() - start_time, 2)
                    }
                elif token and len(token) > 50:
                    # Got response token
                    return {
                        "success": True,
                        "token": token,
                        "type": "turnstile_token",
                        "duration": round(time.time() - start_time, 2)
                    }

                await asyncio.sleep(1)

            return {"success": False, "error": "Timeout waiting for Turnstile solution"}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def solve_recaptcha_v2(self, page_url: str, site_key: str = None) -> Dict[str, Any]:
        """
        Solve reCAPTCHA v2 using audio challenge + free speech-to-text.

        Uses CMU Sphinx or vosk for free local transcription.
        Falls back to requiring manual solution if STT not available.
        """
        if not self._page:
            if not await self.start_browser():
                return {"success": False, "error": "Failed to start browser"}

        try:
            await self._page.goto(page_url, wait_until="domcontentloaded", timeout=30000)

            # Auto-detect sitekey
            if not site_key:
                site_key = await self._page.evaluate("""
                    () => {
                        const el = document.querySelector('[data-sitekey]');
                        return el ? el.getAttribute('data-sitekey') : null;
                    }
                """)

            # Find reCAPTCHA iframe
            captcha_frame = None
            for frame in self._page.frames:
                if "google.com/recaptcha" in frame.url:
                    captcha_frame = frame
                    break

            if not captcha_frame:
                return {"success": False, "error": "reCAPTCHA frame not found"}

            # Click on reCAPTCHA to activate audio challenge
            try:
                await captcha_frame.click(".rc-doscaptcha-header")
                await asyncio.sleep(2)

                # Click audio challenge button
                audio_button = await captcha_frame.query_selector("#recaptcha-audio-button")
                if audio_button:
                    await audio_button.click()
                    await asyncio.sleep(2)
            except Exception as e:
                return {"success": False, "error": f"Failed to activate audio challenge: {e}"}

            # Get audio src URL
            audio_src = await captcha_frame.evaluate("""
                () => {
                    const audio = document.querySelector("#audio-source");
                    return audio ? audio.src : null;
                }
            """)

            if not audio_src:
                return {"success": False, "error": "Audio challenge not available"}

            # Download and transcribe audio
            audio_path = f"/tmp/captcha_audio_{uuid.uuid4().hex[:8]}.mp3"

            # Try to download audio
            try:
                resp = await self._page.request.get(audio_src)
                with open(audio_path, "wb") as f:
                    f.write(await resp.body())
            except Exception:
                return {"success": False, "error": "Failed to download audio challenge"}

            # Try free STT engines
            transcript = await self._transcribe_audio(audio_path)

            # Cleanup
            try:
                os.remove(audio_path)
            except Exception:
                pass

            if not transcript:
                return {
                    "success": False,
                    "error": "Could not transcribe audio. Install sphinxbase/pocketsphinx or vosk for free STT: "
                             "pip install pocketsphinx OR pip install vosk"
                }

            # Enter the transcription
            await captcha_frame.fill("#audio-response", transcript)
            await asyncio.sleep(1)

            # Click verify
            try:
                verify_btn = await captcha_frame.query_selector("#recaptcha-verify-button")
                if verify_btn:
                    await verify_btn.click()
                    await asyncio.sleep(3)
            except Exception:
                pass

            # Get the token
            token = await self._page.evaluate("""
                () => {
                    const textarea = document.querySelector('#g-recaptcha-response');
                    return textarea ? textarea.value : null;
                }
            """)

            if token:
                return {"success": True, "token": token}
            else:
                return {"success": False, "error": "Verification failed, try again"}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _transcribe_audio(self, audio_path: str) -> Optional[str]:
        """Transcribe audio file using free local STT."""

        # Try pocketsphinx first (CMU Sphinx, completely free)
        try:
            import pocketsphinx
            from pocketsphinx import AudioFile

            # Convert mp3 to wav using pydub
            try:
                from pydub import AudioSegment
                audio = AudioSegment.from_mp3(audio_path)
                wav_path = audio_path.replace(".mp3", ".wav")
                audio.export(wav_path, format="wav")
            except Exception:
                # ffmpeg might not be installed, try direct approach
                return None

            audio = AudioFile(audio_file=wav_path)
            text = ""
            try:
                for phrase in audio:
                    text += phrase + " "
                text = text.strip()
            except Exception:
                pass

            try:
                os.remove(wav_path)
            except Exception:
                pass

            if text:
                return text

        except ImportError:
            pass

        # Try vosk (also free, better accuracy)
        try:
            from vosk import Model, KaldiRecognizer
            import json as json_lib
            import wave

            # Convert to wav if needed
            try:
                from pydub import AudioSegment
                audio = AudioSegment.from_mp3(audio_path)
                wav_path = audio_path.replace(".mp3", ".wav")
                audio.export(wav_path, format="wav")
            except Exception:
                return None

            # Load model (need to download vosk model first)
            model = Model("/tmp/vosk-model-small-en-us")
            rec = KaldiRecognizer(model, 16000)

            with wave.open(wav_path, "rb") as wf:
                while True:
                    data = wf.readframes(4000)
                    if not data:
                        break
                    rec.AcceptWaveform(data)

            result = json_lib.loads(rec.FinalResult())
            try:
                os.remove(wav_path)
            except Exception:
                pass

            return result.get("text", "").strip()

        except ImportError:
            pass
        except Exception as e:
            logger.warning(f"Vosk transcription failed: {e}")

        return None


class BotrightCaptchaSolver:
    """
    CAPTCHA solver using Botright's built-in solving capabilities.


    Botright provides free CAPTCHA solving without external APIs:
    - reCaptcha: ~50-80% success rate
    - hCaptcha: ~90% success rate
    - GeeTest v3/v4: ~100% for slider/puzzle types

    Usage:
        solver = BotrightCaptchaSolver()
        result = await solver.solve(page, "recaptcha")
    """

    def __init__(self, page=None):
        self.page = page

    async def solve(self, captcha_type: str = "recaptcha") -> Dict[str, Any]:
        """
        Solve CAPTCHA using Botright's built-in methods.

        Args:
            page: Playwright page with CAPTCHA element
            captcha_type: "recaptcha", "hcaptcha", or "geetest"

        Returns:
            dict with success status and token/solution
        """
        if not self.page:
            return {"success": False, "error": "No page provided"}

        try:
            if captcha_type == "recaptcha":
                return await self._solve_recaptcha()
            elif captcha_type == "hcaptcha":
                return await self._solve_hcaptcha()
            elif captcha_type == "geetest":
                return await self._solve_geetest()
            else:
                return {"success": False, "error": f"Unknown CAPTCHA type: {captcha_type}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _solve_recaptcha(self) -> Dict[str, Any]:
        """Solve reCAPTCHA using Botright's solve_recaptcha method."""
        try:
            # Check if we're in a Botright context
            if hasattr(self.page, 'solve_recaptcha'):
                token = await self.page.solve_recaptcha()
                if token:
                    return {"success": True, "token": token, "type": "recaptcha"}
            # Fallback: try standard approach
            return {"success": False, "error": "Botright solve_recaptcha not available on this page"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _solve_hcaptcha(self) -> Dict[str, Any]:
        """Solve hCaptcha using Botright's solve_hcaptcha method."""
        try:
            if hasattr(self.page, 'solve_hcaptcha'):
                token = await self.page.solve_hcaptcha()
                if token:
                    return {"success": True, "token": token, "type": "hcaptcha"}
            return {"success": False, "error": "Botright solve_hcaptcha not available on this page"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _solve_geetest(self, mode: str = "canny") -> Dict[str, Any]:
        """Solve GeeTest using Botright's solve_geetest method."""
        try:
            if hasattr(self.page, 'solve_geetest'):
                token = await self.page.solve_geetest(mode=mode)
                if token:
                    return {"success": True, "token": token, "type": "geetest"}
            return {"success": False, "error": "Botright solve_geetest not available on this page"}
        except Exception as e:
            return {"success": False, "error": str(e)}


async def botright_solve_captcha(
    captcha_type: str = "recaptcha",
    manager=None,
    **kwargs
) -> Dict[str, Any]:
    """
    Solve CAPTCHA using Botright's built-in solving.

    Botright provides free CAPTCHA solving:
    - reCaptcha: ~50-80% success
    - hCaptcha: ~90% success
    - GeeTest v3/v4: ~100% for sliders

    Requires:
    - Botright installed: pip install botright
    - BrowserManager(use_botright=True) for initial launch
    """
    if not manager:
        return {"error": "No browser manager available"}

    # Check if using Botright
    if not getattr(manager, '_using_botright', False):
        return {
            "error": "Botright not active. Launch browser with use_botright=True "
                     "or cmd-headless --botright flag"
        }

    # Get the primary page
    page = manager.get_primary_page()
    if not page:
        return {"error": "No active page"}

    solver = BotrightCaptchaSolver(page)
    return await solver.solve(captcha_type)


async def captcha_solve_turnstile(
    page_url: str,
    site_key: str = None,
    timeout: int = 30,
    manager = None,
    **kwargs
) -> Dict[str, Any]:
    """Solve Turnstile CAPTCHA using local browser."""
    solver = LocalCaptchaSolver(manager)
    try:
        result = await solver.solve_turnstile(page_url, site_key, timeout)
        return result
    finally:
        await solver.stop_browser()


async def captcha_solve_recaptcha_v2(
    page_url: str,
    site_key: str = None,
    manager = None,
    **kwargs
) -> Dict[str, Any]:
    """Solve reCAPTCHA v2 using audio + free STT."""
    solver = LocalCaptchaSolver(manager)
    try:
        result = await solver.solve_recaptcha_v2(page_url, site_key)
        return result
    finally:
        await solver.stop_browser()


async def captcha_check_status(manager=None, **kwargs) -> Dict[str, Any]:
    """Check if CAPTCHA challenge is visible on the current page."""
    if not manager:
        return {"error": "No browser manager available"}

    page = manager.get_primary_page()
    if not page:
        return {"error": "No active page"}

    try:
        # Check for Turnstile
        turnstile = await page.evaluate("""
            () => {
                const el = document.querySelector('.cf-turnstile');
                return el ? { type: 'turnstile', visible: el.offsetParent !== null } : null;
            }
        """)

        # Check for reCAPTCHA
        recaptcha = await page.evaluate("""
            () => {
                const el = document.querySelector('.g-recaptcha');
                return el ? { type: 'recaptcha', visible: el.offsetParent !== null } : null;
            }
        """)

        # Check for hCaptcha
        hcaptcha = await page.evaluate("""
            () => {
                const el = document.querySelector('.h-captcha');
                return el ? { type: 'hcaptcha', visible: el.offsetParent !== null } : null;
            }
        """)

        # Get sitekey
        sitekey = await page.evaluate("""
            () => {
                const el = document.querySelector('[data-sitekey]');
                return el ? el.getAttribute('data-sitekey') : null;
            }
        """)

        result = {"sitekey": sitekey, "challenges": []}
        if turnstile:
            result["challenges"].append(turnstile)
        if recaptcha:
            result["challenges"].append(recaptcha)
        if hcaptcha:
            result["challenges"].append(hcaptcha)

        result["has_captcha"] = len(result["challenges"]) > 0
        return result

    except Exception as e:
        return {"error": str(e)}


async def captcha_start_solver_server(
    port: int = 8765,
    browser: str = "chromium",
    headless: bool = True,
    **kwargs
) -> Dict[str, Any]:
    """Start local CAPTCHA solver REST API server."""
    import aiohttp

    solver = LocalCaptchaSolver(browser_type=browser)
    started = await solver.start_browser(headless=headless)
    if not started:
        return {"error": "Failed to start browser"}

    app = aiohttp.web.Application()

    async def handle_turnstile(request):
        data = await request.json()
        result = await solver.solve_turnstile(
            page_url=data.get("page_url"),
            site_key=data.get("site_key"),
            timeout=data.get("timeout", 30)
        )
        return aiohttp.web.json_response(result)

    async def handle_recaptcha(request):
        data = await request.json()
        result = await solver.solve_recaptcha_v2(
            page_url=data.get("page_url"),
            site_key=data.get("site_key")
        )
        return aiohttp.web.json_response(result)

    app.router.add_post("/turnstile", handle_turnstile)
    app.router.add_post("/recaptcha", handle_recaptcha)

    runner = aiohttp.web.AppRunner(app)
    await runner.setup()
    site = aiohttp.web.TCPSite(runner, "localhost", port)
    await site.start()

    return {
        "status": "started",
        "port": port,
        "endpoints": {
            "turnstile": f"http://localhost:{port}/turnstile",
            "recaptcha": f"http://localhost:{port}/recaptcha"
        }
    }


def register(manager) -> Dict[str, Callable]:
    """Register CAPTCHA solving tools."""

    async def handle_solve_turnstile(args: Dict[str, Any]) -> Dict[str, Any]:
        return await captcha_solve_turnstile(
            page_url=args["page_url"],
            site_key=args.get("site_key"),
            timeout=args.get("timeout", 30),
            manager=manager
        )

    async def handle_solve_recaptcha(args: Dict[str, Any]) -> Dict[str, Any]:
        return await captcha_solve_recaptcha_v2(
            page_url=args["page_url"],
            site_key=args.get("site_key"),
            manager=manager
        )

    async def handle_check_status(args: Dict[str, Any]) -> Dict[str, Any]:
        return await captcha_check_status(manager=manager)

    async def handle_start_server(args: Dict[str, Any]) -> Dict[str, Any]:
        return await captcha_start_solver_server(
            port=args.get("port", 8765),
            browser=args.get("browser", "chromium"),
            headless=args.get("headless", True)
        )

    async def handle_botright_solve(args: Dict[str, Any]) -> Dict[str, Any]:
        return await botright_solve_captcha(
            captcha_type=args.get("captcha_type", "recaptcha"),
            manager=manager
        )

    return {
        "captcha_solve_turnstile": handle_solve_turnstile,
        "captcha_solve_recaptcha_v2": handle_solve_recaptcha,
        "captcha_check_status": handle_check_status,
        "captcha_start_solver_server": handle_start_server,
        "botright_solve_captcha": handle_botright_solve,
    }
