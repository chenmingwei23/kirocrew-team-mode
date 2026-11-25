"""next_wake rules, the backend tick, the probe template (no body bytes), MCP tools, /state."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import fold, identity, ledger, limits, send, state, wake  # noqa: E402

T0 = 1_000_000.0
BODY = "SECRET-BODY-7f3a9c do not leak"


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, APP / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


probe = _load("team_inbox_probe", "crons/inbox_probe.py")
server = _load("team_mcp_server", "mcp/server.py")


def _setup(root, n=3):
    leads = [identity.register(root, f"chat-{i}", f"lead{i}") for i in range(n)]
    g = send.open_group(root, leads[0], "room", leads)["channel_id"]
    return leads, g


def _decide(root, lead, now):
    chans = {cid: fold.fold_channel(root, cid) for cid in fold.list_channels(root)}
    return wake.next_wake(lead, fold.fold_member(root, lead), fold.unread(root, lead), chans, now)


def _due(root, lead, decision, now):
    return ledger.append(root, fold.member_file(lead), "wake/due", "app", {**decision, "brief_id": None}, now=now)


# --------------------------------------------------------------------------- next_wake


def test_assignment_dm_owner_wake_at_once(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="@b please", mentions=[b], now=T0)
    d = _decide(tmp_path, b, T0 + 1)
    assert d and any(r.startswith("assign:") for r in d["reasons"])
    assert _decide(tmp_path, c, T0 + 1) is None  # ordinary main traffic waits for the batch
    send.post(tmp_path, a, to=c, text="dm", now=T0 + 2)
    assert "dm" in _decide(tmp_path, c, T0 + 3)["reasons"]
    send.post(tmp_path, "owner", channel_id=g, text="hello all", now=T0 + 4)
    assert "owner" in _decide(tmp_path, a, T0 + 5)["reasons"]


def test_batch_window_and_no_rewake_for_pointed_items(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="fyi", now=T0)
    wait = wake.BATCH_WINDOW_SECS + wake.offset_secs(c)
    assert _decide(tmp_path, c, T0 + wait - 1) is None
    d = _decide(tmp_path, c, T0 + wait)
    assert d["reasons"] == ["batch"]
    ch = d["summary"]["channels"][0]
    assert ch["title"] == "room" and ch["n"] == 1
    _due(tmp_path, c, d, T0 + wait)
    assert _decide(tmp_path, c, T0 + wait + 500) is None  # already pointed at


def test_batched_cap_per_hour(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    for i in range(wake.BATCHED_PER_HOUR):
        ledger.append(tmp_path, fold.member_file(c), "wake/due", "app",
                      {"upto": {}, "reasons": ["batch"], "senders": []}, now=T0 + i)
    send.post(tmp_path, a, channel_id=g, text="fyi", now=T0 + 20)
    assert _decide(tmp_path, c, T0 + 1000) is None
    assert _decide(tmp_path, c, T0 + 20 + 3600) is not None


def test_at_once_cap_per_sender(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    for i in range(wake.AT_ONCE_PER_SENDER_HOUR):
        ledger.append(tmp_path, fold.member_file(b), "wake/due", "app",
                      {"upto": {}, "reasons": ["dm"], "senders": [a]}, now=T0 + i)
    send.post(tmp_path, a, to=b, text="dm again", now=T0 + 10)
    assert _decide(tmp_path, b, T0 + 11) is None  # waits for the batch instead


def test_rewake_once_then_unanswered(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="@b", mentions=[b], now=T0)
    d = _decide(tmp_path, b, T0 + 1)
    seq = _due(tmp_path, b, d, T0 + 1)
    ledger.append(tmp_path, fold.member_file(b), "wake/delivered", "app", {"due_seq": seq}, now=T0 + 2)
    assert _decide(tmp_path, b, T0 + 2 + wake.REWAKE_AFTER_SECS - 1) is None
    d2 = _decide(tmp_path, b, T0 + 2 + wake.REWAKE_AFTER_SECS)
    assert d2 and d2["reasons"][0].startswith("rewake:")
    s2 = _due(tmp_path, b, d2, T0 + 130)
    ledger.append(tmp_path, fold.member_file(b), "wake/delivered", "app", {"due_seq": s2}, now=T0 + 131)
    assert _decide(tmp_path, b, T0 + 400) is None  # only one re-wake
    assert wake.check_unanswered(tmp_path, T0 + 131 + wake.REWAKE_AFTER_SECS) == 1
    ch = fold.fold_channel(tmp_path, g)
    assert next(iter(ch["assignments"].values()))["state"] == "unanswered"


def test_unanswered_system_message_names_handles_not_ids(tmp_path):
    """Video round 2, S21: the thread line read 'L-4376048f has not answered owner's assignment A-63f13fc1.'"""
    import re
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, "owner", channel_id=g, text="@b please look", mentions=[b], now=T0)
    send.post(tmp_path, a, channel_id=g, text="@c too", mentions=[c], now=T0 + 1)
    assert wake.check_unanswered(tmp_path, T0 + wake.ANSWER_SECS + 5) == 2
    texts = [r["data"]["text"] for r in ledger.read(tmp_path, fold.channel_file(g))
             if r["type"] == "message/posted" and r["data"].get("kind") == "system"]
    assert sorted(texts) == ["lead1 has not answered Owner's request yet.",
                             "lead2 has not answered lead0's request yet."]
    assert not any(re.search(r"\b[LA]-[0-9a-f]{8}\b", t) for t in texts)


