"""Room decisions (current / superseded / conflict, rejected proposals) and the rolling summary.

Each rule has a test that reddens when its code is removed:

* conflict on a shared topic: ``test_same_topic_without_supersedes_is_conflict_until_superseded``
  (delete the topic loop in conclusions.fold_decisions and it fails).
* supersedes: ``test_supersedes_moves_the_old_decision_out_of_current`` (delete the
  ``for s in new["supersedes"]`` loop and it fails).
* rejected proposals: ``test_vote_writes_the_losing_choice_as_rejected_with_its_reason``
  (drop the ``proposal/rejected`` emit in meeting._outcome and it fails).
* per-section caps: ``test_a_full_section_compresses_only_itself`` (share one budget across
  sections in conclusions.rolling_summary and it fails).
"""

from __future__ import annotations

import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import conclusions, fold, identity, ledger, meeting, pointers, send  # noqa: E402

T0 = 1_000_000.0


def _row(seq, type_, data, by="lead:L-0000000a"):
    return {"v": 1, "seq": seq, "ts": T0 + seq, "type": type_, "by": by, "data": data}


def _dec(seq, topic, text, supersedes=()):
    return _row(seq, "decision/recorded", {"topic": topic, "text": text, "supersedes": list(supersedes),
                                           "msg_seq": seq})


def _status(rows):
    return {d["seq"]: (d["status"], d["superseded_by"], sorted(d["conflict_with"]))
            for d in conclusions.fold_decisions(rows)["decisions"]}


# --------------------------------------------------------------------------- pure rules


def test_supersedes_moves_the_old_decision_out_of_current():
    rows = [_dec(1, "release order", "API first"), _dec(2, "release order", "Web first", [1])]
    assert _status(rows) == {1: ("superseded", 2, []), 2: ("current", None, [])}


def test_same_topic_without_supersedes_is_conflict_until_superseded():
    rows = [_dec(1, "Release  Order", "API first"), _dec(2, "release order", "Web first"),
            _dec(3, "expires_at format", "ISO 8601")]
    assert _status(rows) == {1: ("conflict", None, [2]), 2: ("conflict", None, [1]), 3: ("current", None, [])}
    # superseding one side leaves the other side in conflict with the new decision
    one = _status(rows + [_dec(4, "release order", "API first, web a day later", [1])])
    assert one[1] == ("superseded", 4, []) and one[2] == ("conflict", None, [4]) and one[4] == ("conflict", None, [2])
    # superseding both resolves it
    both = _status(rows + [_dec(4, "release order", "API first, web a day later", [1, 2])])
    assert both == {1: ("superseded", 4, []), 2: ("superseded", 4, []), 3: ("current", None, []),
                    4: ("current", None, [])}


def test_only_explicit_rows_make_decisions():
    """A message that reads like a decision is not one; a deferred outcome is not one."""
    rows = [_row(1, "message/posted", {"msg_id": "M-1", "text": "Decision: API first", "thread_id": None}),
            _row(2, "outcome/recorded", {"meeting_id": "MT-1", "item_id": "I1", "kind": "deferred",
                                         "by": "planner", "text": "Deferred."}, by="app")]
    assert conclusions.fold_decisions(rows) == {"decisions": [], "rejected": []}


def test_a_full_section_compresses_only_itself():
    rows = [_dec(i, f"topic {i}", "x" * 140) for i in range(1, 11)]
    s = {sec["key"]: sec for sec in conclusions.rolling_summary(rows)["sections"]}
    dec = s["decisions"]
    assert len(dec["items"]) == 6 and dec["more"] == 4  # 6 x ~150 chars fits 900, the cap is items
    assert [i["seq"] for i in dec["items"]] == [10, 9, 8, 7, 6, 5]  # newest kept
    assert all(s[k]["items"] == [] and s[k]["more"] == 0 for k in ("waiting", "stuck", "in_progress"))
    small = conclusions.compress([{"text": "a" * 300, "seq": i} for i in range(5)], 6, 600)
    assert len(small["items"]) == 2 and small["more"] == 3  # the character cap


# --------------------------------------------------------------------------- with a ledger


def _setup(root, n=3):
    leads = [identity.register(root, f"chat-{i}", f"lead{i}") for i in range(n)]
    g = send.open_group(root, leads[0], "room", leads, now=T0)["channel_id"]
    return leads, g


def _rows(root, g):
    return ledger.read(root, fold.channel_file(g))


