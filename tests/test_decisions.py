"""Needs you: one record kind for every wait on the owner; skip counts as No; impact order."""

from __future__ import annotations

import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import decisions, fold, identity, ledger, limits, send, state  # noqa: E402

T0 = 1_000_000.0


def _src(key, impact, ts, open_=True, **extra):
    return {"key": key, "kind": "case", "impact": impact, "ts": ts, "open": open_, **extra}


def test_fold_orders_open_first_then_impact_then_oldest():
    rows = [{"seq": 1, "ts": 5, "type": "decision/opened", "data": {"key": "case:C-2"}},
            {"seq": 2, "ts": 9, "type": "decision/skipped", "data": {"key": "case:C-3", "text": "No."}}]
    out = decisions.fold_decisions(rows, [
        _src("ask:G-1:A-1", "ask", 1),
        _src("case:C-1", "security", 3),
        _src("case:C-2", "irreversible", 4),   # opened row ts wins over the source ts
        _src("case:C-3", "irreversible", 2),   # skipped: closed, sorts after every open one
        _src("case:C-4", "spend", 8),
        _src("case:C-5", "spend", 7),
    ])
    assert [d["key"] for d in out] == ["case:C-2", "case:C-5", "case:C-4", "case:C-1", "ask:G-1:A-1", "case:C-3"]
    assert out[0]["opened_ts"] == 5
    assert out[-1]["state"] == "skipped" and out[-1]["answer"]["text"] == "No."


def test_fold_withdrawn_and_answered_before_decision_rows():
    out = decisions.fold_decisions([], [_src("ask:G-1:A-1", "ask", 1, open_=False),
                                        _src("case:C-1", "spend", 2, open_=False, answered_text="yes", answered_ts=3)])
    assert {d["key"]: d["state"] for d in out} == {"ask:G-1:A-1": "withdrawn", "case:C-1": "answered"}


def _ask(root):
    a, b = identity.register(root, "chat-1", "api"), identity.register(root, "chat-2", "ui")
    g = send.open_group(root, a, "room", [a, b])["channel_id"]
    send.post(root, "owner", channel_id=g, text="@api ship it", mentions=[a], now=T0)
    aid = next(iter(fold.fold_channel(root, g)["assignments"]))
    r = send.post(root, a, channel_id=g, text="Which region first?", answers=aid, response="ask", now=T0 + 5)
    assert r["status"] == "accepted"
    return a, g, aid


def test_lead_ask_on_owner_at_opens_a_decision_and_answer_replies_to_it(tmp_path):
    a, g, aid = _ask(tmp_path)
    opened = [r for r in ledger.read(tmp_path, decisions.FILE) if r["type"] == "decision/opened"]
    assert [r["data"]["key"] for r in opened] == [decisions.ask_key(g, aid)]
    d = state.build(tmp_path, now=T0 + 6)["decisions"]
    assert [(x["kind"], x["state"], x["question"]) for x in d] == [("ask", "open", "Which region first?")]
    res = decisions.answer(tmp_path, d[0]["key"], "us-west first")
    assert res["status"] == "accepted"
    post = [r for r in ledger.read(tmp_path, fold.channel_file(g)) if r["type"] == "message/posted"][-1]
    assert post["by"] == "owner" and post["data"]["text"] == "us-west first"
    assert post["data"]["reply_to"] == d[0]["ask_seq"]
    assert decisions.listing(tmp_path)[0]["state"] == "answered"
    assert decisions.answer(tmp_path, d[0]["key"], "again")["reason"] == "already_answered"


def test_ask_sent_as_a_dm_lands_where_the_at_is(tmp_path):
    # pod e2e D3: the lead answered a group @ with to=owner; it was refused no_such_assignment
    a, b = identity.register(tmp_path, "chat-1", "api"), identity.register(tmp_path, "chat-2", "ui")
    g = send.open_group(tmp_path, a, "room", [a, b])["channel_id"]
    send.post(tmp_path, "owner", channel_id=g, text="@api plan Friday", mentions=[a], now=T0)
    aid = next(iter(fold.fold_channel(tmp_path, g)["assignments"]))
    r = send.post(tmp_path, a, to="owner", text="Which day does the freeze start?", answers=aid,
                  response="ask", now=T0 + 5)
    assert r["status"] == "accepted" and r["channel_id"] == g
    assert fold.fold_channel(tmp_path, g)["assignments"][aid]["state"] == "asked"
    assert fold.list_channels(tmp_path) == [g]  # no empty DM left behind
    d = [x for x in decisions.listing(tmp_path) if x["state"] == "open"]
    assert [x["key"] for x in d] == [decisions.ask_key(g, aid)]


