"""Meetings (RFC v5 "Meetings"): planner, sealed round, outcomes, budgets, minutes, accept gate.

Each guarantee has a test that reddens when its check is removed:

* plan_next replay: ``test_plan_next_is_pure_and_the_log_replays`` (drop ``plan_at`` or make a
  turn id random in meeting.py and it fails).
* sealed round: ``test_sealed_round_hides_other_speeches_until_revealed`` (delete the
  ``sealed_key`` check in fold.visible and it fails).
* accept gate: ``test_action_item_reaches_todos_only_through_its_owners_accept`` (delete the
  ``a["owner"] != sender`` check in meeting.action_respond and it fails).
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import bar_raiser, fold, identity, ledger, meeting, send, wake  # noqa: E402

T0 = 1_000_000.0

_spec = importlib.util.spec_from_file_location("team_mcp_server_meeting", APP / "mcp" / "server.py")
server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server)


class _Spawn:
    def __init__(self):
        self.tasks = []

    async def run(self, task, agent="", **kw):
        self.tasks.append(task)
        return "spawn-1"


class _Ctx:
    def __init__(self):
        self.spawn = _Spawn()


def _setup(root, n=3):
    leads = [identity.register(root, f"chat-{i}", f"lead{i}") for i in range(n)]
    g = send.open_group(root, leads[0], "room", leads, now=T0)["channel_id"]
    return leads, g


def _convene(root, leads, g, agenda=None, now=T0, **kw):
    a = leads[0]
    agenda = agenda or [{"title": "expires_at format", "question": "ISO 8601 or epoch seconds?"}]
    r = meeting.convene(root, a, g, "Share API v2", agenda, leads[1:], now=now, **kw)
    assert r["status"] == "accepted", r
    return r["meeting_id"]


def _m(root, mid):
    return meeting.find(root, mid)[2]


def _rows(root, g):
    return ledger.read(root, fold.channel_file(g))


def _turn(root, mid, who):
    m = _m(root, mid)
    it = m["items"][m["current"]]
    return next(g["turn_id"] for g in meeting._open_grants(it) if g["speaker"] == who)


def _br_act(root, case_id, nonce, *rest):
    """``bar_raiser.act`` bound to the packet just read, as a real bar raiser does."""
    return bar_raiser.act(root, case_id, nonce, *rest,
                          packet_hash=bar_raiser.case_packet(root, case_id, nonce).get("packet_hash"))


def _types(root, g, since=0):
    return [r["type"] for r in _rows(root, g)[since:]]


def _accept_all(root, mid, leads, now=T0):
    for who in leads[1:]:
        assert meeting.respond(root, who, mid, "accept", now=now)["status"] == "accepted"


def _run_consensus_meeting(root):
    """a presents P1, b agrees, c objects (sealed); round 2 c agrees -> consensus."""
    leads, g = _setup(root)
    a, b, c = leads
    mid = _convene(root, leads, g)
    _accept_all(root, mid, leads)
    t = T0 + 1
    assert meeting.speak(root, a, mid, _turn(root, mid, a), "propose", "Use ISO 8601 strings in UTC.",
                         evidence=["PR #12"], now=t)["proposal_id"] == "I1-P1"
    assert meeting.speak(root, b, mid, _turn(root, mid, b), "agree", "Agree, dashboards parse it.",
                         proposal_id="I1-P1", now=t + 1)["sealed"] is True
    meeting.speak(root, c, mid, _turn(root, mid, c), "object", "Docs need a sample response.",
                  proposal_id="I1-P1", now=t + 2)
    meeting.progress(root, a, mid, False, True, False, "continue", "Is anyone against ISO?", now=t + 3)
    meeting.speak(root, a, mid, _turn(root, mid, a), "info", "Nothing new from me.", now=t + 4)
    meeting.speak(root, b, mid, _turn(root, mid, b), "pass", now=t + 5)
    meeting.speak(root, c, mid, _turn(root, mid, c), "agree", "Fine with ISO.", proposal_id="I1-P1", now=t + 6)
    meeting.progress(root, a, mid, True, True, False, "close", now=t + 7)
    return leads, g, mid


# --------------------------------------------------------------------------- state machine


def test_meeting_runs_convening_open_adjourning_closed(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g)
    m = _m(tmp_path, mid)
    assert m["state"] == "convening" and m["speakers"] == [a]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    assert _m(tmp_path, mid)["state"] == "convening"  # c has not answered yet
    meeting.respond(tmp_path, c, mid, "accept", now=T0)
    m = _m(tmp_path, mid)
    assert m["state"] == "open" and m["current"] == "I1"
    assert [g_["speaker"] for g_ in meeting._open_grants(m["items"]["I1"])] == [a]  # the presenter first
    leads, g, mid = _run_consensus_meeting(tmp_path / "x")
    root = tmp_path / "x"
    m = _m(root, mid)
    assert m["state"] == "closed"
    out = m["items"]["I1"]["outcome"]
    assert out["kind"] == "consensus" and out["proposal_id"] == "I1-P1" and out["by"] == "planner"
    assert set(out["agree"]) == set(leads) and out["object"] == []
    types = _types(root, g)
    assert types.index("meeting/adjourned") < types.index("minutes/sealed") < types.index("meeting/closed")


def test_meeting_without_quorum_is_cancelled(tmp_path):
    leads, g = _setup(tmp_path)
    mid = _convene(tmp_path, leads, g)
    meeting.respond(tmp_path, leads[1], mid, "decline", "busy with a release", now=T0)
    meeting.respond(tmp_path, leads[2], mid, "decline", now=T0)
    m = _m(tmp_path, mid)
    assert m["state"] == "cancelled" and m["cancel_reason"] == "quorum"
    # and an unanswered invitation runs out at respond_by
    mid2 = _convene(tmp_path, leads, g, respond_within_secs=60, now=T0 + 100)
    meeting.step(tmp_path, g, mid2, T0 + 159)
    assert _m(tmp_path, mid2)["state"] == "convening"
    meeting.step(tmp_path, g, mid2, T0 + 160)
    assert _m(tmp_path, mid2)["state"] == "cancelled"


def test_only_leads_attend_and_nobody_speaks_without_a_turn(tmp_path, monkeypatch):
    leads, g = _setup(tmp_path, 4)
    a, b, c, d = leads
    assert meeting.convene(tmp_path, a, g, "x", [{"title": "t"}], ["L-00000000"], now=T0)["reason"] == "not_a_lead"
    identity.retire(tmp_path, d)
    assert meeting.convene(tmp_path, a, g, "x", [{"title": "t"}], [d], now=T0)["reason"] == "not_a_lead"
    mid = _convene(tmp_path, [a, b, c], g)
    _accept_all(tmp_path, mid, [a, b, c])
    tid = _m(tmp_path, mid)["thread_id"]
    # a lead cannot post into the meeting thread with team_send; the owner can
    assert send.post(tmp_path, b, channel_id=g, thread=tid, text="side remark", now=T0 + 1)["reason"] == "meeting_thread"
    assert send.post(tmp_path, "owner", channel_id=g, thread=tid, text="Owner here.", now=T0 + 1)["status"] == "accepted"
    # b holds no grant yet (a presents first)
    assert meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, a), "info", "me first", now=T0 + 2)["reason"] == "not_your_turn"
    # convening from inside a turn is refused
    assert meeting.convene(tmp_path, a, g, "y", [{"title": "t"}], [b], now=T0 + 2)["reason"] == "convene_inside_turn"
    # an unregistered session gets not_a_lead through the MCP server
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-unknown")
    try:
        server.call("team_meeting_list", {}, tmp_path)
        raise AssertionError("expected refusal")
    except server.ToolError as exc:
        assert str(exc) == "not_a_lead"


def test_invite_during_the_meeting_adds_a_speaker_next_round(tmp_path):
    leads, g = _setup(tmp_path, 4)
    a, b, c, d = leads
    r = meeting.convene(tmp_path, a, g, "m", [{"title": "t"}], [b], chair="none", now=T0)
    mid = r["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    assert meeting.invite(tmp_path, b, mid, d, now=T0)["reason"] == "not_the_convener"
    assert meeting.invite(tmp_path, a, mid, d, now=T0)["status"] == "accepted"
    meeting.respond(tmp_path, d, mid, "accept", now=T0)
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "Do X.", now=T0 + 1)
    # d joined after round 1 was queued, so round 1 seals only b; round 2 includes d
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "info", "ok", now=T0 + 2)
    m = _m(tmp_path, mid)
    assert m["items"]["I1"]["round"] == 2 and d in m["items"]["I1"]["rounds"]["2"]["queue"]


# --------------------------------------------------------------------------- planner


def test_plan_next_is_pure_and_the_log_replays(tmp_path):
    leads, g, mid = _run_consensus_meeting(tmp_path)
    rows = _rows(tmp_path, g)
    batches = {r["data"]["plan_at"] for r in rows if r["by"] == "app" and "plan_at" in r["data"]}
    assert len(batches) >= 8
    assert meeting.replay_check(rows, mid) == []
    # same input, same output; and turn ids are the RFC hash, not random
    k = next(i for i, r in enumerate(rows) if r["type"] == "turn/granted")
    assert meeting.plan_next(rows[:k], mid, T0 + 5) == meeting.plan_next(rows[:k], mid, T0 + 5)
    g0 = rows[k]["data"]
    assert g0["turn_id"] == meeting.turn_id(mid, "I1", 1, leads[0])
    # a tampered planner row no longer replays
    bad = [dict(r, data={**r["data"], "rule": "made_up"}) if r["seq"] == rows[k]["seq"] else r for r in rows]
    assert meeting.replay_check(bad, mid) == [rows[k]["data"]["plan_at"]]


def test_round_two_order_follows_the_owner_then_the_chair_then_calls(tmp_path):
    leads, g = _setup(tmp_path, 4)
    a, b, c, d = leads
    r = meeting.convene(tmp_path, a, g, "m", [{"title": "t"}], [b, c, d], now=T0)
    mid = r["meeting_id"]
    _accept_all(tmp_path, mid, leads)
    tid = _m(tmp_path, mid)["thread_id"]
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "Plan A.", now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "info", "Ask d.", calls=[d], now=T0 + 2)
    meeting.speak(tmp_path, c, mid, _turn(tmp_path, mid, c), "pass", now=T0 + 3)
    meeting.speak(tmp_path, d, mid, _turn(tmp_path, mid, d), "pass", now=T0 + 4)
    # the owner names c before the chair answers
    send.post(tmp_path, "owner", channel_id=g, thread=tid, text="@lead2 first please", mentions=[c], now=T0 + 5)
    meeting.progress(tmp_path, a, mid, False, True, False, "continue", next_speakers=[b, "L-ffffffff"], now=T0 + 6)
    m = _m(tmp_path, mid)
    rd = m["items"]["I1"]["rounds"]["2"]
    assert rd["queue"] == [c, b, d] and rd["rule"].startswith("person_named+chair_next_speakers")
    assert m["items"]["I1"]["extra_rounds"] == 1 and m["continues_used"] == 1  # the owner's word is one round
    assert [x["speaker"] for x in meeting._open_grants(m["items"]["I1"])] == [c]  # one at a time after round 1
    # an expired grant counts as a pass and the floor moves on
    meeting.step(tmp_path, g, mid, T0 + 6 + meeting.TURN_SECS)
    m = _m(tmp_path, mid)
    assert [x["speaker"] for x in meeting._open_grants(m["items"]["I1"])] == [b]


# --------------------------------------------------------------------------- sealed first round


def test_sealed_round_hides_other_speeches_until_revealed(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g)
    _accept_all(tmp_path, mid, leads)
    tid = _m(tmp_path, mid)["thread_id"]
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "PRESENTATION", now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "object", "B-SEALED-STANCE", proposal_id="I1-P1",
                  now=T0 + 2)

    def texts(viewer):
        return [e["data"]["text"] for e in fold.channel_view(tmp_path, g, viewer, thread=tid)["entries"]
                if e["type"] == "message/posted"]

    assert "PRESENTATION" in texts(c) and "B-SEALED-STANCE" not in texts(c)
    assert "B-SEALED-STANCE" in texts(b) and "B-SEALED-STANCE" in texts("owner")
    packet = meeting.read_packet(tmp_path, c, mid)
    assert all("B-SEALED" not in s["text"] for s in packet["new_speeches_from_other_agents_data"])
    assert [p["object"] for p in packet["proposals"]] == [0]  # no count leaks either
    assert packet["current_item"]["sealed"] is True
    # meeting speeches never ride the inbox; a's turn grant does
    assert all(not i["data"].get("meeting") for i in fold.unread(tmp_path, c))
    meeting.speak(tmp_path, c, mid, _turn(tmp_path, mid, c), "info", "C-STANCE", now=T0 + 3)
    assert "agenda/round_revealed" in _types(tmp_path, g)
    assert "B-SEALED-STANCE" in texts(c) and "C-STANCE" in texts(b)


def test_no_consensus_inside_the_sealed_round(tmp_path):
    """Consensus is counted only once round 1 is revealed (never while it is still sealed)."""
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g)
    _accept_all(tmp_path, mid, leads)
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "P", now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "agree", "y", proposal_id="I1-P1", now=T0 + 2)
    # c has not spoken: still sealed, so no round end and no outcome
    assert "agenda/round_ended" not in _types(tmp_path, g)
    assert _m(tmp_path, mid)["items"]["I1"]["outcome"] is None
    meeting.speak(tmp_path, c, mid, _turn(tmp_path, mid, c), "object", "n", proposal_id="I1-P1", now=T0 + 3)
    types = _types(tmp_path, g)
    assert types.index("agenda/round_revealed") < types.index("agenda/round_ended")
    ended = [r for r in _rows(tmp_path, g) if r["type"] == "agenda/round_ended"]
    assert ended[-1]["data"]["consensus"] is None  # c objects
    meeting.progress(tmp_path, a, mid, True, True, False, "continue", now=T0 + 4)
    assert _m(tmp_path, mid)["items"]["I1"]["round"] == 2


def _round_one_all_agree(root, n=3, **kw):
    """The presenter proposes, everyone else agrees in the sealed round 1."""
    leads, g = _setup(root, n)
    mid = meeting.convene(root, leads[0], g, "Share API v2", [{"title": "expires_at format"}], leads[1:],
                          now=T0, **kw)["meeting_id"]
    _accept_all(root, mid, leads)
    meeting.speak(root, leads[0], mid, _turn(root, mid, leads[0]), "propose", "Use ISO 8601.", now=T0 + 1)
    for i, who in enumerate(leads[1:]):
        meeting.speak(root, who, mid, _turn(root, mid, who), "agree", "Agree.", proposal_id="I1-P1",
                      now=T0 + 2 + i)
    return leads, g, mid


def test_b1_round_one_consensus_is_counted_and_close_keeps_it(tmp_path):
    """B1 (e2e S22 run 1): all 3 agree in round 1, chair says settled + close -> consensus, not no_outcome."""
    leads, g, mid = _round_one_all_agree(tmp_path)
    ended = [r for r in _rows(tmp_path, g) if r["type"] == "agenda/round_ended"]
    assert ended[-1]["data"]["consensus"] == "I1-P1"
    meeting.progress(tmp_path, leads[0], mid, True, True, False, "close", now=T0 + 10)
    m = _m(tmp_path, mid)
    out = m["items"]["I1"]["outcome"]
    assert out["kind"] == "consensus" and out["proposal_id"] == "I1-P1" and set(out["agree"]) == set(leads)
    assert m["state"] == "closed" and m["minutes"]["items"][0]["outcome"]["kind"] == "consensus"
    text = next(r["data"]["text"] for r in _rows(tmp_path, g) if r["data"].get("kind") == "minutes")
    assert "No outcome" not in text and "Consensus" in text


def test_round_one_consensus_wins_over_every_chair_recommend(tmp_path):
    for rec in meeting.RECOMMEND:
        root = tmp_path / rec
        leads, g, mid = _round_one_all_agree(root)
        opts = ["A", "B"] if rec == "vote" else None
        meeting.progress(root, leads[0], mid, True, True, False, rec, vote_options=opts, now=T0 + 10)
        out = _m(root, mid)["items"]["I1"]["outcome"]
        assert out and out["kind"] == "consensus", (rec, out)


def test_a_speakers_question_to_the_owner_is_asked_even_when_the_room_agrees(tmp_path):
    """MERGED-SMOKE B-MS2: presenter proposes with ask_person, the other agrees -> the item
    waits on the owner (a decision opens), it is not recorded as the leads' consensus."""
    from teamapp import decisions

    leads, g = _setup(tmp_path, 2)
    a, b = leads
    mid = meeting.convene(tmp_path, a, g, "Redirect lifetime", [{"title": "lifetime"}], [b], now=T0)["meeting_id"]
    _accept_all(tmp_path, mid, leads)
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose",
                  "Keep the redirect for 90 days. Owner, is 90 days fine?", ask_person=True, now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "agree", "Agree.", proposal_id="I1-P1", now=T0 + 2)
    assert [r for r in _rows(tmp_path, g) if r["type"] == "agenda/round_ended"][-1]["data"]["consensus"] == "I1-P1"
    meeting.progress(tmp_path, a, mid, True, True, False, "ask_person", now=T0 + 10)
    it = _m(tmp_path, mid)["items"]["I1"]
    assert it["outcome"] is None and it["waiting"] is not None
    assert [d["kind"] for d in decisions.listing(tmp_path) if d["state"] == "open"] == ["meeting_item"]


