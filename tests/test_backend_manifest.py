"""The demo lead's tool surface is narrow, enforced by permissions.mcpTools (not the prompt)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((APP / "app.json").read_text())
LEAD = json.loads((APP / "agents" / "lead.json").read_text())

ALLOWED_MANAGED = {"cron_add", "cron_remove", "cron_list", "work_report"}
FORBIDDEN = {"work_dispatch", "session_create", "session_send", "spawn_run", "spawn_sub_agents",
             "browser", "file_send", "send_message", "deploy_artifact"}
BUILTIN_WRITERS = {"execute_bash", "shell", "fs_write", "write", "*", "@builtin"}


def test_mcp_tools_allow_list():
    declared = set(MANIFEST["permissions"]["mcpTools"])
    team = {t for t in declared if t.startswith("team_")}
    assert declared - team == ALLOWED_MANAGED
    assert not declared & FORBIDDEN
    assert MANIFEST["permissions"]["spawn"] is True
    assert {"agents/lead.json", "agents/secretary.json", "agents/bar-raiser.json"} <= set(MANIFEST["agents"])


def test_lead_agent_has_no_writer_tools():
    tools = set(LEAD["tools"])
    assert not tools & BUILTIN_WRITERS
    assert not any(t.split("/")[-1] in FORBIDDEN for t in tools)
    assert tools - {"@team"} == {f"@kirocrew-cron/{t}" for t in ("cron_add", "cron_remove", "cron_list")} | {
        "@kirocrew-work/work_report"}
    assert LEAD["allowedTools"] == ["@team"]


def test_platform_turns_mcp_tools_into_exclusions(tmp_path, monkeypatch):
    """Runs the host's own enforcement on our manifest (needs kiro_crew on the path)."""
    monkeypatch.setenv("KIROCREW_HOME", str(tmp_path))
    bridges = pytest.importorskip("kiro_crew.apps.bridges_agents")
    from kiro_crew.apps.manifest import AppManifest

    m = AppManifest.from_json_file(APP / "app.json")
    out = bridges._enforce_declared_mcp_tools(json.loads(json.dumps(LEAD)), m)
    excluded = set(out["managedToolPolicy"]["exclude"])
    universe = _universe()
    assert {"work_dispatch", "session_create", "session_send"} <= universe
    assert FORBIDDEN & universe <= excluded
    assert set(universe) - excluded == ALLOWED_MANAGED | {"skill_search"}  # skill_search: framework-required


def _universe() -> set[str]:
    from kiro_crew.apps import permissions

    return permissions._read_managed_tool_universe()[0]


CREDS_TOOLS = ("get_aws_creds", "configure_aws_access")


@pytest.mark.parametrize("spec", ["lead.json", "secretary.json", "bar-raiser.json"])
def test_every_agent_denies_the_injected_creds_server(spec):
    """The host sandbox appends @creds-agent to tools/allowedTools plus an allow rule at
    session start (e2e 14). kiro-cli ranks deny over allow, so the spec's own deny rule is
    the layer the app controls; tools/allowedTools stay a narrow allow list without it."""
    data = json.loads((APP / "agents" / spec).read_text())
    assert {"capability": "mcp", "match": ["creds-agent/*"], "effect": "deny"} in data["permissions"]["rules"]
    assert not any("creds" in t for t in data["tools"] + data["allowedTools"])
    assert "creds-agent" not in data["mcpServers"]
    assert all(name in data["prompt"] for name in CREDS_TOOLS)
