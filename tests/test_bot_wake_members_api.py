"""A Bot lead is woken through the host's ``POST /api/members/{id}/wake`` (bots: wake).

A fake gateway stands in for the host's two Bot routes. Reddens if: the wake loop stops
calling the wake route for a Bot lead's ``wake/due`` (sent test); the body carries more
than ``ref`` or the app token is not sent (sent test); a host refusal is no longer
recorded as ``wake/refused`` with its reason and a warning (refused test); the owner's
``POST /leads/{id}/wake`` hides a refusal behind a 200 (route test).
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import bot_wake, hooks, identity, ledger, fold, send, wake  # noqa: E402

T0 = 1_000_000.0
TOKEN = "app-token-1"


class _Gateway:
    """The host's ``GET /api/members`` and ``POST /api/members/{id}/wake``."""

    def __init__(self, ticked=("atlas",), wake_status=202, wake_body=None):
        self.ticked, self.wake_status = list(ticked), wake_status
        self.wake_body = wake_body or {"status": "started"}
        self.wakes: list[tuple[str, dict, str]] = []

    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/api/members", self._list)
        app.router.add_post("/api/members/{slug}/wake", self._wake)
        return app

    def _cookie(self, request) -> str:
        port = request.url.port
        return request.cookies.get(f"mc_token_{port}", "")

    async def _list(self, request):
        if self._cookie(request) != TOKEN:
            return web.json_response({"code": "unauthorized"}, status=401)
        rows = [{"id": s, "object": "bot", "name": s.title()} for s in self.ticked]
        return web.json_response({"object": "list", "data": rows})

    async def _wake(self, request):
        self.wakes.append((request.match_info["slug"], await request.json(), self._cookie(request)))
        return web.json_response(self.wake_body, status=self.wake_status)


async def _ctx(tmp_path, gw: _Gateway):
    server = TestServer(gw.app())
    await server.start_server()

    async def app_token():
        return TOKEN

    async def require_owner(request, op):
        return None

    origin = f"http://127.0.0.1:{server.port}"
    ctx = SimpleNamespace(data_dir=str(tmp_path), spawn=None, require_owner=require_owner,
                          app_token=app_token, gateway_origin=lambda: origin)
    return ctx, server


def _bot_lead_with_a_due(root: Path) -> str:
    ledger.append(root, "control.jsonl", "app/started", "app", {})
    bot = identity.register_bot(root, "Atlas", "member-atlas.memory-x", "Atlas")
    other = identity.register(root, "chat-0", "lead0")
    g = send.open_group(root, other, "room", [other, bot])["channel_id"]
    send.post(root, other, channel_id=g, text="@Atlas please", mentions=[bot], now=T0)
    return bot


def _member_rows(root: Path, lead_id: str, kind: str) -> list[dict]:
    return [r for r in ledger.read(root, fold.member_file(lead_id)) if r["type"] == kind]


@pytest.mark.asyncio
async def test_a_bot_leads_due_is_followed_by_one_wake_through_the_members_api(tmp_path):
    root = tmp_path / "ledger"
    gw = _Gateway()
    ctx, server = await _ctx(tmp_path, gw)
    try:
        bot = _bot_lead_with_a_due(root)
        did = await wake.tick(ctx, root, T0 + 1)
        (lead_id, seq), = [d for d in did["dues"] if d[0] == bot]
        assert gw.wakes == [("atlas", {"ref": bot_wake.due_ref(bot, seq)}, TOKEN)]
        assert [r["data"] for r in _member_rows(root, bot, "wake/sent")] == [
            {"due_seq": seq, "outcome": "started"}]
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_a_host_refusal_is_recorded_with_its_reason_and_logged(tmp_path, caplog):
    root = tmp_path / "ledger"
    gw = _Gateway(wake_status=429, wake_body={"code": "rate_limited"})
    ctx, server = await _ctx(tmp_path, gw)
    try:
        bot = _bot_lead_with_a_due(root)
        with caplog.at_level(logging.WARNING, logger="kirocrew.app.team-mode"):
            await wake.tick(ctx, root, T0 + 1)
        (row,) = _member_rows(root, bot, "wake/refused")
        assert row["data"]["outcome"] == "refused: http_429 rate_limited"
        assert "could not wake Bot Atlas" in caplog.text
        assert _member_rows(root, bot, "wake/sent") == []
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_an_unticked_bot_is_refused_by_name_without_a_wake_call(tmp_path):
    root = tmp_path / "ledger"
    gw = _Gateway(ticked=())
    ctx, server = await _ctx(tmp_path, gw)
    try:
        bot = _bot_lead_with_a_due(root)
        await wake.tick(ctx, root, T0 + 1)
        (row,) = _member_rows(root, bot, "wake/refused")
        assert row["data"]["outcome"].startswith("refused: bot_not_ticked")
        assert gw.wakes == []
    finally:
        await server.close()


@pytest.mark.asyncio
async def test_a_host_without_app_tokens_is_refused_not_silent(tmp_path):
    ctx = SimpleNamespace(data_dir=str(tmp_path))
    assert (await bot_wake.wake_bot(ctx, "Atlas", "r1")).startswith("refused: host_without_app_token")


@pytest.mark.asyncio
async def test_owner_wake_route_and_lead_add_report_the_host_answer(tmp_path):
    gw = _Gateway()
    ctx, server = await _ctx(tmp_path, gw)
    app = web.Application()
    for r in hooks.register_routes(ctx):
        app.router.add_route(r.method, "/x" + r.path, lambda req, h=r.handler: h(req, ctx))
    try:
        async with TestClient(TestServer(app)) as client:
            body = await (await client.post("/x/leads", json={
                "bot": "Atlas", "slot_key": "member-atlas.memory-x", "display_name": "Atlas"})).json()
            assert body["wake"] == "ready"
            ok = await client.post(f"/x/leads/{body['lead_id']}/wake")
            assert (ok.status, (await ok.json())["wake"]) == (200, "started")
            assert gw.wakes[-1][0] == "atlas"
            gw.wake_status, gw.wake_body = 409, {"code": "bot_unavailable"}
            bad = await client.post(f"/x/leads/{body['lead_id']}/wake")
            assert bad.status == 409
            assert (await bad.json())["wake"] == "refused: http_409 bot_unavailable"
    finally:
        await server.close()