def test_a_speakers_question_is_quoted_and_placed_on_that_speaker(tmp_path):
    """MERGED-SMOKE F-MS3/F-MS4: the Needs you card quotes the speaker (not "A speaker asked
    for a person."), and the decision names the asking lead so Leads now puts it on that card."""
    from teamapp import decisions

    leads, g = _setup(tmp_path, 2)
    a, b = leads
    mid = meeting.convene(tmp_path, a, g, "Redirect lifetime", [{"title": "lifetime"}], [b], now=T0)["meeting_id"]
    _accept_all(tmp_path, mid, leads)
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose",
                  "Keep the redirect for 90 days. Owner, is 90 days fine?", ask_person=True, now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "info", "Logs show 30 days of traffic.", now=T0 + 2)
    meeting.progress(tmp_path, a, mid, True, True, False, "continue", now=T0 + 10)
    d = next(x for x in decisions.listing(tmp_path) if x["state"] == "open")
    assert d["question"] == "lead0 asks: Keep the redirect for 90 days. Owner, is 90 days fine?"
    assert d["lead"] == a


def test_round_one_consensus_without_a_chair_and_in_a_two_person_meeting(tmp_path):
    leads, g, mid = _round_one_all_agree(tmp_path / "nochair", chair="none")
    assert _m(tmp_path / "nochair", mid)["items"]["I1"]["outcome"]["kind"] == "consensus"
    leads, g, mid = _round_one_all_agree(tmp_path / "two", n=2)
    meeting.progress(tmp_path / "two", leads[0], mid, True, True, False, "close", now=T0 + 10)
    out = _m(tmp_path / "two", mid)["items"]["I1"]["outcome"]
    assert out["kind"] == "consensus" and set(out["agree"]) == set(leads)


