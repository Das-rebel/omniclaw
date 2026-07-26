"""
SOTA Browser — Proxy Rotation Manager

Provides automatic proxy rotation for browser sessions.
Supports:
- HTTP/HTTPS/SOCKS5 proxies
- Proxy lists from file or env var
- Per-session sticky proxies
- Automatic proxy health checks
- GeoIP-based proxy selection

Usage:
    from proxy_manager import ProxyPool
    pool = ProxyPool(["proxy1:port", "proxy2:port"])
    proxy = pool.get_next()  # Rotate to next proxy
    pool.mark_failed(proxy)  # Mark as failed, remove from pool
"""

from __future__ import annotations

import asyncio
import os
import random
import time
from typing import List, Optional, Dict
from dataclasses import dataclass, field
import logging

logger = logging.getLogger("sota-browser.proxy")

@dataclass
class Proxy:
    """Represents a single proxy."""
    url: str
    username: Optional[str] = None
    password: Optional[str] = None
    geoip: Optional[str] = None  # Country code (US, IN, etc.)
    last_used: float = 0
    failures: int = 0
    success_count: int = 0
    avg_latency: float = 0
    is_sticky: bool = False  # Keep same proxy for session

    @property
    def display_url(self) -> str:
        """Safe display URL (mask password)."""
        if "@" in self.url:
            parts = self.url.split("@")
            return f"{parts[0].split(':')[0]}:***@{parts[1]}"
        return self.url

    def format_for_browser(self) -> str:
        """Format URL with credentials for browser/proxy auth."""
        return self.url

