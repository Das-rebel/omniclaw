#!/usr/bin/env python3
"""
sota-browser agent_loop — Autonomous browser agent (v1.8.0)

plan→act→verify loop over ANY sota-browser engine backend:
  - cloakbrowser (DEFAULT, 71 C++ stealth patches)
  - botright (stealth + CAPTCHA solving)
  - playwright (vanilla, --local)

LLM brains (auto-detected):
  - ollama   (default, local, free — qwen2.5:3b)
  - openai   (any OpenAI-compatible endpoint via OPENAI_BASE_URL/OPENAI_API_KEY)

Design: sync Playwright page API throughout (CloakBrowser/Botright are sync
internally). Element addressing via indexed [n] markers captured from a custom
accessibility-style JS walker; actions go through CSS-path locators with
coordinate fallback.

Usage:
    from agent_loop import run_agent
    result = run_agent("go to example.com and report the main heading")
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from typing import Dict, List, Optional

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
)

MAX_ELEMENTS = 60          # elements shown to the LLM per step
BODY_CAPTURE_CAP = 65536   # 64KB per response body
TEXT_EXTRACT_CAP = 4000    # innerText chars shown to LLM
NET_ENTRIES_CAP = 2000     # hard cap on captured network entries


# ─────────────────────────────────────────────────────────────────────
# Element walker JS — returns indexed interactive elements with CSS paths
# ─────────────────────────────────────────────────────────────────────

_ELEMENTS_JS = r"""
() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','META','LINK','HEAD']);
  const out = [];
  let idx = 0;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 &&
           r.top < window.innerHeight && r.left < window.innerWidth;
  };
  const role = (el) => {
    const r = el.getAttribute('role');
    if (r) return r.toLowerCase();
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (['checkbox','radio','file','image'].includes(ty)) return ty;
      if (ty === 'submit' || ty === 'button' || ty === 'reset') return 'button';
      return 'input';
    }
    if (t === 'select') return 'select';
    if (t === 'textarea') return 'textarea';
    if (el.isContentEditable) return 'input';
    if (el.onclick || el.hasAttribute('ng-click') || el.hasAttribute('@click')) return 'button';
    return null;
  };
  const label = (el) => {
    let l = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
            el.getAttribute('name') || '';
    if (!l) {
      const lab = el.labels && el.labels[0];
      if (lab) l = lab.innerText.trim();
    }
    if (!l && el.id) l = el.id;
    if (!l) l = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
    return l.slice(0, 100);
  };
  const cssPath = (el) => {
    const parts = [];
    let e = el;
    for (let d = 0; e && e !== document.body && d < 6; d++, e = e.parentElement) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.tagName.toLowerCase();
      const p = e.parentElement;
      if (p) {
        const sibs = Array.from(p.children).filter(c => c.tagName === e.tagName);
        if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(e) + 1) + ')';
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const walk = (el) => {
    if (SKIP.has(el.tagName)) return;
    const r = role(el);
    if (r && vis(el)) {
      const b = el.getBoundingClientRect();
      const e = {
        i: ++idx,
        role: r,
        name: label(el),
        css: cssPath(el),
        x: Math.round(b.left + b.width / 2),
        y: Math.round(b.top + b.height / 2),
      };
      if (r === 'input' || r === 'textarea') e.value = String(el.value || '').slice(0, 60);
      if (r === 'link') e.href = (el.getAttribute('href') || '').slice(0, 80);
      if (r === 'select') {
        e.options = Array.from(el.options || []).slice(0, 12)
          .map(o => o.text.trim().slice(0, 40)).filter(Boolean);
      }
      out.push(e);
    }
    for (const c of el.children) walk(c);
  };
  const root = document.body || document.documentElement;
  if (root) for (const c of root.children) walk(c);
  return out;
}
"""


def _render_elements(elements: List[dict]) -> str:
    """Compact one-line-per-element rendering for the LLM."""
    lines = []
    for e in elements[:MAX_ELEMENTS]:
        line = f'[{e["i"]}] {e["role"]} "{e["name"]}"'
        if "value" in e:
            line += f' value="{e["value"]}"'
        if "href" in e and e["href"]:
            line += f' href={e["href"]}'
        if "options" in e and e["options"]:
            line += f' options={e["options"]}'
        lines.append(line)
    if len(elements) > MAX_ELEMENTS:
        lines.append(f'... ({len(elements) - MAX_ELEMENTS} more elements not shown; scroll to reveal)')
    return "\n".join(lines) if lines else "(no interactive elements found)"


# ─────────────────────────────────────────────────────────────────────
# LLM client — ollama / OpenAI-compatible, strict JSON
# ─────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a web automation agent controlling a real browser. Complete the task step by step, one action at a time.

Respond ONLY with a single JSON object, no other text:
{"thought": "<one short sentence>", "action": "<name>", "args": {...}, "answer": "<only for done>"}

Actions:
{"action":"navigate","args":{"url":"https://..."}}
{"action":"click","args":{"index":123}}
{"action":"type","args":{"index":123,"text":"...","submit":false}}
{"action":"select","args":{"index":123,"value":"exact option text"}}
{"action":"key","args":{"key":"Enter"}}
{"action":"scroll","args":{"direction":"down"}}
{"action":"extract_text","args":{}}
{"action":"screenshot","args":{}}
{"action":"wait","args":{"seconds":2}}
{"action":"done","args":{},"answer":"final answer to the task"}

Rules:
- Use element indexes EXACTLY as shown in [n] markers. Never invent indexes.
- After typing in a search box, use submit:true or key Enter.
- extract_text gives you the page text in your NEXT observation. Call it ONCE, then use that text.
- If PAGE TEXT or LAST ACTION already contains what the task needs, call done IMMEDIATELY with the answer. NEVER repeat an action that already succeeded.
- If blocked by CAPTCHA, login wall, or paywall you cannot pass, call done and explain in answer.
- If the task is complete, call done with the answer."""


