"""Approval and verdict rules (summary items 1, 2, 4, 5, 13): pure functions first,
then the same rules through the bar raiser and the owner's answer.

Each test names the one-line change that turns it red, so the guarantee can be
checked by removing it.
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import approval, fold, ledger, send, state  # noqa: E402
from teamapp import bar_raiser as br  # noqa: E402

A, B = "L-0000000a", "L-0000000b"
G = "G-00000001"
F = fold.channel_file(G)
T0 = 1_800_000_000.0
_n = iter(range(10_000))
CARD = {"class": "spend", "question": "Run the load test?", "what": "Run the $40 load test",
        "cost": "$40", "reversible": "no", "if_no": "close_thread"}


# --- pure rules -----------------------------------------------------------------------

def test_binding_voids_on_change_attempt_expiry_and_reuse():
    # red if void_reason drops any of its checks
    b = approval.bind(7, {"x": 1}, 1, expires=100.0)
    h = approval.content_hash({"x": 1})
    assert approval.void_reason(b, seq=7, content_sha=h, attempt=1, now=50) is None
    assert approval.void_reason(b, seq=7, content_sha=approval.content_hash({"x": 2}), attempt=1, now=50) == "changed"
    assert approval.void_reason(b, seq=7, content_sha=h, attempt=2, now=50) == "new_attempt"
    assert approval.void_reason(b, seq=7, content_sha=h, attempt=1, now=100) == "expired"
    assert approval.void_reason(b, seq=7, content_sha=h, attempt=1, now=50, used=True) == "already_used"
    assert approval.void_reason(b, seq=8, content_sha=h, attempt=1, now=50) == "other_item"
    # canonical: key order does not change the hash
    assert approval.content_hash({"a": 1, "b": 2}) == approval.content_hash({"b": 2, "a": 1})


def test_standing_only_for_stop_or_hold_actions():
    # red if REDUCE_ONLY gains "continue" (releases held messages) or the hour cap goes
    assert approval.standing_error(["close_thread"], 24) is None
    assert "only covers" in approval.standing_error(["continue"], 1)
    assert "only covers" in approval.standing_error(["call_person"], 1)
    assert approval.standing_error(["hold"], 25) is not None
    assert approval.standing_error(["hold"], 0) is not None
    live = [{"seq": 3, "channel_id": G, "class": "spend", "actions": ["close_thread"], "expires": 200}]
    assert approval.standing_covers(live, channel_id=G, cls="spend", action="close_thread", now=100)
    assert approval.standing_covers(live, channel_id=G, cls="security", action="close_thread", now=100) is None
    assert approval.standing_covers(live, channel_id=G, cls="spend", action="close_thread", now=200) is None
    assert approval.standing_covers(live, channel_id="G-x", cls="spend", action="close_thread", now=100) is None


def test_party_claims_alone_are_not_evidence_for_a_verdict():
    rows = [{"seq": 1, "type": "message/posted", "by": "lead:L-1"},
            {"seq": 2, "type": "message/posted", "by": "owner"},
            {"seq": 3, "type": "message/held", "by": "app"},
            {"seq": 4, "type": "ballot/cast", "by": "lead:L-2"}]
    src = approval.classify_rows(rows, lambda r: "main")
    assert src == {1: "party_claim", 2: "owner", 3: "record", 4: "party_claim"}
    # red if evidence_error accepts party claims for veto / rule
    assert "party claims" in approval.evidence_error("veto", [1, 4], src)
    assert "party claims" in approval.evidence_error("rule", [1], src)
    assert approval.evidence_error("rule", [1, 3], src) is None
    assert approval.evidence_error("veto", [2], src) is None
    # close_thread only stops a chain: the loop itself is enough, but it still needs a seq
    assert approval.evidence_error("close_thread", [1], src) is None
    assert approval.evidence_error("close_thread", [], src) == "evidence_seqs required"


def test_veto_hold_and_ruling_templates():
    assert approval.veto_error({"rule": "hop limit", "number": "hop 5 > 4", "change": "split the thread"}) is None
    assert "number" in approval.veto_error({"rule": "hop limit", "number": "", "change": "x"})
    assert approval.hold_error({"missing": "CI result for PR 7"}) is None
    assert approval.hold_error({"missing": " "}) is not None
    sides = [{"by": "api", "claim": "ready", "evidence_seqs": [1]}, {"by": "web", "claim": "fix", "evidence_seqs": []}]
    ok = {"choice": "api", "positions": sides, "decides": "lower risk"}
    assert approval.ruling_error(ok, ["api", "web"], {1}) is None
    # no middle value
    assert "middle value" in approval.ruling_error({**ok, "choice": "api and web"}, ["api", "web"], {1})
    assert "at least 2" in approval.ruling_error({**ok, "positions": sides[:1]}, ["api", "web"], {1})
    assert "decides" in approval.ruling_error({**ok, "decides": ""}, ["api", "web"], {1})
    assert "not in this room" in approval.ruling_error(
        {**ok, "positions": [{**sides[0], "evidence_seqs": [99]}, sides[1]]}, ["api", "web"], {1})


def test_card_has_fixed_fields_and_if_no_must_stop_or_hold():
    card = approval.person_card(CARD, who="#room › main · a, b", attempt=2, tried=["continue"], expires=9.0)
    assert tuple(card) == approval.CARD_FIELDS
    assert approval.card_args_error(CARD, br.IF_NO_ROOM) is None
    assert "if_no" in approval.card_args_error({**CARD, "if_no": "continue"}, br.IF_NO_ROOM)
    assert "reversible" in approval.card_args_error({**CARD, "reversible": "maybe"}, br.IF_NO_ROOM)


# --- through the bar raiser ---------------------------------------------------------------

class _Spawn:
    def __init__(self):
        self.calls = []

    async def run(self, task, agent, *, silent=False, model=""):
        self.calls.append(re.search(r"nonce=(\S+)", task).group(1))
        return "run"


class _Ctx:
    def __init__(self):
        self.spawn = _Spawn()


def _post(root, by, text="hi", *, kind="message", mentions=()):
    return ledger.append(root, F, "message/posted", by, {
        "msg_id": f"m{next(_n):08x}", "thread_id": None, "text": text, "kind": kind,
        "mentions": list(mentions), "cc": [], "everyone": False, "also_main": False,
        "reply_to": None, "answers": None, "chain": {"root_seq": 0, "hops": 1, "br_resets": 0}})


def _hold(root, text="hop 5 reply"):
    mid = f"m{next(_n):08x}"
    ledger.append(root, F, "message/posted", f"lead:{B}", {
        "msg_id": mid, "thread_id": None, "text": text, "kind": "message", "mentions": [], "cc": [],
        "everyone": False, "also_main": False, "reply_to": None, "answers": None,
        "chain": {"root_seq": 0, "hops": 5, "br_resets": 0}})
    return ledger.append(root, F, "message/held", "app", {"msg_id": mid, "reason": "hop_limit"})


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "ledger"
    ledger.append(r, F, "channel/opened", "owner", {
        "kind": "group", "title": "release", "members": [A, B], "people": ["owner"], "creator": A,
        "managers": [], "bar_raiser": "default"})
    _post(r, "owner", "please plan the launch")
    return r


def _open(root, ctx=None):
    ctx = ctx or _Ctx()
    [case] = br.detect(root, G, T0)
    case_id = asyncio.run(br.summon(ctx, root, case))
    return case_id, ctx.spawn.calls[-1]


def _act(root, case_id, nonce, action, args, why="why", ev=()):
    ph = br.case_packet(root, case_id, nonce)["packet_hash"]
    return br.act(root, case_id, nonce, action, args, why, list(ev), ph)


def test_ruling_is_bound_to_the_packet_it_read(root):
    held = _hold(root)
    case_id, nonce = _open(root)
    ph = br.case_packet(root, case_id, nonce)["packet_hash"]
    _post(root, f"lead:{A}", "one more thing")            # the room moves on after the read
    # red if act stops comparing packet_hash
    res = br.act(root, case_id, nonce, "close_thread", {}, "loop", [held], ph)
    assert res["reason"] == "packet_changed"
    assert br.cases_state(root)[case_id]["invalid"] == 0   # not counted as a wrong answer
    assert _act(root, case_id, nonce, "close_thread", {}, "loop", [held])["status"] == "accepted"
    acted = br.cases_state(root)[case_id]["acted"]
    assert acted["binding"]["seq"] == br.cases_state(root)[case_id]["seq"] and acted["binding"]["attempt"] == 1


def test_packet_marks_party_claims_and_lists_records(root):
    _post(root, f"lead:{A}", "Done, I tested it")
    held = _hold(root)
    case_id, nonce = _open(root)
    p = br.case_packet(root, case_id, nonce)
    src = {m["text"]: m["source"] for m in p["messages_from_other_agents_data"]}
    assert src["Done, I tested it"] == "party_claim" and src["please plan the launch"] == "owner"
    assert [r["seq"] for r in p["records_written_by_the_app"]] == [held]
    claim = next(m["seq"] for m in p["messages_from_other_agents_data"] if m["source"] == "party_claim")
    veto = {"rule": "no unverified done", "number": "0 checks", "change": "attach CI"}
    # a veto on the leads' own words alone is refused; with the record it is accepted
    assert _act(root, case_id, nonce, "veto", veto, "x", [claim])["reason"] == "invalid"
    assert _act(root, case_id, nonce, "veto", veto, "x", [claim, held])["status"] == "accepted"


def test_veto_blocks_and_hold_names_what_is_missing(root):
    held = _hold(root)
    case_id, nonce = _open(root)
    assert _act(root, case_id, nonce, "veto", {"rule": "hop limit", "number": "hop 5 > 4",
                                               "change": "one owner per thread"}, "x", [held])["status"] == "accepted"
    br.apply_due(root, T0)
    rows = ledger.read(root, F)
    assert rows[-2]["type"] == "chain/closed" and rows[-2]["data"]["veto"]["number"] == "hop 5 > 4"
    assert rows[-1]["data"]["text"] == "Bar raiser blocked this: hop limit (hop 5 > 4). To go on: one owner per thread"
    # a hold closes nothing
    _post(root, "owner", "reopen")
    _hold(root)
    case_id, nonce = _open(root)
    assert _act(root, case_id, nonce, "hold", {"missing": "the CI run for PR 7"})["status"] == "accepted"
    br.apply_due(root, T0)
    rows = ledger.read(root, F)
    assert rows[-1]["data"]["text"] == "Bar raiser cannot decide yet. Missing: the CI run for PR 7"
    assert [r["type"] for r in rows].count("chain/closed") == 1


def _called(root):
    _hold(root)
    case_id, nonce = _open(root)
    assert _act(root, case_id, nonce, "call_person", CARD, "spend")["status"] == "accepted"
    br.apply_due(root, T0)
    [c] = [c for c in state.cases(root, T0) if c["case_id"] == case_id]
    return case_id, c["called_person"]


def test_person_card_fields_come_from_the_server(root):
    case_id, cp = _called(root)
    card = cp["card"]
    assert card["what"] == "Run the $40 load test" and card["attempt"] == 1 and card["tried"] == []
    assert card["who"].startswith("#release › main") and card["expires"] == T0 + br.CARD_SECS
    assert cp["void"] is None and cp["card_hash"] == approval.content_hash(card)


def test_approve_once_bound_to_the_card_version(root):
    case_id, cp = _called(root)
    # red if answer_case stops checking card_hash
    assert state.answer_case(root, case_id, "approve", "0" * 64, now=T0)["reason"] == "changed"
    res = state.answer_case(root, case_id, "approve", cp["card_hash"], now=T0)
    assert res["status"] == "accepted"
    assert res["post"]["status"] == "accepted"
    assert ledger.read(root, F)[[r["seq"] for r in ledger.read(root, F)].index(res["post"]["seq"])]["data"][
        "text"] == "Approved: Run the $40 load test."
    # one approval, one use
    assert state.answer_case(root, case_id, "approve", cp["card_hash"], now=T0)["reason"] == "already_used"


def test_expired_card_cannot_be_approved_and_lapses_to_no(root):
    case_id, cp = _called(root)
    late = T0 + br.CARD_SECS + 1
    assert state.answer_case(root, case_id, "approve", cp["card_hash"], now=late)["reason"] == "expired"
    br.apply_due(root, late)                                    # no answer = No: if_no runs once
    types = [r["type"] for r in ledger.read(root, F)]
    assert types.count("chain/closed") == 1
    br.apply_due(root, late + 5)
    assert [r["type"] for r in ledger.read(root, F)].count("chain/closed") == 1


def test_no_runs_the_frozen_if_no_and_a_retry_is_a_new_card(root):
    case_id, cp = _called(root)
    res = state.answer_case(root, case_id, "no", cp["card_hash"], now=T0)
    assert res["status"] == "accepted"
    rows = ledger.read(root, F)
    # the owner's "No" is posted first, then the close, so the chain stays closed
    assert [r["type"] for r in rows][-3:] == ["message/posted", "chain/closed", "message/posted"]
    assert send._closed(rows, "main")


def test_a_retry_on_the_same_chain_is_a_new_card_and_voids_the_old_one(root):
    first, cp1 = _called(root)
    second, cp2 = _called(root)              # same chain (no owner word between): attempt 2
    assert cp2["card"]["attempt"] == 2 and cp2["card"]["tried"] == ["call_person"]
    # red if card_void stops looking for a newer card on the chain
    assert state.answer_case(root, first, "approve", cp1["card_hash"], now=T0)["reason"] == "new_attempt"
    assert state.answer_case(root, second, "approve", cp2["card_hash"], now=T0)["status"] == "accepted"
    # the old card does not run its if_no when it lapses either
    br.apply_due(root, T0 + br.CARD_SECS + 1)
    assert "chain/closed" not in [r["type"] for r in ledger.read(root, F)]


def test_standing_approval_skips_the_card_only_for_its_if_no(root):
    case_id, cp = _called(root)
    bad = state.answer_case(root, case_id, "change", cp["card_hash"], "ok", standing={"hours": 24}, now=T0)
    assert bad["reason"] == "bad_standing"
    ok = state.answer_case(root, case_id, "no", cp["card_hash"], standing={"hours": 24}, now=T0)
    assert ok["status"] == "accepted" and br.standings(root)[0]["actions"] == ["close_thread"]
    # next time in this room and class: the if_no runs without a card
    _post(root, "owner", "new round")
    _hold(root)
    case2, nonce = _open(root)
    assert _act(root, case2, nonce, "call_person", CARD, "spend")["status"] == "accepted"
    br.apply_due(root, T0 + 10)
    [c] = [c for c in state.cases(root, T0 + 10) if c["case_id"] == case2]
    assert c["called_person"]["standing"] and "void" not in c["called_person"]
    # nothing waits on the owner: no open decision for it (Needs you / waitingOnYou)
    from teamapp import decisions
    states = {d["key"]: d["state"] for d in decisions.listing(root)}
    assert states[f"case:{case_id}"] == "answered" and states.get(f"case:{case2}", "withdrawn") != "open"
    assert ledger.read(root, F)[-2]["type"] == "chain/closed"
    # an if_no that would release work is never covered
    assert approval.standing_covers(br.standings(root), channel_id=G, cls="spend", action="continue",
                                    now=T0) is None


def test_take_is_bound_to_the_assignment(tmp_path):
    from teamapp import identity

    a = identity.register(tmp_path, "chat-a", "a-lead")
    b = identity.register(tmp_path, "chat-b", "b-lead")
    g = send.open_group(tmp_path, a, "room", [a, b])["channel_id"]
    m1 = send.post(tmp_path, a, channel_id=g, text="@b do X", mentions=[b], now=T0)
    ch = fold.fold_channel(tmp_path, g)
    [aid] = list(ch["assignments"])
    r = send.post(tmp_path, b, channel_id=g, text="on it", answers=aid, response="take", now=T0 + 1)
    assert r["status"] == "accepted"
    a1 = fold.fold_channel(tmp_path, g)["assignments"][aid]
    assert a1["binding"]["seq"] == m1["seq"] and a1["binding"]["attempt"] == 1
    # a re-ask is a new assignment, attempt 2, and needs its own take
    send.post(tmp_path, a, channel_id=g, text="@b do X, but by Friday", mentions=[b], now=T0 + 30)
    ch = fold.fold_channel(tmp_path, g)
    aid2 = next(k for k in ch["assignments"] if k != aid)
    send.post(tmp_path, b, channel_id=g, text="ok, Friday", answers=aid2, response="take", now=T0 + 31)
    a2 = fold.fold_channel(tmp_path, g)["assignments"][aid2]
    assert a2["binding"]["attempt"] == 2 and a2["binding"]["hash"] != a1["binding"]["hash"]
    # a take answers one assignment once
    again = send.post(tmp_path, b, channel_id=g, text="took", answers=aid, response="take", now=T0 + 40)
    assert again["reason"] == "assignment_taken"  # after a take only a result closes it