# --------------------------------------------------------------------------- tick


class _Ctx:
    spawn = None
    data_dir = None


def test_tick_writes_due_and_charges_and_stops_on_budget(tmp_path, monkeypatch):
    (a, b, c), g = _setup(tmp_path)
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    send.post(tmp_path, a, to=b, text=BODY, now=T0)
    did = asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 1))
    assert [x[0] for x in did["dues"]] == [b]
    assert limits.usage(tmp_path, T0 + 1)["totals"]["wake"] == 1
    monkeypatch.setattr(limits, "TOTAL_WAKES", 1)
    send.post(tmp_path, a, to=c, text="another", now=T0 + 2)
    asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 3))
    assert limits.stopped(tmp_path)
    assert asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 4))["dues"] == []


def test_owner_at_one_lead_wakes_only_that_lead_at_once(tmp_path):
    """S34: the owner's '@Ada' woke Ada, Uma and Ira. Now only the @-ed lead wakes at once;
    the others get the post in the normal batch. No @ and @everyone still wake everyone."""
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, "owner", channel_id=g, text="@lead1 please check", mentions=[b], now=T0)
    assert _decide(tmp_path, b, T0 + 1) is not None
    assert _decide(tmp_path, a, T0 + 1) is None and _decide(tmp_path, c, T0 + 1) is None
    late = _decide(tmp_path, c, T0 + 400)  # the batch window still delivers it
    assert late and "batch" in late["reasons"]
    (a2, b2, c2), g2 = (a, b, c), send.open_group(tmp_path, a, "room2", [a, b, c])["channel_id"]
    send.post(tmp_path, "owner", channel_id=g2, text="all of you", everyone=True, now=T0 + 500)
    assert "owner" in _decide(tmp_path, c2, T0 + 501)["reasons"]


def test_tick_skips_a_capped_lead_and_still_wakes_the_next(tmp_path):
    """Scenario run: b's 12 wakes/h stopped the app, so c (after b in the loop) was
    never woken. Now b is skipped and c is woken; the app does not stop."""
    (a, b, c), g = _setup(tmp_path)
    assert list(identity.active_leads(tmp_path)) == [a, b, c]  # b is checked before c
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    for i in range(limits.WAKES_PER_LEAD_HOUR):
        ledger.append(tmp_path, "control.jsonl", "budget/charged", "app",
                      {"kind": "wake", "n": 1, "lead_id": b}, now=T0 + i)
    send.post(tmp_path, a, channel_id=g, text="fyi b", cc=[b], now=T0 + 20)  # a cc obeys the cap (A-F1)
    send.post(tmp_path, a, to=c, text="for c", now=T0 + 21)
    did = asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 30))
    assert [x[0] for x in did["dues"]] == [c]
    assert not limits.stopped(tmp_path)
    assert [r["data"]["lead_id"] for r in ledger.read(tmp_path, "control.jsonl")
            if r["type"] == "budget/lead_capped"] == [b]