def _extract_json(text: str) -> Optional[dict]:
    """Robust JSON extraction: strips fences, finds balanced object."""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        t = t.rsplit("```", 1)[0]
    start = t.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(t)):
        c = t[i]
        if esc:
            esc = False
            continue
        if c == "\\":
            esc = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(t[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


class LLMClient:
    """Minimal LLM client: ollama (format:json) or OpenAI-compatible."""

    def __init__(self, provider: str = "ollama", model: str = None,
                 base_url: str = None, timeout: int = 120):
        self.provider = provider
        self.timeout = timeout
        if provider == "ollama":
            self.base_url = (base_url or os.environ.get("OLLAMA_HOST")
                             or "http://127.0.0.1:11434").rstrip("/")
            if self.base_url and not self.base_url.startswith("http"):
                self.base_url = "http://" + self.base_url
            self.model = model or "qwen2.5:3b"
        else:  # openai-compatible
            self.base_url = (base_url or os.environ.get("OPENAI_BASE_URL")
                             or "https://api.openai.com/v1").rstrip("/")
            self.model = model or "gpt-4o-mini"
            self.api_key = os.environ.get("OPENAI_API_KEY", "")

    @staticmethod
    def _post(url: str, payload: dict, headers: dict = None,
              timeout: int = 120) -> dict:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": "application/json",
                                              **(headers or {})})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())

    def complete_json(self, system: str, user: str) -> dict:
        if self.provider == "ollama":
            r = self._post(
                f"{self.base_url}/api/chat",
                {"model": self.model,
                 "messages": [{"role": "system", "content": system},
                              {"role": "user", "content": user}],
                 "format": "json", "stream": False,
                 "options": {"temperature": 0, "num_ctx": 8192,
                             "num_predict": 512}},
                timeout=self.timeout)
            return _extract_json(r.get("message", {}).get("content", "")) or {}
        # OpenAI-compatible
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {"model": self.model,
                   "messages": [{"role": "system", "content": system},
                                {"role": "user", "content": user}],
                   "temperature": 0}
        try:
            payload["response_format"] = {"type": "json_object"}
            r = self._post(f"{self.base_url}/chat/completions", payload,
                           headers, self.timeout)
        except urllib.error.HTTPError:
            payload.pop("response_format", None)
            r = self._post(f"{self.base_url}/chat/completions", payload,
                           headers, self.timeout)
        return _extract_json(r["choices"][0]["message"]["content"]) or {}