def _open(root):
    return [x for x in decisions.listing(root) if x["state"] == "open"]


def test_lead_dm_to_owner_waits_until_the_owner_answers_in_the_dm(tmp_path):
    a = identity.register(tmp_path, "chat-1", "api")
    r = send.post(tmp_path, a, to="owner", text="Which day does the freeze start?", now=T0)
    assert r["status"] == "accepted"
    dm = r["channel_id"]
    opened = [x["data"]["key"] for x in ledger.read(tmp_path, decisions.FILE) if x["type"] == "decision/opened"]
    assert opened == [decisions.dm_key(dm, r["seq"])]
    send.post(tmp_path, a, to="owner", text="Also: Friday or Monday?", now=T0 + 1)  # same wait, not two
    d = _open(tmp_path)
    assert [(x["key"], x["kind"], x["via"], x["lead"], x["question"]) for x in d] == \
        [(decisions.dm_key(dm, r["seq"]), "ask", "dm", a, "Which day does the freeze start?")]
    send.post(tmp_path, "owner", channel_id=dm, text="Thursday noon.", now=T0 + 2)
    assert _open(tmp_path) == []
    assert decisions.listing(tmp_path)[0]["answer"]["text"] == "Thursday noon."


def test_lead_dm_ask_skipped_from_needs_you_posts_no_in_the_dm(tmp_path):
    a = identity.register(tmp_path, "chat-1", "api")
    dm = send.post(tmp_path, a, to="owner", text="Can I drop the old index?", now=T0)["channel_id"]
    send.post(tmp_path, a, to="owner", text="note to self", kind="notice", now=T0 + 1)
    [d] = _open(tmp_path)
    assert decisions.answer(tmp_path, d["key"], None, skip=True)["state"] == "skipped"
    assert _open(tmp_path) == []
    last = [x for x in ledger.read(tmp_path, fold.channel_file(dm)) if x["type"] == "message/posted"][-1]
    assert last["by"] == "owner" and last["data"]["text"] == decisions.SKIP_TEXT


def test_a_notice_in_a_dm_does_not_wait_on_the_owner(tmp_path):
    a = identity.register(tmp_path, "chat-1", "api")
    send.post(tmp_path, a, to="owner", text="missing the staging creds", kind="notice", now=T0)
    assert _open(tmp_path) == []


def test_ask_between_leads_is_not_the_owners_decision(tmp_path):
    a, b = identity.register(tmp_path, "chat-1", "api"), identity.register(tmp_path, "chat-2", "ui")
    g = send.open_group(tmp_path, a, "room", [a, b])["channel_id"]
    send.post(tmp_path, a, channel_id=g, text="@ui do it", mentions=[b], now=T0)
    aid = next(iter(fold.fold_channel(tmp_path, g)["assignments"]))
    send.post(tmp_path, b, channel_id=g, text="what?", answers=aid, response="ask", now=T0 + 1)
    assert decisions.listing(tmp_path) == []


def test_lead_taking_after_ask_withdraws_it(tmp_path):
    a, g, aid = _ask(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="on it", answers=aid, response="take", now=T0 + 9)
    assert decisions.listing(tmp_path)[0]["state"] == "withdrawn"


def _case(root, g):
    """A call_person case as the app writes it now: a fixed-field card bound to (seq, hash, attempt)."""
    from teamapp import approval

    seq = ledger.append(root, "cases.jsonl", "bar_raiser/summoned", "app",
                        {"case_id": "C-1", "channel_id": g, "thread_id": None, "root_seq": 0,
                         "triggers": [{"trigger": "requested", "key": "k"}], "continues_left": 2,
                         "deadline": T0 + 600, "model": "m"})
    card = approval.person_card({"class": "spend", "question": "ok to spend $40?", "what": "Spend $40 on the load test",
                                 "cost": "$40", "reversible": "no", "if_no": "hold"},
                                who="#room › main", attempt=1, tried=[], expires=4e9)  # far future: the page uses the real clock
    ledger.append(root, "cases.jsonl", "bar_raiser/called_person", "app",
                  {"case_id": "C-1", "class": "spend", "question": "ok to spend $40?", "card": card,
                   "binding": approval.bind(seq, card, 1, 4e9)})
    return approval.content_hash(card)