def test_round_one_after_a_tied_vote_first_ballot_counts_consensus(tmp_path):
    """vote_first ties -> bar raiser continue -> round 1 discussion; agreement there is consensus."""
    leads, g = _setup(tmp_path, 2)
    a, b = leads
    mid = meeting.convene(tmp_path, a, g, "m", [{"title": "t", "mode": "vote_first", "options": ["x", "y"]}],
                          [b], now=T0)["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    meeting.vote(tmp_path, a, mid, "I1-B1", "x", "x is ready", now=T0 + 1)
    meeting.vote(tmp_path, b, mid, "I1-B1", "y", "y is safer", now=T0 + 1)
    case = bar_raiser.detect(tmp_path, g, T0 + 2)[0]
    ctx = _Ctx()
    case_id = asyncio.run(bar_raiser.summon(ctx, tmp_path, case))
    nonce = ctx.spawn.tasks[0].split("nonce=")[1].split()[0]
    assert _br_act(tmp_path, case_id, nonce, "continue", {}, "talk it through", [])["status"] == "accepted"
    bar_raiser.apply_due(tmp_path, T0 + 3)
    meeting.step(tmp_path, g, mid, T0 + 3)
    assert _m(tmp_path, mid)["items"]["I1"]["round"] == 1
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "Ship x behind a flag.", now=T0 + 4)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "agree", "With a flag, fine.", proposal_id="I1-P1",
                  now=T0 + 5)
    meeting.progress(tmp_path, a, mid, True, True, False, "close", now=T0 + 6)
    out = _m(tmp_path, mid)["items"]["I1"]["outcome"]
    assert out["kind"] == "consensus" and out["proposal_id"] == "I1-P1"


def test_adjourning_keeps_a_consensus_already_reached_and_reveals_the_sealed_round(tmp_path):
    """The turn budget runs out the moment round 1 is fully spoken: the agreement is kept, not deferred."""
    leads, g, mid = _round_one_all_agree(tmp_path, budgets={"turns": 3}, chair="none")
    m = _m(tmp_path, mid)
    assert m["adjourn_reason"] == "turn_budget" and m["state"] == "closed"
    assert m["items"]["I1"]["outcome"]["kind"] == "consensus"
    assert "agenda/round_revealed" in _types(tmp_path, g)
    # and without agreement it is still deferred
    leads, g = _setup(tmp_path / "x")
    a, b, c = leads
    mid = _convene(tmp_path / "x", leads, g, budgets={"turns": 3}, chair="none")
    _accept_all(tmp_path / "x", mid, leads)
    meeting.speak(tmp_path / "x", a, mid, _turn(tmp_path / "x", mid, a), "propose", "P", now=T0 + 1)
    meeting.speak(tmp_path / "x", b, mid, _turn(tmp_path / "x", mid, b), "agree", "y", proposal_id="I1-P1",
                  now=T0 + 2)
    meeting.speak(tmp_path / "x", c, mid, _turn(tmp_path / "x", mid, c), "object", "n", proposal_id="I1-P1",
                  now=T0 + 3)
    assert _m(tmp_path / "x", mid)["items"]["I1"]["outcome"]["kind"] == "deferred"