def test_vote_writes_the_losing_choice_as_rejected_with_its_reason(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    r = meeting.convene(tmp_path, a, g, "Release", [{"title": "Who ships first", "mode": "vote_first",
                                                     "options": ["API first", "Web first"],
                                                     "topic": "release order"}], [b, c], now=T0)
    mid = r["meeting_id"]
    for who in (b, c):
        meeting.respond(tmp_path, who, mid, "accept", now=T0)
    for who, ch in ((a, "API first"), (b, "API first"), (c, "Web first")):
        meeting.vote(tmp_path, who, mid, "I1-B1", ch, "because", now=T0 + 1)
    rows = _rows(tmp_path, g)
    rej = [x["data"] for x in rows if x["type"] == "proposal/rejected"]
    assert [(x["text"], x["outcome_kind"], x["lost_to"]) for x in rej] == [("Web first", "vote", "API first")]
    assert meeting.replay_check(rows, mid) == []  # the new rows are part of the planner's pure output
    mem = conclusions.fold_decisions(rows)
    assert [(d["topic"], d["text"], d["status"]) for d in mem["decisions"]] == [("release order", "API first", "current")]
    assert mem["rejected"][0]["topic"] == "release order" and mem["rejected"][0]["reason"]


def test_consensus_rejects_the_other_proposal_with_its_objections(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = meeting.convene(tmp_path, a, g, "Share API", [{"title": "expires_at format"}], [b, c], now=T0)["meeting_id"]
    for who in (b, c):
        meeting.respond(tmp_path, who, mid, "accept", now=T0)

    def turn(who):
        m = meeting.find(tmp_path, mid)[2]
        return next(x["turn_id"] for x in meeting._open_grants(m["items"][m["current"]]) if x["speaker"] == who)

    meeting.speak(tmp_path, a, mid, turn(a), "propose", "Epoch seconds.", now=T0 + 1)
    meeting.speak(tmp_path, b, mid, turn(b), "propose", "ISO 8601 in UTC.", now=T0 + 2)
    meeting.speak(tmp_path, c, mid, turn(c), "object", "Epoch is unreadable in logs.", proposal_id="I1-P1", now=T0 + 3)
    meeting.progress(tmp_path, a, mid, False, True, False, "continue", now=T0 + 4)
    # round 2 runs one speaker at a time: a and b back P2 (c's objection is to P1), c passes
    for who, stance in ((a, "agree"), (b, "agree"), (c, "pass")):
        meeting.speak(tmp_path, who, mid, turn(who), stance, "ok", proposal_id="I1-P2" if stance == "agree" else None,
                      now=T0 + 5)
    meeting.progress(tmp_path, a, mid, True, True, False, "close", now=T0 + 6)
    rows = _rows(tmp_path, g)
    out = next(x["data"] for x in rows if x["type"] == "outcome/recorded")
    assert out["kind"] == "consensus" and out["proposal_id"] == "I1-P2"
    rej = [x["data"] for x in rows if x["type"] == "proposal/rejected"]
    obj = next(x["seq"] for x in rows if (x["data"].get("meeting") or {}).get("stance") == "object")
    assert [(x["proposal_id"], x["proposed_by"], x["objections"]) for x in rej] == [("I1-P1", a, [obj])]
    assert meeting.replay_check(rows, mid) == []


def test_a_deferred_item_rejects_nothing(tmp_path):
    leads, g = _setup(tmp_path, 2)
    a, b = leads
    mid = meeting.convene(tmp_path, a, g, "M", [{"title": "t"}], [b], now=T0)["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    meeting.adjourn(tmp_path, a, mid, "out of time", now=T0 + 1)
    meeting.step(tmp_path, g, mid, T0 + 1 + meeting.ACTION_WINDOW_SECS)
    rows = _rows(tmp_path, g)
    assert any(x["type"] == "outcome/recorded" and x["data"]["kind"] == "deferred" for x in rows)
    assert not any(x["type"] == "proposal/rejected" for x in rows)


def test_record_checks_member_supersedes_and_posts_in_main(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    outsider = identity.register(tmp_path, "chat-x", "outsider")
    assert conclusions.record(tmp_path, outsider, g, "release order", "API first")["reason"] == "not_a_member"
    assert conclusions.record(tmp_path, a, g, "", "API first")["reason"] == "bad_topic"
    first = conclusions.record(tmp_path, a, g, "release order", "API first", now=T0 + 1)
    assert first["status"] == "accepted" and first["decision_status"] == "current"
    assert conclusions.record(tmp_path, b, g, "release order", "x", [999])["reason"] == "no_such_decision"
    second = conclusions.record(tmp_path, b, g, "release order", "Web first", [first["seq"]], now=T0 + 2)
    assert second["decision_status"] == "current"
    again = conclusions.record(tmp_path, c, g, "release order", "y", [first["seq"]])
    assert again["reason"] == "already_superseded"
    msgs = [x for x in _rows(tmp_path, g) if x["type"] == "message/posted" and x["seq"] == second["msg_seq"]]
    assert msgs and msgs[0]["data"]["text"].startswith("Decision · release order: Web first (replaces: API first")
    assert msgs[0]["data"].get("thread_id") is None


def test_a_meeting_item_can_supersede_a_lead_decision(tmp_path):
    leads, g = _setup(tmp_path, 2)
    a, b = leads
    old = conclusions.record(tmp_path, a, g, "release order", "API first", now=T0)["seq"]
    bad = meeting.convene(tmp_path, a, g, "M", [{"title": "t", "supersedes": [old + 50]}], [b], now=T0)
    assert bad["reason"] == "no_such_decision"
    mid = meeting.convene(tmp_path, a, g, "M", [{"title": "Who ships first", "topic": "release order",
                                                 "supersedes": [old], "mode": "vote_first",
                                                 "options": ["Web first", "API first"]}], [b], now=T0)["meeting_id"]
    meeting.respond(tmp_path, b, mid, "accept", now=T0)
    for who in (a, b):
        meeting.vote(tmp_path, who, mid, "I1-B1", "Web first", "web has the fix", now=T0 + 1)
    st = {d["seq"]: d["status"] for d in conclusions.fold_decisions(_rows(tmp_path, g))["decisions"]}
    assert st[old] == "superseded" and list(st.values()).count("current") == 1


def test_summary_sections_from_assignments_and_held(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    send.post(tmp_path, a, text="Can you check the build?", channel_id=g, mentions=[b], now=T0 + 1)
    r = send.post(tmp_path, a, text="Please write the release note", channel_id=g, mentions=[c], now=T0 + 2)
    aid = next(x["data"]["assignment_id"] for x in _rows(tmp_path, g)
               if x["type"] == "assignment/opened" and x["data"]["to"] == c)
    send.post(tmp_path, c, text="On it", channel_id=g, answers=aid, response="take", reply_to=r["seq"], now=T0 + 3)
    names = fold.handles(tmp_path)
    s = {x["key"]: x for x in conclusions.rolling_summary(_rows(tmp_path, g), names)["sections"]}
    assert [i["text"] for i in s["waiting"]["items"]] == ["lead1 ← lead0: Can you check the build?"]
    assert [i["text"] for i in s["in_progress"]["items"]] == ["lead2: Please write the release note"]
    assert not any("L-" in i["text"] for sec in s.values() for i in sec["items"])


def test_brief_pointers_name_a_decision_and_a_rejected_choice(tmp_path):
    leads, g = _setup(tmp_path)
    a, b, c = leads
    mid = meeting.convene(tmp_path, a, g, "Release", [{"title": "Who ships first", "mode": "vote_first",
                                                       "options": ["API first", "Web first"],
                                                       "topic": "release order"}], [b, c], now=T0)["meeting_id"]
    for who in (b, c):
        meeting.respond(tmp_path, who, mid, "accept", now=T0)
    for who in (a, b, c):
        meeting.vote(tmp_path, who, mid, "I1-B1", "API first", "ready", now=T0 + 1)
    r = send.post(tmp_path, c, text="Should we change the release order and ship web first?", channel_id=g,
                  now=T0 + 10)
    brief = {"groups": [{"channel_id": g, "thread_id": None, "items": [{"seqs": [r["seq"]], "summary": "x"}]}]}
    out = pointers.attach_pointers(tmp_path, b, brief, [{"channel_id": g, "seq": r["seq"], "ts": T0 + 10,
                                                         "text": "Should we change the release order and ship web first?"}])
    p = out["groups"][0]["items"][0]["pointers"]
    assert p["decided_before"]["topic"] == "release order" and p["decided_before"]["status"] == "current"
    assert p["rejected_before"]["topic"] == "release order"
    unrelated = pointers.attach_pointers(tmp_path, b, {"groups": [{"channel_id": g, "thread_id": None, "items": [
        {"seqs": [r["seq"]], "summary": "x"}]}]}, [{"channel_id": g, "seq": r["seq"], "ts": T0 + 10, "text": "lunch?"}])
    assert unrelated["groups"][0]["items"][0]["pointers"]["decided_before"] is None