def test_skip_counts_as_no_and_is_posted(tmp_path):
    a, b = identity.register(tmp_path, "chat-1", "api"), identity.register(tmp_path, "chat-2", "ui")
    g = send.open_group(tmp_path, a, "room", [a, b])["channel_id"]
    h = _case(tmp_path, g)
    assert [d["state"] for d in decisions.listing(tmp_path)] == ["open"]
    # a case answer is bound to the card version (W-BR): no card_hash, no answer
    assert decisions.answer(tmp_path, "case:C-1", "ignored", skip=True)["reason"] == "changed"
    res = decisions.answer(tmp_path, "case:C-1", "ignored", skip=True, card_hash=h)
    assert res == {"status": "accepted", "seq": 1, "state": "skipped"}
    assert state.cases(tmp_path)[0]["answer"]["decision"] == "no"
    posts = [r for r in ledger.read(tmp_path, fold.channel_file(g)) if r["type"] == "message/posted"]
    owner = [p for p in posts if p["by"] == "owner"][-1]
    assert owner["data"]["text"] == "No: Spend $40 on the load test."
    assert posts[-1]["data"]["text"].startswith("Bar raiser cannot decide yet.")  # the card's if_no ran
    assert decisions.listing(tmp_path)[0]["state"] == "skipped"


def test_stopped_refuses_and_writes_nothing(tmp_path):
    a, g, aid = _ask(tmp_path)
    limits.stop(tmp_path, "owner")
    assert decisions.answer(tmp_path, decisions.ask_key(g, aid), "x")["reason"] == "stopped"
    assert [r["type"] for r in ledger.read(tmp_path, decisions.FILE)] == ["decision/opened"]


def test_impact_covers_every_bar_raiser_class_and_matches_the_page():
    import json
    import re

    from teamapp import bar_raiser

    assert set(bar_raiser.PERSON_CLASSES) | {"ask"} == set(decisions.IMPACT)
    js = (APP / "ui-src" / "src" / "needsYou.js").read_text()
    body = re.search(r"export const IMPACT = (\{[^}]*\})", js).group(1)
    assert json.loads(re.sub(r"(\w+):", r'"\1":', body)) == decisions.IMPACT


def _row(seq, type_, data, ts=10):
    return {"seq": seq, "ts": ts, "type": type_, "data": data}


def test_a_kind_with_only_decision_rows_counts_and_closes():
    """meeting_item (opened by the meeting module): open, then deferred = skipped."""
    key = "meeting_item:MT-1:I2"
    opened = _row(1, "decision/opened", {"key": key, "kind": "meeting_item", "impact": "requested",
                                         "channel_id": "G-1", "thread_id": "T-1", "question": "Pick A or B?",
                                         "ref": {"meeting_id": "MT-1", "item_id": "I2"}})
    out = decisions.fold_decisions([opened], [])
    assert [(d["key"], d["kind"], d["state"], d["question"]) for d in out] == [(key, "meeting_item", "open", "Pick A or B?")]
    out = decisions.fold_decisions([opened, _row(2, "decision/skipped", {"key": key, "reason": "deferred"})], [])
    assert out[0]["state"] == "skipped" and out[0]["answer"]["reason"] == "deferred"


def test_case_answered_in_the_meeting_box_leaves_the_queue(tmp_path):
    """The case itself still has no answer; the meeting box's decision/answered closes it."""
    a, b = identity.register(tmp_path, "chat-1", "api"), identity.register(tmp_path, "chat-2", "ui")
    g = send.open_group(tmp_path, a, "room", [a, b])["channel_id"]
    _case(tmp_path, g)
    ledger.append(tmp_path, decisions.FILE, "decision/answered", "owner", {"key": "case:C-1", "text": "go"})
    assert state.cases(tmp_path)[0]["answer"] is None
    assert [d["state"] for d in decisions.listing(tmp_path)] == ["answered"]