def discover_llm(preferred: str = None, model: str = None,
                 base_url: str = None) -> LLMClient:
    """Auto-detect brain: ollama if reachable, else OpenAI-compatible."""
    if preferred == "openai":
        return LLMClient("openai", model, base_url)
    if preferred == "ollama":
        return LLMClient("ollama", model, base_url)
    # auto: probe ollama
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:11434/api/tags", timeout=2) as r:
            models = [m["name"] for m in json.loads(r.read().decode()).get("models", [])]
        # normalize: "qwen2.5-fast:latest" -> "qwen2.5-fast"
        norm = {m.split(":")[0]: m for m in models}
        pick = None
        if model:
            pick = norm.get(model.split(":")[0], model if model in models else None)
        if not pick:
            for want in ("best-perf", "qwen2.5:3b", "qwen2.5-fast", "qwen2.5:latest"):
                if want in norm:
                    pick = norm[want]
                    break
        pick = pick or (models[0] if models else "qwen2.5:3b")
        return LLMClient("ollama", pick, base_url)
    except Exception:
        if os.environ.get("OPENAI_API_KEY"):
            return LLMClient("openai", model, base_url)
        raise RuntimeError(
            "No agent brain available. Start ollama (ollama serve) or set "
            "OPENAI_API_KEY. Tried ollama@127.0.0.1:11434.")


# ─────────────────────────────────────────────────────────────────────
# Engine backends — sync Playwright page API (cloakbotright/playwright)
# ─────────────────────────────────────────────────────────────────────

def _launch_engine(engine: str, proxy: str = None, stealth: bool = True):
    """Returns (browser, context_or_None, page, close_fn, engine_name).
    Falls back cloak→botright→playwright with a warning if import fails."""
    tried = []

    def _try_cloak():
        from cloakbrowser import launch as cloak_launch
        kw = {"headless": True, "humanize": True}
        if proxy:
            kw["proxy"] = proxy
        browser = cloak_launch(**kw)
        page = browser.new_page()
        return browser, None, page, browser.close

    def _try_botright():
        from botright import Botright
        br = Botright(headless=True)
        browser = br.launch()
        page = browser.new_page()
        return browser, None, page, br.close

    def _try_playwright():
        from playwright.sync_api import sync_playwright
        pw = sync_playwright().start()
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-extensions"])
        ctx_kw = {
            "viewport": {"width": 1280, "height": 720},
            "user_agent": USER_AGENT,
            "locale": "en-US",
            "timezone_id": "America/New_York",
            "extra_http_headers": {
                "sec-ch-ua": '"Google Chrome";v="132", "Chromium";v="132", '
                             '"Not=A?Brand";v="99"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"macOS"',
            },
        }
        if proxy:
            ctx_kw["proxy"] = {"server": proxy}
        context = browser.new_context(**ctx_kw)
        if stealth:
            try:
                from cmd_headless import _MANUAL_STEALTH_JS
                context.add_init_script(_MANUAL_STEALTH_JS)
            except Exception:
                pass
        page = context.new_page()
        return browser, context, page, lambda: (browser.close(), pw.stop())

    order = {"cloakbrowser": [_try_cloak, _try_botright, _try_playwright],
             "botright": [_try_botright, _try_cloak, _try_playwright],
             "playwright": [_try_playwright]}[engine]
    names = {"cloakbrowser": ["cloakbrowser", "botright", "playwright"],
             "botright": ["botright", "cloakbrowser", "playwright"],
             "playwright": ["playwright"]}[engine]
    for fn, name in zip(order, names):
        try:
            browser, context, page, close_fn = fn()
            return browser, context, page, close_fn, name
        except ImportError as e:
            tried.append(f"{name}: {e}")
        except Exception as e:
            tried.append(f"{name}: {type(e).__name__}: {e}")
    raise RuntimeError("All agent engines failed to launch:\n" + "\n".join(tried))