def test_a_capped_lead_is_still_woken_for_an_assignment_and_a_dm(tmp_path):
    """round4 A-F1: Ada at her 12 wakes/h was @-assigned; the loop skipped her silently and
    later posted 'Ada has not answered'. A wake that must be answered (an assignment to
    her, a DM) now goes past the per-lead cap; global caps still hold."""
    (a, b, c), g = _setup(tmp_path)
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    for i in range(limits.WAKES_PER_LEAD_HOUR):
        ledger.append(tmp_path, "control.jsonl", "budget/charged", "app",
                      {"kind": "wake", "n": 1, "lead_id": b}, now=T0 + i)
    send.post(tmp_path, a, channel_id=g, text="@b please check", mentions=[b], now=T0 + 20)
    did = asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 30))
    assert [x[0] for x in did["dues"]] == [b]
    due = [r for r in ledger.read(tmp_path, fold.member_file(b)) if r["type"] == "wake/due"]
    assert any(x.startswith("assign:") for x in due[-1]["data"]["reasons"])
    send.post(tmp_path, c, to=b, text="private word", now=T0 + 40)
    did = asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 50))
    assert [x[0] for x in did["dues"]] == [b] and not limits.stopped(tmp_path)


def test_inbox_thread_and_assignment_items_carry_words_not_ids(tmp_path, monkeypatch):
    """round4 A-F3: Ada told the owner 'we lined up in T-14' and 'task A-44ba912f timed out'.
    Inbox, thread and assignment results now give a 'say' with the group name, the thread's
    first words and whose request it is; the rule names thread and assignment ids too."""
    (a, b, c), g = _setup(tmp_path)
    root = send.post(tmp_path, a, channel_id=g, text="Release notes for refunds v2 are ready", now=T0)
    send.post(tmp_path, a, channel_id=g, text="@b can you check the wording?", mentions=[b],
              thread="new", root_seq=root["seq"], now=T0 + 1)
    tid = next(iter(fold.fold_channel(tmp_path, g)["threads"]))
    got = wake.inbox_read(tmp_path, b)["items"]
    ask = next(i for i in got if i["type"] == "assignment/opened")
    assert ask["say"] == "the group 'room', the thread 'Release notes for refunds v2 are ready', lead0's request to lead1"
    assert all(tid not in i["say"] and "A-" not in i["say"] for i in got)
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-1")
    rows = server.call("team_assignments", {}, tmp_path)["received"]
    assert rows[0]["say"].endswith("lead0's request to lead1")
    items = server.call("team_thread_read", {"channel_id": g, "thread": tid}, tmp_path)["items"]
    assert items and all(i["say"].startswith("the group 'room', the thread 'Release notes") for i in items)
    assert "assignment A-" in server.NO_IDS_RULE and "thread T-" in server.NO_IDS_RULE


def test_thread_read_over_an_answer_names_the_request_and_does_not_crash(tmp_path, monkeypatch):
    """round5 S46: Uma's team_thread_read over Ada's answer raised TypeError (answers is a
    dict on the row), which ended the stdio server and left Uma's team tools 'Not connected'."""
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="@b please send the codes", mentions=[b], now=T0)
    aid = next(iter(fold.fold_channel(tmp_path, g)["assignments"]))
    send.post(tmp_path, b, channel_id=g, text="taking it", answers=aid, response="take", now=T0 + 1)
    send.post(tmp_path, b, channel_id=g, text="two codes", answers=aid, response="result", now=T0 + 2)
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    items = server.call("team_thread_read", {"channel_id": g, "thread": "main", "since_seq": 1}, tmp_path)["items"]
    answers = [i for i in items if i["type"] == "message/posted" and i.get("answers")]
    assert len(answers) == 2 and all(i["say"].endswith("lead0's request to lead1") for i in answers)


