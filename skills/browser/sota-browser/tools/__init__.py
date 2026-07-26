"""
SOTA Browser MCP Server — Tools Package

Collects all tool schemas and handlers from sub-modules.
"""

from __future__ import annotations

import logging
import importlib
from typing import Any, Callable, Dict, List

logger = logging.getLogger("sota-browser.tools")

# Tool sub-modules in registration order
_TOOL_MODULE_NAMES = [
    "tools.session_tools",
    "tools.navigation",
    "tools.interaction",
    "tools.snapshot",
    "tools.frames",
    "tools.cookies",
    "tools.http_tools",
    "tools.form_tools",
    "tools.download",
    "tools.dialog",
    "tools.network",
    "tools.wait",
    "tools.captcha",
]


def get_all_schemas() -> List[dict]:
    """Collect MCP tool schemas from all tool modules."""
    schemas = []
    for mod_name in _TOOL_MODULE_NAMES:
        mod = importlib.import_module(mod_name)
        schemas.extend(mod.SCHEMAS)
    return schemas


def register_all(manager) -> Dict[str, Callable]:
    """Register all tool handlers. Returns {tool_name: async_handler}."""
    handlers: Dict[str, Callable] = {}
    for mod_name in _TOOL_MODULE_NAMES:
        mod = importlib.import_module(mod_name)
        mod_handlers = mod.register(manager)
        overlap = set(handlers.keys()) & set(mod_handlers.keys())
        if overlap:
            logger.warning("Duplicate tool names from %s: %s", mod_name, overlap)
        handlers.update(mod_handlers)
    logger.info("Registered %d tools", len(handlers))
    return handlers
