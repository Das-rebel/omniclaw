"""
SOTA Browser MCP Server — BrowserManager

Core browser lifecycle and page operations.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import sys
import time
import uuid
from typing import Any, Dict, List, Optional

from config import DEFAULT_TIMEOUT, DEFAULT_VIEWPORT, FAST_WAIT, USER_AGENT

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

try:
    from form_engine import (
        ResumeParser,
        FormScanner,
        FormFiller,
    )
    FORM_ENGINE_AVAILABLE = True
except ImportError:
    FORM_ENGINE_AVAILABLE = False

logger = logging.getLogger("sota-browser.manager")


class BrowserManager:
    """Manages Playwright browser instances, sessions, tabs, and all page operations."""

    def __init__(self):
        self._playwright = None
        self._browser = None
        self._using_existing = False
        self.sessions: Dict[str, dict] = {}
        self.contexts: Dict[str, Any] = {}
        self.pages: Dict[str, dict] = {}
        self._lock = asyncio.Lock()
        self._console_capture_init: Dict[str, bool] = {}
        self._pending_dialogs: Dict[str, Any] = {}
        self._network_logs: Dict[str, list] = {}
        self._downloads: Dict[str, dict] = {}
        self._mocked_routes: Dict[str, list] = {}

    # ------------------------------------------------------------------
    # Browser lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if not PLAYWRIGHT_AVAILABLE:
            print("ERROR: playwright not installed", file=sys.stderr)
            sys.exit(1)

        self._playwright = await async_playwright().start()

        cdp_url = os.environ.get("CHROME_CDP_URL", "")
        self._using_existing = False

        if cdp_url:
            print(f"[sota-browser] Attempting Chrome CDP connection: {cdp_url[:50]}...", file=sys.stderr)
            try:
                self._browser = await self._playwright.chromium.connect_over_cdp(cdp_url, timeout=20000)
                self._using_existing = True
                print("[sota-browser] Connected to existing Chrome via CDP!", file=sys.stderr)
            except Exception as e:
                print(f"[sota-browser] CDP failed ({str(e)[:60]}...), falling back", file=sys.stderr)
                await self._launch_browser()
        else:
            await self._launch_browser()

    async def _launch_browser(self) -> None:
        sock_path = f"/tmp/sota-b-{os.getpid()}.sock"
        headless = os.environ.get("BH_HEADLESS", "true").lower() != "false"
        stealth = os.environ.get("BH_STEALTH", "true").lower() != "false"

        # Base args
        args = [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            f"--devtools-file-based-cdp-socket-name={sock_path}",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-default-apps",
            "--disable-sync",
            "--no-first-run",
        ]

        # Full stealth args (from browser-use @ 96K stars)
        if stealth:
            args.extend([
                "--disable-infobars",
                "--disable-breakpad",
                "--disable-component-extensions-with-background-pages",
                "--disable-client-side-phishing-detection",
                "--disable-component-update",
                "--disable-ipc-flooding-protection",
                "--disable-hang-monitor",
                "--disable-prompt-on-repost",
                "--metrics-recording-only",
                "--enable-features=NetworkService,NetworkServiceInProcess",
                "--password-store=basic",
                "--use-mock-keychain",
            ])

        self._browser = await self._playwright.chromium.launch(
            headless=headless,
            args=args,
        )
        self._using_existing = False
        self._stealth_enabled = stealth
        print(f"[sota-browser] Browser ready (fresh launch, stealth={'on' if stealth else 'off'})", file=sys.stderr)

    async def shutdown(self) -> None:
        # Save persistent profiles before shutting down
        for sid, session in list(self.sessions.items()):
            profile_dir = session.get("profile_dir")
            if profile_dir and sid in self.contexts:
                try:
                    state_path = os.path.join(profile_dir, "state.json")
                    await self.contexts[sid].storage_state(path=state_path)
                    print(f"[sota-browser] Saved profile: {state_path}", file=sys.stderr)
                except Exception as e:
                    print(f"[sota-browser] Profile save failed: {e}", file=sys.stderr)

        for p in self.pages.values():
            try:
                await p["page"].close()
            except Exception:
                pass
        for c in self.contexts.values():
            try:
                await c.close()
            except Exception:
                pass
        if self._browser:
            try:
                await self._browser.close()
            except Exception:
                pass
        if self._playwright:
            await self._playwright.stop()

    # ------------------------------------------------------------------
    # Session / Tab management
    # ------------------------------------------------------------------

    async def create_session(self, user_id: str, **options) -> dict:
        session_id = str(uuid.uuid4())

        if getattr(self, "_using_existing", False):
            existing_contexts = self._browser.contexts
            if existing_contexts:
                context = existing_contexts[0]
                self.sessions[session_id] = {"user_id": user_id, "context": context}
                self.contexts[session_id] = context
                return {
                    "id": session_id,
                    "user_id": user_id,
                    "created": True,
                    "existing_browser": True,
                    "note": "Using existing Chrome context",
                }

        # Profile persistence — use a named directory if provided
        profile_dir = options.get("profile_dir")
        context_kwargs: dict = {
            "viewport": {"width": options.get("width") or 1280, "height": options.get("height") or 720},
            "user_agent": options.get("user_agent") or USER_AGENT,
            "locale": "en-US",
            "timezone_id": "America/New_York",
        }

        if profile_dir:
            # Persist browser profile across sessions
            os.makedirs(profile_dir, exist_ok=True)
            # Copy cookies/storage files if they exist
            context_kwargs["storage_state"] = os.path.join(profile_dir, "state.json")
            if os.path.exists(context_kwargs["storage_state"]):
                print(f"[sota-browser] Loading persistent profile: {profile_dir}", file=sys.stderr)

        context = await self._browser.new_context(**context_kwargs)

        # Apply playwright-stealth evasions (anti-detection)
        if getattr(self, "_stealth_enabled", True):
            try:
                from playwright_stealth import Stealth
                stealth_obj = Stealth(
                    # Override platform to MacIntel (we're on macOS M1/M2)
                    navigator_platform_override="MacIntel",
                    # Override languages
                    navigator_languages_override=("en-US", "en"),
                    # Spoof WebGL GPU info
                    webgl_vendor_override="Intel Inc.",
                    webgl_renderer_override="Intel Iris OpenGL Engine",
                    # Disable chrome.runtime (causes false positives)
                    chrome_runtime=False,
                    # Disable hairline (Modernizr offsetHeight) — can interfere
                    hairline=False,
                    # Disable iframe.contentWindow (breaks some sites)
                    iframe_content_window=False,
                )
                await stealth_obj.apply_stealth_async(context)
                print("[sota-browser] 🥷 Stealth evasions applied", file=sys.stderr)
            except ImportError:
                # Fallback: minimal evasion
                pass
            except Exception as e:
                print(f"[sota-browser] Stealth warning: {e}", file=sys.stderr)

        # Manual navigator.webdriver fallback (belt-and-suspenders)
        try:
            await context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => false});"
            )
        except Exception:
            pass

        self.sessions[session_id] = {"user_id": user_id, "context": context, "profile_dir": profile_dir}
        self.contexts[session_id] = context
        return {
            "id": session_id,
            "user_id": user_id,
            "created": True,
            "existing_browser": False,
            "stealth": getattr(self, "_stealth_enabled", True),
            "profile_dir": profile_dir,
        }

    async def create_tab(self, session_id: str, url: str = None) -> dict:
        if session_id not in self.contexts:
            return {"error": "Session not found"}

        context = self.contexts[session_id]
        page = await context.new_page()
        tab_id = str(uuid.uuid4())
        self.pages[tab_id] = {"page": page, "session_id": session_id}

        # Set up dialog handler
        self._setup_dialog_handler(page, tab_id)

        if url:
            await page.goto(url, wait_until="commit", timeout=10000)

        title = ""
        if page.url != "about:blank":
            try:
                title = await page.title()
            except Exception:
                pass

        return {"id": tab_id, "session_id": session_id, "url": page.url, "title": title}

    async def list_tabs(self, session_id: str) -> list:
        if session_id not in self.contexts:
            return []
        result = []
        for p in self.contexts[session_id].pages:
            try:
                title = await p.title() if p else "Unknown"
            except Exception:
                title = "Unknown"
            result.append({"url": p.url if p else "", "title": title})
        return result

    async def close_tab(self, tab_id: str) -> dict:
        if tab_id in self.pages:
            try:
                await self.pages[tab_id]["page"].close()
            except Exception:
                pass
            del self.pages[tab_id]
        return {"success": True}

    async def close_session(self, session_id: str) -> dict:
        for tid in list(self.pages.keys()):
            if self.pages[tid]["session_id"] == session_id:
                try:
                    await self.pages[tid]["page"].close()
                except Exception:
                    pass
                del self.pages[tid]
        if session_id in self.contexts:
            try:
                await self.contexts[session_id].close()
            except Exception:
                pass
            del self.contexts[session_id]
        if session_id in self.sessions:
            del self.sessions[session_id]
        return {"success": True}

    async def switch_tab(self, tab_id: str, tab_index: int) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        session_id = self.pages[tab_id]["session_id"]
        context = self.contexts.get(session_id)
        if not context:
            return {"error": "Context not found"}
        pages = context.pages
        if tab_index < 0 or tab_index >= len(pages):
            return {"error": f"Tab index {tab_index} out of range (0-{len(pages)-1})"}
        new_page = pages[tab_index]
        new_tab_id = str(uuid.uuid4())
        self.pages[new_tab_id] = {"page": new_page, "session_id": session_id}
        del self.pages[tab_id]
        try:
            title = await new_page.title()
        except Exception:
            title = ""
        return {"success": True, "new_tab_id": new_tab_id, "url": new_page.url, "title": title}

    def info(self) -> dict:
        return {"sessions": len(self.sessions), "tabs": len(self.pages)}

    # ------------------------------------------------------------------
    # Navigation
    # ------------------------------------------------------------------

    async def navigate(self, tab_id: str, url: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            response = await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            return {
                "url": page.url,
                "title": await page.title(),
                "status": response.status if response else 0,
            }
        except Exception as e:
            return {"error": str(e), "url": url}

    async def go_back(self, tab_id: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            await page.go_back(wait_until="commit", timeout=10000)
            return {"success": True, "url": page.url, "title": await page.title()}
        except Exception as e:
            return {"error": str(e)}

    async def go_forward(self, tab_id: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            await page.go_forward(wait_until="commit", timeout=10000)
            return {"success": True, "url": page.url, "title": await page.title()}
        except Exception as e:
            return {"error": str(e)}

    async def reload(self, tab_id: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            response = await page.reload(wait_until="domcontentloaded", timeout=10000)
            return {
                "success": True,
                "url": page.url,
                "title": await page.title(),
                "status": response.status if response else 0,
            }
        except Exception as e:
            return {"error": str(e)}

    async def wait_for_navigation(self, tab_id: str, url_pattern: str = None, timeout: float = 30000) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            if url_pattern:
                await page.wait_for_url(url_pattern, timeout=timeout)
            else:
                await page.wait_for_load_state("domcontentloaded", timeout=timeout)
            return {"success": True, "url": page.url}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Interaction
    # ------------------------------------------------------------------

    async def click(self, tab_id: str, selector: str = None, ref: str = None,
                    x: float = None, y: float = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            if x is not None and y is not None:
                await page.mouse.click(x, y)
            elif selector:
                await page.click(selector, timeout=5000)
            elif ref:
                data = await self.get_snapshot(tab_id)
                if ref in data.get("elements", {}):
                    name = data["elements"][ref]["name"]
                    try:
                        await page.get_by_text(name, exact=False).first.click(timeout=3000)
                    except Exception:
                        await page.locator(f"text={name}").first.click(timeout=3000)
            else:
                return {"error": "Must specify selector, ref, or coordinates"}
            await page.wait_for_load_state("commit", timeout=5000)
            return {"success": True, "url": page.url}
        except Exception as e:
            return {"error": str(e)}

    async def type_text(self, tab_id: str, text: str, selector: str = None,
                        ref: str = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            if ref:
                data = await self.get_snapshot(tab_id)
                if ref in data.get("elements", {}):
                    name = data["elements"][ref]["name"]
                    try:
                        el = page.get_by_text(name, exact=False).first
                        await el.click(timeout=3000)
                        await el.fill(text)
                    except Exception:
                        await page.locator(f"text={name}").first.fill(text)
            elif selector:
                await page.fill(selector, text)
            else:
                await page.keyboard.type(text, delay=50)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    async def press_key(self, tab_id: str, key: str, modifiers: int = 0) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        try:
            await self.pages[tab_id]["page"].keyboard.press(key)
            return {"success": True, "key": key}
        except Exception as e:
            return {"error": str(e)}

    async def scroll(self, tab_id: str, dx: float = 0, dy: float = -300) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        await self.pages[tab_id]["page"].mouse.wheel(int(dx), int(dy))
        await asyncio.sleep(FAST_WAIT)
        return {"success": True}

    async def hover(self, tab_id: str, selector: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            await page.hover(selector, timeout=5000)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    async def drag_drop(self, tab_id: str, source: str, target: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            await page.drag_and_drop(source, target, timeout=5000)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    async def select_option(self, tab_id: str, selector: str, value: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            values = await page.select_option(selector, value, timeout=5000)
            return {"success": True, "values": values}
        except Exception as e:
            return {"error": str(e)}

    async def upload_file(self, tab_id: str, selector: str, paths: list) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            await page.set_input_files(selector, paths)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Snapshot / State / HTML / Screenshot / Extract
    # ------------------------------------------------------------------

    async def get_snapshot(self, tab_id: str, include_screenshot: bool = False) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            frames_info = await page.evaluate("""() => {
                const frames = [];
                function walk(win, path) {
                    try {
                        const doc = win.document;
                        const tag = win.frameElement ? win.frameElement.tagName.toLowerCase() : 'window';
                        frames.push({
                            url: win.location.href,
                            tag: tag,
                            name: win.name || '',
                            path: path,
                            sameOrigin: win.location.origin === window.location.origin
                        });
                    } catch(e) {}
                    for (let i = 0; i < win.frames.length; i++) {
                        try { walk(win.frames[i], path + '>' + (win.frames[i].name || 'unnamed')); } catch(e) {}
                    }
                }
                walk(window, 'main');
                return frames;
            }""")

            tree_script = """
            () => {
                const tree = [], elements = {};
                let idx = 0;
                const skip = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK'];
                function walk(el, d) {
                    if (skip.includes(el.tagName)) return;
                    const tag = el.tagName.toLowerCase();
                    let role = el.getAttribute('role');
                    if (!role) {
                        const m = {'button':1,'a':1,'input':1,'select':1,'textarea':1};
                        if (m[tag]) role = tag === 'a' ? 'link' : tag;
                        else if (tag === 'p') role = 'paragraph';
                        else if (tag === 'div') role = 'generic';
                    }
                    let name = el.getAttribute('aria-label') || el.textContent?.trim().slice(0,80) || '';
                    if (name && role) {
                        tree.push({d, role, name});
                        if (name.length > 2 && idx < 200) {
                            idx++;
                            const ref = 'e' + idx;
                            elements[ref] = {role, name, tag};
                        }
                    }
                    for (const c of el.children) walk(c, d+1);
                }
                walk(document.body || document.documentElement, 0);
                return {tree, elements};
            }
            """
            data = await page.evaluate(tree_script)
            text = "\n".join([f"{'  '*n['d']}[{n['role']}] {n['name']}" for n in data["tree"]])

            result = {
                "url": page.url,
                "title": await page.title(),
                "tree": data["tree"],
                "text": text,
                "elements": data["elements"],
                "frames": frames_info,
            }

            if include_screenshot:
                result["screenshot"] = base64.b64encode(await page.screenshot()).decode()

            return result
        except Exception as e:
            return {"error": str(e)}

    async def get_state(self, tab_id: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            elements = await page.evaluate("""() => {
                const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','META','LINK','HEAD','HTML','BODY']);
                const CLICKABLE_ROLES = new Set(['button','link','input','select','textarea','menuitem','tab','checkbox','radio','switch','option']);
                const result = [];
                let idx = 0;
                function isVisible(el) {
                    if (!el.getBoundingClientRect) return false;
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
                }
                function getRole(el) {
                    const role = el.getAttribute('role');
                    if (role) return role.toLowerCase();
                    const tag = el.tagName.toLowerCase();
                    if (tag === 'a') return 'link';
                    if (tag === 'button' || tag === 'submit' || tag === 'reset') return 'button';
                    if (tag === 'input') {
                        const type = (el.type || 'text').toLowerCase();
                        if (['checkbox','radio','switch','submit','reset','button','image'].includes(type)) return type;
                        return 'input';
                    }
                    if (tag === 'select' || tag === 'textarea') return tag;
                    return null;
                }
                function getName(el) {
                    return el.getAttribute('aria-label')
                        || el.getAttribute('aria-labelledby')
                        || el.getAttribute('placeholder')
                        || el.getAttribute('name')
                        || el.id
                        || el.textContent?.trim().replace(/\\s+/g, ' ').slice(0, 80)
                        || '';
                }
                function walk(el, skipSelf) {
                    if (!skipSelf && SKIP_TAGS.has(el.tagName)) return;
                    const role = getRole(el);
                    const isClickable = role && (CLICKABLE_ROLES.has(role) || el.onclick || el.hasAttribute('ng-click') || el.hasAttribute('@click'));
                    const isEditable = role === 'input' || role === 'select' || role === 'textarea';
                    if ((isClickable || isEditable || role === 'tab') && isVisible(el)) {
                        const rect = el.getBoundingClientRect();
                        const name = getName(el);
                        if (name || isClickable) {
                            result.push({
                                index: ++idx,
                                role: role || 'unknown',
                                name: name,
                                tag: el.outerHTML.slice(0, 200),
                                x: Math.round(rect.left + rect.width / 2),
                                y: Math.round(rect.top + rect.height / 2),
                                visible: true
                            });
                        }
                    }
                    for (const c of el.children) walk(c, false);
                }
                const root = document.body || document.documentElement;
                for (const c of root.children) walk(c, false);
                return result;
            }""")
            return {"elements": elements, "count": len(elements), "url": page.url}
        except Exception as e:
            return {"error": str(e)}

    async def get_html(self, tab_id: str, selector: str = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            if selector:
                html = await page.evaluate(
                    "(sel) => { const el = document.querySelector(sel); return el ? el.outerHTML : null; }",
                    selector,
                )
                if html is None:
                    return {"error": f"Element not found: {selector}"}
                return {"html": html[:102400], "selector": selector, "truncated": len(html) > 102400}
            else:
                html = await page.content()
                return {"html": html[:102400], "selector": None, "truncated": len(html) > 102400}
        except Exception as e:
            return {"error": str(e)}

    async def screenshot(self, tab_id: str, full: bool = False) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        img = await self.pages[tab_id]["page"].screenshot(full_page=full)
        return {"base64": base64.b64encode(img).decode()}

    async def extract_images(self, tab_id: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        try:
            imgs = await self.pages[tab_id]["page"].evaluate("""() => {
                return Array.from(document.querySelectorAll('img')).map(i => ({
                    src: i.src, alt: i.alt || '',
                    width: i.naturalWidth, height: i.naturalHeight
                }));
            }""")
            return {"images": imgs, "count": len(imgs)}
        except Exception as e:
            return {"error": str(e)}

    async def extract_links(self, tab_id: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            links = await page.evaluate("""() => {
                return Array.from(document.querySelectorAll('a[href]')).map(a => ({
                    href: a.href,
                    text: (a.textContent || '').trim().slice(0, 100)
                }));
            }""")
            return {"links": links, "count": len(links)}
        except Exception as e:
            return {"error": str(e)}

    async def get_text(self, tab_id: str, selector: str = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            if selector:
                text = await page.inner_text(selector, timeout=5000)
            else:
                text = await page.inner_text("body")
            return {"text": text[:50000], "length": len(text)}
        except Exception as e:
            return {"error": str(e)}

    async def evaluate(self, tab_id: str, script: str, frame_index: int = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            if frame_index is not None:
                frames = page.frames
                if frame_index < len(frames):
                    frame = frames[frame_index]
                    result = await frame.evaluate(script)
                else:
                    return {"error": f"Frame {frame_index} not found, total frames: {len(frames)}"}
            else:
                result = await page.evaluate(script)
            return {"success": True, "result": result}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Console
    # ------------------------------------------------------------------

    async def get_console_logs(self, tab_id: str, clear: bool = False) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            if tab_id not in self._console_capture_init:
                self._console_capture_init[tab_id] = True
                await page.evaluate("""() => {
                    if (!window._pi_console_capture) {
                        window._pi_console_capture = true;
                        window._pi_logs = [];
                        const methods = ['log', 'warn', 'error', 'info', 'debug'];
                        methods.forEach(m => {
                            const orig = console[m].bind(console);
                            console[m] = (...args) => {
                                window._pi_logs.push({
                                    type: m,
                                    message: args.map(a => String(a)).join(' '),
                                    timestamp: Date.now()
                                });
                                orig(...args);
                            };
                        });
                    }
                }""")
            if clear:
                await page.evaluate("window._pi_logs = []")
            logs = await page.evaluate("window._pi_logs || []")
            return {"logs": logs, "count": len(logs)}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Frames
    # ------------------------------------------------------------------

    async def list_frames(self, tab_id: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            frames_list = []
            for i, frame in enumerate(page.frames):
                try:
                    frames_list.append({
                        "index": i,
                        "url": frame.url,
                        "name": frame.name or "",
                        "is_main": frame.is_main_frame,
                    })
                except Exception:
                    frames_list.append({"index": i, "url": "[cross-origin]", "name": "", "is_main": False})
            return {"frames": frames_list, "total": len(frames_list)}
        except Exception as e:
            return {"error": str(e)}

    async def evaluate_in_frame(self, tab_id: str, script: str,
                                 frame_selector: str = None,
                                 frame_url_contains: str = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            target_frame = None
            for frame in page.frames:
                if frame_url_contains and frame_url_contains in frame.url:
                    target_frame = frame
                    break
            if not target_frame:
                return {"error": f"Frame with URL containing '{frame_url_contains}' not found"}
            result = await target_frame.evaluate(script)
            return {"success": True, "result": result, "frame_url": target_frame.url}
        except Exception as e:
            return {"error": str(e)}

    async def get_frame_content(self, tab_id: str, frame_index: int = None,
                                 frame_url_contains: str = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            target_frame = None
            if frame_url_contains:
                for frame in page.frames:
                    if frame_url_contains in frame.url:
                        target_frame = frame
                        break
            elif frame_index is not None:
                frames = page.frames
                if frame_index < len(frames):
                    target_frame = frames[frame_index]
            else:
                return {"error": "Must specify frame_index or frame_url_contains"}
            if not target_frame:
                return {"error": "Frame not found"}
            content = await target_frame.content()
            return {"content": content[:50000], "url": target_frame.url, "length": len(content)}
        except Exception as e:
            return {"error": str(e)}

    async def inject_into_all_frames(self, tab_id: str, script: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        results = []
        for i, frame in enumerate(page.frames):
            try:
                result = await frame.evaluate(script)
                results.append({"frame_index": i, "url": frame.url, "success": True, "result": result})
            except Exception as e:
                results.append({
                    "frame_index": i,
                    "url": frame.url[:50] if frame.url else "unknown",
                    "success": False,
                    "error": str(e),
                })
        return {"results": results, "total_frames": len(results)}

    # ------------------------------------------------------------------
    # Cookies
    # ------------------------------------------------------------------

    async def import_cookies(self, session_id: str, cookies: list) -> dict:
        if session_id not in self.contexts:
            return {"error": "Session not found"}
        sanitized = [
            {
                "name": c.get("name", ""),
                "value": c.get("value", ""),
                "domain": c.get("domain", ""),
                "path": c.get("path", "/"),
                "secure": bool(c.get("secure", False)),
            }
            for c in cookies
        ]
        await self.contexts[session_id].add_cookies(sanitized)
        return {"success": True, "count": len(sanitized)}

    async def export_cookies(self, session_id: str) -> dict:
        if session_id not in self.contexts:
            return {"error": "Session not found"}
        cookies = await self.contexts[session_id].cookies()
        return {"cookies": cookies, "count": len(cookies)}

    async def clear_cookies(self, session_id: str) -> dict:
        if session_id not in self.contexts:
            return {"error": "Session not found"}
        await self.contexts[session_id].clear_cookies()
        return {"success": True}

    # ------------------------------------------------------------------
    # Viewport
    # ------------------------------------------------------------------

    async def set_viewport(self, tab_id: str, width: int, height: int) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        await self.pages[tab_id]["page"].set_viewport_size({"width": width, "height": height})
        return {"success": True, "width": width, "height": height}

    # ------------------------------------------------------------------
    # Wait primitives
    # ------------------------------------------------------------------

    async def wait(self, tab_id: str = None, seconds: float = 1.0) -> dict:
        await asyncio.sleep(seconds)
        return {"success": True, "waited": seconds}

    async def wait_for_selector(self, tab_id: str, selector: str,
                                 state: str = "visible", timeout: float = 30000) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            el = await page.wait_for_selector(selector, state=state, timeout=timeout)
            return {"success": True, "found": el is not None}
        except Exception as e:
            return {"error": str(e)}

    async def wait_for_network_idle(self, tab_id: str, timeout: float = 30000) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            await page.wait_for_load_state("networkidle", timeout=timeout)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # HTTP tools
    # ------------------------------------------------------------------

    async def http_get(self, url: str, headers: dict = None, timeout: float = 10.0) -> dict:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(url, headers=headers or {})
                return {
                    "url": str(resp.url),
                    "status": resp.status_code,
                    "headers": dict(resp.headers),
                    "content": resp.text[:30000],
                }
        except Exception as e:
            return {"error": str(e)}

    async def http_post(self, url: str, data: str = None, json: dict = None,
                        headers: dict = None, timeout: float = 10.0) -> dict:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, data=data, json=json, headers=headers or {})
                return {
                    "url": str(resp.url),
                    "status": resp.status_code,
                    "headers": dict(resp.headers),
                    "content": resp.text[:30000],
                }
        except Exception as e:
            return {"error": str(e)}

    async def http_put(self, url: str, data: str = None, json: dict = None,
                       headers: dict = None, timeout: float = 10.0) -> dict:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.put(url, data=data, json=json, headers=headers or {})
                return {
                    "url": str(resp.url),
                    "status": resp.status_code,
                    "headers": dict(resp.headers),
                    "content": resp.text[:30000],
                }
        except Exception as e:
            return {"error": str(e)}

    async def http_delete(self, url: str, headers: dict = None, timeout: float = 10.0) -> dict:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.delete(url, headers=headers or {})
                return {
                    "url": str(resp.url),
                    "status": resp.status_code,
                    "headers": dict(resp.headers),
                    "content": resp.text[:30000],
                }
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Download
    # ------------------------------------------------------------------

    async def download_file(self, tab_id: str, trigger_selector: str = None,
                             url: str = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            if trigger_selector:
                async with page.expect_download(timeout=30000) as download_info:
                    await page.click(trigger_selector, timeout=5000)
                download = await download_info.value
            elif url:
                async with page.expect_download(timeout=30000) as download_info:
                    await page.goto(url, wait_until="commit", timeout=10000)
                download = await download_info.value
            else:
                return {"error": "Must specify trigger_selector or url"}

            download_id = str(uuid.uuid4())
            suggested = download.suggested_filename
            self._downloads[download_id] = {"download": download, "suggested_filename": suggested}
            return {"download_id": download_id, "filename": suggested}
        except Exception as e:
            return {"error": str(e)}

    async def wait_for_download(self, download_id: str, path: str = None) -> dict:
        if download_id not in self._downloads:
            return {"error": "Download not found"}
        entry = self._downloads[download_id]
        download = entry["download"]
        try:
            if path:
                await download.save_as(path)
            else:
                path = os.path.join("/tmp", download.suggested_filename)
                await download.save_as(path)
            del self._downloads[download_id]
            return {"success": True, "path": path, "filename": download.suggested_filename}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Dialog handling
    # ------------------------------------------------------------------

    def _setup_dialog_handler(self, page, tab_id: str) -> None:
        """Register a dialog listener for a page."""
        def on_dialog(dialog):
            self._pending_dialogs[tab_id] = dialog
        page.on("dialog", on_dialog)

    async def handle_dialog(self, tab_id: str, action: str = "accept",
                            prompt_text: str = "") -> dict:
        if tab_id not in self._pending_dialogs:
            return {"error": "No pending dialog for this tab"}
        dialog = self._pending_dialogs.pop(tab_id)
        try:
            message = dialog.message
            dtype = dialog.type
            if action == "accept":
                await dialog.accept(prompt_text if dtype == "prompt" else "")
            else:
                await dialog.dismiss()
            return {"success": True, "action": action, "message": message, "type": dtype}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Network interception
    # ------------------------------------------------------------------

    async def intercept_request(self, tab_id: str, url_pattern: str = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        if tab_id not in self._network_logs:
            self._network_logs[tab_id] = []

        def on_request(request):
            if url_pattern and url_pattern not in request.url:
                return
            self._network_logs[tab_id].append({
                "url": request.url,
                "method": request.method,
                "resource_type": request.resource_type,
                "timestamp": time.time(),
            })

        page.on("request", on_request)
        return {"success": True, "intercepting": True, "url_pattern": url_pattern}

    async def get_network_log(self, tab_id: str) -> dict:
        if tab_id not in self._network_logs:
            return {"requests": [], "count": 0}
        return {"requests": self._network_logs[tab_id], "count": len(self._network_logs[tab_id])}

    async def mock_response(self, tab_id: str, url_pattern: str, body: str,
                            status: int = 200, content_type: str = "application/json") -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            await page.route(
                url_pattern,
                lambda route: route.fulfill(
                    status=status,
                    body=body,
                    headers={"content-type": content_type},
                ),
            )
            if tab_id not in self._mocked_routes:
                self._mocked_routes[tab_id] = []
            self._mocked_routes[tab_id].append(url_pattern)
            return {"success": True, "mocking": url_pattern}
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Form Engine
    # ------------------------------------------------------------------

    async def parse_resume(self, resume_text: str) -> dict:
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        try:
            parser = ResumeParser()
            profile = await parser.parse(resume_text)
            return {"success": True, "profile": profile}
        except Exception as e:
            return {"error": str(e)}

    async def analyze_form(self, tab_id: str) -> dict:
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            scanner = FormScanner()
            analysis = await scanner.scan(page)
            return {"success": True, "analysis": analysis}
        except Exception as e:
            return {"error": str(e)}

    async def fill_form(self, tab_id: str, profile: dict,
                        skip_types: list = None, fill_unmatched: bool = False) -> dict:
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            scanner = FormScanner()
            analysis = await scanner.scan(page)
            filler = FormFiller()
            result = await filler.fill(
                page, analysis, profile,
                skip_semantic_types=skip_types,
                fill_unmatched=fill_unmatched,
            )
            return {
                "success": True,
                "fill_result": result,
                "form_type": analysis.get("form_type"),
                "total_fields": analysis.get("total_fields", 0),
            }
        except Exception as e:
            return {"error": str(e)}

    async def fill_form_from_resume(self, tab_id: str, resume_text: str,
                                     skip_types: list = None,
                                     fill_unmatched: bool = False) -> dict:
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            parser = ResumeParser()
            profile = await parser.parse(resume_text)
            scanner = FormScanner()
            analysis = await scanner.scan(page)
            filler = FormFiller()
            result = await filler.fill(
                page, analysis, profile,
                skip_semantic_types=skip_types,
                fill_unmatched=fill_unmatched,
            )
            return {
                "success": True,
                "profile": profile,
                "fill_result": result,
                "form_type": analysis.get("form_type"),
                "total_fields": analysis.get("total_fields", 0),
            }
        except Exception as e:
            return {"error": str(e)}

    async def fill_form_page(self, tab_id: str, profile: dict,
                              skip_types: list = None,
                              fill_unmatched: bool = False) -> dict:
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            scanner = FormScanner()
            analysis = await scanner.scan(page)
            filler = FormFiller()
            result = await filler.fill_and_advance(
                page, analysis, profile,
                skip_semantic_types=skip_types,
                fill_unmatched=fill_unmatched,
            )
            return {
                "success": True,
                "fill_result": result,
                "form_type": analysis.get("form_type"),
                "total_fields": analysis.get("total_fields", 0),
            }
        except Exception as e:
            return {"error": str(e)}

    async def submit_form(self, tab_id: str) -> dict:
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            scanner = FormScanner()
            analysis = await scanner.scan(page)
            submit_btn = analysis.get("submit_button")
            if not submit_btn:
                return {"error": "No submit button found on this page"}
            selector = submit_btn.get("selector", "")
            if not selector:
                return {"error": "Submit button found but no selector available"}
            await page.click(selector, timeout=5000)
            await page.wait_for_load_state("domcontentloaded", timeout=10000)
            return {"success": True, "url": page.url, "title": await page.title()}
        except Exception as e:
            return {"error": str(e)}