def test_an_at_by_handle_reaches_the_lead(tmp_path):
    """round5 S46: Ada answered Uma's @ with mentions=["Uma"]; it was refused not_a_member with
    'do not retry', so the answer never reached Uma. A handle maps to the lead_id, as to= does."""
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="@lead1 please send the codes", mentions=[b], now=T0)
    aid = next(iter(fold.fold_channel(tmp_path, g)["assignments"]))
    r = send.post(tmp_path, b, channel_id=g, text="@lead0 two codes", answers=aid, response="result",
                  mentions=["lead0"], cc=["lead2"], now=T0 + 1)
    assert r["status"] == "accepted", r
    row = [x for x in ledger.read(tmp_path, fold.channel_file(g)) if x["type"] == "message/posted"][-1]
    assert row["data"]["mentions"] == [a] and row["data"]["cc"] == [c]


def test_fallback_brief_without_secretary_carries_history_pointers(tmp_path, monkeypatch):
    """Secretary module missing: the loop's own rules brief is secretary.brief.v1 and
    every item carries the same history pointers as the secretary's (FIX-08)."""
    (a, b, c), g = _setup(tmp_path)
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    real = wake._optional
    monkeypatch.setattr(wake, "_optional", lambda name: None if name == "secretary" else real(name))
    old = send.post(tmp_path, a, channel_id=g, text="Who drained the installation quota?", now=T0)
    ans = send.post(tmp_path, b, channel_id=g, text="The rerun batch did.", reply_to=old["seq"],
                    kind="reply", now=T0 + 5)
    ledger.append(tmp_path, fold.member_file(b), "inbox/acked", f"lead:{b}",
                  {"channel_id": g, "upto": ans["seq"], "max_hops_read": {}}, now=T0 + 6)
    new = send.post(tmp_path, c, to=b, text="Who drained the installation quota?", now=T0 + 10)
    asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 11))
    briefed = [r for r in ledger.read(tmp_path, fold.member_file(b)) if r["type"] == "secretary/briefed"]
    brief = briefed[-1]["data"]["brief"]
    items = [it for grp in brief["groups"] for it in grp["items"]]
    assert [it["seqs"] for it in items] == [[new["seq"]]]
    assert items[0]["summary"] == "Who drained the installation quota?"
    p = items[0]["pointers"]
    assert p["seen_before"] == [{"channel_id": g, "seq": old["seq"], "ts": T0, "thread_id": None}]
    assert p["answered_before"] == {"channel_id": g, "seq": ans["seq"], "ts": T0 + 5}
    assert p["repeat_count"] == 2


def test_tick_quiet_when_app_not_running(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, a, to=b, text="x", now=T0)
    assert asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 1))["dues"] == []


# --------------------------------------------------------------------------- probe


def test_probe_template_has_no_body_bytes(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    send.post(tmp_path, a, channel_id=g, text=BODY, mentions=[b], now=T0)
    send.post(tmp_path, a, to=b, text=BODY + " dm", now=T0 + 1)
    asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 2))
    got = probe.observe_files(tmp_path, b)
    assert got is not None
    kind, seq, brief = got
    assert brief.endswith("Call team_inbox_read.")
    for frag in (BODY, "SECRET", "7f3a9c", "leak"):
        assert frag not in brief
    assert "room" in brief and "3 new item(s)" in brief  # message + its assignment + the DM
    # every byte of the brief comes from the fixed template, the titles and the numbers
    skeleton = probe.TEMPLATE.split("{")[0]
    assert brief.startswith(skeleton)
    # after the lead reads, the probe goes quiet
    wake.inbox_read(tmp_path, b)
    assert probe.observe_files(tmp_path, b) is None