# --------------------------------------------------------------------------- counting


def test_consensus_needs_two_agrees_and_no_objection():
    it = {"proposals": {"P1": {"seq": 1}, "P2": {"seq": 2}}, "latest": {}}
    sp = ["a", "b", "c"]
    it["latest"] = {"a": ["propose", "P1", 1], "b": ["agree", "P1", 3]}
    assert meeting.consensus(it, sp) == "P1"
    it["latest"]["c"] = ["object", "P1", 4]
    assert meeting.consensus(it, sp) is None
    it["latest"]["c"] = ["agree", "P2", 5]  # c's latest stance moved off P1: no objection left
    assert meeting.consensus(it, sp) == "P1"
    assert meeting.stance_counts(it, sp, "P1") == {"agree": ["a", "b"], "object": [], "abstain": ["c"]}


def test_tally_majority_and_ties():
    def t(*votes, options=("A", "B", "C")):
        return meeting.tally({"options": list(options),
                              "votes": {f"v{i}": {"choice": v} for i, v in enumerate(votes)}})

    assert t("A", "A", "B")["winner"] == "A"
    assert t("A", "B")["tie"] == ["A", "B"] and t("A", "B")["winner"] is None
    assert t("A", "A", "B", "C")["tie"] == ["A", "B", "C"]  # top has no majority of the votes cast
    assert t()["winner"] is None and t()["tie"] == []


