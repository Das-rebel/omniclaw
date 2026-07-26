#!/usr/bin/env python3
"""
SOTA Browser MCP Server — Entry Point (v1.7.0)

Thin JSON-RPC stdio loop that delegates to modular tools + middleware.
Drop-in compatible with the previous monolithic mcp_server.py.

Stealth Browsers (v1.7.0):
- CloakBrowser: 71 C++ patches (canvas, WebGL, audio, fonts, GPU, WebRTC)
- Botright: Enhanced stealth + built-in free CAPTCHA solving
- Proxy rotation: ProxyPool for automatic proxy management

Local CAPTCHA Solver (v1.5.0):
- Tools: captcha_solve_turnstile, captcha_solve_recaptcha_v2, captcha_check_status
"""

import asyncio
import json
import logging
import sys

from config import MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION
from browser_manager import BrowserManager
from tools import get_all_schemas, register_all
from middleware import MiddlewarePipeline
from middleware.guardrails import GuardrailsMiddleware
from middleware.cost_tracker import CostTrackerMiddleware
from middleware.semantic_cache import SemanticCacheMiddleware
from middleware.circuit_breaker import CircuitBreakerMiddleware
from middleware.retry import RetryMiddleware
from middleware.memory import MemoryMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="[%(name)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("sota-browser")


class MCPServer:
    def __init__(self):
        self.browser = BrowserManager()
        self._initialized = False
        self._handlers: dict = {}
        self._pipeline: MiddlewarePipeline | None = None
        self._memory_mw: MemoryMiddleware | None = None

    async def initialize(self) -> None:
        await self.browser.start()
        self._handlers = register_all(self.browser)

        # Build middleware pipeline (outer → inner):
        # guardrails → cost_tracker → semantic_cache → circuit_breaker → retry → execute
        self._memory_mw = MemoryMiddleware()
        self._pipeline = MiddlewarePipeline([
            GuardrailsMiddleware(strict_mode=False),
            CostTrackerMiddleware(default_budget=10000.0),
            SemanticCacheMiddleware(),
            CircuitBreakerMiddleware(),
            RetryMiddleware(),
            self._memory_mw,
        ])

        self._initialized = True
        logger.info("Server initialized: %d tools registered", len(self._handlers))

    def _write(self, msg: dict) -> None:
        print(json.dumps(msg), flush=True)

    # ------------------------------------------------------------------
    # JSON-RPC dispatch
    # ------------------------------------------------------------------

    async def handle(self, req: dict) -> dict | None:
        method = req.get("method", "")
        req_id = req.get("id")
        params = req.get("params", {})

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": True}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                },
            }

        if method == "notifications/initialized":
            return None

        if method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": get_all_schemas()},
            }

        if method == "tools/call":
            tool_name = params.get("name", "")
            args = params.get("arguments", {})
            try:
                result = await self._call_tool(tool_name, args)
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"content": [{"type": "text", "text": json.dumps(result)}]},
                }
            except Exception as exc:
                logger.exception("Tool call failed: %s", tool_name)
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32603, "message": str(exc)},
                }

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Unknown method: {method}"},
        }

    async def _call_tool(self, name: str, args: dict) -> dict:
        handler = self._handlers.get(name)
        if not handler:
            return {"error": f"Unknown tool: {name}"}

        # Session/tab-level tools bypass middleware (no tab_id, no url)
        bypass = name in {
            "browser_create_session", "browser_create_tab", "browser_close_session",
            "browser_list_tabs", "browser_info", "browser_import_cookies",
            "browser_export_cookies", "browser_clear_cookies",
            "browser_parse_resume", "browser_switch_tab",
        }

        if bypass or not self._pipeline:
            return await handler(**args)

        return await self._pipeline.execute(name, args, handler)

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
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
            except Exception as exc:
                logger.exception("Unhandled error in main loop")
                self._write({
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32603, "message": str(exc)},
                })

        await self.browser.shutdown()


if __name__ == "__main__":
    asyncio.run(MCPServer().run())
