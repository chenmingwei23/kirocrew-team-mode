"""End to end with B's bar raiser: team_send -> detect (requested), and close_thread -> send refused."""

from __future__ import annotations

import asyncio
import importlib.util
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import bar_raiser, fold, identity, ledger, send  # noqa: E402

T0 = 1_000_000.0

_spec = importlib.util.spec_from_file_location("team_mcp_server_link", APP / "mcp" / "server.py")
server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server)


class _Spawn:
    def __init__(self):
        self.tasks = []

    async def run(self, task, agent="", **kw):
        self.tasks.append(task)
        return "spawn-1"

    def is_done(self, _id):
        return False


class _Ctx:
    def __init__(self):
        self.spawn = _Spawn()


def _setup(root):
    leads = [identity.register(root, f"chat-{i}", f"lead{i}") for i in range(3)]
    g = send.open_group(root, leads[0], "room", leads)["channel_id"]
    return leads, g


def test_team_send_bar_raiser_request_reaches_detect(tmp_path, monkeypatch):
    (a, b, c), g = _setup(tmp_path)
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    r = server.call("team_send", {"channel_id": g, "text": "we are stuck, please decide", "kind": "request",
                                  "mentions": ["bar_raiser"]}, tmp_path)
    assert r["status"] == "accepted"
    assert fold.fold_channel(tmp_path, g)["assignments"] == {}
    cases = bar_raiser.detect(tmp_path, g, T0)
    assert [t["trigger"] for c in cases for t in c["triggers"]] == ["requested"]
    assert cases[0]["triggers"][0]["seq"] == r["seq"]
    # without kind=request nothing reaches detect
    r2 = server.call("team_send", {"channel_id": g, "text": "plain", "mentions": ["bar_raiser"]}, tmp_path)
    assert r2["reason"] == "bar_raiser_needs_request"


def test_close_thread_from_bar_raiser_closes_the_chain(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    root = send.post(tmp_path, a, channel_id=g, text="root", now=T0)
    tid = f"T-{root['seq']}"
    reply = send.post(tmp_path, b, channel_id=g, text="in thread", thread="new", root_seq=root["seq"], now=T0 + 1)
    ask = send.post(tmp_path, a, channel_id=g, text="decide please", thread=tid, kind="request",
                    mentions=["bar_raiser"], now=T0 + 2)
    assert ask["status"] == "accepted"
    ctx = _Ctx()
    cases = bar_raiser.detect(tmp_path, g, T0 + 3)
    assert cases and cases[0]["thread_id"] == tid
    case_id = asyncio.run(bar_raiser.summon(ctx, tmp_path, cases[0]))
    nonce = re.search(r"nonce=(\S+)", ctx.spawn.tasks[0]).group(1)
    res = bar_raiser.act(tmp_path, case_id, nonce, "close_thread", {}, "Both sides repeat; nothing new.",
                         [reply["seq"]],
                         bar_raiser.case_packet(tmp_path, case_id, nonce)["packet_hash"])
    assert res["status"] != "refused", res
    bar_raiser.apply_due(tmp_path, T0 + 4)
    closed = [r for r in ledger.read(tmp_path, fold.channel_file(g)) if r["type"] == "chain/closed"]
    assert closed and closed[0]["data"]["thread_id"] == tid
    assert closed[0]["data"]["root_seq"] == root["seq"]  # segment root = thread root (no reset yet)
    r = send.post(tmp_path, b, channel_id=g, text="but wait", thread=tid, now=T0 + 50)
    assert r["status"] == "refused" and r["reason"] == "thread_closed"
    send.post(tmp_path, "owner", channel_id=g, text="reopen", thread=tid, now=T0 + 60)
    assert send.post(tmp_path, b, channel_id=g, text="ok", thread=tid, now=T0 + 70)["status"] == "accepted"
