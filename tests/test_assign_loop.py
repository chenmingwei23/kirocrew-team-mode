"""@ closes its loop (x-heli-15 learning #6): ack then result, an empty result is a
reply, "@-ed and not answered" comes from the ledger only, a notice wakes nobody."""

from __future__ import annotations

import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import fold, identity, ledger, send, state, wake  # noqa: E402

T0 = 1_000_000.0


def _setup(root):
    a, b, c = (identity.register(root, f"chat-{i}", f"lead{i}") for i in range(3))
    g = send.open_group(root, a, "room", [a, b, c])["channel_id"]
    return (a, b, c), g


def _assign(root, g, a, b, now=T0):
    send.post(root, a, channel_id=g, text="@b find the flaky test", mentions=[b], now=now)
    return next(iter(fold.fold_channel(root, g)["assignments"]))


def _decide(root, lead, now):
    chans = {cid: fold.fold_channel(root, cid) for cid in fold.list_channels(root)}
    return wake.next_wake(lead, fold.fold_member(root, lead), fold.unread(root, lead), chans, now)


# --------------------------------------------------------------------------- assignment_due (pure)


def test_assignment_due_steps():
    a = {"from": "A", "to": "B", "opened_ts": T0, "state": "open"}
    assert wake.assignment_due(a, T0 + 10) == {"step": "ack", "owed_by": "B",
                                               "due_ts": T0 + wake.ANSWER_SECS, "late": False}
    assert wake.assignment_due(a, T0 + wake.ANSWER_SECS)["late"] is True
    # two delivered wakes + 120 s is late before the 900 s
    assert wake.assignment_due(a, T0 + 300, [T0 + 10, T0 + 150])["late"] is True
    taken = {**a, "state": "taken", "acked_ts": T0 + 60}
    d = wake.assignment_due(taken, T0 + 61)
    assert (d["step"], d["late"], d["due_ts"]) == ("result", False, T0 + 60 + wake.RESULT_SECS)
    assert wake.assignment_due(taken, T0 + 60 + wake.RESULT_SECS)["late"] is True
    assert wake.assignment_due({**a, "state": "asked"}, T0 + 99999) == \
        {"step": "asker", "owed_by": "A", "due_ts": None, "late": False}
    assert wake.assignment_due({**a, "state": "closed"}, T0 + 99999)["step"] == "done"
    assert wake.assignment_due({**a, "state": "declined"}, T0 + 99999)["step"] == "done"
    marked = wake.assignment_due({**a, "state": "unanswered", "reason": "no_result"}, T0)
    assert (marked["step"], marked["step_missed"]) == ("marked", "result")


# --------------------------------------------------------------------------- ack, then result