def test_tie_goes_to_the_bar_raiser_who_rules(tmp_path):
    leads, g = _setup(tmp_path, 2)
    a, b = leads
    r = meeting.convene(tmp_path, a, g, "Release order", [{"title": "Who ships first", "mode": "vote_first",
                                                             "options": ["api", "web"]}], [b], now=T0)
    mid = r["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    m = _m(tmp_path, mid)
    bid = m["items"]["I1"]["ballot_open"]
    assert bid == "I1-B1"
    assert meeting.vote(tmp_path, a, mid, bid, "api", "", now=T0 + 1)["reason"] == "vote_needs_reason"
    meeting.vote(tmp_path, a, mid, bid, "api", "API is ready", evidence=["PR #7"], now=T0 + 1)
    # sealed until close: b cannot see a's vote
    cast = next(x for x in _rows(tmp_path, g) if x["type"] == "ballot/cast")
    assert not fold.visible(cast, fold.fold_channel(tmp_path, g), b)
    assert meeting.vote(tmp_path, a, mid, bid, "web", "changed my mind", now=T0 + 1)["reason"] == "already_voted"
    meeting.vote(tmp_path, b, mid, bid, "web", "Web has the fix", now=T0 + 2)
    assert fold.visible(cast, fold.fold_channel(tmp_path, g), b)
    need = [x for x in _rows(tmp_path, g) if x["type"] == "meeting/bar_raiser_needed"]
    assert need and need[-1]["data"]["trigger"] == "tie" and need[-1]["data"]["choices"] == ["api", "web"]
    # the existing case machinery takes it
    cases = bar_raiser.detect(tmp_path, g, T0 + 3)
    assert [t["trigger"] for t in cases[0]["triggers"]] == ["meeting_tie"]
    ctx = _Ctx()
    case_id = asyncio.run(bar_raiser.summon(ctx, tmp_path, cases[0]))
    nonce = ctx.spawn.tasks[0].split("nonce=")[1].split()[0]
    packet = bar_raiser.case_packet(tmp_path, case_id, nonce)
    assert packet["allowed_actions"] == list(bar_raiser.MEETING_ACTIONS)
    assert packet["meeting"]["choices"] == ["api", "web"]
    seqs = [x["seq"] for x in _rows(tmp_path, g) if x["type"] == "ballot/cast"]
    closed = [x["seq"] for x in _rows(tmp_path, g) if x["type"] == "ballot/closed"]
    sides = [{"by": "api side", "claim": "API is ready", "evidence_seqs": seqs[:1]},
             {"by": "web side", "claim": "Web has the fix", "evidence_seqs": seqs[1:]}]
    ruling = {"positions": sides, "decides": "Which side carries less release risk"}
    bad = _br_act(tmp_path, case_id, nonce, "rule", {**ruling, "choice": "mobile"}, "x", seqs + closed)
    assert bad["reason"] == "invalid"
    assert _br_act(tmp_path, case_id, nonce, "close_thread", {}, "x", seqs)["reason"] == "invalid"
    ok = _br_act(tmp_path, case_id, nonce, "rule", {**ruling, "choice": "api"},
                 "API is behind a flag; lower risk.", seqs + closed)
    assert ok["status"] == "accepted"
    bar_raiser.apply_due(tmp_path, T0 + 4)
    meeting.step(tmp_path, g, mid, T0 + 4)
    out = _m(tmp_path, mid)["items"]["I1"]["outcome"]
    assert out["kind"] == "bar_raiser_ruling" and out["text"] == "api" and out["by"] == "bar_raiser"
    assert out["rationale"].startswith("API is behind a flag")
    assert _m(tmp_path, mid)["state"] == "closed"


def test_owner_fact_in_main_reaches_the_tie_packet_and_settles_a_ruling(tmp_path):
    """round4 F2: the owner gave the deciding fact in the group's main before the meeting.
    The case packet shows it as an owner message, so a 1:1:1 tie can end in rule."""
    leads, g = _setup(tmp_path)
    a, b, c = leads
    fact = send.post(tmp_path, fold.OWNER, text="The payments freeze starts Dec 18.", channel_id=g, now=T0)
    assert fact["status"] == "accepted"
    fact_seq = max(x["seq"] for x in _rows(tmp_path, g) if x["type"] == "message/posted")
    mid = _convene(tmp_path, leads, g, agenda=[{"title": "Release day", "mode": "vote_first",
                                                "options": ["Dec 14", "Dec 17", "Dec 21"]}], now=T0 + 1)
    _accept_all(tmp_path, mid, leads, now=T0 + 1)
    for who, ch in ((a, "Dec 14"), (b, "Dec 17"), (c, "Dec 21")):
        meeting.vote(tmp_path, who, mid, "I1-B1", ch, f"I want {ch}", now=T0 + 2)
    cases = bar_raiser.detect(tmp_path, g, T0 + 3)
    ctx = _Ctx()
    case_id = asyncio.run(bar_raiser.summon(ctx, tmp_path, cases[0]))
    nonce = ctx.spawn.tasks[0].split("nonce=")[1].split()[0]
    packet = bar_raiser.case_packet(tmp_path, case_id, nonce)
    main = [x for x in packet["messages_from_other_agents_data"] if x.get("where") == "main"]
    assert [(x["seq"], x["source"], x["text"]) for x in main] == [
        (fact_seq, "owner", "The payments freeze starts Dec 18.")]
    votes = [x["seq"] for x in _rows(tmp_path, g) if x["type"] == "ballot/cast"]
    sides = [{"by": w, "claim": f"wants {d}", "evidence_seqs": [s]}
             for w, d, s in zip(("Ada", "Uma", "Ira"), ("Dec 14", "Dec 17", "Dec 21"), votes)]
    ok = _br_act(tmp_path, case_id, nonce, "rule",
                 {"choice": "Dec 17", "positions": sides, "decides": "the freeze starts Dec 18"},
                 "Dec 21 is inside the freeze; Dec 17 is the last day before it.", votes + [fact_seq])
    assert ok["status"] == "accepted", ok


def test_majority_vote_records_a_vote_outcome(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g, agenda=[{"title": "pick", "mode": "vote_first", "options": ["A", "B"]}])
    _accept_all(tmp_path, mid, leads)
    for who, ch in ((a, "A"), (b, "A"), (c, "B")):
        meeting.vote(tmp_path, who, mid, "I1-B1", ch, f"because {ch}", now=T0 + 1)
    out = _m(tmp_path, mid)["items"]["I1"]["outcome"]
    assert out["kind"] == "vote" and out["text"] == "A" and out["tally"] == {"A": 2, "B": 1}


def test_three_stalls_summon_the_bar_raiser_and_continue_resets(tmp_path):
    leads, g = _setup(tmp_path, 2)
    a, b = leads
    r = meeting.convene(tmp_path, a, g, "m", [{"title": "t"}], [b], now=T0)
    mid = r["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    t = T0
    for rnd in (1, 2, 3):
        for who in (a, b):
            t += 1
            meeting.speak(tmp_path, who, mid, _turn(tmp_path, mid, who), "info", f"same point r{rnd} {who}", now=t)
        t += 1
        meeting.progress(tmp_path, a, mid, False, False, True, "continue", now=t)
    m = _m(tmp_path, mid)
    it = m["items"]["I1"]
    assert it["stalls"] == 3 and it["br_needed"][0]["trigger"] == "stalled"
    cases = bar_raiser.detect(tmp_path, g, t)
    ctx = _Ctx()
    case_id = asyncio.run(bar_raiser.summon(ctx, tmp_path, cases[0]))
    nonce = ctx.spawn.tasks[0].split("nonce=")[1].split()[0]
    _br_act(tmp_path, case_id, nonce, "continue", {}, "one more round with evidence", [])
    bar_raiser.apply_due(tmp_path, t + 1)
    meeting.step(tmp_path, g, mid, t + 1)
    it = _m(tmp_path, mid)["items"]["I1"]
    assert it["stalls"] == 0 and it["round"] == 4 and it["extra_rounds"] == 1


def test_bar_raiser_default_defers_a_meeting_item(tmp_path):
    leads, g = _setup(tmp_path, 2)
    a, b = leads
    mid = meeting.convene(tmp_path, a, g, "m", [{"title": "t", "mode": "vote_first", "options": ["x", "y"]}],
                          [b], now=T0)["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    meeting.vote(tmp_path, a, mid, "I1-B1", "x", "x", now=T0)
    meeting.vote(tmp_path, b, mid, "I1-B1", "y", "y", now=T0)
    case = bar_raiser.detect(tmp_path, g, T0)[0]
    asyncio.run(bar_raiser.summon(object(), tmp_path, case))  # no spawn: defaulted at once
    bar_raiser.apply_due(tmp_path, T0 + 1)
    meeting.step(tmp_path, g, mid, T0 + 1)
    out = _m(tmp_path, mid)["items"]["I1"]["outcome"]
    assert out["kind"] == "deferred" and out["by"] == "bar_raiser" and out["default"] is True


# --------------------------------------------------------------------------- budgets


def test_budgets_are_lower_only_and_a_spent_turn_budget_adjourns_with_deferred_items(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    agenda = [{"title": "first"}, {"title": "second"}]
    assert meeting.convene(tmp_path, a, g, "m", agenda, [b, c], budgets={"turns": 50}, now=T0)["reason"] == "budget_raise"
    assert meeting.convene(tmp_path, a, g, "m", [{"title": str(i)} for i in range(7)], [b], now=T0)["reason"] == "bad_agenda"
    mid = _convene(tmp_path, leads, g, agenda=agenda, budgets={"turns": 3}, chair="none")
    _accept_all(tmp_path, mid, leads)
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "P", now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "pass", now=T0 + 2)
    meeting.speak(tmp_path, c, mid, _turn(tmp_path, mid, c), "pass", now=T0 + 3)
    m = _m(tmp_path, mid)
    assert m["turns_used"] == 3 and m["adjourn_reason"] == "turn_budget" and m["state"] == "closed"
    assert [m["items"][i]["outcome"]["kind"] for i in ("I1", "I2")] == ["deferred", "deferred"]
    assert m["items"]["I2"]["outcome"]["text"].startswith("Not reached")
    assert m["minutes"]["budget"]["turns"] == [3, 3]


def test_time_budget_adjourns_and_early_warning_summons_once(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g, budgets={"minutes": 10}, chair="none")
    _accept_all(tmp_path, mid, leads)
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "P", now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "pass", now=T0 + 2)
    meeting.speak(tmp_path, c, mid, _turn(tmp_path, mid, c), "pass", now=T0 + 3)
    meeting.step(tmp_path, g, mid, T0 + 8 * 60 + 1)  # past 80 % of 10 minutes
    needs = [r["data"]["trigger"] for r in _rows(tmp_path, g) if r["type"] == "meeting/bar_raiser_needed"]
    assert needs == ["budget_warning"]
    meeting.step(tmp_path, g, mid, T0 + 8 * 60 + 30)
    assert [r["data"]["trigger"] for r in _rows(tmp_path, g) if r["type"] == "meeting/bar_raiser_needed"] == needs
    meeting.step(tmp_path, g, mid, T0 + 10 * 60)
    m = _m(tmp_path, mid)
    assert m["adjourn_reason"] == "time_budget" and m["state"] == "closed"


# --------------------------------------------------------------------------- minutes


def test_minutes_are_built_from_entries_posted_to_main_and_pointed_at(tmp_path):
    leads, g, mid = _run_consensus_meeting(tmp_path)
    a, b, c = leads
    m = _m(tmp_path, mid)
    mn = m["minutes"]
    assert mn["source"].startswith("Built by the server")
    assert mn["items"][0]["outcome"]["kind"] == "consensus"
    assert mn["items"][0]["stances"] == {"agree": [a, b, c], "object": [], "abstain": []}
    assert mn["attendees"]["accepted"] == [a, b, c]
    # rebuilding from the same entries gives the same minutes
    sealed = next(r for r in _rows(tmp_path, g) if r["type"] == "minutes/sealed")
    before = [r for r in _rows(tmp_path, g) if r["seq"] < sealed["seq"]]
    again = meeting.build_minutes(meeting.fold_meeting(before, mid), sealed["ts"])
    assert again == sealed["data"]["minutes"]
    post = next(r for r in _rows(tmp_path, g) if r["type"] == "message/posted" and r["data"].get("kind") == "minutes")
    assert post["data"]["thread_id"] is None and post["by"] == "app"
    assert "Minutes: Share API v2" in post["data"]["text"] and "Consensus: Use ISO 8601" in post["data"]["text"]
    assert "Agree: lead0, lead1, lead2" in post["data"]["text"]
    # model-written fields (bar raiser rationale, dissent) are shown with handles, not L- ids
    mn2 = {**mn, "items": [{**mn["items"][0], "outcome": {**mn["items"][0]["outcome"],
                                                          "rationale": f"{a} and lead:{b} agreed"}}]}
    text = meeting.render_minutes(mn2)
    assert "Bar raiser rationale: lead0 and lead1 agreed" in text and a not in text and b not in text
    # every attendee: one inbox pointer, the minutes in its next unread; nothing else is written for them
    for who in leads:
        rows = ledger.read(tmp_path, fold.member_file(who))
        ptr = [r for r in rows if r["type"] == "inbox/meeting"]
        assert len(ptr) == 1 and ptr[0]["data"]["minutes_seq"] == sealed["seq"]
        assert any(i["data"].get("kind") == "minutes" for i in fold.unread(tmp_path, who))


def test_minutes_record_dissent_and_unowned_actions(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g, chair="none")
    _accept_all(tmp_path, mid, leads)
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "Ship Tuesday.", now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "object", "Docs are not ready.", proposal_id="I1-P1",
                  now=T0 + 2)
    meeting.speak(tmp_path, c, mid, _turn(tmp_path, mid, c), "pass", now=T0 + 3)
    meeting.action_propose(tmp_path, a, mid, b, "Write the sample response", due="Thu", now=T0 + 4)
    meeting.adjourn(tmp_path, a, mid, "out of time", now=T0 + 5)
    assert _m(tmp_path, mid)["state"] == "adjourning"  # waits for the action answer window
    meeting.step(tmp_path, g, mid, T0 + 5 + meeting.ACTION_WINDOW_SECS)
    mn = _m(tmp_path, mid)["minutes"]
    assert mn["items"][0]["dissent"] == [{"who": b, "text": "Docs are not ready."}]
    assert mn["actions"][0]["state"] == "unowned"
    assert mn["adjourn_reason"] == "out of time"
    assert mn["items"][0]["rejected"] == []  # a deferred item turns nothing down


def _consensus_on_p2(root):
    """a proposes P1, b proposes P2, c objects to P1; round 2 a and b agree on P2 -> consensus on P2."""
    leads, g = _setup(root)
    a, b, c = leads
    mid = _convene(root, leads, g)
    _accept_all(root, mid, leads)
    meeting.speak(root, a, mid, _turn(root, mid, a), "propose", "Do not dual-write. Cut over in one step.", now=T0 + 1)
    meeting.speak(root, b, mid, _turn(root, mid, b), "propose", "Dual-write for 2 weeks.", now=T0 + 2)
    meeting.speak(root, c, mid, _turn(root, mid, c), "object", "I object to I1-P1: no rollback.",
                  proposal_id="I1-P1", now=T0 + 3)
    meeting.progress(root, a, mid, False, True, False, "continue", now=T0 + 4)
    for who, stance in ((a, "agree"), (b, "agree"), (c, "pass")):
        meeting.speak(root, who, mid, _turn(root, mid, who), stance, "ok",
                      proposal_id="I1-P2" if stance == "agree" else None, now=T0 + 5)
    meeting.progress(root, a, mid, True, True, False, "close", now=T0 + 6)
    return leads, g, mid


def test_minutes_list_turned_down_proposals_verbatim(tmp_path):
    """MERGED-SMOKE F-MS1: the losing proposal's own words and its objection are in the minutes."""
    leads, g, mid = _consensus_on_p2(tmp_path)
    a, b, c = leads
    mn = _m(tmp_path, mid)["minutes"]
    rej = mn["items"][0]["rejected"]
    assert [(r["label"], r["by"], r["text"], r["lost_to"]) for r in rej] == [
        ("Proposal 1", a, "Do not dual-write. Cut over in one step.", "Dual-write for 2 weeks.")]
    assert [o["who"] for o in rej[0]["objections"]] == [c]
    text = next(r["data"]["text"] for r in _rows(tmp_path, g) if r["data"].get("kind") == "minutes")
    assert "Turned down:" in text and '"Do not dual-write. Cut over in one step."' in text


def test_minutes_name_proposals_not_their_ids(tmp_path):
    """MERGED-SMOKE F-MS2: a lead writing "I1-P1" reads as "Proposal 1" in the minutes."""
    leads, g, mid = _consensus_on_p2(tmp_path)
    rej = _m(tmp_path, mid)["minutes"]["items"][0]["rejected"]
    assert rej[0]["objections"][0]["text"] == "I object to Proposal 1: no rollback."
    text = next(r["data"]["text"] for r in _rows(tmp_path, g) if r["data"].get("kind") == "minutes")
    assert "I1-P" not in text and "Proposal 1" in text
    assert meeting.readable_ids("I2-P3 or I1-P1", "I1") == "Proposal 3 of item 2 or Proposal 1"


def test_minutes_name_cited_seqs_and_ballots_instead_of_ids(tmp_path):
    """round4 F4: the bar raiser wrote 'Ballot I2-B1 ... (record seq 130) ... (seqs 116, 119, 120)';
    minutes and the page say what those are. The ledger keeps the raw text."""
    refs = {116: "Ada's speech", 119: "Uma's speech", 120: "Ira's speech", 130: "the vote result"}
    raw = ("Ballot I2-B1 is a 1-1-1 tie (record seq 130). Every claim (seqs 116, 119, 120) is a party "
           "claim; only cited by Ada, seq 116; seq 999 and ballot I1-B2.")
    assert meeting.readable_ids(raw, "I2", refs) == (
        "Vote 1 is a 1-1-1 tie (the vote result). Every claim (Ada's speech, Uma's speech and Ira's "
        "speech) is a party claim; only cited by Ada, Ada's speech; an earlier entry and vote 2 of item 1.")
    assert meeting.readable_ids("seq 130", "I2") == "seq 130"  # case cards (no refs) keep linked seqs
    # pod run S49: the bar raiser wrote "Owner message seq 2 sets the freeze"
    assert meeting.readable_ids("Owner message seq 2 sets it", "I1", {2: "the owner's message"}) == \
        "the owner's message sets it"
    sys_text = fold.system_text({"type": "ballot/opened", "data": {"item_id": "I1", "ballot_id": "I1-B1",
                                                                   "options": ["X", "Y"]}}, {})
    assert sys_text == "Vote now on item 1: X, Y; answer with team_meeting_vote."

    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g, agenda=[{"title": "Day", "mode": "vote_first", "options": ["X", "Y", "Z"]}])
    _accept_all(tmp_path, mid, leads)
    for who, ch in ((a, "X"), (b, "Y"), (c, "Z")):
        meeting.vote(tmp_path, who, mid, "I1-B1", ch, f"for {ch}", now=T0 + 1)
    closed = next(x["seq"] for x in _rows(tmp_path, g) if x["type"] == "ballot/closed")
    cases = bar_raiser.detect(tmp_path, g, T0 + 2)
    ctx = _Ctx()
    case_id = asyncio.run(bar_raiser.summon(ctx, tmp_path, cases[0]))
    nonce = ctx.spawn.tasks[0].split("nonce=")[1].split()[0]
    why = f"Ballot I1-B1 is a tie (record seq {closed}); hold."
    assert _br_act(tmp_path, case_id, nonce, "hold", {"missing": f"an owner fact (seq {closed})"}, why,
                   [closed])["status"] == "accepted"
    bar_raiser.apply_due(tmp_path, T0 + 3)
    meeting.step(tmp_path, g, mid, T0 + 3)
    meeting.adjourn(tmp_path, a, mid, now=T0 + 4)
    meeting.step(tmp_path, g, mid, T0 + 4 + meeting.ACTION_WINDOW_SECS + 1)
    text = next(x["data"]["text"] for x in _rows(tmp_path, g) if x["data"].get("kind") == "minutes")
    assert "seq" not in text and "I1-B1" not in text, text
    assert "Vote 1 is a tie (the vote result); hold." in text and "an owner fact (the vote result)" in text
    summ = meeting.summary(_m(tmp_path, mid))
    assert summ["refs"][str(closed)] == "the vote result"
    acted = next(x for x in _rows(tmp_path, g) if x["type"] == "meeting/bar_raiser_acted")
    assert acted["data"]["rationale"] == why  # the ledger keeps what the bar raiser wrote