# ─────────────────────────────────────────────────────────────────────
# Action executor
# ─────────────────────────────────────────────────────────────────────

def answer_from_text(brain, task: str, text: str) -> str:
    """Deterministic fallback: answer the task directly from extracted page text.

    Used when the agent loop is exhausted or the LLM is stuck repeating itself.
    A single focused Q&A call is far more reliable for small local models than
    another full agent turn."""
    sys = ('You answer tasks using ONLY the given page text. '
           'The answer must be the exact short phrase from the page text that '
           'answers the TASK. Never answer with navigation links or button '
           'labels like "Learn more" or "Click here". '
           'Reply ONLY with JSON: {"answer": "..."}')
    user = f"TASK: {task}\n\nPAGE TEXT:\n{text}"
    out = brain.complete_json(sys, user)
    return str(out.get("answer", "")).strip()


class ActionExecutor:
    """Executes one LLM-chosen action against the page. Sync API."""

    def __init__(self, page):
        self.page = page
        self.elements: List[dict] = []
        self.extracted_text: Optional[str] = None

    def observe(self) -> dict:
        """Refresh element snapshot + page meta."""
        try:
            self.page.wait_for_load_state("domcontentloaded", timeout=10000)
        except Exception:
            pass
        time.sleep(0.6)
        try:
            self.elements = self.page.evaluate(_ELEMENTS_JS) or []
        except Exception as e:
            return {"error": f"state evaluation failed: {e}"}
        try:
            title = self.page.title()
        except Exception:
            title = ""
        return {"url": self.page.url, "title": (title or "")[:120]}

    def _find(self, index) -> Optional[dict]:
        try:
            index = int(index)
        except (TypeError, ValueError):
            return None
        for e in self.elements:
            if e["i"] == index:
                return e
        return None

    def _click_element(self, el: dict) -> str:
        css = el.get("css")
        if css:
            try:
                self.page.click(css, timeout=4000)
                return "ok"
            except Exception:
                pass
        # coordinate fallback (viewport-relative, captured fresh this step)
        try:
            self.page.mouse.click(el["x"] + random.randint(-2, 2),
                                  el["y"] + random.randint(-2, 2))
            return "ok (coordinate fallback)"
        except Exception as e:
            return f"error: click failed: {e}"

    def execute(self, action: str, args: dict) -> str:
        """Returns short observation string for the LLM."""
        try:
            if action == "navigate":
                url = str(args.get("url", "")).strip()
                if not url:
                    return "error: no url given"
                if not url.startswith("http"):
                    url = "https://" + url
                resp = self.page.goto(url, wait_until="domcontentloaded",
                                      timeout=30000)
                self.extracted_text = None  # stale text from previous page
                return f"navigated (status {resp.status if resp else '?'})"

            if action == "click":
                el = self._find(args.get("index"))
                if not el:
                    return f"error: element {args.get('index')} not on page (may have scrolled away)"
                result = self._click_element(el)
                if result.startswith("error"):
                    return result
                try:
                    self.page.wait_for_load_state("commit", timeout=5000)
                except Exception:
                    pass
                return f"clicked [{el['i']}] {el['role']} \"{el['name'][:60]}\""

            if action == "type":
                el = self._find(args.get("index"))
                if not el:
                    return f"error: element {args.get('index')} not on page"
                text = str(args.get("text", ""))
                css = el.get("css")
                typed = False
                if css and el["role"] in ("input", "textarea"):
                    try:
                        self.page.fill(css, text, timeout=4000)
                        typed = True
                    except Exception:
                        pass
                if not typed:
                    self._click_element(el)
                    self.page.keyboard.type(text, delay=30)
                if args.get("submit"):
                    self.page.keyboard.press("Enter")
                    try:
                        self.page.wait_for_load_state("commit", timeout=5000)
                    except Exception:
                        pass
                suffix = " + submitted" if args.get("submit") else ""
                return f"typed {len(text)} chars into [{el['i']}]" + suffix

            if action == "select":
                el = self._find(args.get("index"))
                if not el:
                    return f"error: element {args.get('index')} not on page"
                value = str(args.get("value", ""))
                css = el.get("css")
                if css:
                    try:
                        self.page.select_option(css, label=value, timeout=4000)
                        return f"selected \"{value}\" in [{el['i']}]"
                    except Exception:
                        pass
                    try:
                        self.page.select_option(css, value=value, timeout=4000)
                        return f"selected (by value) \"{value}\" in [{el['i']}]"
                    except Exception:
                        pass
                return f"error: option \"{value}\" not found in [{el['i']}]"

            if action == "key":
                key = str(args.get("key", "Enter"))
                self.page.keyboard.press(key)
                try:
                    self.page.wait_for_load_state("commit", timeout=4000)
                except Exception:
                    pass
                return f"pressed {key}"

            if action == "scroll":
                dy = 600 if str(args.get("direction", "down")) == "down" else -600
                self.page.mouse.wheel(0, dy)
                time.sleep(0.4)
                return f"scrolled {args.get('direction', 'down')}"

            if action == "extract_text":
                try:
                    txt = self.page.evaluate(
                        "() => document.body ? document.body.innerText : ''")
                    self.extracted_text = (txt or "")[:TEXT_EXTRACT_CAP]
                    return f"extracted {len(self.extracted_text)} chars (included in next observation)"
                except Exception as e:
                    return f"error: extract failed: {e}"

            if action == "screenshot":
                path = str(args.get("path") or
                           f"/tmp/sota_agent_{int(time.time())}.png")
                self.page.screenshot(path=path, full_page=True)
                return f"screenshot saved: {path}"

            if action == "wait":
                time.sleep(min(float(args.get("seconds", 2)), 10))
                return "waited"

            if action == "done":
                return "done"

            return f"error: unknown action \"{action}\""
        except Exception as e:
            return f"error: {type(e).__name__}: {e}"


