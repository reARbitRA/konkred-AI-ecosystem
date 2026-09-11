"""Gateway client resilience: cold starts, 429s, 503s, malformed payloads."""
from __future__ import annotations

import json
import unittest
from typing import Callable, List, Optional

import _bootstrap  # noqa: F401

import httpx  # noqa: E402

from gateway_client import GatewayClient, GatewayError  # noqa: E402

OK_BODY = {
    "ok": True,
    "requestId": "req-1",
    "data": {
        "content": "hello from the gateway",
        "provider": "mock",
        "model": "atlas-70b-mock",
        "modelId": "mock:atlas-70b",
        "cached": False,
        "usage": {"promptTokens": 10, "completionTokens": 6, "totalTokens": 16},
        "attemptCount": 1,
        "attempts": [],
    },
}

MESSAGES = [{"role": "user", "content": "hi"}]


def _client(handler: Callable[[httpx.Request], httpx.Response], **kwargs) -> GatewayClient:
    transport = httpx.MockTransport(handler)
    return GatewayClient(
        base_url="http://gateway.test:3000/api/ai",
        health_url="http://gateway.test:3000/api/health",
        api_key="test-key",
        transport=transport,
        **kwargs,
    )


def _json_response(status: int, body: dict, headers: Optional[dict] = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers or {})


class HappyPathTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_data_block(self):
        seen: List[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return _json_response(200, OK_BODY)

        client = _client(handler)
        data = await client.ask("general", MESSAGES)
        self.assertEqual(data["content"], "hello from the gateway")
        self.assertEqual(data["provider"], "mock")
        self.assertEqual(client.stats["successes"], 1)

        payload = json.loads(seen[0].content.decode())
        self.assertEqual(payload["taskType"], "general")
        self.assertEqual(payload["messages"], MESSAGES)
        self.assertEqual(payload["privacy"], "any")
        self.assertFalse(payload["skipCache"])
        self.assertEqual(seen[0].headers["x-api-key"], "test-key")
        await client.close()

    async def test_preferred_model_is_forwarded(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content.decode()))
            return _json_response(200, OK_BODY)

        client = _client(handler)
        await client.ask("code-generation", MESSAGES, preferred_model="groq:gpt-oss-120b")
        self.assertEqual(captured["model"], "groq:gpt-oss-120b")
        await client.close()

    async def test_empty_messages_rejected_locally(self):
        client = _client(lambda request: _json_response(200, OK_BODY))
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", [])
        self.assertEqual(ctx.exception.code, "EMPTY_MESSAGES")
        await client.close()


