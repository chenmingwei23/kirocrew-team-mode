"""e2e item 12: once the app is disabled, its stdio MCP servers do nothing and then exit."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
sys.path.insert(0, str(APP / "mcp"))

import staff_server  # noqa: E402
from teamapp import identity, ledger, limits, offswitch  # noqa: E402


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, APP / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


server = _load("team_mcp_server_offswitch", "mcp/server.py")


@pytest.fixture
def lead(tmp_path, monkeypatch):
    root = tmp_path / "ledger"
    ledger.append(root, limits.CONTROL, "app/started", "app", {})
    identity.register(root, "chat-1", "api")
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-1")
    monkeypatch.setattr(server, "APP_ROOT", tmp_path)       # no installed.json yet
    monkeypatch.setattr(staff_server, "APP_ROOT", tmp_path)
    return root


def test_tools_refused_after_app_stopped_and_back_after_started(lead):
    assert server.call("team_whoami", {}, lead)["registered"] is True
    ledger.append(lead, limits.CONTROL, "app/stopped", "app", {})
    for name in ("team_whoami", "team_directory", "team_send"):
        with pytest.raises(server.ToolError, match="app_disabled"):
            server.call(name, {"text": "x"} if name == "team_send" else {}, lead)
    assert staff_server.call(lead, "staff_case_read", {"case_id": "C-1", "nonce": "n"}) == {
        "status": "refused", "reason": "app_disabled"}
    ledger.append(lead, limits.CONTROL, "app/started", "app", {})
    assert server.call("team_whoami", {}, lead)["registered"] is True


def test_installed_json_enabled_false_refuses(lead, tmp_path):
    (tmp_path / "installed.json").write_text(json.dumps({"name": "team-mode", "enabled": False}))
    with pytest.raises(server.ToolError, match="app_disabled"):
        server.call("team_whoami", {}, lead)
    (tmp_path / "installed.json").write_text(json.dumps({"name": "team-mode", "enabled": True}))
    assert server.call("team_whoami", {}, lead)["registered"] is True


def test_unreadable_installed_json_does_not_turn_app_off(lead, tmp_path):
    (tmp_path / "installed.json").write_text("{not json")
    assert offswitch.app_off(lead, tmp_path) is False


class _Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def _run_watch(root, app_root, script):
    """Drive offswitch.watch synchronously: *script* runs before each poll."""
    clock, exits, polls = _Clock(), [], iter(script)

    def sleep(_):
        clock.t += offswitch.POLL_SECS
        next(polls, lambda: None)()

    thread = offswitch.watch(root, app_root, exit_fn=lambda: exits.append(clock.t),
                             clock=clock, sleep=sleep)
    thread.join(5)
    return exits


def _ctl(root, type):
    return lambda: ledger.append(root, limits.CONTROL, type, "app", {})


def test_watch_exits_once_off_for_the_grace(lead, tmp_path):
    ledger.append(lead, limits.CONTROL, "app/stopped", "app", {})
    assert _run_watch(lead, tmp_path, []) == [offswitch.GRACE_SECS]


def test_watch_survives_a_quick_restart(lead, tmp_path):
    """stopped at t=0, started again at t=5 (an update), stopped for good at t=20."""
    ledger.append(lead, limits.CONTROL, "app/stopped", "app", {})
    noop = lambda: None  # noqa: E731
    exits = _run_watch(lead, tmp_path, [_ctl(lead, "app/started"), noop, noop, _ctl(lead, "app/stopped")])
    assert exits == [20 + offswitch.GRACE_SECS]