def test_take_then_result_and_empty_result(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    aid = _assign(tmp_path, g, a, b)
    assert send.post(tmp_path, b, channel_id=g, text="on it", answers=aid, response="take",
                     now=T0 + 5)["status"] == "accepted"
    # a second ack is refused, with advice pointing at the result step
    again = send.post(tmp_path, b, channel_id=g, text="on it again", answers=aid, response="take", now=T0 + 6)
    assert again["reason"] == "assignment_taken" and "result" in again["advice"]
    r = send.post(tmp_path, b, channel_id=g, text="Searched 3 runs, nothing flaky.", answers=aid,
                  response="no_result", now=T0 + 7)
    assert r["status"] == "accepted"
    a_ = fold.fold_channel(tmp_path, g)["assignments"][aid]
    assert (a_["state"], a_["empty"], a_["acked_ts"]) == ("closed", True, T0 + 5)
    assert fold.fold_member(tmp_path, b)["todos"][aid]["state"] == "done"
    assert send.post(tmp_path, b, channel_id=g, text="more", answers=aid, response="result",
                     now=T0 + 8)["reason"] == "assignment_closed"
    # the assigner is woken by the result at once
    assert any(x.startswith("answer:") for x in _decide(tmp_path, a, T0 + 9)["reasons"])


def test_result_without_take_counts_as_both(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    aid = _assign(tmp_path, g, a, b)
    assert send.post(tmp_path, b, channel_id=g, text="Done: PR 12.", answers=aid, response="result",
                     now=T0 + 3)["status"] == "accepted"
    assert fold.fold_channel(tmp_path, g)["assignments"][aid]["empty"] is False
    assert wake.check_unanswered(tmp_path, T0 + 99999) == 0


def test_taken_without_result_is_marked_no_result(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    aid = _assign(tmp_path, g, a, b)
    send.post(tmp_path, b, channel_id=g, text="on it", answers=aid, response="take", now=T0 + 5)
    # the ack answered the @: past ANSWER_SECS nothing is marked
    assert wake.check_unanswered(tmp_path, T0 + wake.ANSWER_SECS + 1) == 0
    assert wake.check_unanswered(tmp_path, T0 + 5 + wake.RESULT_SECS) == 1
    rows = ledger.read(tmp_path, fold.channel_file(g))
    marked = [r for r in rows if r["type"] == "assignment/unanswered"]
    assert marked[0]["data"]["reason"] == "no_result"
    assert "has not sent a result" in rows[-1]["data"]["text"]
    assert wake.check_unanswered(tmp_path, T0 + 99999) == 0  # once only


def test_state_carries_the_same_rule(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    aid = _assign(tmp_path, g, a, b)
    row = next(x for x in state.build(tmp_path, now=T0 + 10)["assignments"] if x["assignment_id"] == aid)
    assert (row["step"], row["owed_by"], row["late"]) == ("ack", b, False)
    send.post(tmp_path, b, channel_id=g, text="on it", answers=aid, response="take", now=T0 + 20)
    row = next(x for x in state.build(tmp_path, now=T0 + 20 + wake.RESULT_SECS)["assignments"])
    assert (row["step"], row["late"]) == ("result", True)


# --------------------------------------------------------------------------- notice


def test_notice_wakes_nobody_is_no_hop_and_rides_the_brief(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    assert send.post(tmp_path, a, channel_id=g, text="missing repro", kind="notice", mentions=[b],
                     now=T0)["reason"] == "notice_names_nobody"
    r = send.post(tmp_path, a, channel_id=g, text="I am missing the repro report.", kind="notice", now=T0)
    assert r["status"] == "accepted" and r["hops"] == 0
    # no at-once wake and no batch, however long it waits
    assert _decide(tmp_path, b, T0 + 1) is None
    assert _decide(tmp_path, b, T0 + 3600) is None
    # not a hop: b's reply after it is hop 1, as if the notice were not there
    assert send.post(tmp_path, b, channel_id=g, text="ok", now=T0 + 10)["hops"] == 1
    # unread, so the next real wake's brief carries it
    assert any(i["data"].get("kind") == "notice" for i in fold.unread(tmp_path, c))


def test_notice_cannot_wash_a_hop_chain(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    assert send.post(tmp_path, a, channel_id=g, text="x1", now=T0)["hops"] == 1
    assert send.post(tmp_path, b, channel_id=g, text="x2", now=T0 + 1)["hops"] == 2
    assert send.post(tmp_path, a, channel_id=g, text="x3", now=T0 + 2)["hops"] == 3
    send.post(tmp_path, b, channel_id=g, text="I am missing the logs.", kind="notice", now=T0 + 3)
    # counted as a hop-0 message, the notice would drop a's next post back to hop 1
    assert send.post(tmp_path, a, channel_id=g, text="x4", now=T0 + 4)["hops"] == 3


def test_briefed_notice_is_not_an_inbox_item_but_a_newer_one_is(tmp_path):
    (a, b, c), g = _setup(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="I am missing the logs.", kind="notice", now=T0)
    send.post(tmp_path, a, channel_id=g, text="@c look", mentions=[c], now=T0 + 1)
    d = _decide(tmp_path, c, T0 + 2)
    ledger.append(tmp_path, fold.member_file(c), "secretary/briefed", "app",
                  {"brief_id": "B-1", "lane": "rules", "brief": {"schema": "secretary.brief.v1", "groups": []}})
    ledger.append(tmp_path, fold.member_file(c), "wake/due", "app", {**d, "brief_id": "B-1"}, now=T0 + 2)
    send.post(tmp_path, b, channel_id=g, text="I am missing the spec.", kind="notice", now=T0 + 3)
    out = wake.inbox_read(tmp_path, c)
    texts = [i.get("body", "") for i in out["items"]]
    assert not any("missing the logs" in t for t in texts)  # read in the brief
    assert any("missing the spec" in t for t in texts)  # newer than the brief: shown, not lost
    assert fold.unread(tmp_path, c) == []