class ProxyPool:
    """
    Manages a pool of proxies with rotation, health tracking, and sticky sessions.

    Usage:
        pool = ProxyPool.from_env("BH_PROXY_LIST")  # or ["proxy1:port", ...]
        proxy = pool.get_next()  # Get next proxy
        pool.mark_success(proxy)  # Record success
        pool.mark_failed(proxy)  # Record failure, remove from rotation
    """

    def __init__(
        self,
        proxies: List[str] = None,
        sticky_sessions: bool = False,
        max_failures: int = 3,
        health_check_interval: int = 300,
    ):
        self._proxies: List[Proxy] = []
        self._sticky_sessions = sticky_sessions
        self._max_failures = max_failures
        self._health_check_interval = health_check_interval
        self._session_proxy: Optional[Proxy] = None  # Sticky proxy for current session
        self._lock = asyncio.Lock()

        if proxies:
            for p in proxies:
                self.add_proxy(p)

    @classmethod
    def from_env(cls, env_var: str = "BH_PROXY_LIST", separator: str = ",") -> "ProxyPool":
        """Create ProxyPool from environment variable (comma-separated proxy URLs)."""
        proxy_str = os.environ.get(env_var, "")
        if not proxy_str:
            # Try common env vars
            for var in ["PROXY_LIST", "PROXIES", "SCRAPER_PROXY"]:
                proxy_str = os.environ.get(var, "")
                if proxy_str:
                    break

        proxies = [p.strip() for p in proxy_str.split(separator) if p.strip()] if proxy_str else []
        return cls(proxies=proxies)

    @classmethod
    def from_file(cls, filepath: str) -> "ProxyPool":
        """Load proxies from a file (one per line)."""
        proxies = []
        try:
            with open(filepath) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        proxies.append(line)
        except FileNotFoundError:
            logger.warning(f"Proxy file not found: {filepath}")
        return cls(proxies=proxies)

    def add_proxy(self, proxy_url: str, geoip: str = None) -> None:
        """Add a proxy to the pool."""
        # Parse credentials if embedded
        username, password, host = self._parse_proxy_url(proxy_url)
        proxy = Proxy(
            url=proxy_url,
            username=username,
            password=password,
            geoip=geoip,
        )
        self._proxies.append(proxy)

    def _parse_proxy_url(self, url: str) -> tuple:
        """Parse proxy URL to extract components."""
        # Format: [scheme://][username:password@]host[:port]
        if "://" not in url:
            url = f"http://{url}"

        try:
            from urllib.parse import urlparse, parse_qs
        except ImportError:
            return None, None, url

        parsed = urlparse(url)
        username = parsed.username
        password = parsed.password
        return username, password, url

    def get_next(self, geo_filter: str = None) -> Optional[Proxy]:
        """
        Get next available proxy, optionally filtered by geo.

        Args:
            geo_filter: Country code (e.g., "US", "IN") to filter proxies

        Returns:
            Next available Proxy or None if pool is empty/exhausted
        """
        if not self._proxies:
            return None

        # Filter by geo if requested
        candidates = self._proxies
        if geo_filter:
            candidates = [p for p in candidates if p.geoip == geo_filter]

        # Remove failed/exhausted proxies
        candidates = [p for p in candidates if p.failures < self._max_failures]

        if not candidates:
            return None

        # Sticky session: keep same proxy for session
        if self._sticky_sessions and self._session_proxy:
            if self._session_proxy in candidates:
                return self._session_proxy

        # Round-robin: pick least recently used
        candidates.sort(key=lambda p: p.last_used)
        proxy = candidates[0]
        proxy.last_used = time.time()

        # Set as sticky for session
        if self._sticky_sessions:
            self._session_proxy = proxy

        return proxy

    def mark_success(self, proxy: Proxy) -> None:
        """Record successful use of a proxy."""
        proxy.success_count += 1
        proxy.failures = 0  # Reset on success

    def mark_failed(self, proxy: Proxy) -> None:
        """Record failed use of a proxy. Removes from pool if max failures reached."""
        proxy.failures += 1
        if proxy.failures >= self._max_failures:
            self._proxies.remove(proxy)
            if self._session_proxy == proxy:
                self._session_proxy = None
            logger.warning(f"Proxy removed after {proxy.failures} failures: {proxy.display_url}")

    def get_stats(self) -> Dict:
        """Get proxy pool statistics."""
        total = len(self._proxies)
        available = sum(1 for p in self._proxies if p.failures < self._max_failures)
        return {
            "total": total,
            "available": available,
            "failed": total - available,
            "sticky_session": self._session_proxy.display_url if self._session_proxy else None,
        }

    async def health_check_all(self) -> Dict[str, bool]:
        """Ping all proxies, mark unreachable ones as failed."""
        import socket

        results = {}
        for proxy in list(self._proxies):
            try:
                # Simple TCP connect check
                host = proxy.url.split("@")[-1].split(":")[0] if "@" in proxy.url else proxy.url.split(":")[0]
                port = int(proxy.url.split(":")[-1]) if ":" in proxy.url else 8080
                sock = socket.socket()
                sock.settimeout(5)
                result = sock.connect_ex((host, port))
                sock.close()
                alive = result == 0
                results[proxy.display_url] = alive
                if not alive:
                    self.mark_failed(proxy)
            except Exception as e:
                results[proxy.display_url] = False
                self.mark_failed(proxy)

        return results


class ProxyMiddleware:
    """
    Playwright route interception middleware for automatic proxy rotation.

    Usage:
        from proxy_manager import ProxyMiddleware
        manager = BrowserManager()
        proxy_mw = ProxyMiddleware(manager, pool)
        await proxy_mw.install()
    """

    def __init__(self, manager, pool: ProxyPool):
        self.manager = manager
        self.pool = pool

    async def install(self) -> None:
        """Install proxy middleware on all contexts."""
        # This would intercept requests and route through rotating proxies
        # Implementation depends on how sessions/contexts are created
        pass

    async def rotate(self, session_id: str = None) -> Optional[Proxy]:
        """Rotate proxy for a session."""
        proxy = self.pool.get_next()
        if proxy and session_id:
            # Apply new proxy to session
            session = self.manager.sessions.get(session_id)
            if session and session.get("context"):
                context = session["context"]
                # Proxy would need to be set on context creation
                # For now, mark for next session
                session["next_proxy"] = proxy
        return proxy


def create_proxy_pool() -> ProxyPool:
    """Factory: Create proxy pool from environment/config."""
    pool = ProxyPool.from_env()

    # Also check for rotating proxies service
    rotating_proxy = os.environ.get("ROTATING_PROXY")
    if rotating_proxy:
        pool.add_proxy(rotating_proxy)

    return pool
