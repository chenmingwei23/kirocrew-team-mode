"""Lifecycle and budget rules learned from the X-post projects (round 2, W-LC).

Each guarantee has a test that reddens when its rule is removed:

* #8 hard caps only tighten: ``test_owner_limits_only_tighten`` (make
  ``limits.effective_caps`` use the asked value instead of ``min(asked, hard)`` and it fails).
* #10 opening a group / adding members wakes nobody: ``test_open_and_add_wake_nobody``
  (add ``"member/added"`` or ``"channel/opened"`` to ``fold._INBOX_TYPES`` and it fails);
  created / reused: ``test_open_same_group_twice_reuses_it`` (drop the
  ``reusable_group`` lookup in ``send.open_group`` and it fails).
* #12 close only once action items are cleared: ``test_group_closes_only_after_action_items_clear``
  (return ``[]`` from ``lifecycle.close_blockers`` blocking and it fails); owner away pauses
  batch wakes: ``test_owner_away_pauses_batch_wakes_only`` (drop ``not batch_paused`` in
  ``wake.next_wake`` and it fails).
* #15 intent -> model: ``test_roles_pick_models_by_intent`` (hard-code a model id in
  ``secretary._llm_lane`` and it fails).
* Remove lists its impact first: ``test_removal_impact_lists_what_removing_touches``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import fold, identity, ledger, lifecycle, limits, meeting, models, send, state, wake  # noqa: E402

T0 = 1_000_000.0


def _leads(root, n=3):
    return [identity.register(root, f"chat-{i}", f"lead{i}") for i in range(n)]


def _decide(root, lead, now, **kw):
    chans = {cid: fold.fold_channel(root, cid) for cid in fold.list_channels(root)}
    return wake.next_wake(lead, fold.fold_member(root, lead), fold.unread(root, lead), chans, now, **kw)


class _Ctx:
    spawn = None


# --------------------------------------------------------------------------- #8


def test_owner_limits_only_tighten(tmp_path):
    hard = limits.hard_caps()
    r = limits.set_limits(tmp_path, {"hourly_message": 3, "total_wakes": hard["total_wakes"] + 500})
    assert r["status"] == "accepted"
    assert r["caps"]["hourly_message"] == 3
    assert r["caps"]["total_wakes"] == hard["total_wakes"]  # looser than the hard cap: not applied
    assert r["clamped"] == ["total_wakes"]
    assert r["asked"]["total_wakes"] == hard["total_wakes"] + 500  # kept as asked, so the page can say so
    # the tighter cap is the one enforced
    assert all(limits.charge(tmp_path, "message", now=T0 + i) for i in range(3))
    assert limits.charge(tmp_path, "message", now=T0 + 3) is False
    assert limits.stop_reason(tmp_path) == "budget"
    b = state.budget(tmp_path, T0 + 4)
    assert b["messages_hour"]["cap"] == 3 and b["limits"]["clamped"] == ["total_wakes"]


def test_set_limits_refuses_unknown_keys_and_bad_numbers(tmp_path):
    assert limits.set_limits(tmp_path, {"hop_limit": 99})["reason"] == "unknown_limit"
    assert limits.set_limits(tmp_path, {"hourly_wake": 0})["reason"] == "bad_limit"
    assert limits.set_limits(tmp_path, {"hourly_wake": True})["reason"] == "bad_limit"
    assert limits.set_limits(tmp_path, {"owner_away_secs": 5})["reason"] == "bad_limit"
    assert limits.set_limits(tmp_path, "x")["reason"] == "bad_limits"
    assert not (tmp_path / "control.jsonl").exists()


# --------------------------------------------------------------------------- #10


def test_open_and_add_wake_nobody(tmp_path):
    a, b, c, d = _leads(tmp_path, 4)
    r = send.open_group(tmp_path, "owner", "launch", [a, b, c], now=T0)
    assert r["created"] == [r["channel_id"]] and r["reused"] == []
    add = send.change_members(tmp_path, r["channel_id"], [d, a], [])
    assert add["added"] == [d] and add["already_members"] == [a]
    assert "created" not in add and "reused" not in add  # created/reused name the group only
    # members are picked from existing leads: an unknown one is refused, nobody is created
    assert send.change_members(tmp_path, r["channel_id"], ["L-00000000"], [])["reason"] == "not_a_lead"
    assert send.open_group(tmp_path, "owner", "x", [a, "L-00000000"], now=T0)["reason"] == "not_a_lead"
    assert len(fold.directory(tmp_path)["leads"]) == 4
    for lead in (a, b, c, d):
        assert fold.unread(tmp_path, lead) == []
        assert _decide(tmp_path, lead, T0 + 3600) is None  # not even a batch, an hour later
    send.post(tmp_path, "owner", channel_id=r["channel_id"], text="kickoff", now=T0 + 10)
    assert "owner" in _decide(tmp_path, d, T0 + 11)["reasons"]  # the first message is the first wake


def test_open_same_group_twice_reuses_it(tmp_path):
    a, b, c = _leads(tmp_path)
    first = send.open_group(tmp_path, a, "Launch", [a, b], now=T0)
    again = send.open_group(tmp_path, "owner", "  launch ", [b, a], now=T0 + 1)
    assert again["reused"] == [first["channel_id"]] and again["created"] == []
    other = send.open_group(tmp_path, a, "Launch", [a, b, c], now=T0 + 2)
    assert other["created"] and other["channel_id"] != first["channel_id"]
    assert len([cid for cid in fold.list_channels(tmp_path) if cid.startswith("G-")]) == 2


# --------------------------------------------------------------------------- #12 close


def test_group_closes_only_after_action_items_clear(tmp_path):
    a, b, c = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c], now=T0)["channel_id"]
    mid = meeting.convene(tmp_path, a, g, "Plan", [{"title": "t", "question": "q?"}], [b, c],
                          now=T0)["meeting_id"]
    blocking = lifecycle.close_blockers(tmp_path, g)["blocking"]
    assert [x["kind"] for x in blocking] == ["meeting"]
    for who in (b, c):
        meeting.respond(tmp_path, who, mid, "accept", now=T0)
    aid = meeting.action_propose(tmp_path, a, mid, b, "Write the runbook", now=T0)["action_id"]
    meeting.action_propose(tmp_path, a, mid, c, "Ping infra", now=T0)
    meeting.adjourn(tmp_path, "owner", mid, "owner", now=T0 + 1)
    meeting.step_all(tmp_path, T0 + 2)
    kinds = sorted(x["kind"] for x in lifecycle.close_blockers(tmp_path, g)["blocking"])
    assert kinds == ["action", "action", "meeting"]  # still adjourning: two actions wait for an answer
    r = lifecycle.close_group(tmp_path, g)
    assert r["status"] == "refused" and r["reason"] == "open_items"
    assert all("L-" not in x["text"] for x in r["blocking"])  # handles, never ids
    meeting.action_respond(tmp_path, b, mid, aid, "accept", now=T0 + 3)
    aid2 = [x for x in meeting.find(tmp_path, mid)[2]["actions"] if x != aid][0]
    meeting.action_respond(tmp_path, c, mid, aid2, "decline", "not mine", now=T0 + 3)
    meeting.step_all(tmp_path, T0 + 4)
    blocking = lifecycle.close_blockers(tmp_path, g)["blocking"]
    assert [x["kind"] for x in blocking] == ["todo"] and "@lead1" in blocking[0]["text"]
    todo = meeting.todo_list(tmp_path, b)["todos"][0]
    assert todo["state"] == "open"
    assert meeting.todo_close(tmp_path, c, todo["todo_id"], "done")["reason"] == "no_such_todo"  # not c's
    assert meeting.todo_close(tmp_path, b, todo["todo_id"], "finished")["reason"] == "bad_state"
    assert meeting.todo_close(tmp_path, b, todo["todo_id"], "done", "shipped")["status"] == "accepted"
    assert meeting.todo_close(tmp_path, b, todo["todo_id"], "cancelled")["reason"] == "todo_closed"
    assert lifecycle.close_blockers(tmp_path, g)["blocking"] == []
    assert lifecycle.close_group(tmp_path, g)["status"] == "accepted"
    # closed: no posts, no member changes, no meetings, not reused
    assert send.post(tmp_path, a, channel_id=g, text="hi", now=T0 + 5)["reason"] == "group_closed"
    assert send.post(tmp_path, "owner", channel_id=g, text="hi", now=T0 + 5)["reason"] == "group_closed"
    assert send.change_members(tmp_path, g, [], [c])["reason"] == "group_closed"
    assert meeting.convene(tmp_path, a, g, "Again", [{"title": "t", "question": "q?"}], [b],
                           now=T0 + 6)["reason"] == "group_closed"
    assert send.open_group(tmp_path, a, "room", [a, b, c], now=T0 + 7)["created"]
    assert lifecycle.close_group(tmp_path, g)["reason"] == "group_closed"


def test_a_removed_leads_todo_does_not_block_close(tmp_path):
    a, b = _leads(tmp_path, 2)
    g = send.open_group(tmp_path, a, "pair", [a, b], now=T0)["channel_id"]
    mid = meeting.convene(tmp_path, a, g, "Plan", [{"title": "t", "question": "q?"}], [b], now=T0)["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    aid = meeting.action_propose(tmp_path, a, mid, b, "Do it", now=T0)["action_id"]
    meeting.action_respond(tmp_path, b, mid, aid, "accept", now=T0)
    meeting.adjourn(tmp_path, "owner", mid, "owner", now=T0 + 1)
    meeting.step_all(tmp_path, T0 + 2)
    meeting.step_all(tmp_path, T0 + 3)
    identity.retire(tmp_path, b)
    check = lifecycle.close_blockers(tmp_path, g)
    assert check["blocking"] == [] and [n["kind"] for n in check["notes"]] == ["todo"]


# --------------------------------------------------------------------------- #12 owner away


def test_owner_away_pauses_batch_wakes_only(tmp_path):
    a, b, c = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c], now=T0)["channel_id"]
    rows = []
    assert limits.owner_away(rows, T0) is False  # never seen: present (older installs)
    limits.note_owner_seen(tmp_path, now=T0)
    limits.note_owner_seen(tmp_path, now=T0 + 10)  # throttled: one row a minute
    assert [r["type"] for r in ledger.read(tmp_path, limits.CONTROL)] == ["owner/seen"]
    away_at = T0 + limits.OWNER_AWAY_SECS
    assert limits.owner_away(ledger.read(tmp_path, limits.CONTROL), away_at - 1) is False
    assert limits.owner_away(ledger.read(tmp_path, limits.CONTROL), away_at) is True
    # a plain group message would batch-wake c; while the owner is away it waits
    send.post(tmp_path, a, channel_id=g, text="fyi", now=away_at)
    later = away_at + wake.BATCH_WINDOW_SECS + wake.BATCH_OFFSET_MAX
    assert _decide(tmp_path, c, later)["reasons"] == ["batch"]
    assert _decide(tmp_path, c, later, batch_paused=True) is None
    # a DM still wakes at once: the pause is for the timer, not for a direct word
    send.post(tmp_path, a, to=c, text="quick one", now=later)
    assert "dm" in _decide(tmp_path, c, later + 1, batch_paused=True)["reasons"]


def test_tick_records_the_pause_and_the_owner_ends_it(tmp_path):
    a, b = _leads(tmp_path, 2)
    g = send.open_group(tmp_path, a, "pair", [a, b], now=T0)["channel_id"]
    ledger.append(tmp_path, limits.CONTROL, "app/started", "app", {}, now=T0)
    limits.set_limits(tmp_path, {"owner_away_secs": 60})  # the owner may only shorten it
    limits.note_owner_seen(tmp_path, now=T0)
    send.post(tmp_path, a, channel_id=g, text="fyi", now=T0 + 1)
    late = T0 + 60 + wake.BATCH_WINDOW_SECS + wake.BATCH_OFFSET_MAX
    did = asyncio.run(wake.tick(_Ctx(), tmp_path, now=late))
    assert did["dues"] == []
    assert limits.batch_paused_since(ledger.read(tmp_path, limits.CONTROL)) == late
    asyncio.run(wake.tick(_Ctx(), tmp_path, now=late + 2))
    assert [r["type"] for r in ledger.read(tmp_path, limits.CONTROL)].count("wake/batch_paused") == 1
    limits.note_owner_seen(tmp_path, now=late + 5)
    rows = ledger.read(tmp_path, limits.CONTROL)
    assert limits.batch_paused_since(rows) is None and rows[-1]["type"] == "wake/batch_resumed"
    assert state.budget(tmp_path, late + 6)["owner_away"]["last_pause"] == {"from": late, "to": late + 5}
    did = asyncio.run(wake.tick(_Ctx(), tmp_path, now=late + 6))
    assert [lead for lead, _ in did["dues"]] == [b]


# --------------------------------------------------------------------------- #15


class _Spawn:
    def __init__(self):
        self.models = []

    async def run(self, task, agent="", **kw):
        self.models.append(kw.get("model"))
        raise RuntimeError("no model in tests")

    def is_done(self, run_id):
        return True


def test_roles_pick_models_by_intent(tmp_path):
    cfg = models.config([])
    assert models.resolve(cfg, "secretary") == "claude-haiku-4.5"
    assert models.resolve(cfg, "bar_raiser") == "claude-sonnet-5.5"
    r = models.set_config(tmp_path, routes={"easy": "claude-sonnet-4.6"}, roles={"bar_raiser": "smartest"})
    assert r["status"] == "accepted"
    assert models.model_for(tmp_path, "secretary") == "claude-sonnet-4.6"
    assert models.model_for(tmp_path, "bar_raiser") == "claude-opus-5.5"
    # a later edit sends only what changed and keeps the rest
    models.set_config(tmp_path, roles={"secretary": "default"})
    assert models.config(ledger.read(tmp_path, limits.CONTROL))["roles"] == {"secretary": "default",
                                                                             "bar_raiser": "smartest"}
    assert models.set_config(tmp_path, routes={"fast": "x"})["reason"] == "unknown_intent"
    assert models.set_config(tmp_path, routes={"easy": "Bad Id!"})["reason"] == "bad_model_id"
    assert models.set_config(tmp_path, roles={"lead": "easy"})["reason"] == "unknown_role"
    # the secretary really asks spawn for the routed id
    from teamapp import secretary

    ctx = type("C", (), {"spawn": _Spawn()})()
    a, b = _leads(tmp_path, 2)
    g = send.open_group(tmp_path, a, "pair", [a, b], now=T0)["channel_id"]
    send.post(tmp_path, a, channel_id=g, text="hello", now=T0)
    asyncio.run(secretary.brief_for(ctx, tmp_path, b, fold.unread(tmp_path, b)))
    assert ctx.spawn.models == ["claude-sonnet-5.5"]  # secretary -> default -> claude-sonnet-5.5


# --------------------------------------------------------------------------- Remove


def test_removal_impact_lists_what_removing_touches(tmp_path):
    a, b, c = _leads(tmp_path)
    g2 = send.open_group(tmp_path, a, "pair", [a, b], now=T0)["channel_id"]
    g3 = send.open_group(tmp_path, a, "trio", [a, b, c], now=T0)["channel_id"]
    send.post(tmp_path, a, to=b, text="dm", now=T0)
    send.post(tmp_path, a, channel_id=g3, text="@lead1 can you", mentions=[b], now=T0 + 1)
    mid = meeting.convene(tmp_path, c, g3, "Sync", [{"title": "t", "question": "q?"}], [b], now=T0 + 2)["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0 + 2)
    meeting.action_propose(tmp_path, c, mid, b, "Fix the alarm", now=T0 + 3)
    imp = lifecycle.removal_impact(tmp_path, b)
    assert imp["handle"] == "lead1" and imp["dms"] == 1
    assert {(x["title"], x["left"], x["short"]) for x in imp["groups"]} == {("pair", 1, True), ("trio", 2, False)}
    assert [x["text"] for x in imp["requests"]] == ["@lead0's request to @lead1"]
    assert imp["meetings"] == [{"group": "trio", "title": "Sync", "role": "attendee"}]
    assert imp["actions"] == [{"group": "trio", "title": "Fix the alarm", "state": "unanswered"}]
    assert "L-" not in str({k: v for k, v in imp.items() if k != "status"})
    # nothing written, and the lead record is untouched until the owner confirms
    assert fold.directory(tmp_path)["leads"][b]["active"] is True
    assert lifecycle.removal_impact(tmp_path, "L-00000000")["reason"] == "unknown_lead"
    assert g2


def test_removal_impact_waiting_matches_needs_you(tmp_path):
    """MERGED-SMOKE B-MS1: Remove says "waiting on you" only for an open decision (the
    page's waitingOnYou). A lapsed card or one answered elsewhere has no case answer but
    no longer waits."""
    from teamapp import decisions

    a, b = _leads(tmp_path, 2)
    g = send.open_group(tmp_path, a, "room", [a, b], now=T0)["channel_id"]
    for cid in ("C-1", "C-2", "C-3"):
        ledger.append(tmp_path, "cases.jsonl", "bar_raiser/summoned", "app",
                      {"case_id": cid, "channel_id": g, "thread_id": None, "root_seq": 0,
                       "triggers": [], "continues_left": 2, "deadline": T0 + 600, "model": "m"})
        ledger.append(tmp_path, "cases.jsonl", "bar_raiser/acted", f"bar_raiser:{cid}",
                      {"case_id": cid, "action": "call_person", "args": {}, "rationale": "r", "evidence_seqs": []})
        ledger.append(tmp_path, "cases.jsonl", "bar_raiser/called_person", "app",
                      {"case_id": cid, "class": "spend", "question": "ok?"})
    ledger.append(tmp_path, "cases.jsonl", "bar_raiser/card_lapsed", "app", {"case_id": "C-1"})
    ledger.append(tmp_path, decisions.FILE, "decision/answered", "owner", {"key": "case:C-2", "text": "go"})
    assert [d["key"] for d in decisions.listing(tmp_path) if d["state"] == "open"] == ["case:C-3"]
    assert lifecycle.removal_impact(tmp_path, b)["cases"] == [{"group": "room", "state": "waiting on you"}]
    ledger.append(tmp_path, decisions.FILE, "decision/answered", "owner", {"key": "case:C-3", "text": "ok"})
    assert lifecycle.removal_impact(tmp_path, b)["cases"] == []