def test_needs_you_refuses_kinds_answered_elsewhere(tmp_path):
    ledger.append(tmp_path, decisions.FILE, "decision/opened", "app",
                  {"key": "meeting_item:MT-1:I2", "kind": "meeting_item", "channel_id": "G-00000001"})
    assert decisions.answer(tmp_path, "meeting_item:MT-1:I2", "A")["reason"] == "answer_where_asked"


def test_withdrawn_closes_and_leaves_the_queue():
    """A meeting adjourned or ran out of time: the wait ends without the owner."""
    key = "meeting_item:MT-1:I2:1"
    rows = [_row(1, "decision/opened", {"key": key, "kind": "meeting_item", "impact": "ask"}),
            _row(2, "decision/withdrawn", {"key": key, "reason": "adjourned"}),
            _row(3, "decision/answered", {"key": key, "text": "late"})]   # first closing row wins
    out = decisions.fold_decisions(rows, [_src(key, "ask", 1)])
    assert out[0]["state"] == "withdrawn" and out[0]["answer"]["reason"] == "adjourned"


def test_sources_include_meeting_decision_sources_when_present(tmp_path, monkeypatch):
    from teamapp import meeting

    src = {"key": "meeting_item:MT-1:I2:1", "kind": "meeting_item", "impact": "ask", "ts": 5.0,
           "channel_id": "G-00000001", "thread_id": "T-1", "meeting_id": "MT-1", "item_id": "I2",
           "question": "A or B?", "open": True}
    monkeypatch.setattr(meeting, "decision_sources", lambda root: [dict(src)], raising=False)
    out = decisions.listing(tmp_path)
    assert [(d["key"], d["state"], d["meeting_id"], d["item_id"]) for d in out] == [(src["key"], "open", "MT-1", "I2")]
    monkeypatch.delattr(meeting, "decision_sources")   # an older base without it
    assert decisions.listing(tmp_path) == []


def test_a_meeting_case_carries_its_meeting_and_item(tmp_path):
    a, b = identity.register(tmp_path, "chat-1", "api"), identity.register(tmp_path, "chat-2", "ui")
    g = send.open_group(tmp_path, a, "room", [a, b])["channel_id"]
    ledger.append(tmp_path, "cases.jsonl", "bar_raiser/summoned", "app",
                  {"case_id": "C-9", "channel_id": g, "thread_id": "T-1", "root_seq": 0,
                   "triggers": [{"trigger": "meeting_tie", "key": "meeting:3",
                                 "counters": {"meeting_id": "MT-1", "item_id": "I2"}}],
                   "continues_left": 2, "deadline": T0 + 600, "model": "m"})
    ledger.append(tmp_path, "cases.jsonl", "bar_raiser/called_person", "app",
                  {"case_id": "C-9", "class": "requested", "question": "A or B?"})
    d = decisions.listing(tmp_path)[0]
    assert (d["key"], d["meeting_id"], d["item_id"]) == ("case:C-9", "MT-1", "I2")


def test_a_case_rationale_names_proposals_not_their_ids(tmp_path):
    """FIX-MS pod retest (F-MS2): the bar raiser card's rationale read "No one objects to I1-P1"."""
    ledger.append(tmp_path, "cases.jsonl", "bar_raiser/summoned", "app",
                  {"case_id": "C-7", "channel_id": "G-00000001", "thread_id": "T-1", "root_seq": 0,
                   "triggers": [], "continues_left": 2, "deadline": T0 + 600, "model": "m"})
    ledger.append(tmp_path, "cases.jsonl", "bar_raiser/acted", "bar_raiser:C-7",
                  {"case_id": "C-7", "action": "rule", "args": {"choice": "I1-P1", "decides": "No one objects to I1-P1."},
                   "rationale": "No one objects to I1-P1.", "evidence_seqs": []})
    acted = state.cases(tmp_path)[0]["acted"]
    assert acted["rationale"] == "No one objects to Proposal 1 of item 1."
    assert acted["args"] == {"choice": "Proposal 1 of item 1", "decides": "No one objects to Proposal 1 of item 1."}