# ─────────────────────────────────────────────────────────────────────
# Network capture (works on every engine — plain Playwright events)
# ─────────────────────────────────────────────────────────────────────

def attach_net_capture(page, pattern: Optional[str],
                       capture_body: bool) -> List[dict]:
    """Attach response listener. Returns the live entries list."""
    entries: List[dict] = []

    def on_response(resp):
        try:
            if len(entries) >= NET_ENTRIES_CAP:
                return
            url = resp.url
            if pattern and pattern not in url:
                return
            req = resp.request
            entry = {"url": url[:512], "status": resp.status,
                     "method": req.method, "type": req.resource_type,
                     "ts": round(time.time(), 3)}
            if capture_body and req.resource_type in ("xhr", "fetch"):
                try:
                    ct = (resp.headers or {}).get("content-type", "")
                    if any(k in ct for k in ("json", "text", "xml")):
                        entry["body"] = resp.text()[:BODY_CAPTURE_CAP]
                        entry["content_type"] = ct
                except Exception:
                    pass
            entries.append(entry)
        except Exception:
            pass

    page.on("response", on_response)
    return entries


def write_har(entries: List[dict], path: str) -> dict:
    """Write captured entries as a simplified HAR 1.2 file."""
    har = {
        "log": {
            "version": "1.2",
            "creator": {"name": "sota-browser cmd-headless", "version": "1.8.0"},
            "entries": [
                {"startedDateTime": time.strftime(
                    "%Y-%m-%dT%H:%M:%S", time.localtime(e.get("ts", time.time()))),
                 "time": 0,
                 "request": {"method": e.get("method", "GET"),
                             "url": e.get("url", ""),
                             "httpVersion": "http/2",
                             "headers": [], "queryString": [],
                             "headersSize": -1, "bodySize": 0},
                 "response": {"status": e.get("status", 0),
                              "statusText": "",
                              "httpVersion": "http/2",
                              "headers": [],
                              "content": {"size": len(e.get("body", "") or ""),
                                          "mimeType": e.get("content_type",
                                                            "application/json"),
                                          **({"text": e["body"]}
                                             if e.get("body") else {})},
                              "headersSize": -1, "bodySize": -1},
                 "cache": {},
                 "timings": {"send": 0, "wait": 0, "receive": 0},
                 "_resourceType": e.get("type", "")}
                for e in entries
            ],
        }
    }
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(har, f, indent=1)
    return {"har": path, "entries": len(entries)}