def test_probe_quiet_when_stopped_or_app_stopped(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    send.post(tmp_path, a, to=b, text="x", now=T0)
    asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 1))
    assert probe.observe_files(tmp_path, b) is not None
    ledger.append(tmp_path, "control.jsonl", "app/stopped", "app", {})
    assert probe.observe_files(tmp_path, b) is None
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    limits.stop(tmp_path, "owner")
    assert probe.observe_files(tmp_path, b) is None


def test_probe_title_is_sanitised():
    due = {"data": {"summary": {"channels": [{"title": "<b>x</b>\n{evil}", "n": 1}], "assignments": 0}}}
    out = probe.brief_for_due(due)
    assert "<" not in out and "\n" not in out and "{" not in out


def test_probe_with_irq_kernel(tmp_path, monkeypatch):
    irq = pytest.importorskip("kiro_crew.irq")
    (a, b, c), g = _setup(tmp_path)
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    send.post(tmp_path, a, to=b, text=BODY, now=T0)
    asyncio.run(wake.tick(_Ctx(), tmp_path, T0 + 1))
    monkeypatch.setattr(probe, "ROOT", tmp_path)
    p = probe._make_probe()

    class C:
        message = json.dumps({"lead_id": b})
    assert p.identity(C()) == ("team-mode-inbox", b)
    tick = p.observe(C())
    assert len(tick.observations) == 1 and tick.observations[0].severity is irq.Severity.IMMEDIATE
    assert BODY not in tick.observations[0].brief
    with pytest.raises(ValueError):
        p.identity(type("X", (), {"message": '{"lead_id": "../x"}'})())


# --------------------------------------------------------------------------- MCP


def test_mcp_identity_and_unknown_args(tmp_path, monkeypatch):
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-new")
    who = server.call("team_whoami", {}, tmp_path)
    assert who["registered"] is False and who["reason"] == "not_a_lead"
    assert "owner" in who["advice"]
    # An unregistered caller leaves no trace: nobody registers themselves.
    assert ledger.read(tmp_path, identity.DIRECTORY) == []
    with pytest.raises(server.ToolError, match="not_a_lead"):
        server.call("team_inbox_read", {}, tmp_path)
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "")
    with pytest.raises(server.ToolError, match="lead_unverifiable"):
        server.call("team_directory", {}, tmp_path)
    (a, b, c), g = _setup(tmp_path)
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    with pytest.raises(server.ToolError, match="unknown argument"):
        server.call("team_send", {"channel_id": g, "text": "x", "from": b}, tmp_path)
    with pytest.raises(server.ToolError, match="unknown argument"):
        server.call("team_send", {"channel_id": g, "text": "x", "hops": 0}, tmp_path)
    r = server.call("team_send", {"channel_id": g, "text": "hi all"}, tmp_path)
    assert r["status"] == "accepted"
    row = ledger.read(tmp_path, fold.channel_file(g))[-1]
    assert row["by"] == f"lead:{a}"  # sender comes from the label, never from arguments


def test_mcp_jsonrpc_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-zz")
    listed = server._handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    names = {t["name"] for t in listed["result"]["tools"]}
    assert {"team_whoami", "team_send", "team_inbox_read", "team_inbox_peek", "team_thread_read",
            "team_assignments", "team_group_open", "team_relay_note", "team_directory",
            "team_channels"} <= names
    res = server._handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                          "params": {"name": "team_inbox_peek", "arguments": {}}})
    assert res["result"]["isError"] is True
    assert json.loads(res["result"]["content"][0]["text"])["reason"] == "not_a_lead"


