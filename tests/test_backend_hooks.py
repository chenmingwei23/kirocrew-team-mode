"""HTTP routes are owner-only (reads too) and on_startup / on_shutdown mark the app running."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import pytest

web = pytest.importorskip("aiohttp.web")
from aiohttp.test_utils import make_mocked_request  # noqa: E402

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import hooks, ledger, limits  # noqa: E402


class Ctx:
    def __init__(self, data_dir, owner):
        self.data_dir = data_dir
        self.owner = owner
        self.spawn = None

    async def require_owner(self, request, op):
        return None if self.owner else web.json_response({"error": "owner_only"}, status=403)


def _routes(ctx):
    return {(r.method, r.path): r.handler for r in hooks.register_routes(ctx)}


def _req(method, path, body=None, match=None):
    payload = json.dumps(body or {}).encode()

    class Stream:
        async def read(self, n=-1):
            return payload
    return make_mocked_request(method, path, headers={"Content-Type": "application/json",
                                                      "Content-Length": str(len(payload))},
                               match_info=match or {}, payload=Stream())


def _run(coro):
    return asyncio.run(coro)


def test_every_route_refuses_a_non_owner(tmp_path):
    ctx = Ctx(tmp_path, owner=False)
    for (method, path), handler in _routes(ctx).items():
        resp = _run(handler(_req(method, "/x"), ctx))
        assert resp.status == 403, (method, path)
    assert not (tmp_path / "ledger" / "control.jsonl").exists()


def test_owner_stop_resume_and_lead_register(tmp_path):
    ctx = Ctx(tmp_path, owner=True)
    r = _routes(ctx)
    assert _run(r[("POST", "/stop")](_req("POST", "/stop"), ctx)).status == 200
    assert limits.stopped(tmp_path / "ledger")
    assert _run(r[("POST", "/resume")](_req("POST", "/resume", {"reset_budget": True}), ctx)).status == 200
    assert not limits.stopped(tmp_path / "ledger")
    resp = _run(r[("POST", "/leads")](_req("POST", "/leads", {"session_label": "chat-1", "handle": "a"}), ctx))
    assert resp.status == 200 and json.loads(resp.body)["lead_id"].startswith("L-")
    bad = _req("POST", "/leads", {"session_label": "chat-2", "handle": "b", "evil": 1})
    with pytest.raises(web.HTTPBadRequest):
        _run(r[("POST", "/leads")](bad, ctx))
    state = _run(r[("GET", "/state")](make_mocked_request("GET", "/state"), ctx))
    assert json.loads(state.body)["leads"][0]["handle"] == "a"


def test_startup_shutdown_mark_running(tmp_path):
    ctx = Ctx(tmp_path, owner=True)

    async def go():
        await hooks.on_startup(ctx)
        assert limits.app_running(ledger.read(tmp_path / "ledger", "control.jsonl"))
        await hooks.on_shutdown(ctx)
    _run(go())
    assert not limits.app_running(ledger.read(tmp_path / "ledger", "control.jsonl"))


# --------------------------------------------------------------------------- Bots as leads

BOT_SLOT = "member-api-lead.memory-member-api-lead-0001"


def _add(r, ctx, body):
    resp = _run(r[("POST", "/leads")](_req("POST", "/leads", body), ctx))
    return resp.status, json.loads(resp.body)


def test_add_bot_records_kind_bot_and_its_project(tmp_path):
    from teamapp import fold, identity

    ctx = Ctx(tmp_path, owner=True)
    r = _routes(ctx)
    code, out = _add(r, ctx, {"bot": "api-lead", "slot_key": BOT_SLOT, "project": "shop-api"})
    assert code == 200
    lead = fold.directory(tmp_path / "ledger")["leads"][out["lead_id"]]
    assert lead["kind"] == "bot" and lead["bot"] == "api-lead" and lead["project"] == "shop-api"
    assert lead["handle"] == "api-lead"
    # A team tool called from that Bot's own chat resolves to it.
    assert identity.resolve_lead(tmp_path / "ledger", f"dashboard:{BOT_SLOT}") == (out["lead_id"], "ok")


def test_add_bot_refusals(tmp_path):
    ctx = Ctx(tmp_path, owner=True)
    r = _routes(ctx)
    assert _add(r, ctx, {"bot": "api-lead", "slot_key": BOT_SLOT})[0] == 200
    # Same Bot again, even through another chat key: already in the team.
    assert _add(r, ctx, {"bot": "api-lead", "slot_key": BOT_SLOT})[1]["reason"] == "already_in_team"
    assert _add(r, ctx, {"bot": "api-lead", "slot_key": "member-api-lead"})[1]["reason"] == "already_in_team"
    # Not a Bot chat (a plain chat key, or none: the Bot was never opened).
    assert _add(r, ctx, {"bot": "web-lead", "slot_key": "chat-12-1700"})[1]["reason"] == "not_a_bot"
    assert _add(r, ctx, {"bot": "web-lead", "slot_key": ""})[1]["reason"] == "not_a_bot"
    # Another Bot whose display name makes the same handle: name clash.
    out = _add(r, ctx, {"bot": "other", "slot_key": "member-other", "display_name": "api lead"})
    assert out == (409, {"status": "refused", "reason": "handle_taken"})


def test_removed_bot_can_be_added_again(tmp_path):
    ctx = Ctx(tmp_path, owner=True)
    r = _routes(ctx)
    lid = _add(r, ctx, {"bot": "api-lead", "slot_key": BOT_SLOT})[1]["lead_id"]
    resp = _run(r[("DELETE", "/leads/{lead_id}")](_req("DELETE", "/x", match={"lead_id": lid}), ctx))
    assert resp.status == 200
    code, out = _add(r, ctx, {"bot": "api-lead", "slot_key": BOT_SLOT})
    assert code == 200 and out["lead_id"] != lid


def test_legacy_lead_chat_still_registers_and_is_kind_chat(tmp_path):
    from teamapp import fold

    ctx = Ctx(tmp_path, owner=True)
    r = _routes(ctx)
    code, out = _add(r, ctx, {"session_label": "dashboard:chat-9", "handle": "old-lead", "kind": "chat"})
    assert code == 200
    assert fold.directory(tmp_path / "ledger")["leads"][out["lead_id"]]["kind"] == "chat"
    # A Bot cannot take the legacy lead's handle.
    assert _add(r, ctx, {"bot": "old-lead", "slot_key": "member-old-lead"})[1]["reason"] == "handle_taken"


def test_panel_knows_its_bot_from_the_session_key(tmp_path):
    ctx = Ctx(tmp_path, owner=True)
    r = _routes(ctx)
    lid = _add(r, ctx, {"bot": "api-lead", "slot_key": BOT_SLOT})[1]["lead_id"]

    def panel(key):
        req = make_mocked_request("GET", "/panel", headers={"X-Session-Key": key} if key else {})
        return json.loads(_run(r[("GET", "/panel")](req, ctx)).body)

    assert panel(f"dashboard:{BOT_SLOT}") == {"bot": True, "slot_key": BOT_SLOT, "lead_id": lid}
    assert panel("dashboard:member-web-lead") == {"bot": True, "slot_key": "member-web-lead", "lead_id": None}
    assert panel("dashboard:chat-1-1700")["bot"] is False
    assert panel("")["bot"] is False


def test_bot_handle_rules():
    from teamapp import identity

    assert identity.bot_handle("api-lead") == "api-lead"
    assert identity.bot_handle("x", "API Lead (shop)") == "API-Lead-shop"
    assert identity.bot_handle("", "   ") == ""
    assert len(identity.bot_handle("a" * 90)) == 40
