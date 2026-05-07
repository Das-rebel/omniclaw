#!/usr/bin/env python3
"""
SOTA Browser MCP Server - Optimized Version
Keep browser warm for faster subsequent calls.
"""

import asyncio
import json
import os
import sys

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    print("ERROR: playwright not installed", file=sys.stderr)
    sys.exit(1)

# Speed optimizations
DEFAULT_VIEWPORT = {"width": 1280, "height": 720}  # Smaller = faster
DEFAULT_TIMEOUT = 15000  # 15s instead of 30s
FAST_WAIT = 0.1

# Form engine integration
try:
    from form_engine import (
        ResumeParser,
        FieldMatcher,
        FormAnalyzer,
        FormFiller,
        analyze_and_fill,
    )
    FORM_ENGINE_AVAILABLE = True
except ImportError:
    FORM_ENGINE_AVAILABLE = False

class BrowserManager:
    def __init__(self):
        self._playwright = None
        self._browser = None
        self.sessions = {}
        self.contexts = {}
        self.pages = {}
        self._lock = asyncio.Lock()
        self._ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        self._console_capture_init = {}

    async def start(self):
        self._playwright = await async_playwright().start()

        # Check for Chrome CDP connection
        cdp_url = os.environ.get("CHROME_CDP_URL", "")
        self._using_existing = False

        if cdp_url:
            print(f"[sota-browser] Attempting Chrome CDP connection: {cdp_url[:50]}...", file=sys.stderr)
            try:
                # Try connecting to existing Chrome
                self._browser = await self._playwright.chromium.connect_over_cdp(cdp_url, timeout=20000)
                self._using_existing = True
                print(f"[sota-browser] ✓ Connected to existing Chrome via CDP!", file=sys.stderr)
            except Exception as e:
                err_str = str(e)
                print(f"[sota-browser] CDP failed ({err_str[:60]}...), falling back to local browser", file=sys.stderr)
                self._using_existing = False
                await self._launch_browser()
        else:
            await self._launch_browser()

    async def _launch_browser(self):
        """Launch a fresh headless browser."""
        sock_path = f"/tmp/sota-b-{os.getpid()}.sock"
        headless = os.environ.get("BH_HEADLESS", "true").lower() != "false"
        self._browser = await self._playwright.chromium.launch(
            headless=headless,
            args=[
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
            ],
        )
        self._using_existing = False
        print(f"[sota-browser] Browser ready (fresh launch)", file=sys.stderr)

    async def create_session(self, user_id: str, **options) -> dict:
        import uuid
        session_id = str(uuid.uuid4())

        # If connected to existing Chrome, reuse its context
        if getattr(self, '_using_existing', False):
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
                    "note": "Using existing Chrome context"
                }

        # Create new context (fresh browser or CDP browser without existing context)
        context = await self._browser.new_context(
            viewport={"width": options.get("width", 1280), "height": options.get("height", 720)},
            user_agent=self._ua,
            locale="en-US",
            timezone_id="America/New_York",
        )

        # Apply stealth synchronously (quick)
        try:
            await context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => false});")
        except: pass

        self.sessions[session_id] = {"user_id": user_id, "context": context}
        self.contexts[session_id] = context

        return {"id": session_id, "user_id": user_id, "created": True, "existing_browser": False}

    async def create_tab(self, session_id: str, url: str = None) -> dict:
        import uuid
        if session_id not in self.contexts:
            return {"error": "Session not found"}

        context = self.contexts[session_id]
        page = await context.new_page()
        tab_id = str(uuid.uuid4())
        self.pages[tab_id] = {"page": page, "session_id": session_id}

        if url:
            await page.goto(url, wait_until="commit", timeout=10000)

        return {
            "id": tab_id,
            "session_id": session_id,
            "url": page.url,
            "title": await page.title() if page.url != "about:blank" else "",
        }

    async def navigate(self, tab_id: str, url: str) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            response = await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            return {"url": page.url, "title": await page.title(), "status": response.status if response else 0}
        except Exception as e:
            return {"error": str(e), "url": url}

    async def get_snapshot(self, tab_id: str, include_screenshot: bool = False) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]

        try:
            # Get all frames including iframes
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
                    } catch(e) { /* cross-origin, skip */ }
                    // win.frames is a WindowProxy, use numeric indexing
                    for (let i = 0; i < win.frames.length; i++) {
                        try { walk(win.frames[i], path + '>' + (win.frames[i].name || 'unnamed')); } catch(e) {}
                    }
                }
                walk(window, 'main');
                return frames;
            }""")

            # Get main frame tree
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
                "frames": frames_info
            }

            if include_screenshot:
                import base64
                result["screenshot"] = base64.b64encode(await page.screenshot()).decode()

            return result
        except Exception as e:
            return {"error": str(e)}

    async def click(self, tab_id: str, selector: str = None, ref: str = None, x: float = None, y: float = None) -> dict:
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
                    except:
                        await page.locator(f"text={name}").first.click(timeout=3000)
            else:
                return {"error": "Must specify selector, ref, or coordinates"}

            await page.wait_for_load_state("commit", timeout=5000)
            return {"success": True, "url": page.url}
        except Exception as e:
            return {"error": str(e)}

    async def type_text(self, tab_id: str, text: str, selector: str = None, ref: str = None) -> dict:
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
                    except:
                        await page.locator(f"text={name}").first.fill(text)
            elif selector:
                await page.fill(selector, text)
            else:
                await page.keyboard.type(text, delay=50)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    async def scroll(self, tab_id: str, dx: float = 0, dy: float = -300) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        await self.pages[tab_id]["page"].mouse.wheel(int(dx), int(dy))
        await asyncio.sleep(FAST_WAIT)
        return {"success": True}

    async def screenshot(self, tab_id: str, full: bool = False) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        import base64
        img = await self.pages[tab_id]["page"].screenshot(full_page=full)
        return {"base64": base64.b64encode(img).decode()}

    async def evaluate(self, tab_id: str, script: str, frame_index: int = None) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            if frame_index is not None:
                # Access specific frame
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

    async def list_frames(self, tab_id: str) -> dict:
        """List all frames in the page with their URLs and origins"""
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
                        "name": frame.name or '',
                        "is_main": frame.is_main_frame
                    })
                except:
                    frames_list.append({"index": i, "url": "[cross-origin]", "name": "", "is_main": False})
            return {"frames": frames_list, "total": len(frames_list)}
        except Exception as e:
            return {"error": str(e)}

    async def get_console_logs(self, tab_id: str, clear: bool = False) -> dict:
        """Capture browser console messages and errors. Returns list of {type, message, timestamp} objects."""
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            # Initialize capture dict for this tab if not already set up
            if tab_id not in self._console_capture_init:
                self._console_capture_init[tab_id] = True
                # Inject console interceptor once per tab
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

            # Clear logs if requested
            if clear:
                await page.evaluate("window._pi_logs = []")

            # Return captured logs
            logs = await page.evaluate("window._pi_logs || []")
            return {"logs": logs, "count": len(logs)}
        except Exception as e:
            return {"error": str(e)}

    async def get_frame_content(self, tab_id: str, frame_index: int = None, frame_url_contains: str = None) -> dict:
        """Get HTML content from a specific frame. Useful for scraping iframe content."""
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
        """Inject and execute JavaScript in ALL frames. Returns results from each frame."""
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        results = []

        for i, frame in enumerate(page.frames):
            try:
                result = await frame.evaluate(script)
                results.append({"frame_index": i, "url": frame.url, "success": True, "result": result})
            except Exception as e:
                results.append({"frame_index": i, "url": frame.url[:50] if frame.url else "unknown", "success": False, "error": str(e)})

        return {"results": results, "total_frames": len(results)}

    async def evaluate_in_frame(self, tab_id: str, script: str, frame_selector: str = None, frame_url_contains: str = None) -> dict:
        """Evaluate script in a specific frame by selector or URL contains"""
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

    async def press_key(self, tab_id: str, key: str, modifiers: int = 0) -> dict:
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        try:
            await self.pages[tab_id]["page"].keyboard.press(key)
            return {"success": True, "key": key}
        except Exception as e:
            return {"error": str(e)}

    async def wait(self, tab_id: str, seconds: float = 1.0) -> dict:
        await asyncio.sleep(seconds)
        return {"success": True, "waited": seconds}

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

    async def get_html(self, tab_id: str, selector: str = None) -> dict:
        """Return raw HTML of page or specific element (truncated to 100KB)."""
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            if selector:
                html = await page.evaluate(
                    "(sel) => { const el = document.querySelector(sel); return el ? el.outerHTML : null; }",
                    selector
                )
                if html is None:
                    return {"error": f"Element not found: {selector}"}
                return {"html": html[:102400], "selector": selector, "truncated": len(html) > 102400}
            else:
                html = await page.content()
                return {"html": html[:102400], "selector": None, "truncated": len(html) > 102400}
        except Exception as e:
            return {"error": str(e)}

    async def http_get(self, url: str, headers: dict = None, timeout: float = 10.0) -> dict:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(url, headers=headers or {})
                return {"url": str(resp.url), "status": resp.status_code,
                        "headers": dict(resp.headers), "content": resp.text[:30000]}
        except Exception as e:
            return {"error": str(e)}

    async def list_tabs(self, session_id: str) -> list:
        if session_id not in self.contexts:
            return []
        return [{"url": p.url, "title": await p.title() if p else "Unknown"}
                for p in self.contexts[session_id].pages]

    async def close_tab(self, tab_id: str) -> dict:
        if tab_id in self.pages:
            await self.pages[tab_id]["page"].close()
            del self.pages[tab_id]
        return {"success": True}

    async def close_session(self, session_id: str) -> dict:
        for tid in list(self.pages.keys()):
            if self.pages[tid]["session_id"] == session_id:
                await self.pages[tid]["page"].close()
                del self.pages[tid]
        if session_id in self.contexts:
            await self.contexts[session_id].close()
            del self.contexts[session_id]
        if session_id in self.sessions:
            del self.sessions[session_id]
        return {"success": True}

    async def import_cookies(self, session_id: str, cookies: list) -> dict:
        if session_id not in self.contexts:
            return {"error": "Session not found"}
        sanitized = [{"name": c.get("name",""), "value": c.get("value",""),
                     "domain": c.get("domain",""), "path": c.get("path","/"),
                     "secure": bool(c.get("secure", False))} for c in cookies]
        await self.contexts[session_id].add_cookies(sanitized)
        return {"success": True, "count": len(sanitized)}

    async def get_state(self, tab_id: str) -> dict:
        """Return clean indexed list of clickable elements for automation."""
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
                    // Skip self only if explicitly requested (for BODY root)
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

                // Start at body but skip body itself (just traverse children)
                const root = document.body || document.documentElement;
                for (const c of root.children) walk(c, false);
                return result;
            }""")
            return {"elements": elements, "count": len(elements), "url": page.url}
        except Exception as e:
            return {"error": str(e)}

    async def go_back(self, tab_id: str) -> dict:
        """Navigate back in browser history."""
        if tab_id not in self.pages:
            return {"error": "Tab not found"}
        page = self.pages[tab_id]["page"]
        try:
            await page.go_back(wait_until="commit", timeout=10000)
            return {"success": True, "url": page.url, "title": await page.title()}
        except Exception as e:
            return {"error": str(e)}

    async def switch_tab(self, tab_id: str, tab_index: int) -> dict:
        """Switch to a different tab by index in the context's pages list."""
        import uuid
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

    # ------------------------------------------------------------------
    # Form Engine methods
    # ------------------------------------------------------------------

    async def parse_resume(self, resume_text: str) -> dict:
        """Parse a plain-text resume into structured profile data."""
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        try:
            parser = ResumeParser()
            profile = await parser.parse(resume_text)
            return {"success": True, "profile": profile}
        except Exception as e:
            return {"error": str(e)}

    async def analyze_form(self, tab_id: str) -> dict:
        """Analyze the current page's form structure (Google Forms, standard HTML, Material UI, etc.)."""
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            analyzer = FormAnalyzer()
            analysis = await analyzer.analyze(page)
            return {"success": True, "analysis": analysis}
        except Exception as e:
            return {"error": str(e)}

    async def fill_form(
        self,
        tab_id: str,
        profile: dict,
        skip_types: list = None,
        fill_unmatched: bool = False,
    ) -> dict:
        """Fill form fields on the page using profile data. Auto-analyzes the form first."""
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            analyzer = FormAnalyzer()
            analysis = await analyzer.analyze(page)

            filler = FormFiller()
            result = await filler.fill(
                page,
                analysis,
                profile,
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

    async def fill_form_from_resume(
        self,
        tab_id: str,
        resume_text: str,
        skip_types: list = None,
        fill_unmatched: bool = False,
    ) -> dict:
        """Parse a resume and fill form fields in one shot."""
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            # Parse resume
            parser = ResumeParser()
            profile = await parser.parse(resume_text)

            # Analyze form
            analyzer = FormAnalyzer()
            analysis = await analyzer.analyze(page)

            # Fill
            filler = FormFiller()
            result = await filler.fill(
                page,
                analysis,
                profile,
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

    async def fill_form_page(
        self,
        tab_id: str,
        profile: dict,
        skip_types: list = None,
        fill_unmatched: bool = False,
    ) -> dict:
        """Fill current page of a multi-page form and click Next. Returns fill result."""
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            analyzer = FormAnalyzer()
            analysis = await analyzer.analyze(page)

            filler = FormFiller()
            result = await filler.fill_and_advance(
                page,
                analysis,
                profile,
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
        """Submit the current form by clicking the Submit button."""
        if not FORM_ENGINE_AVAILABLE:
            return {"error": "form_engine module not available"}
        if tab_id not in self.pages:
            return {"error": "Tab not found"}

        page = self.pages[tab_id]["page"]
        try:
            analyzer = FormAnalyzer()
            analysis = await analyzer.analyze(page)

            submit_btn = analysis.get("submit_button")
            if not submit_btn:
                return {"error": "No submit button found on this page"}

            selector = submit_btn.get("selector", "")
            if not selector:
                return {"error": "Submit button found but no selector available"}

            await page.click(selector, timeout=5000)
            await page.wait_for_load_state("domcontentloaded", timeout=10000)

            return {
                "success": True,
                "url": page.url,
                "title": await page.title(),
            }
        except Exception as e:
            return {"error": str(e)}

    async def shutdown(self):
        for p in self.pages.values():
            await p["page"].close()
        for c in self.contexts.values():
            await c.close()
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()

class MCPServer:
    def __init__(self):
        self.browser = BrowserManager()
        self._initialized = False

    async def initialize(self):
        await self.browser.start()
        self._initialized = True

    def _write(self, msg):
        print(json.dumps(msg), flush=True)

    async def handle(self, req):
        method = req.get("method", "")
        req_id = req.get("id")
        params = req.get("params", {})

        if method == "initialize":
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": {"name": "sota-browser", "version": "1.2.0"}}}

        if method == "notifications/initialized":
            return None

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": [
                {"name": "browser_create_session", "description": "Create isolated browser session",
                 "inputSchema": {"type": "object", "properties": {"user_id": {"type": "string"}, "width": {"type": "integer"}, "height": {"type": "integer"}}, "required": ["user_id"]}},
                {"name": "browser_create_tab", "description": "Create new tab in session",
                 "inputSchema": {"type": "object", "properties": {"session_id": {"type": "string"}, "url": {"type": "string"}}, "required": ["session_id"]}},
                {"name": "browser_navigate", "description": "Navigate to URL",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "url": {"type": "string"}}, "required": ["tab_id", "url"]}},
                {"name": "browser_snapshot", "description": "Get page accessibility tree",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "screenshot": {"type": "boolean"}}, "required": ["tab_id"]}},
                {"name": "browser_click", "description": "Click element by selector/ref/coordinates",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "selector": {"type": "string"}, "ref": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}, "required": ["tab_id"]}},
                {"name": "browser_type", "description": "Type text into element",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "text": {"type": "string"}, "selector": {"type": "string"}, "ref": {"type": "string"}}, "required": ["tab_id", "text"]}},
                {"name": "browser_scroll", "description": "Scroll page (dx/dy)",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "dx": {"type": "number"}, "dy": {"type": "number"}}, "required": ["tab_id"]}},
                {"name": "browser_screenshot", "description": "Take screenshot",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "full": {"type": "boolean"}}, "required": ["tab_id"]}},
                {"name": "browser_evaluate", "description": "Execute JavaScript in main frame or specify frame_index",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "script": {"type": "string"}, "frame_index": {"type": "integer"}}, "required": ["tab_id", "script"]}},
                {"name": "browser_list_frames", "description": "List all frames in the page",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}}, "required": ["tab_id"]}},
                {"name": "browser_evaluate_in_frame", "description": "Evaluate JavaScript in a specific frame by URL contains",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "script": {"type": "string"}, "frame_url_contains": {"type": "string"}}, "required": ["tab_id", "script", "frame_url_contains"]}},
                {"name": "browser_get_console_logs", "description": "Capture browser console messages and errors",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "clear": {"type": "boolean"}}, "required": ["tab_id"]}},
                {"name": "browser_get_frame_content", "description": "Get HTML content from a specific frame",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "frame_index": {"type": "integer"}, "frame_url_contains": {"type": "string"}}, "required": ["tab_id"]}},
                {"name": "browser_inject_all_frames", "description": "Inject and run JS in all frames, returns per-frame results",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "script": {"type": "string"}}, "required": ["tab_id", "script"]}},
                {"name": "browser_press_key", "description": "Press key (Enter, Tab, etc.)",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "key": {"type": "string"}, "modifiers": {"type": "integer"}}, "required": ["tab_id", "key"]}},
                {"name": "browser_wait", "description": "Explicit wait",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "seconds": {"type": "number"}}, "required": ["tab_id"]}},
                {"name": "browser_extract_images", "description": "Extract images from page",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}}, "required": ["tab_id"]}},
                {"name": "browser_list_tabs", "description": "List tabs in session",
                 "inputSchema": {"type": "object", "properties": {"session_id": {"type": "string"}}, "required": ["session_id"]}},
                {"name": "browser_close_tab", "description": "Close tab",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}}, "required": ["tab_id"]}},
                {"name": "browser_http_get", "description": "Direct HTTP GET",
                 "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}, "headers": {"type": "object"}, "timeout": {"type": "number"}}, "required": ["url"]}},
                {"name": "browser_import_cookies", "description": "Import cookies",
                 "inputSchema": {"type": "object", "properties": {"session_id": {"type": "string"}, "cookies": {"type": "array"}}, "required": ["session_id", "cookies"]}},
                {"name": "browser_info", "description": "Get browser info",
                 "inputSchema": {"type": "object", "properties": {}}},
                {"name": "browser_close_session", "description": "Close session and all tabs",
                 "inputSchema": {"type": "object", "properties": {"session_id": {"type": "string"}}, "required": ["session_id"]}},
                {"name": "browser_get_state", "description": "Get indexed clickable elements for automation",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}}, "required": ["tab_id"]}},
                {"name": "browser_get_html", "description": "Return raw HTML of page or specific element (truncated to 100KB)",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "selector": {"type": "string"}}, "required": ["tab_id"]}},
                {"name": "browser_go_back", "description": "Navigate back in browser history",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}}, "required": ["tab_id"]}},
                {"name": "browser_switch_tab", "description": "Switch to a different tab by index",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "tab_index": {"type": "integer"}}, "required": ["tab_id", "tab_index"]}},
                # --- Form Engine tools ---
                {"name": "browser_parse_resume", "description": "Parse plain-text resume into structured profile data (name, email, phone, education, experience, skills, etc). Use this to extract profile data before filling forms.",
                 "inputSchema": {"type": "object", "properties": {"resume_text": {"type": "string", "description": "Plain-text resume content"}}, "required": ["resume_text"]}},
                {"name": "browser_analyze_form", "description": "Analyze the current page's form structure. Detects Google Forms, standard HTML, Material UI, Ant Design, Bootstrap forms. Returns field types, labels, options, required status, and submit/navigation buttons.",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}}, "required": ["tab_id"]}},
                {"name": "browser_fill_form", "description": "Fill form fields on the page using structured profile data. Auto-analyzes the form, matches fields to profile keys (first_name, email, phone, etc.), and fills them. Works with Google Forms, standard HTML, Material UI, etc.",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "profile": {"type": "object", "description": "Profile data with keys like first_name, last_name, email, phone, city, state, etc."}, "skip_types": {"type": "array", "items": {"type": "string"}, "description": "Semantic field types to skip (e.g. [\"salary\", \"gender\"])"}, "fill_unmatched": {"type": "boolean", "description": "Try to fill fields even without direct profile match"}}, "required": ["tab_id", "profile"]}},
                {"name": "browser_fill_form_from_resume", "description": "Parse a resume AND fill form fields in one shot. Pass raw resume text, it will be parsed into a profile and used to auto-fill all matching form fields.",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "resume_text": {"type": "string", "description": "Plain-text resume content"}, "skip_types": {"type": "array", "items": {"type": "string"}, "description": "Semantic field types to skip"}, "fill_unmatched": {"type": "boolean", "description": "Try to fill fields even without direct profile match"}}, "required": ["tab_id", "resume_text"]}},
                {"name": "browser_fill_form_page", "description": "Fill current page of a multi-page form and click Next to advance. Use for Google Forms with multiple pages/sections.",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}, "profile": {"type": "object", "description": "Profile data"}, "skip_types": {"type": "array", "items": {"type": "string"}}, "fill_unmatched": {"type": "boolean"}}, "required": ["tab_id", "profile"]}},
                {"name": "browser_submit_form", "description": "Submit the current form by finding and clicking the Submit button. Auto-detects the submit button from form analysis.",
                 "inputSchema": {"type": "object", "properties": {"tab_id": {"type": "string"}}, "required": ["tab_id"]}}
            ]}}

        if method == "tools/call":
            try:
                result = await self._call(params.get("name", ""), params.get("arguments", {}))
                return {"jsonrpc": "2.0", "id": req_id, "result": {"content": [{"type": "text", "text": json.dumps(result)}]}}
            except Exception as e:
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32603, "message": str(e)}}

        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Unknown: {method}"}}

    async def _call(self, name, args):
        b = self.browser
        sid, tid = args.get("session_id"), args.get("tab_id")

        if name == "browser_create_session":
            return await b.create_session(**args)
        if name == "browser_create_tab":
            return await b.create_tab(sid, args.get("url"))
        if name == "browser_close_session":
            return await b.close_session(sid)
        if name == "browser_list_tabs":
            return {"tabs": await b.list_tabs(sid)}
        if name == "browser_http_get":
            return await b.http_get(args["url"], args.get("headers"), args.get("timeout", 10))
        if name == "browser_import_cookies":
            return await b.import_cookies(sid, args["cookies"])
        if name == "browser_info":
            return {"sessions": len(b.sessions), "tabs": len(b.pages)}
        if name == "browser_close_tab":
            return await b.close_tab(tid)

        if not tid:
            return {"error": "tab_id required"}

        if name == "browser_navigate":
            return await b.navigate(tid, args["url"])
        if name == "browser_snapshot":
            return await b.get_snapshot(tid, args.get("screenshot", False))
        if name == "browser_click":
            return await b.click(tid, args.get("selector"), args.get("ref"), args.get("x"), args.get("y"))
        if name == "browser_type":
            return await b.type_text(tid, args["text"], args.get("selector"), args.get("ref"))
        if name == "browser_scroll":
            return await b.scroll(tid, args.get("dx", 0), args.get("dy", -300))
        if name == "browser_screenshot":
            return await b.screenshot(tid, args.get("full", False))
        if name == "browser_evaluate":
            return await b.evaluate(tid, args["script"], args.get("frame_index"))
        if name == "browser_list_frames":
            return await b.list_frames(tid)
        if name == "browser_evaluate_in_frame":
            return await b.evaluate_in_frame(tid, args["script"], args.get("frame_selector"), args.get("frame_url_contains"))
        if name == "browser_get_console_logs":
            return await b.get_console_logs(tid, args.get("clear", False))
        if name == "browser_get_frame_content":
            return await b.get_frame_content(tid, args.get("frame_index"), args.get("frame_url_contains"))
        if name == "browser_inject_all_frames":
            return await b.inject_into_all_frames(tid, args["script"])
        if name == "browser_press_key":
            return await b.press_key(tid, args["key"], args.get("modifiers", 0))
        if name == "browser_wait":
            return await b.wait(tid, args.get("seconds", 1))
        if name == "browser_extract_images":
            return await b.extract_images(tid)
        if name == "browser_get_state":
            return await b.get_state(tid)
        if name == "browser_get_html":
            return await b.get_html(tid, args.get("selector"))
        if name == "browser_go_back":
            return await b.go_back(tid)
        if name == "browser_switch_tab":
            return await b.switch_tab(tid, args["tab_index"])

        # Form Engine tools
        if name == "browser_parse_resume":
            return await b.parse_resume(args["resume_text"])
        if name == "browser_analyze_form":
            return await b.analyze_form(tid)
        if name == "browser_fill_form":
            return await b.fill_form(tid, args["profile"], args.get("skip_types"), args.get("fill_unmatched", False))
        if name == "browser_fill_form_from_resume":
            return await b.fill_form_from_resume(tid, args["resume_text"], args.get("skip_types"), args.get("fill_unmatched", False))
        if name == "browser_fill_form_page":
            return await b.fill_form_page(tid, args["profile"], args.get("skip_types"), args.get("fill_unmatched", False))
        if name == "browser_submit_form":
            return await b.submit_form(tid)

        return {"error": f"Unknown tool: {name}"}

    async def run(self):
        await self.initialize()
        self._write({"jsonrpc": "2.0", "method": "initialized", "params": {}})

        while True:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                resp = await self.handle(json.loads(line))
                if resp:
                    self._write(resp)
            except Exception as e:
                self._write({"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": str(e)}})

        await self.browser.shutdown()

if __name__ == "__main__":
    asyncio.run(MCPServer().run())