def test_mcp_thread_read_and_relay(tmp_path, monkeypatch):
    (a, b, c), g = _setup(tmp_path)
    root = send.post(tmp_path, a, channel_id=g, text="root", now=T0)
    send.post(tmp_path, b, channel_id=g, text="hidden reply", thread="new", root_seq=root["seq"], now=T0 + 1)
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-2")  # c, not a participant
    out = server.call("team_thread_read", {"channel_id": g, "thread": f"T-{root['seq']}"}, tmp_path)
    assert out["items"] == []
    main = server.call("team_thread_read", {"channel_id": g}, tmp_path)
    assert [i["body"] for i in main["items"] if "hidden reply" in i["body"]] == []
    assert main["stubs"] and main["stubs"][0]["count"] == 1
    r = server.call("team_relay_note", {"channel_id": g, "from_session": "w1", "via_session": "c1",
                                        "to_session": "w2", "summary": "pass it on"}, tmp_path)
    assert r["status"] == "accepted"
    assert ledger.read(tmp_path, fold.channel_file(g))[-1]["type"] == "relay/noted"


# --------------------------------------------------------------------------- /state


def test_state_shape_matches_page_fixture(tmp_path):
    fixture = json.loads((APP / "ui-src" / "fixtures" / "state-13-quota.json").read_text())
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="hello", now=T0)
    s = state.build(tmp_path, now=T0 + 1)
    assert set(fixture) <= set(s)
    assert "seen" not in s
    assert set(fixture["leads"][0]) <= set(s["leads"][0])
    assert set(fixture["channels"][0]) <= set(s["channels"][0])
    assert set(fixture["channels"][0]["stubs"][0]) <= {"thread_id", "root_seq", "count", "last_ts", "participants"}
    for k, v in fixture["budget"].items():
        assert k in s["budget"]
        if isinstance(v, dict) and k != "lead_wakes_hour":
            assert set(v) <= set(s["budget"][k]), k
    # incremental: since=cursor returns no old rows
    again = state.build(tmp_path, since=s["cursor"], now=T0 + 2)
    assert again["entries"][g] == []
    send.post(tmp_path, b, channel_id=g, text="new one", now=T0 + 3)
    assert [r["data"]["text"] for r in state.build(tmp_path, since=s["cursor"])["entries"][g]
            if r["type"] == "message/posted"] == ["new one"]


def test_state_cases_and_briefs_shape(tmp_path):
    fixture = json.loads((APP / "ui-src" / "fixtures" / "state-13-quota.json").read_text())
    (a, b, c), g = _setup(tmp_path)
    from teamapp import approval

    summoned = ledger.append(tmp_path, "cases.jsonl", "bar_raiser/summoned", "app",
                             {"case_id": "C-1", "channel_id": g, "thread_id": None, "root_seq": 0,
                              "triggers": [{"trigger": "requested", "key": "k"}], "continues_left": 2,
                              "deadline": T0 + 600, "model": "m"})
    card = approval.person_card({"class": "spend", "question": "ok to spend?", "what": "spend $5",
                                 "cost": "$5", "reversible": "no", "if_no": "hold"},
                                who="#g", attempt=1, tried=[], expires=T0 + 3600)
    ledger.append(tmp_path, "cases.jsonl", "bar_raiser/called_person", "app",
                  {"case_id": "C-1", "class": "spend", "question": "ok to spend?", "card": card,
                   "binding": approval.bind(summoned, card, 1, T0 + 3600)})
    ledger.append(tmp_path, fold.member_file(a), "secretary/briefed", "app",
                  {"brief_id": "B-1", "lane": "rules", "brief": {"schema": "secretary.brief.v1", "groups": []},
                   "error": "timeout"})
    s = state.build(tmp_path, now=T0)
    assert set(fixture["cases"][0]) <= set(s["cases"][0])
    assert set(fixture["briefs"][0]) <= set(s["briefs"][0])
    assert s["briefs"][0]["fallback_reason"] == "timeout"
    h = s["cases"][0]["called_person"]["card_hash"]
    res = state.answer_case(tmp_path, "C-1", "change", h, "yes, go", now=T0)
    assert res["status"] == "accepted" and res["post"]["status"] == "accepted"
    assert state.build(tmp_path)["cases"][0]["answer"]["text"] == "yes, go"
    assert state.answer_case(tmp_path, "C-1", "change", h, "again", now=T0)["reason"] == "already_used"
