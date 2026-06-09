"""
SOTA Browser MCP Server — Cookie Tools

Handles cookie import/export for browser sessions.
Supports importing from Chrome, Brave, Firefox via browser_cookie3.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Callable, Dict, List, Optional

logger = logging.getLogger("sota-browser.tools.cookies")

# ---------------------------------------------------------------------------
# browser_cookie3 — lazy import (optional dependency)
# ---------------------------------------------------------------------------

_browser_cookie3 = None


def _get_browser_cookie3():
    global _browser_cookie3
    if _browser_cookie3 is None:
        try:
            import browser_cookie3 as bc3

            _browser_cookie3 = bc3
        except ImportError:
            logger.warning("browser_cookie3 not installed — Chrome cookie import unavailable")
            _browser_cookie3 = False
    return _browser_cookie3


# ── MCP Tool Schemas ──────────────────────────────────────────────────

SCHEMAS = [
    {
        "name": "browser_import_cookies",
        "description": (
            "Import cookies into a browser session. Accepts cookies as an array of "
            "{name, value, domain, path, secure} objects, or a JSON string of such an array."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "cookies": {
                    "description": "Array of cookie objects or JSON string",
                },
            },
            "required": ["session_id", "cookies"],
        },
    },
    {
        "name": "browser_export_cookies",
        "description": "Export all cookies from a session context",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "required": ["session_id"],
        },
    },
    {
        "name": "browser_clear_cookies",
        "description": "Clear all cookies from a session context",
        "inputSchema": {
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "required": ["session_id"],
        },
    },
    {
        "name": "browser_import_cookies_from_browser",
        "description": (
            "Extract cookies from an installed browser (Chrome, Brave, Firefox) "
            "and import them into a session. Uses browser_cookie3 to read the "
            "browser's cookie database directly. Supports domain filtering."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "Session ID to import cookies into",
                },
                "browser": {
                    "type": "string",
                    "enum": ["chrome", "brave", "firefox"],
                    "description": "Browser to extract cookies from (default: chrome)",
                },
                "domain": {
                    "type": "string",
                    "description": "Filter to a specific domain (e.g. 'google.com'). Omit for all cookies.",
                },
                "domains": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Filter to multiple domains",
                },
            },
            "required": ["session_id"],
        },
    },
]


# ── Cookie extraction helpers ─────────────────────────────────────────


def _extract_cookies_from_browser(
    browser: str = "chrome",
    domain: Optional[str] = None,
    domains: Optional[List[str]] = None,
) -> List[dict]:
    """Extract cookies from a browser using browser_cookie3.

    Returns a list of cookie dicts compatible with Playwright's add_cookies().
    """
    bc3 = _get_browser_cookie3()
    if not bc3:
        return []

    loader_map = {
        "chrome": bc3.chrome,
        "brave": bc3.brave,
        "firefox": bc3.firefox,
    }

    loader = loader_map.get(browser.lower())
    if not loader:
        logger.warning("Unknown browser: %s", browser)
        return []

    try:
        raw_cookies = loader()
    except Exception as e:
        logger.warning("Failed to load cookies from %s: %s", browser, e)
        return []

    # Collect domain filters
    filter_domains = set()
    if domain:
        filter_domains.add(domain.lower().lstrip("."))
    if domains:
        for d in domains:
            filter_domains.add(d.lower().lstrip("."))

    cookies: List[dict] = []
    seen = set()
    now = time.time()

    for c in raw_cookies:
        try:
            c_domain = (getattr(c, "domain", "") or "").lstrip(".")
            c_name = getattr(c, "name", "") or ""
            c_value = getattr(c, "value", "") or ""

            # Skip empty cookies
            if not c_name or not c_domain:
                continue

            # Domain filtering
            if filter_domains and c_domain not in filter_domains:
                # Also check if this is a subdomain of any filter
                matched = False
                for fd in filter_domains:
                    if c_domain.endswith("." + fd) or c_domain == fd:
                        matched = True
                        break
                if not matched:
                    continue

            # Check expiry
            expires = getattr(c, "expires", None)
            if expires is not None:
                try:
                    if isinstance(expires, (int, float)) and expires < now:
                        continue  # expired
                    if hasattr(expires, "timestamp") and expires.timestamp() < now:
                        continue
                except Exception:
                    pass  # can't parse — keep it

            # Deduplicate by domain+name
            key = f"{c_domain}|{c_name}"
            if key in seen:
                continue
            seen.add(key)

            cookie = {
                "name": c_name,
                "value": c_value,
                "domain": c_domain,
                "path": getattr(c, "path", "/") or "/",
                "secure": bool(getattr(c, "secure", False)),
            }

            # Optional fields
            if hasattr(c, "httpOnly"):
                cookie["httpOnly"] = bool(c.httpOnly)
            if hasattr(c, "sameSite") and c.sameSite:
                cookie["sameSite"] = c.sameSite

            cookies.append(cookie)

        except Exception:
            continue

    logger.info(
        "Extracted %d cookies from %s (filtered from %d raw, domains=%s)",
        len(cookies),
        browser,
        len(list(raw_cookies)) if hasattr(raw_cookies, "__len__") else 0,
        filter_domains or "all",
    )
    return cookies


# ── Handler Registration ──────────────────────────────────────────────


def register(manager) -> Dict[str, Callable]:
    handlers: Dict[str, Callable] = {}

    # ── browser_import_cookies ────────────────────────────────────────
    async def browser_import_cookies(**kwargs):
        cookies = kwargs["cookies"]

        # Accept JSON string
        if isinstance(cookies, str):
            try:
                cookies = json.loads(cookies)
            except json.JSONDecodeError:
                return {"error": "Invalid JSON for cookies"}

        return await manager.import_cookies(kwargs["session_id"], cookies)

    handlers["browser_import_cookies"] = browser_import_cookies

    # ── browser_export_cookies ────────────────────────────────────────
    async def browser_export_cookies(**kwargs):
        return await manager.export_cookies(kwargs["session_id"])

    handlers["browser_export_cookies"] = browser_export_cookies

    # ── browser_clear_cookies ─────────────────────────────────────────
    async def browser_clear_cookies(**kwargs):
        return await manager.clear_cookies(kwargs["session_id"])

    handlers["browser_clear_cookies"] = browser_clear_cookies

    # ── browser_import_cookies_from_browser ───────────────────────────
    async def browser_import_cookies_from_browser(**kwargs):
        session_id = kwargs["session_id"]
        browser = kwargs.get("browser", "chrome")
        domain = kwargs.get("domain")
        domains = kwargs.get("domains")

        cookies = _extract_cookies_from_browser(
            browser=browser,
            domain=domain,
            domains=domains,
        )

        if not cookies:
            return {
                "success": False,
                "error": f"No cookies found from {browser}"
                + (f" for {domain or domains}" if domain or domains else ""),
                "cookies_imported": 0,
            }

        result = await manager.import_cookies(session_id, cookies)
        result["cookies_imported"] = len(cookies)
        result["source_browser"] = browser
        if domain:
            result["domain"] = domain
        return result

    handlers["browser_import_cookies_from_browser"] = browser_import_cookies_from_browser

    return handlers