# ─────────────────────────────────────────────────────────────────────
# Main agent loop
# ─────────────────────────────────────────────────────────────────────

def run_agent(task: str, engine: str = "cloakbrowser", proxy: str = None,
              cookies: List[dict] = None, profile_dir: str = None,
              max_steps: int = 15, llm: str = None, llm_model: str = None,
              llm_base_url: str = None, net_pattern: str = None,
              net_body: bool = False, har_path: str = None,
              screenshot: str = None, stealth: bool = True,
              start_url: str = None) -> dict:
    """Run the autonomous agent. Returns structured result dict."""
    t0 = time.time()
    result: dict = {"task": task, "engine": engine, "steps": [],
                    "success": False}

    brain = discover_llm(llm, llm_model, llm_base_url)
    result["llm"] = f"{brain.provider}:{brain.model}"
    print(f"[sota-agent] brain={result['llm']} engine={engine} "
          f"max_steps={max_steps}", file=sys.stderr)

    browser, context, page, close_fn, engine_used = _launch_engine(
        engine, proxy, stealth)
    result["engine"] = engine_used

    network: Optional[List[dict]] = None
    if net_pattern is not None:
        network = attach_net_capture(page, net_pattern or None, net_body)

    try:
        if profile_dir:
            state_file = os.path.join(profile_dir, "state.json")
            if os.path.exists(state_file):
                try:
                    with open(state_file) as f:
                        state = json.load(f)
                    page.context.add_cookies(state.get("cookies", []))
                    print(f"[sota-agent] loaded profile {profile_dir}",
                          file=sys.stderr)
                except Exception as e:
                    print(f"[sota-agent] profile load failed: {e}",
                          file=sys.stderr)
        if cookies:
            clean = [{k: v for k, v in c.items()
                      if k in ("name", "value", "domain", "path", "secure",
                               "httpOnly", "sameSite")} for c in cookies]
            try:
                page.context.add_cookies(clean)
            except Exception as e:
                print(f"[sota-agent] cookie import failed: {e}", file=sys.stderr)

        executor = ActionExecutor(page)

        # Initial navigation: explicit URL from task, or explicit start_url,
        # else drop on DuckDuckGo and let the agent navigate.
        url_match = start_url
        if not url_match:
            import re
            m = re.search(r"go to (\S+)", task, re.I)
            url_match = m.group(1) if m else None
        if url_match:
            if not url_match.startswith("http"):
                url_match = "https://" + url_match
            executor.page.goto(url_match, wait_until="domcontentloaded",
                               timeout=30000)

        consecutive_errors = 0
        last_sig = None
        repeat_count = 0
        for step_num in range(1, max_steps + 1):
            state = executor.observe()
            if "error" in state:
                result["steps"].append({"n": step_num, "error": state["error"]})
                break

            obs_parts = [f"TASK: {task}", f"URL: {state['url']}",
                         f"TITLE: {state['title']}"]
            if executor.extracted_text is not None:
                obs_parts.append("PAGE TEXT (already extracted — USE THIS to answer; "
                                 "do NOT call extract_text again):\n" + executor.extracted_text)
            if result["steps"]:
                last = result["steps"][-1]
                obs_parts.append(f"LAST ACTION: {last.get('action')} -> {last.get('result', '')[:300]}")
                if len(result["steps"]) >= 2:
                    a, b = result["steps"][-2], result["steps"][-1]
                    sig_a = (a.get("action"), json.dumps(a.get("args") or {}, sort_keys=True))
                    sig_b = (b.get("action"), json.dumps(b.get("args") or {}, sort_keys=True))
                    if sig_a == sig_b:
                        obs_parts.append("WARNING: you repeated the same action with the same args. "
                                         "That gives no new information. Use what you already have, "
                                         "choose a DIFFERENT action, or call done with the answer.")
                obs_parts.append("If PAGE TEXT or LAST ACTION already answers the task, "
                                 "call done NOW with the answer.")
            obs_parts.append("ELEMENTS:\n" + _render_elements(executor.elements))
            obs_parts.append("Respond with the next action JSON.")

            decision = brain.complete_json(SYSTEM_PROMPT, "\n".join(obs_parts))
            action = decision.get("action", "")
            args = decision.get("args", {}) or {}
            sig = (action, json.dumps(args, sort_keys=True))
            if sig == last_sig:
                repeat_count += 1
            else:
                repeat_count = 0
            last_sig = sig
            if repeat_count >= 2:
                result["steps"].append({"n": step_num, "error":
                    "loop-guard: same action repeated 3x; trying direct answer "
                    "from extracted page text"})
                break
            if not action:
                result["steps"].append({
                    "n": step_num, "error": "LLM returned no action",
                    "raw": str(decision)[:200]})
                consecutive_errors += 1
                if consecutive_errors >= 2:
                    result["error"] = "agent aborted: LLM produced no valid action twice"
                    break
                continue

            step_entry = {"n": step_num,
                          "thought": str(decision.get("thought", ""))[:200],
                          "action": action, "args": args}
            if action == "done":
                result["answer"] = str(decision.get("answer", ""))[:2000]
                result["success"] = bool(result["answer"])
                step_entry["result"] = "done"
                result["steps"].append(step_entry)
                break

            step_entry["result"] = executor.execute(action, args)
            result["steps"].append(step_entry)
            print(f"[sota-agent] step {step_num}/{max_steps}: {action} "
                  f"-> {step_entry['result'][:120]}", file=sys.stderr)

            if step_entry["result"].startswith("error:"):
                consecutive_errors += 1
                if consecutive_errors >= 4:
                    result["error"] = ("agent aborted: 4 consecutive errors "
                                       f"(last: {step_entry['result'][:200]})")
                    break
            else:
                consecutive_errors = 0
        else:
            result["error"] = f"max_steps ({max_steps}) reached without done"

        # Deterministic fallback: if the loop failed but we hold page text,
        # answer the task directly with one focused Q&A call.
        if not result.get("success") and executor.extracted_text:
            try:
                print("[sota-agent] fallback: answering directly from page text",
                      file=sys.stderr)
                ans = answer_from_text(brain, task, executor.extracted_text)
                if ans:
                    result["answer"] = ans[:2000]
                    result["success"] = True
                    result["fallback"] = "answered from extracted page text"
                    result.pop("error", None)
            except Exception as e:
                result.setdefault("error", f"fallback failed: {e}")
        if not result.get("success") and not result.get("error"):
            result["error"] = "loop-guard: agent repeated the same action without done"

        if screenshot:
            try:
                page.screenshot(path=screenshot, full_page=True)
                result["screenshot"] = screenshot
            except Exception:
                pass

        if network is not None:
            result["network_count"] = len(network)
            result["network"] = network[:500]
            if har_path:
                result["har"] = write_har(network, har_path)

        result["elapsed_s"] = round(time.time() - t0, 1)
        result["url"] = page.url
        return result
    finally:
        try:
            close_fn()
        except Exception:
            pass


if __name__ == "__main__":
    # Standalone: python3 agent_loop.py "task text" [--engine X] [--max-steps N]
    task_args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(zip(sys.argv[1::2], sys.argv[2::2]))
    if not task_args:
        print("usage: python3 agent_loop.py \"<task>\" [--engine cloakbrowser] "
              "[--max-steps 15] [--net PATTERN] [--har FILE]")
        sys.exit(1)
    out = run_agent(" ".join(task_args),
                    engine=opts.get("--engine", "cloakbrowser"),
                    max_steps=int(opts.get("--max-steps", 15)),
                    net_pattern=opts.get("--net"),
                    har_path=opts.get("--har"))
    print(json.dumps(out, indent=2))
