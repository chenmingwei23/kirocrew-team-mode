"""B3 (e2e S25): an argument mistake the caller can fix says "fix the arguments and
call again" with what is wrong and the expected shape; a real refusal keeps
"do not retry"; and the fix advice stops after RETRY_LIMIT tries per tool and turn."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import identity, limits, send  # noqa: E402

spec = importlib.util.spec_from_file_location("team_mcp_server_b3", APP / "mcp/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
FIX = getattr(server, "ADVICE_FIX", "fix the arguments and call again")
LIMIT = getattr(server, "RETRY_LIMIT", 3)


@pytest.fixture
def room(tmp_path, monkeypatch):
    leads = [identity.register(tmp_path, f"chat-{i}", f"lead{i}") for i in range(2)]
    g = send.open_group(tmp_path, leads[0], "room", leads)["channel_id"]
    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    getattr(server, "_ARG_ERRORS", {}).clear()
    return tmp_path, g


def _call(name, arguments):
    res = server._handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                          "params": {"name": name, "arguments": arguments}})
    return res["result"]["isError"], json.loads(res["result"]["content"][0]["text"])


def test_missing_arguments_say_fix_and_call_again(room):
    is_error, out = _call("team_meeting_speak", {})
    assert is_error is True
    assert out["advice"].startswith(FIX)
    assert out["missing"] == ["meeting_id", "turn_id", "stance"]
    assert out["expected"]["required"] == ["meeting_id", "turn_id", "stance"]
    assert out["expected"]["properties"]["stance"] == ["info", "propose", "agree", "object", "pass"]
    assert out["retries_left"] == LIMIT - 1


def test_wrong_enum_and_type_and_domain_format_errors_are_fixable(room):
    _, out = _call("team_meeting_speak", {"meeting_id": "MT-x", "turn_id": "TU-x", "stance": "maybe"})
    assert out["advice"].startswith(FIX) and out["field"] == "stance"
    _, out = _call("team_inbox_read", {"limit": "5"})
    assert out["advice"].startswith(FIX) and out["field"] == "limit"
    _, out = _call("team_send", {"channel_id": room[1], "text": "x", "from": "chat-1"})
    assert out["advice"].startswith(FIX) and out["unknown"] == ["from"]
    _, out = _call("team_send", {"channel_id": room[1], "text": "   "})  # send.post: empty_text
    assert out["reason"] == "empty_text" and out["advice"].startswith(FIX)


def test_real_refusals_keep_do_not_retry(room, monkeypatch):
    root, g = room
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-unknown")
    _, out = _call("team_inbox_peek", {})
    assert out["reason"] == "not_a_lead" and out["advice"] == limits.ADVICE_STOP
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    _, out = _call("team_meeting_read", {"meeting_id": "MT-none"})
    assert out["advice"] == limits.ADVICE_STOP
    limits.stop(root, "owner")
    _, out = _call("team_send", {"channel_id": g, "text": "hi"})
    assert out["reason"] == "stopped" and out["advice"] == limits.ADVICE_STOP


def test_fix_advice_stops_after_the_retry_limit_per_tool_and_turn(room):
    bad = {"meeting_id": "MT-x", "turn_id": "TU-1"}
    for i in range(LIMIT):
        _, out = _call("team_meeting_speak", bad)
        assert out["advice"].startswith(FIX), i
    _, out = _call("team_meeting_speak", bad)
    assert out["advice"] == limits.ADVICE_STOP and out["retry_limit"] == LIMIT
    # another turn, or another tool, has its own count
    _, out = _call("team_meeting_speak", {**bad, "turn_id": "TU-2"})
    assert out["advice"].startswith(FIX)
    _, out = _call("team_relay_note", {})
    assert out["advice"].startswith(FIX)


def test_a_good_call_resets_the_count(room):
    g = room[1]
    for _ in range(LIMIT):
        _call("team_send", {"channel_id": g})
    is_error, out = _call("team_send", {"channel_id": g, "text": "hello"})
    assert is_error is False and out["status"] == "accepted"
    _, out = _call("team_send", {"channel_id": g})
    assert out["advice"].startswith(FIX)