class ColdStartTests(unittest.IsolatedAsyncioTestCase):
    async def test_connect_errors_are_retried_then_succeed(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] < 3:
                raise httpx.ConnectError("connection refused (gateway still booting)")
            return _json_response(200, OK_BODY)

        client = _client(handler)
        data = await client.ask("general", MESSAGES)
        self.assertEqual(data["content"], OK_BODY["data"]["content"])
        self.assertEqual(calls["n"], 3)
        self.assertGreaterEqual(client.stats["retries"], 2)
        await client.close()

    async def test_connect_errors_exhaust_retries_and_surface_503(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        client = _client(handler, max_retries=2)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(ctx.exception.code, "GATEWAY_UNREACHABLE")
        self.assertEqual(ctx.exception.attempts, 3)
        await client.close()

    async def test_read_timeout_maps_to_504_and_is_retried(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                raise httpx.ReadTimeout("timed out")
            return _json_response(200, OK_BODY)

        client = _client(handler)
        data = await client.ask("general", MESSAGES)
        self.assertIn("content", data)
        await client.close()

    async def test_wait_until_ready_returns_true_once_healthy(self):
        state = {"healthy": False}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/api/health"):
                if not state["healthy"]:
                    raise httpx.ConnectError("not up yet")
                return _json_response(200, {"ok": True, "data": {"status": "ok"}})
            return _json_response(200, OK_BODY)

        client = _client(handler)
        self.assertFalse(await client.ping(timeout=0.2))
        state["healthy"] = True
        self.assertTrue(await client.ping(timeout=0.2))
        self.assertTrue(await client.wait_until_ready(timeout=1, interval=0.05))
        await client.close()

    async def test_wait_until_ready_times_out_without_raising(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("still down")

        client = _client(handler)
        self.assertFalse(await client.wait_until_ready(timeout=0.2, interval=0.05))
        await client.close()


class RateLimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_short_retry_after_is_honoured_then_succeeds(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return _json_response(
                    429,
                    {"ok": False, "error": {"code": "USER_RPM", "message": "slow down"}},
                    headers={"Retry-After": "0"},
                )
            return _json_response(200, OK_BODY)

        client = _client(handler)
        data = await client.ask("general", MESSAGES)
        self.assertEqual(data["content"], OK_BODY["data"]["content"])
        self.assertEqual(calls["n"], 2)
        await client.close()

    async def test_long_retry_after_surfaces_immediately(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _json_response(
                429,
                {"ok": False, "error": {"code": "CAPACITY_EXHAUSTED", "message": "all quotas exhausted"}},
                headers={"Retry-After": "600"},
            )

        client = _client(handler)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        err = ctx.exception
        self.assertEqual(err.status_code, 429)
        self.assertEqual(err.retry_after, 600)
        self.assertTrue(err.is_rate_limited)
        self.assertEqual(err.attempts, 1, "must not block the chat for 10 minutes")
        await client.close()

    async def test_retry_after_http_date_is_parsed(self):
        from email.utils import formatdate

        when = formatdate(timeval=__import__("time").time() + 5, usegmt=True)

        def handler(request: httpx.Request) -> httpx.Response:
            return _json_response(429, {"error": {"code": "USER_RPM"}}, headers={"Retry-After": when})

        client = _client(handler, max_retries=0)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        self.assertIsNotNone(ctx.exception.retry_after)
        self.assertGreaterEqual(ctx.exception.retry_after, 3)
        await client.close()


class CapacityTests(unittest.IsolatedAsyncioTestCase):
    async def test_503_is_retried_then_reported(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return _json_response(503, {"ok": False, "error": {"code": "CAPACITY_EXHAUSTED", "message": "every key is cooling down"}}, headers={"Retry-After": "0"})

        client = _client(handler, max_retries=1)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertTrue(ctx.exception.is_capacity)
        self.assertEqual(calls["n"], 2)
        await client.close()

    async def test_502_and_504_are_transient(self):
        for status in (500, 502, 504):
            calls = {"n": 0}

            def handler(request: httpx.Request, status=status) -> httpx.Response:
                calls["n"] += 1
                if calls["n"] == 1:
                    return _json_response(status, {"error": {"code": "UPSTREAM", "message": "bad gateway"}})
                return _json_response(200, OK_BODY)

            client = _client(handler)
            data = await client.ask("general", MESSAGES)
            self.assertIn("content", data, f"status {status} should have been retried")
            await client.close()


class TerminalErrorTests(unittest.IsolatedAsyncioTestCase):
    async def test_401_is_not_retried(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return _json_response(401, {"ok": False, "error": {"code": "INVALID_API_KEY", "message": "unknown key"}})

        client = _client(handler)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertEqual(ctx.exception.code, "INVALID_API_KEY")
        self.assertEqual(calls["n"], 1)
        await client.close()

    async def test_400_validation_error_is_not_retried(self):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return _json_response(400, {"error": {"code": "UNKNOWN_TASK_TYPE", "message": "bad task"}})

        client = _client(handler)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        self.assertEqual(ctx.exception.code, "UNKNOWN_TASK_TYPE")
        self.assertEqual(calls["n"], 1)
        await client.close()

    async def test_malformed_200_becomes_502(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _json_response(200, {"ok": True, "data": {"provider": "mock"}})

        client = _client(handler, max_retries=1)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(ctx.exception.code, "MALFORMED_RESPONSE")
        await client.close()

    async def test_non_json_body_is_handled(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>proxy error</html>")

        client = _client(handler, max_retries=0)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        self.assertEqual(ctx.exception.code, "INVALID_JSON")
        await client.close()

    async def test_error_without_json_body_falls_back_to_text(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="internal explosion")

        client = _client(handler, max_retries=0)
        with self.assertRaises(GatewayError) as ctx:
            await client.ask("general", MESSAGES)
        self.assertIn("internal explosion", ctx.exception.message)
        await client.close()


class ConnectionLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_client_is_reused_across_calls(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _json_response(200, OK_BODY)

        client = _client(handler)
        await client.ask("general", MESSAGES)
        first = client._client
        await client.ask("general", [{"role": "user", "content": "again"}])
        self.assertIs(client._client, first)
        await client.close()
        self.assertTrue(first.is_closed)

    async def test_close_is_idempotent(self):
        client = _client(lambda request: _json_response(200, OK_BODY))
        await client.close()
        await client.close()  # must not raise

    async def test_closed_client_is_reopened_on_next_call(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return _json_response(200, OK_BODY)

        client = _client(handler)
        await client.ask("general", MESSAGES)
        await client.close()
        data = await client.ask("general", MESSAGES)
        self.assertIn("content", data)
        await client.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)


class UrlNormalisationTests(unittest.TestCase):
    """Cloud blueprints usually only know a service origin — normalise it."""

    def test_bare_origin_gets_inference_path(self):
        client = _client(lambda request: _json_response(200, OK_BODY))
        self.assertEqual(
            GatewayClient._normalise_inference_url("https://konkred-gateway.onrender.com"),
            "https://konkred-gateway.onrender.com/api/ai",
        )
        self.assertEqual(
            GatewayClient._normalise_inference_url("http://gateway:3000/api/ai"),
            "http://gateway:3000/api/ai",
        )
        self.assertEqual(GatewayClient._normalise_inference_url("gateway:3000"), "http://gateway:3000/api/ai")
        self.assertEqual(GatewayClient._normalise_inference_url("http://gw/api/ai/"), "http://gw/api/ai")

    def test_health_url_is_derived_from_origin(self):
        self.assertEqual(
            GatewayClient._normalise_health_url("", "https://gw.onrender.com/api/ai"),
            "https://gw.onrender.com/api/health",
        )
        self.assertEqual(GatewayClient._normalise_health_url("https://gw/readyz", "x"), "https://gw/readyz")

    def test_empty_url_raises(self):
        with self.assertRaises(ValueError):
            GatewayClient._normalise_inference_url("")

    def test_client_uses_normalised_urls(self):
        client = GatewayClient(
            base_url="https://gw.test",
            health_url="",  # force derivation from the inference origin
            api_key="k",
            transport=httpx.MockTransport(lambda r: _json_response(200, OK_BODY)),
        )
        self.assertEqual(client.base_url, "https://gw.test/api/ai")
        self.assertEqual(client.health_url, "https://gw.test/api/health")