# --------------------------------------------------------------------------- accept gate


def test_action_item_reaches_todos_only_through_its_owners_accept(tmp_path, monkeypatch):
    leads, g = _setup(tmp_path, 4)
    a, b, c, d = leads
    mid = _convene(tmp_path, [a, b, c], g)
    _accept_all(tmp_path, mid, [a, b, c])

    def todos(who):
        return [r for r in ledger.read(tmp_path, fold.member_file(who)) if r["type"] == "todo/requested"]

    assert meeting.action_propose(tmp_path, a, mid, d, "x", now=T0)["reason"] == "owner_not_attending"
    r = meeting.action_propose(tmp_path, a, mid, b, "Add revoked flag", detail="boolean", now=T0)
    aid = r["action_id"]
    assert r["state"] == "proposed" and todos(b) == []
    assert meeting.action_respond(tmp_path, c, mid, aid, "accept", now=T0)["reason"] == "not_your_action"
    assert meeting.action_respond(tmp_path, a, mid, aid, "accept", now=T0)["reason"] == "not_your_action"
    assert todos(b) == []
    assert meeting.action_respond(tmp_path, b, mid, aid, "decline", "no", now=T0)["reason"] == "decline_needs_reason"
    assert meeting.action_respond(tmp_path, b, mid, aid, "accept", now=T0)["status"] == "accepted"
    t = todos(b)
    assert len(t) == 1 and t[0]["data"]["source"] == f"meeting:{mid}#{aid}" and t[0]["by"] == "app"
    assert meeting.action_respond(tmp_path, b, mid, aid, "accept", now=T0)["reason"] == "action_closed"
    # a decline with a reason writes no to-do
    aid2 = meeting.action_propose(tmp_path, a, mid, c, "Update docs", now=T0)["action_id"]
    assert meeting.action_respond(tmp_path, c, mid, aid2, "decline", "not my project", now=T0)["status"] == "accepted"
    assert todos(c) == []
    # proposing for yourself is your own accept
    meeting.action_propose(tmp_path, a, mid, a, "Write minutes summary", now=T0)
    assert len(todos(a)) == 1
    # the action is announced to its owner only
    assert any(i["type"] == "action/proposed" for i in fold.unread(tmp_path, c))
    assert not any(i["type"] == "action/proposed" and i["data"]["to"] == c for i in fold.unread(tmp_path, b))
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-1")
    assert [x["title"] for x in server.call("team_todo_list", {}, tmp_path)["todos"]] == ["Add revoked flag"]


