#!/usr/bin/env python3
"""
cmd-headless v1.7.0 — One-command browser automation CLI

Stealth Browsers (v1.7):
- --cloakbrowser: CloakBrowser (71 C++ stealth patches, highest stealth)
- --botright: Botright (enhanced stealth + free CAPTCHA solving)
- --proxy: HTTP/SOCKS5 proxy with rotation support

Local CAPTCHA Solver:
- captcha_solve_turnstile: Solve Cloudflare Turnstile
- captcha_solve_recaptcha_v2: Solve reCAPTCHA v2 via audio
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

# User agent string
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
)

# Manual stealth fallback JS (used when playwright-stealth unavailable)
_MANUAL_STEALTH_JS = r"""
(function() {
  Object.defineProperty(navigator, 'webdriver', {get: () => false, configurable: true});
  Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5], configurable: true});
  Object.defineProperty(navigator, 'languages', {get: () => ['en-US','en'], configurable: true});
  Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8, configurable: true});
  Object.defineProperty(navigator, 'deviceMemory', {get: () => 8, configurable: true});
  Object.defineProperty(navigator, 'platform', {get: () => 'MacIntel', configurable: true});
  Object.defineProperty(navigator, 'vendor', {get: () => 'Google Inc.', configurable: true});
  Object.defineProperty(navigator, 'userAgent', {
    get: function() { return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'; },
    configurable: true, enumerable: true
  });
  Object.defineProperty(navigator, 'userAgentData', {
    get: function() {
      return {
        brands: [
          {brand: 'Not=A?Brand', version: '99'},
          {brand: 'Google Chrome', version: '132'},
          {brand: 'Chromium', version: '132'}
        ],
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: function(hints) {
          return Promise.resolve({
            platform: 'macOS', platformVersion: '14.0.0',
            architecture: 'arm', model: '',
            uaFullVersion: '132.0.6834.160',
            fullVersionList: [
              {brand: 'Not=A?Brand', version: '99.0.0.0'},
              {brand: 'Google Chrome', version: '132.0.6834.160'},
              {brand: 'Chromium', version: '132.0.6834.160'}
            ]
          });
        }
      };
    },
    configurable: true, enumerable: true
  });
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {writable: true, enumerable: true, configurable: false, value: {}});
  }
  window.chrome.runtime = {};
  window.chrome.loadTimes = function() { return {}; };
  window.chrome.csi = function() { return {}; };
  window.chrome.app = { isInstalled: false };
  const _origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications' ? Promise.resolve({state: Notification.permission}) : _origQuery(p);
  Object.defineProperty(Error.prototype, 'name', {configurable: false, enumerable: false});
  (function() {
    const noise = (canvas) => {
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx || canvas.width < 16 || canvas.height < 16) return;
        const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const n = Math.max(3, Math.floor(canvas.width * canvas.height / 1000));
        for (let i = 0; i < n; i++) {
          const px = Math.floor(Math.random() * canvas.width);
          const py = Math.floor(Math.random() * canvas.height);
          const idx = (py * canvas.width + px) * 4;
          id.data[idx] ^= 1; id.data[idx+1] ^= 1; id.data[idx+2] ^= 1;
        }
        ctx.putImageData(id, 0, 0);
      } catch(e) {}
    };
    const _origTDU = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() { noise(this); return _origTDU.apply(this, arguments); };
    const _origTB = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(cb) { noise(this); return _origTB.call(this, cb, Array.prototype.slice.call(arguments, 1)); };
    const _origGID = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(x,y,w,h) {
      const r = _origGID.call(this, x, y, w, h);
      if (w*h > 100) { for (let i=0, n=Math.max(1,Math.floor(w*h/500)); i<n; i++) { r.data[Math.floor(Math.random()*r.data.length)] ^= 1; } }
      return r;
    };
  })();
  (function() {
    const hook = (proto) => {
      const _orig = proto.prototype.getParameter;
      proto.prototype.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel Iris OpenGL Engine';
        return _orig.call(this, p);
      };
    };
    if (typeof WebGLRenderingContext !== 'undefined') hook(WebGLRenderingContext);
    if (typeof WebGL2RenderingContext !== 'undefined') hook(WebGL2RenderingContext);
  })();
})();
"""

# Extra fix: override userAgentData + userAgent to match Chrome/132 (not headless 139)
_UADATA_FIX_JS = r"""
Object.defineProperty(navigator, 'userAgent', {
  get: function() { return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'; },
  configurable: true, enumerable: true
});
Object.defineProperty(navigator, 'userAgentData', {
  get: function() {
    return {
      brands: [
        {brand: 'Not=A?Brand', version: '99'},
        {brand: 'Google Chrome', version: '132'},
        {brand: 'Chromium', version: '132'}
      ],
      mobile: false,
      platform: 'macOS',
      getHighEntropyValues: function(hints) {
        return Promise.resolve({
          platform: 'macOS', platformVersion: '14.0.0',
          architecture: 'arm', model: '',
          uaFullVersion: '132.0.6834.160',
          fullVersionList: [
            {brand: 'Not=A?Brand', version: '99.0.0.0'},
            {brand: 'Google Chrome', version: '132.0.6834.160'},
            {brand: 'Chromium', version: '132.0.6834.160'}
          ]
        });
      }
    };
  },
  configurable: true, enumerable: true
});
"""

# Path setup
_SOTA_DIR = Path(__file__).resolve().parent
if str(_SOTA_DIR) not in sys.path:
    sys.path.insert(0, str(_SOTA_DIR))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="cmd-headless", description="One-command browser automation")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--local", action="store_true", help="Force local Playwright")
    g.add_argument("--cloud", action="store_true", help="Force Browser Use Cloud API")
    g.add_argument("--auto", action="store_true", default=True, help="Auto-detect (default)")
    p.add_argument("--cdp", action="store_true", help="Connect to existing Chrome via CDP")
    p.add_argument("--cdp-port", type=int, default=9222, help="CDP port (default: 9222)")
    p.add_argument("--cookies", choices=["chrome", "brave", "firefox"], help="Import cookies from browser")
    p.add_argument("--domain", help="Filter cookies by domain")
    p.add_argument("--import-only", action="store_true", help="Import cookies and output JSON only")
    p.add_argument("--profile-dir", help="Persist cookies/localStorage across runs")
    p.add_argument("--no-stealth", action="store_true", help="Disable anti-detection evasions")
    p.add_argument("--sdk", action="store_true", help="Use browser-use-sdk for cloud tasks")
    p.add_argument("--json", action="store_true", help="Output results as JSON")
    p.add_argument("--screenshot", help="Save screenshot to file")
    p.add_argument("--botright", action="store_true",
                   help="Use Botright stealth browser (enhanced stealth + free CAPTCHA solving). "
                        "Install with: pip install botright && playwright install")
    p.add_argument("--cloakbrowser", action="store_true",
                   help="Use CloakBrowser (71 C++ stealth patches). "
                        "Install with: pip install cloakbrowser")
    p.add_argument("--proxy", help="Proxy URL (http/socks5://user:pass@host:port). "
                   "Or set BH_PROXY env var. Use --proxy-list for multiple.")
    p.add_argument("--proxy-list", help="File with proxy list (one per line). Rotates automatically.")
    p.add_argument("--geoip", action="store_true", help="Match timezone/locale to proxy IP (requires geoip package).")
    p.add_argument("--humanize", action="store_true", default=True,
                   help="Human-like mouse/keyboard/scroll (CloakBrowser). Default: on")
    p.add_argument("--no-humanize", action="store_false", dest="humanize",
                   help="Disable human-like behavior")
    p.add_argument("--cost", action="store_true", help="Show cost breakdown")
    p.add_argument("--version", action="store_true", help="Show version")
    # Local CAPTCHA solver (open source, no paid API)
    p.add_argument("--solve-captcha", action="store_true",
                   help="Solve CAPTCHA (Turnstile/reCAPTCHA) on the page before proceeding")
    p.add_argument("--captcha-type", choices=["turnstile", "recaptcha-v2", "auto"], default="auto",
                   help="Type of CAPTCHA to solve (default: auto-detect)")
    p.add_argument("prompt", nargs="*", help="Natural language prompt")
    return p.parse_args()


def extract_cookies(browser: str, domain: Optional[str] = None) -> Dict:
    try:
        import browser_cookie3
    except ImportError:
        return {"error": "browser_cookie3 not installed. Run: pip install browser-cookie3"}
    cb_map = {"chrome": browser_cookie3.chrome, "brave": browser_cookie3.brave, "firefox": browser_cookie3.firefox}
    if browser not in cb_map:
        return {"error": f"Unsupported browser: {browser}. Use: chrome, brave, or firefox"}
    try:
        cookies = cb_map[browser]()
        if domain:
            cookies = [c for c in cookies if domain in c.domain]
        return {
            "cookies": [{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path,
                         "secure": c.secure, "httpOnly": getattr(c, 'httponly', False),
                         "sameSite": getattr(c, 'samesite', 'None')} for c in cookies],
            "count": len(cookies), "browser": browser, "domain": domain,
        }
    except Exception as e:
        return {"error": str(e), "cookies": [], "count": 0}


def _find_cdp_endpoint(port: int = 9222) -> Optional[str]:
    import urllib.request
    try:
        resp = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3)
        return json.loads(resp.read()).get("webSocketDebuggerUrl")
    except Exception:
        return None


def _launch_chrome_with_cdp(port: int = 9222) -> bool:
    import subprocess
    for path in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                 "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                 "/Applications/Chromium.app/Contents/MacOS/Chromium"]:
        if os.path.exists(path):
            subprocess.Popen([path, f"--remote-debugging-port={port}",
                              "--no-first-run", "--no-default-browser-check",
                              "--user-data-dir=/tmp/chrome-cdp"])
            return True
    return False


async def _apply_stealth(context) -> bool:
    """Apply playwright-stealth anti-detection evasions to a context."""
    try:
        from playwright_stealth import Stealth
        stealth_obj = Stealth(
            # Disable BOTH userAgent and userAgentData evasions in playwright-stealth
            # They conflict with our _UADATA_FIX_JS which properly patches both
            navigator_user_agent=False,
            navigator_user_agent_data=False,
            navigator_platform_override="MacIntel",
            navigator_languages_override=("en-US", "en"),
            webgl_vendor_override="Intel Inc.",
            webgl_renderer_override="Intel Iris OpenGL Engine",
            chrome_runtime=False,
            hairline=False,
            iframe_content_window=False,
        )
        await stealth_obj.apply_stealth_async(context)
        print("[cmd-headless] stealth: playwright-stealth (userAgent/userAgentData evasions disabled)", file=sys.stderr)
    except ImportError:
        pass
    except Exception as e:
        print(f"[cmd-headless] Stealth library error: {e}, using manual fallback", file=sys.stderr)

    # Our fix: override navigator.userAgent AND userAgentData to Chrome/132
    # This must be the LAST init script so it runs after playwright-stealth
    try:
        await context.add_init_script(_UADATA_FIX_JS)
        print("[cmd-headless] stealth: ua-data fix applied", file=sys.stderr)
    except Exception as e:
        print(f"[cmd-headless] UA fix failed: {e}", file=sys.stderr)

    return True


async def _browse_local(prompt: str, cookies: List = None, stealth: bool = True,
                        profile_dir: str = None, screenshot: str = None,
                        timeout: int = 30, nopecha_extension: str = None,
                        use_cloakbrowser: bool = False, use_botright: bool = False,
                        proxy: str = None) -> Dict:
    from playwright.async_api import async_playwright
    url_match = re.search(r"go to (\S+)", prompt)
    if not url_match:
        return {"error": "No URL found in prompt. Use: go to <url>"}
    url = url_match.group(1)
    if not url.startswith("http"):
        url = "https://" + url

    # Try CloakBrowser first if requested (highest stealth)
    # CloakBrowser uses Playwright Sync API internally, must run in thread
    if use_cloakbrowser:
        try:
            import threading

            def _cloakbrowser_task():
                from cloakbrowser import launch as cloak_launch
                cloak_kwargs = {"headless": True, "humanize": True}
                if proxy:
                    cloak_kwargs["proxy"] = proxy
                browser = cloak_launch(**cloak_kwargs)
                page = browser.new_page()
                result = {}
                try:
                    response = page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
                    result["status"] = response.status if response else 0
                except Exception as e:
                    result["error"] = f"Navigation failed: {e}"
                    result["url"] = url
                    browser.close()
                    return result
                page.wait_for_timeout(1000)
                result["url"] = page.url
                result["title"] = page.title()
                result["stealth"] = "cloakbrowser"
                if screenshot:
                    page.screenshot(path=screenshot, full_page=True)
                    result["screenshot"] = screenshot
                browser.close()
                return result

            result = await asyncio.get_event_loop().run_in_executor(None, _cloakbrowser_task)
            if result.get("error"):
                return result
            return result
        except ImportError:
            print("[cmd-headless] CloakBrowser not installed. Falling back to Playwright.", file=sys.stderr)
        except Exception as e:
            print(f"[cmd-headless] CloakBrowser error: {e}. Falling back to Playwright.", file=sys.stderr)

    # Try Botright if requested (enhanced stealth + CAPTCHA solving)
    # Botright uses Playwright Sync API internally, must run in thread
    if use_botright:
        try:
            def _botright_task():
                from botright import Botright
                botright = Botright(headless=True)
                browser = botright.launch()
                page = browser.new_page()
                result = {}
                try:
                    response = page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
                    result["status"] = response.status if response else 0
                except Exception as e:
                    result["error"] = f"Navigation failed: {e}"
                    result["url"] = url
                    botright.close()
                    return result
                page.wait_for_timeout(1000)
                result["url"] = page.url
                result["title"] = page.title()
                result["stealth"] = "botright"
                if screenshot:
                    page.screenshot(path=screenshot, full_page=True)
                    result["screenshot"] = screenshot
                botright.close()
                return result

            result = await asyncio.get_event_loop().run_in_executor(None, _botright_task)
            if result.get("error"):
                return result
            return result
        except ImportError:
            print("[cmd-headless] Botright not installed. Falling back to Playwright.", file=sys.stderr)
        except Exception as e:
            print(f"[cmd-headless] Botright error: {e}. Falling back to Playwright.", file=sys.stderr)

    # Default: Vanilla Playwright
    async with async_playwright() as p:
        # Build launch arguments
        launch_args = ["--no-sandbox", "--disable-setuid-sandbox"]
        if nopecha_extension:
            launch_args.append(f"--load-extension={nopecha_extension}")
            print(f"[cmd-headless] Loading Nopecha extension: {nopecha_extension}", file=sys.stderr)
        else:
            launch_args.append("--disable-extensions")

        browser = await p.chromium.launch(headless=True, args=launch_args)
        context_kwargs = {
            "viewport": {"width": 1280, "height": 720},
            "user_agent": USER_AGENT,
            "locale": "en-US",
            "timezone_id": "America/New_York",
            "extra_http_headers": {
                "sec-ch-ua": '"Google Chrome";v="132", "Chromium";v="132", "Not=A?Brand";v="99"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"macOS"',
            },
        }
        if profile_dir:
            os.makedirs(profile_dir, exist_ok=True)
            context_kwargs["storage_state"] = os.path.join(profile_dir, "state.json")
        context = await browser.new_context(**context_kwargs)
        if stealth:
            await _apply_stealth(context)
        if cookies:
            clean = [{k: v for k, v in c.items()
                      if k in ("name", "value", "domain", "path", "secure", "httpOnly", "sameSite")}
                     for c in cookies]
            await context.add_cookies(clean)
        page = await context.new_page()
        try:
            response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            status = response.status if response else 0
        except Exception as e:
            return {"error": f"Navigation failed: {e}", "url": url}
        await asyncio.sleep(1)
        title = await page.title()
        try:
            text = await page.evaluate("() => document.body?.innerText || ''")
        except Exception:
            text = ""
        result = {"url": page.url, "title": title, "status": status,
                  "text": text[:10000], "text_length": len(text)}
        if screenshot:
            await page.screenshot(path=screenshot, full_page=True)
            result["screenshot"] = screenshot
        if profile_dir:
            state_path = os.path.join(profile_dir, "state.json")
            await context.storage_state(path=state_path)
            result["profile_saved"] = state_path
        await browser.close()
        return result


def _browse_cloud(prompt: str, api_key: str, timeout: int = 30) -> Dict:
    import httpx
    base = "https://api.browser-use.com/api/v3"
    try:
        resp = httpx.post(f"{base}/sessions", headers={"Authorization": f"Bearer {api_key}"},
                          json={"task": prompt, "model": "bu-max"}, timeout=timeout)
        session = resp.json()
        session_id = session.get("session_id")
        if not session_id:
            return {"error": "No session_id returned"}
        for _ in range(timeout):
            time.sleep(1)
            try:
                state_resp = httpx.get(f"{base}/sessions/{session_id}",
                                       headers={"Authorization": f"Bearer {api_key}"}, timeout=10)
                state = state_resp.json().get("state", "running")
                if state == "done":
                    result_resp = httpx.get(f"{base}/sessions/{session_id}/result",
                                           headers={"Authorization": f"Bearer {api_key}"}, timeout=10)
                    return result_resp.json()
                elif state in ("failed", "error"):
                    return {"error": f"Cloud task {state}", "session_id": session_id, "status": state}
            except Exception:
                pass
        return {"error": "Timeout waiting for cloud task", "session_id": session_id}
    except Exception as e:
        return {"error": str(e)}


def main() -> int:
    args = parse_args()
    if args.version:
        print("cmd-headless v1.7.0 (sota-browser)")
        print("Modes: --local (Playwright) | --cloud (Browser Use API) | --cdp (existing Chrome)")
        print("Cookies: --cookies chrome|brave|firefox [--domain DOMAIN]")
        print("Stealth: CloakBrowser (71 C++ patches) | Botright | playwright-stealth")
        print("Proxy: --proxy URL | --proxy-list FILE (rotating)")
        print("Profile: --profile-dir DIR (persist cookies/localStorage across runs)")
        print("CAPTCHA: --solve-captcha [--captcha-type auto|turnstile|recaptcha-v2]")
        return 0
    if args.cost:
        print("Local mode: FREE (Playwright)")
        print("Cloud mode: $0.08/task (Browser Use API, bu_ key)")
        print("CDP mode:  FREE (existing Chrome)")
        print("CloakBrowser: FREE (71 C++ patches, no API needed)")
        print("Botright: FREE (enhanced stealth, built-in free CAPTCHA solving)")
        print("CAPTCHA: FREE (local solver - Turnstile, reCAPTCHA v2)")
        print("Proxy: FREE (bring your own proxies)")
        return 0

    prompt = " ".join(args.prompt) if args.prompt else ""
    if args.import_only:
        result = extract_cookies(args.cookies, args.domain)
        print(json.dumps(result, indent=2))
        return 0
    if args.cookies and not args.import_only:
        cookies_data = extract_cookies(args.cookies, args.domain)
        if "error" in cookies_data:
            print(json.dumps(cookies_data, indent=2))
            return 1
        cookies = cookies_data.get("cookies", [])
        print(f"[cmd-headless] Loaded {len(cookies)} cookies from {args.cookies}", file=sys.stderr)
    else:
        cookies = None
    if args.cloud or (not args.local and not args.cdp and (args.sdk or "cloud" in prompt.lower())):
        api_key = os.environ.get("BROWSER_USE_API_KEY") or os.environ.get("BU_API_KEY")
        if not api_key:
            print("Error: Cloud mode requires BROWSER_USE_API_KEY env var", file=sys.stderr)
            return 1
        result = _browse_cloud(prompt, api_key)
    elif args.cdp:
        cdp_url = _find_cdp_endpoint(args.cdp_port)
        if not cdp_url:
            print(f"[cmd-headless] No Chrome on port {args.cdp_port}. Launching...", file=sys.stderr)
            _launch_chrome_with_cdp(args.cdp_port)
            time.sleep(2)
            cdp_url = _find_cdp_endpoint(args.cdp_port)
            if not cdp_url:
                print("Error: Could not connect to Chrome CDP", file=sys.stderr)
                return 1
        result = {"note": f"CDP mode connected to port {args.cdp_port}", "cdp_url": cdp_url, "prompt": prompt}
    else:
        stealth = not args.no_stealth
        result = asyncio.run(_browse_local(
            prompt,
            cookies=cookies,
            stealth=stealth,
            profile_dir=args.profile_dir,
            screenshot=args.screenshot,
            use_cloakbrowser=args.cloakbrowser,
            use_botright=args.botright,
            proxy=args.proxy,
        ))

        # Optionally solve CAPTCHA after browsing
        if args.solve_captcha and result.get("url"):
            from tools.captcha import LocalCaptchaSolver
            solver = LocalCaptchaSolver()

            async def solve_captcha_async():
                try:
                    if args.captcha_type in ("auto", "turnstile"):
                        captcha_result = await solver.solve_turnstile(result["url"])
                        if captcha_result.get("success"):
                            print(f"[cmd-headless] CAPTCHA solved: {captcha_result.get('type')}", file=sys.stderr)
                            result["captcha_token"] = captcha_result.get("token")
                    if args.captcha_type in ("auto", "recaptcha-v2"):
                        if "captcha_token" not in result:
                            captcha_result = await solver.solve_recaptcha_v2(result["url"])
                            if captcha_result.get("success"):
                                print(f"[cmd-headless] reCAPTCHA v2 solved", file=sys.stderr)
                                result["captcha_token"] = captcha_result.get("token")
                except Exception as e:
                    print(f"[cmd-headless] CAPTCHA solving failed: {e}", file=sys.stderr)
                finally:
                    await solver.stop_browser()

            asyncio.run(solve_captcha_async())

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if isinstance(result, dict):
            if "error" in result:
                print(f"Error: {result['error']}", file=sys.stderr)
                return 1
            if "text" in result:
                print(result["text"][:3000])
            else:
                print(json.dumps(result, indent=2))
        else:
            print(str(result)[:3000])
    return 0


if __name__ == "__main__":
    sys.exit(main())