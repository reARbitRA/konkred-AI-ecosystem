"""HTTP client for the Konkred gateway.

Resilience goals (all exercised by `bot/tests/test_gateway_client.py`):

* **Cold starts** — the gateway container may still be booting when the bot
  starts, so connect errors are retried with exponential backoff + jitter and
  `wait_until_ready()` blocks startup until `/api/health` answers.
* **429 rate limits** — `Retry-After` (seconds or HTTP-date) is honoured; the
  request is re-queued once when the wait is short, otherwise surfaced.
* **503 capacity timeouts** — treated as transient and retried, then surfaced
  with a `retry_after` so the UI can tell the user when to come back.
* **Malformed payloads** — a 200 without `data.content` is an error, never a
  `KeyError` in a handler.
"""
from __future__ import annotations

import asyncio
import logging
import random
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit

import httpx

from config import SETTINGS

logger = logging.getLogger("konkred.gateway")

RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


class GatewayError(Exception):
    """Normalised gateway failure surfaced to handlers."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        retry_after: Optional[int] = None,
        attempts: int = 1,
    ) -> None:
        super().__init__(message)
        self.status_code = int(status_code)
        self.code = str(code)
        self.message = str(message)
        self.retry_after = retry_after
        self.attempts = attempts

    @property
    def is_rate_limited(self) -> bool:
        return self.status_code == 429

    @property
    def is_capacity(self) -> bool:
        return self.status_code in {503, 504, 502}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"GatewayError(status={self.status_code}, code={self.code!r}, retry_after={self.retry_after})"


def _parse_retry_after(response: httpx.Response) -> Optional[int]:
    """Parse `Retry-After` as delta-seconds or HTTP-date, clamped to >= 0."""
    header = response.headers.get("retry-after") or response.headers.get("Retry-After")
    if not header:
        return None
    try:
        return max(0, int(float(header)))
    except (TypeError, ValueError):
        pass
    from email.utils import parsedate_to_datetime

    try:
        delta = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    if delta is None:
        return None
    import datetime as _dt

    now = _dt.datetime.now(_dt.timezone.utc)
    if delta.tzinfo is None:
        delta = delta.replace(tzinfo=_dt.timezone.utc)
    return max(0, int((delta - now).total_seconds()))


def _backoff_delay(attempt: int) -> float:
    base = min(SETTINGS.gateway_retry_backoff_max, SETTINGS.gateway_retry_backoff * (2 ** max(0, attempt - 1)))
    return base / 2 + random.random() * (base / 2)


class GatewayClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        health_url: Optional[str] = None,
        max_retries: Optional[int] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.base_url = self._normalise_inference_url(base_url or SETTINGS.gateway_url)
        # `None` = "use the configured default"; "" = "derive from base_url".
        configured_health = SETTINGS.gateway_health_url if health_url is None else health_url
        self.health_url = self._normalise_health_url(configured_health, self.base_url)
        self.api_key = api_key if api_key is not None else SETTINGS.gateway_api_key
        self.max_retries = SETTINGS.gateway_max_retries if max_retries is None else max(0, int(max_retries))
        # `transport` exists purely for tests (httpx.MockTransport); production
        # leaves it None and uses the real network stack.
        self._transport = transport
        self._client: Optional[httpx.AsyncClient] = None
        self._lock = asyncio.Lock()
        self.stats: Dict[str, int] = {"requests": 0, "retries": 0, "errors": 0, "successes": 0}

    # ------------------------------------------------------------------ #
    # URL normalisation
    # ------------------------------------------------------------------ #
    @staticmethod
    def _normalise_inference_url(url: str) -> str:
        """Accept a bare origin and append the inference path.

        Cloud blueprints (Render/Koyeb) usually only know the service origin, so
        `https://gw.onrender.com` is treated as `https://gw.onrender.com/api/ai`.
        """
        raw = (url or "").strip()
        if not raw:
            raise ValueError("GATEWAY_URL must not be empty")
        if "://" not in raw:
            raw = f"http://{raw}"
        parts = urlsplit(raw)
        path = parts.path.rstrip("/")
        if path in ("", "/"):
            path = "/api/ai"
        return urlunsplit((parts.scheme, parts.netloc, path, "", "")).rstrip("/")

    @staticmethod
    def _normalise_health_url(url: str, inference_url: str) -> str:
        raw = (url or "").strip()
        if not raw:
            parts = urlsplit(inference_url)
            raw = urlunsplit((parts.scheme, parts.netloc, "/api/health", "", ""))
            return raw
        if "://" not in raw:
            raw = f"http://{raw}"
        parts = urlsplit(raw)
        path = parts.path.rstrip("/")
        if path in ("", "/"):
            path = "/api/health"
        return urlunsplit((parts.scheme, parts.netloc, path, "", ""))

    # ------------------------------------------------------------------ #
    # Connection management
    # ------------------------------------------------------------------ #
    def _build_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=httpx.Timeout(SETTINGS.gateway_timeout, connect=SETTINGS.gateway_connect_timeout),
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50),
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "x-api-key": self.api_key,
                "User-Agent": "konkred-telegram-bot/2.0",
            },
            follow_redirects=False,
            transport=self._transport,
        )

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is not None and not self._client.is_closed:
            return self._client
        async with self._lock:
            if self._client is None or self._client.is_closed:
                self._client = self._build_client()
        return self._client

    async def ping(self, timeout: float = 5.0) -> bool:
        """Best-effort liveness probe used during cold-start waits."""
        try:
            client = await self._get_client()
            response = await client.get(self.health_url, timeout=timeout)
            return response.status_code == 200
        except (httpx.HTTPError, RuntimeError) as exc:
            logger.debug("gateway ping failed: %s", exc)
            return False

    async def wait_until_ready(self, timeout: Optional[float] = None, interval: float = 2.0) -> bool:
        """Block until the gateway answers `/api/health` (or timeout).

        Handles the docker-compose race where `depends_on: service_healthy`
        passes but the gateway is still warming its registry/key pool, and the
        Render/Koyeb cold-start case where the service was scaled to zero.
        """
        deadline = asyncio.get_event_loop().time() + (timeout if timeout is not None else SETTINGS.startup_wait_timeout)
        attempt = 0
        while True:
            attempt += 1
            if await self.ping():
                logger.info("gateway ready after %s probe(s)", attempt)
                return True
            if asyncio.get_event_loop().time() >= deadline:
                logger.warning("gateway not ready after %.0fs — continuing, requests will retry", timeout or SETTINGS.startup_wait_timeout)
                return False
            await asyncio.sleep(min(interval, max(0.5, deadline - asyncio.get_event_loop().time())))

    # ------------------------------------------------------------------ #
    # Inference
    # ------------------------------------------------------------------ #
    async def ask(
        self,
        task_type: str,
        messages: List[Dict[str, str]],
        max_tokens: int = 2048,
        temperature: float = 0.3,
        preferred_model: Optional[str] = None,
        privacy: str = "any",
        skip_cache: bool = False,
    ) -> Dict[str, Any]:
        if not messages:
            raise GatewayError(400, "EMPTY_MESSAGES", "No messages supplied to the gateway.")

        payload: Dict[str, Any] = {
            "taskType": task_type or "general",
            "messages": messages,
            "maxTokens": max_tokens,
            "temperature": temperature,
            "privacy": privacy,
            "skipCache": skip_cache,
        }
        if preferred_model:
            payload["model"] = preferred_model

        last_error: Optional[GatewayError] = None
        attempts = 0

        for attempt in range(1, self.max_retries + 2):
            attempts = attempt
            self.stats["requests"] += 1
            try:
                client = await self._get_client()
                response = await client.post(self.base_url, json=payload)
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                # Cold start / DNS not settled yet — always worth retrying.
                last_error = GatewayError(503, "GATEWAY_UNREACHABLE", f"Gateway unreachable: {exc.__class__.__name__}", attempts=attempt)
                logger.warning("gateway connect failure (attempt %s): %s", attempt, exc)
            except httpx.ReadTimeout as exc:
                last_error = GatewayError(504, "GATEWAY_TIMEOUT", f"Gateway read timeout: {exc}", attempts=attempt)
                logger.warning("gateway read timeout (attempt %s)", attempt)
            except httpx.PoolTimeout as exc:
                last_error = GatewayError(503, "POOL_TIMEOUT", f"Local connection pool exhausted: {exc}", attempts=attempt)
            except httpx.RequestError as exc:
                last_error = GatewayError(503, "GATEWAY_UNREACHABLE", f"Gateway communication error: {exc}", attempts=attempt)
                logger.warning("gateway request error (attempt %s): %s", attempt, exc)
            else:
                parsed = self._parse_response(response, attempt)
                if parsed is None:
                    self.stats["successes"] += 1
                    return self._extract_data(response)
                last_error = parsed

            if attempt > self.max_retries:
                break

            wait = 0.0
            if last_error is not None and last_error.retry_after:
                wait = float(min(last_error.retry_after, SETTINGS.gateway_max_retry_wait))
                if last_error.retry_after > SETTINGS.gateway_max_retry_wait:
                    # Not worth blocking a Telegram chat for minutes — surface it.
                    break
            else:
                wait = _backoff_delay(attempt)

            self.stats["retries"] += 1
            logger.info("retrying gateway in %.2fs (attempt %s/%s, code=%s)", wait, attempt, self.max_retries + 1, last_error.code if last_error else "?")
            await asyncio.sleep(wait)

        self.stats["errors"] += 1
        if last_error is None:  # pragma: no cover - defensive
            last_error = GatewayError(502, "UNKNOWN", "Gateway request failed for an unknown reason", attempts=attempts)
        last_error.attempts = attempts
        raise last_error

    def _parse_response(self, response: httpx.Response, attempt: int) -> Optional[GatewayError]:
        """Return None on success, otherwise a GatewayError describing the failure."""
        if response.status_code == 200:
            try:
                body = response.json()
            except ValueError as exc:
                return GatewayError(502, "INVALID_JSON", f"Gateway returned non-JSON body: {exc}", attempts=attempt)
            data = body.get("data") if isinstance(body, dict) else None
            if not isinstance(data, dict) or not isinstance(data.get("content"), str) or not data.get("content"):
                return GatewayError(502, "MALFORMED_RESPONSE", "Gateway returned 200 without data.content", attempts=attempt)
            return None

        retry_after = _parse_retry_after(response)
        code = f"HTTP_{response.status_code}"
        message = response.text[:400] or f"Gateway responded {response.status_code}"
        try:
            body = response.json()
            error = body.get("error") if isinstance(body, dict) else None
            if isinstance(error, dict):
                code = str(error.get("code") or code)
                message = str(error.get("message") or message)
            elif isinstance(body, dict) and body.get("message"):
                message = str(body["message"])
        except ValueError:
            pass

        if response.status_code in RETRYABLE_STATUS:
            return GatewayError(response.status_code, code, message, retry_after=retry_after, attempts=attempt)
        # 4xx that we cannot fix by retrying (auth, validation, payload).
        raise GatewayError(response.status_code, code, message, retry_after=retry_after, attempts=attempt)

    @staticmethod
    def _extract_data(response: httpx.Response) -> Dict[str, Any]:
        body = response.json()
        data = body.get("data", {}) if isinstance(body, dict) else {}
        if not isinstance(data, dict):
            raise GatewayError(502, "MALFORMED_RESPONSE", "Gateway 'data' field is not an object")
        return data

    # ------------------------------------------------------------------ #
    async def close(self) -> None:
        client, self._client = self._client, None
        if client is not None and not client.is_closed:
            try:
                await client.aclose()
            except httpx.HTTPError as exc:  # pragma: no cover - best effort
                logger.debug("error closing gateway client: %s", exc)


gateway_client = GatewayClient()

__all__ = ["GatewayClient", "GatewayError", "gateway_client", "RETRYABLE_STATUS"]