# --------------------------------------------------------------------------- wakes and tools


def test_invite_turn_and_chair_check_wake_only_their_lead(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g)

    def reasons(who, now):
        ch = {cid: fold.fold_channel(tmp_path, cid) for cid in fold.list_channels(tmp_path)}
        d = wake.next_wake(who, fold.fold_member(tmp_path, who), fold.unread(tmp_path, who), ch, now)
        return d["reasons"] if d else []

    assert f"meeting_invite:{mid}" in reasons(b, T0)
    assert not any(r.startswith("meeting_invite") for r in reasons(a, T0))
    _accept_all(tmp_path, mid, leads)
    tid = _turn(tmp_path, mid, a)
    assert f"meeting_turn:{tid}" in reasons(a, T0)
    assert not any(r.startswith("meeting_turn") for r in reasons(c, T0))
    inbox = wake.inbox_read(tmp_path, a)
    assert any(i["type"] == "turn/granted" and i["turn_id"] == tid and "Your turn" in i["note"] for i in inbox["items"])


def _reasons(root, who, now):
    ch = {cid: fold.fold_channel(root, cid) for cid in fold.list_channels(root)}
    d = wake.next_wake(who, fold.fold_member(root, who), fold.unread(root, who), ch, now)
    return d["reasons"] if d else []


def test_b2_a_chair_opened_ballot_wakes_every_speaker_at_once(tmp_path):
    """B2 (e2e S23): recommend=vote opened I1-B1 but nobody was woken to vote."""
    leads, g = _setup(tmp_path, 4)
    a, b, c, d = leads  # d is in the group but not in the meeting
    mid = meeting.convene(tmp_path, a, g, "m", [{"title": "t"}], [b, c], now=T0)["meeting_id"]
    _accept_all(tmp_path, mid, [a, b, c])
    meeting.speak(tmp_path, a, mid, _turn(tmp_path, mid, a), "propose", "P", now=T0 + 1)
    meeting.speak(tmp_path, b, mid, _turn(tmp_path, mid, b), "object", "no", proposal_id="I1-P1", now=T0 + 2)
    meeting.speak(tmp_path, c, mid, _turn(tmp_path, mid, c), "info", "hm", now=T0 + 3)
    for who in (a, b, c):
        wake.inbox_read(tmp_path, who)  # clear the turn wakes
    meeting.progress(tmp_path, a, mid, False, True, False, "vote", vote_options=["A", "B"], now=T0 + 4)
    assert _m(tmp_path, mid)["items"]["I1"]["ballot_open"] == "I1-B1"
    for who in (a, b, c):
        assert f"meeting_vote:{mid}:I1-B1" in _reasons(tmp_path, who, T0 + 5), who
        item = next(i for i in wake.inbox_read(tmp_path, who)["items"] if i["type"] == "ballot/opened")
        assert item["ballot_id"] == "I1-B1" and item["options"] == ["A", "B"] and "team_meeting_vote" in item["note"]
    assert not any(r.startswith("meeting_vote") for r in _reasons(tmp_path, d, T0 + 5))
    assert not any(i["type"] == "ballot/opened" for i in fold.unread(tmp_path, d))


def test_b2_a_vote_first_item_wakes_every_speaker_when_it_opens(tmp_path):
    """B2 (e2e S24): the vote_first ballot opens with the item; every speaker is woken to vote."""
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = _convene(tmp_path, leads, g, agenda=[{"title": "pick", "mode": "vote_first", "options": ["A", "B"]}])
    _accept_all(tmp_path, mid, leads)
    for who in (a, b, c):
        assert f"meeting_vote:{mid}:I1-B1" in _reasons(tmp_path, who, T0), who
    # once read it does not wake again
    wake.inbox_read(tmp_path, b)
    assert not any(r.startswith("meeting_vote") for r in _reasons(tmp_path, b, T0 + 1))


def test_meeting_speeches_do_not_fire_the_room_round_budget(tmp_path):
    leads, g = _setup(tmp_path, 2)
    a, b = leads
    mid = meeting.convene(tmp_path, a, g, "m", [{"title": "t"}], [b], chair="none",
                          budgets={"rounds": 3}, now=T0)["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    t = T0
    for _ in range(3):
        for who in (a, b):
            t += 1
            meeting.speak(tmp_path, who, mid, _turn(tmp_path, mid, who), "info", f"word {t}", now=t)
    trig = [x["trigger"] for c in bar_raiser.detect(tmp_path, g, t) for x in c["triggers"]]
    assert "round_budget" not in trig


def test_mcp_round_trip(tmp_path, monkeypatch):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    r = server.call("team_meeting_convene", {"channel_id": g, "title": "Sync", "invitees": [b, c],
                                             "agenda": [{"title": "Format", "question": "ISO?"}],
                                             "budgets": {"turns": 20}}, tmp_path)
    assert r["status"] == "accepted"
    mid = r["meeting_id"]
    for i, who in ((1, b), (2, c)):
        monkeypatch.setenv("KIROCREW_SESSION_LABEL", f"chat-{i}")
        assert server.call("team_meeting_respond", {"meeting_id": mid, "answer": "accept"}, tmp_path)["answer"] == "accept"
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    packet = server.call("team_meeting_read", {"meeting_id": mid}, tmp_path)
    turn = packet["my_open_turn"]["turn_id"]
    assert server.call("team_meeting_speak", {"meeting_id": mid, "turn_id": turn, "stance": "propose",
                                              "text": "ISO", "evidence": ["PR #1"]}, tmp_path)["proposal_id"] == "I1-P1"
    try:
        server.call("team_meeting_convene", {"channel_id": g, "title": "x", "agenda": ["not an object"],
                                             "invitees": [b]}, tmp_path)
        raise AssertionError("expected refusal")
    except server.ToolError as exc:
        assert "agenda" in str(exc)
    st = server.call("team_meeting_status", {"meeting_id": mid}, tmp_path)
    assert st["state"] == "open" and st["budgets"]["turns"] == 20
    assert [x["meeting_id"] for x in server.call("team_meeting_list", {}, tmp_path)["meetings"]] == [mid]


def test_bot_facing_text_names_things_and_forbids_ids(tmp_path, monkeypatch):
    """round4 F1: a Bot sees only this server's text (never agents/lead.json), so the no-ids
    rule is in every tool description and in initialize, and results carry readable names."""
    init = server._handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})["result"]
    assert "Never write them" in init["instructions"]
    tools = server._handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
    assert all("never ids" in t["description"] for t in tools)
    assert "Never write them" in next(t for t in tools if t["name"] == "team_whoami")["description"]

    leads, g = _setup(tmp_path)
    a, b, c = leads
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    r = server.call("team_meeting_convene", {"channel_id": g, "title": "Gift card refunds", "invitees": [b, c],
                                             "agenda": [{"title": "Refund line", "question": "What?"}]}, tmp_path)
    assert r["say"] == "the meeting 'Gift card refunds'"
    mid = r["meeting_id"]
    for i in (1, 2):
        monkeypatch.setenv("KIROCREW_SESSION_LABEL", f"chat-{i}")
        assert server.call("team_meeting_respond", {"meeting_id": mid, "answer": "accept"},
                           tmp_path)["say"] == "the meeting 'Gift card refunds'"
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-0")
    turn = server.call("team_meeting_read", {"meeting_id": mid}, tmp_path)["my_open_turn"]["turn_id"]
    sp = server.call("team_meeting_speak", {"meeting_id": mid, "turn_id": turn, "stance": "propose",
                                            "text": "One line."}, tmp_path)
    assert sp["say"] == "proposal 1 by lead0"
    ap = server.call("team_meeting_action_propose", {"meeting_id": mid, "owner": b, "title": "Ship the line"},
                     tmp_path)
    assert ap["say"] == "the action item 'Ship the line' for lead1"
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "chat-1")
    pk = server.call("team_meeting_read", {"meeting_id": mid}, tmp_path)
    assert pk["actions_for_me"][0]["say"] == "the action item 'Ship the line' from lead0"
    assert [p["say"] for p in pk["proposals"]] in ([], ["proposal 1 by lead0"])  # sealed round may hide it
    ar = server.call("team_meeting_action_respond", {"meeting_id": mid, "action_id": ap["action_id"],
                                                     "answer": "accept"}, tmp_path)
    assert ar["say"] == "the action item 'Ship the line' from lead0"
    assert "AI-" not in ar["say"] and "MT-" not in r["say"]


# --------------------------------------------------------------------------- decisions (W-MTG)


def _ask_person_wait(root):
    """a proposes, b agrees, c objects with ask_person=true -> after the chair check the item waits."""
    leads, g = _setup(root)
    a, b, c = leads
    mid = _convene(root, leads, g)
    _accept_all(root, mid, leads)
    meeting.speak(root, a, mid, _turn(root, mid, a), "propose", "Use ISO 8601.", now=T0 + 1)
    meeting.speak(root, b, mid, _turn(root, mid, b), "agree", "Yes.", proposal_id="I1-P1", now=T0 + 2)
    meeting.speak(root, c, mid, _turn(root, mid, c), "object", "Owner must confirm.", proposal_id="I1-P1",
                  ask_person=True, now=T0 + 3)
    meeting.progress(root, a, mid, False, True, False, "continue", now=T0 + 4)
    return leads, g, mid


def _decisions(root):
    return ledger.read(root, meeting.DECISIONS)


def test_an_ask_person_wait_opens_a_decision_and_the_owner_word_answers_it(tmp_path):
    leads, g, mid = _ask_person_wait(tmp_path)
    m = _m(tmp_path, mid)
    w = m["items"]["I1"]["waiting"]
    key = f"meeting_item:{mid}:I1:1"
    assert w["key"] == key
    opened = [r for r in _decisions(tmp_path) if r["type"] == "decision/opened"]
    assert [r["data"]["key"] for r in opened] == [key]
    assert opened[0]["data"]["kind"] == "meeting_item" and opened[0]["data"]["meeting_id"] == mid
    src = meeting.decision_sources(tmp_path)
    assert [(s["key"], s["open"]) for s in src] == [(key, True)]
    # the owner answers in the meeting box: the wait ends and its decision is answered with that text
    assert send.post(tmp_path, fold.OWNER, text="Confirmed, they may change.", channel_id=g,
                     thread=m["thread_id"], now=T0 + 5)["status"] == "accepted"
    meeting.step(tmp_path, g, mid, T0 + 6)
    ans = [r for r in _decisions(tmp_path) if r["type"] == "decision/answered"]
    assert [(r["data"]["key"], r["data"]["text"]) for r in ans] == [(key, "Confirmed, they may change.")]
    assert _m(tmp_path, mid)["items"]["I1"]["waiting"] is None
    assert [s["open"] for s in meeting.decision_sources(tmp_path)] == [False]
    assert meeting.replay_check(_rows(tmp_path, g), mid) == []


def test_a_wait_nobody_answers_is_withdrawn_when_time_runs_out(tmp_path):
    # PERSON_SECS (4 h) is longer than the 90-minute meeting cap, so the time budget
    # adjourns first and the wait is withdrawn with reason "adjourned".
    leads, g, mid = _ask_person_wait(tmp_path)
    meeting.step(tmp_path, g, mid, T0 + 4 + meeting.PERSON_SECS + 1)
    rows = _decisions(tmp_path)
    assert [r["type"] for r in rows] == ["decision/opened", "decision/withdrawn"]
    assert rows[1]["data"]["reason"] in ("deadline", "adjourned")
    assert _m(tmp_path, mid)["items"]["I1"]["outcome"]["kind"] == "deferred"


def test_adjourning_withdraws_an_open_wait(tmp_path):
    leads, g, mid = _ask_person_wait(tmp_path)
    assert meeting.adjourn(tmp_path, fold.OWNER, mid, now=T0 + 10)["status"] == "accepted"
    rows = _decisions(tmp_path)
    assert [(r["type"], r["data"].get("reason")) for r in rows][-1] == ("decision/withdrawn", "adjourned")
