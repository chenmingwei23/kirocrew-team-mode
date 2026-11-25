"""Visibility (one exit), hop chain, rates, @/cc/@everyone caps, budget stop, stopped sends."""

from __future__ import annotations

import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import fold, identity, ledger, limits, send, wake  # noqa: E402

T0 = 1_000_000.0


def _leads(root, n=4):
    return [identity.register(root, f"chat-{i}", f"lead{i}") for i in range(n)]


def _texts(entries):
    return [e["data"]["text"] for e in entries if e["type"] == "message/posted"]


# --------------------------------------------------------------------------- visibility


def test_dm_is_invisible_to_outsiders_and_visible_to_owner(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    r = send.post(tmp_path, a, to=b, text="secret plan", now=T0)
    assert r["status"] == "accepted"
    dm = r["channel_id"]
    assert _texts(fold.channel_view(tmp_path, dm, b)["entries"]) == ["secret plan"]
    outsider = fold.channel_view(tmp_path, dm, c)
    assert outsider["visible"] is False and outsider["entries"] == []
    assert fold.unread(tmp_path, c) == []
    assert _texts(fold.channel_view(tmp_path, dm, "owner")["entries"]) == ["secret plan"]
    # the one predicate other exits (secretary input, case packets) call directly
    ch = fold.fold_channel(tmp_path, dm)
    row = [r for r in ledger.read(tmp_path, fold.channel_file(dm)) if r["type"] == "message/posted"][0]
    assert fold.visible(row, ch, b) and fold.visible(row, ch, "owner") and not fold.visible(row, ch, c)
    # an outsider cannot post into it either
    assert send.post(tmp_path, c, channel_id=dm, text="hi", now=T0 + 1)["reason"] == "not_a_member"


def test_dm_reply_to_a_handle_lands_in_the_same_dm(tmp_path):
    """Inbox items name the sender by handle, so the answer often comes back as to=<handle>."""
    a, b, c, _ = _leads(tmp_path)
    dm = send.post(tmp_path, a, to=b, text="can you parse it?", now=T0)["channel_id"]
    r = send.post(tmp_path, b, to="lead0", text="yes", now=T0 + 1)
    assert r["status"] == "accepted" and r["channel_id"] == dm
    assert send.post(tmp_path, b, to="nobody", text="x", now=T0 + 2)["reason"] == "not_a_lead"


def test_thread_replies_hidden_from_non_participants_stub_shown(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    root = send.post(tmp_path, a, channel_id=g, text="root msg", now=T0)
    send.post(tmp_path, b, channel_id=g, text="thread reply", thread="new", root_seq=root["seq"], now=T0 + 1)
    for viewer, expected in ((a, True), (b, True), (c, False), ("owner", True)):
        view = fold.channel_view(tmp_path, g, viewer)
        assert ("thread reply" in _texts(view["entries"])) is expected, viewer
        assert "root msg" in _texts(view["entries"])
    stub = fold.channel_view(tmp_path, g, c)["stubs"]
    assert stub and stub[0]["count"] == 1 and set(stub[0]["participants"]) == {a, b}
    assert "thread reply" not in [i["data"].get("text") for i in fold.unread(tmp_path, c)]
    assert send.post(tmp_path, c, channel_id=g, text="x", thread=f"T-{root['seq']}",
                     now=T0 + 2)["reason"] == "not_a_participant"
    # an @ in the thread pulls c in, after which it sees the history
    send.post(tmp_path, a, channel_id=g, text="@c join", thread=f"T-{root['seq']}", mentions=[c], now=T0 + 3)
    assert "thread reply" in _texts(fold.channel_view(tmp_path, g, c)["entries"])


def test_also_main_reply_reaches_main(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    root = send.post(tmp_path, a, channel_id=g, text="root", now=T0)
    send.post(tmp_path, b, channel_id=g, text="conclusion", thread="new", root_seq=root["seq"],
              also_main=True, now=T0 + 1)
    assert "conclusion" in _texts(fold.channel_view(tmp_path, g, c, thread="main")["entries"])


# --------------------------------------------------------------------------- hops


def _pingpong(root, a, b, g, n, t=T0):
    out = []
    for i in range(n):
        who = a if i % 2 == 0 else b
        out.append(send.post(root, who, channel_id=g, text=f"turn {i}", now=t + i * 5))
    return out


def test_hop_over_four_is_held_and_hidden(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    res = _pingpong(tmp_path, a, b, g, 5)
    assert [r.get("hops") for r in res] == [1, 2, 3, 4, 5]
    assert [r["status"] for r in res] == ["accepted"] * 4 + ["held"]
    assert res[-1]["reason"] == "hop_limit" and "end this turn" in res[-1]["advice"]
    rows = ledger.read(tmp_path, fold.channel_file(g))
    assert any(r["type"] == "message/held" and r["data"]["reason"] == "hop_limit" for r in rows)
    assert "turn 4" not in _texts(fold.channel_view(tmp_path, g, c)["entries"])
    assert "turn 4" in _texts(fold.channel_view(tmp_path, g, "owner")["entries"])


def test_owner_message_resets_the_chain(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    _pingpong(tmp_path, a, b, g, 4)
    assert send.post(tmp_path, "owner", channel_id=g, text="keep going", now=T0 + 100)["status"] == "accepted"
    res = _pingpong(tmp_path, a, b, g, 4, t=T0 + 200)
    assert [r["hops"] for r in res] == [1, 2, 3, 4]


def test_main_is_one_chain_so_a_new_topic_there_is_held_but_a_thread_is_not(tmp_path):
    """RFC v5 "Hops in main and threads": main has one chain, each thread its own.
    A lead starting a new topic in main after the cap is held, as the RFC says; a new
    thread, a person in main, or a bar raiser continue is the way to a fresh chain."""
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    _pingpong(tmp_path, a, b, g, 4)
    assert send.post(tmp_path, a, channel_id=g, text="new topic: release notes",
                     now=T0 + 100)["status"] == "held"
    root_seq = [r for r in ledger.read(tmp_path, fold.channel_file(g))
                if r["type"] == "message/posted" and r["data"]["text"] == "turn 0"][0]["seq"]
    r = send.post(tmp_path, c, channel_id=g, text="release notes, in a thread", thread="new",
                  root_seq=root_seq, now=T0 + 110)
    assert r["status"] == "accepted" and r["hops"] == 1


def test_hop_count_survives_restart(tmp_path):
    """Counters come from the files: a fresh process (cache gone) sees the same chain."""
    import shutil
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    _pingpong(tmp_path, a, b, g, 4)
    shutil.rmtree(tmp_path / "cache", ignore_errors=True)
    assert send.post(tmp_path, a, channel_id=g, text="fifth", now=T0 + 500)["status"] == "held"


def test_chain_reset_by_bar_raiser_resets_only_its_timeline(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    _pingpong(tmp_path, a, b, g, 4)
    ledger.append(tmp_path, fold.channel_file(g), "chain/reset", "bar_raiser:C-1", {"thread_id": None})
    assert send.post(tmp_path, b, channel_id=g, text="after reset", now=T0 + 300)["hops"] == 1


def test_backstop_same_node_refuses(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    a_results = []
    for i in range(20):  # a and b alternate; bar raiser resets keep hops low, the backstop never resets
        if i % 2 == 0:
            ledger.append(tmp_path, fold.channel_file(g), "chain/reset", "bar_raiser:C-1", {"thread_id": None})
        who = a if i % 2 == 0 else b
        r = send.post(tmp_path, who, channel_id=g, text=f"again {i}", now=T0 + i * 40)
        if who == a:
            a_results.append(r)
    assert [r["status"] for r in a_results[:9]] == ["accepted"] * 9
    assert a_results[9]["reason"] == "chain_backstop"
    assert any(r["type"] == "alert/backstop" for r in ledger.read(tmp_path, fold.channel_file(g)))
    # alerts are owner-only
    assert not any(e["type"].startswith("alert/") for e in fold.channel_view(tmp_path, g, b)["entries"])


# --------------------------------------------------------------------------- rates and caps


def test_duplicate_text_and_unsolicited_cap(tmp_path):
    a, b, c, d = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c, d])["channel_id"]
    q = send.post(tmp_path, "owner", channel_id=g, text="anyone?", now=T0)
    assert send.post(tmp_path, a, channel_id=g, text="me", reply_to=q["seq"], now=T0 + 1)["status"] == "accepted"
    assert send.post(tmp_path, a, channel_id=g, text="me", now=T0 + 2)["reason"] == "duplicate_text"
    assert send.post(tmp_path, b, channel_id=g, text="me too", reply_to=q["seq"], now=T0 + 3)["status"] == "accepted"
    third = send.post(tmp_path, c, channel_id=g, text="and me", reply_to=q["seq"], now=T0 + 4)
    assert third["status"] == "redirected"
    assert "and me" not in _texts(fold.channel_view(tmp_path, g, "owner")["entries"])
    # round4 A-F2: one trace for the owner's card back, written once, waking nobody
    send.post(tmp_path, c, channel_id=g, text="and me again", reply_to=q["seq"], now=T0 + 5)
    traces = [x for x in fold.channel_view(tmp_path, g, "owner")["entries"] if x["type"] == "reply/redirected"]
    assert [(x["data"]["reply_to"], x["data"]["who"], x["data"]["answers_in_main"]) for x in traces] == [(q["seq"], c, 2)]
    assert all(i["type"] != "reply/redirected" for i in fold.unread(tmp_path, d))


def test_mention_cc_everyone_and_assignment_caps(tmp_path):
    leads = _leads(tmp_path, 6)
    a, b = leads[0], leads[1]
    g = send.open_group(tmp_path, a, "room", leads)["channel_id"]
    assert send.post(tmp_path, a, channel_id=g, text="x", mentions=leads[1:5], now=T0)["reason"] == "too_many_mentions"
    assert send.post(tmp_path, b, channel_id=g, text="all", everyone=True, now=T0)["reason"] == "everyone_not_allowed"
    assert send.post(tmp_path, a, channel_id=g, text="all 1", everyone=True, now=T0 + 1)["status"] == "accepted"
    assert send.post(tmp_path, a, channel_id=g, text="all 2", everyone=True, now=T0 + 2)["status"] == "accepted"
    assert send.post(tmp_path, a, channel_id=g, text="all 3", everyone=True, now=T0 + 3)["reason"] == "everyone_rate"
    outsider = identity.register(tmp_path, "chat-x", "outsider")
    assert send.post(tmp_path, a, channel_id=g, text="hey", mentions=[outsider], now=T0 + 4)["reason"] == "not_a_member"
    for i in range(6):
        ledger.append(tmp_path, fold.channel_file(g), "chain/reset", "bar_raiser:C-1", {"thread_id": None})
        assert send.post(tmp_path, a, channel_id=g, text=f"task {i}", mentions=[b], now=T0 + 10 + i * 40)["status"] == "accepted"
    ledger.append(tmp_path, fold.channel_file(g), "chain/reset", "bar_raiser:C-1", {"thread_id": None})
    assert send.post(tmp_path, a, channel_id=g, text="task 7", mentions=[b],
                     now=T0 + 400)["reason"] == "too_many_open_assignments"


def test_bar_raiser_reserved_mention(tmp_path):
    leads = _leads(tmp_path, 4)
    a, b, c, d = leads
    g = send.open_group(tmp_path, a, "room", leads)["channel_id"]
    # needs kind=request
    assert send.post(tmp_path, a, channel_id=g, text="help", mentions=["bar_raiser"],
                     now=T0)["reason"] == "bar_raiser_needs_request"
    # does not take one of the 3 @ slots and opens no assignment for it
    r = send.post(tmp_path, a, channel_id=g, text="stuck", kind="request",
                  mentions=["bar_raiser", b, c, d], now=T0 + 1)
    assert r["status"] == "accepted"
    row = [x for x in ledger.read(tmp_path, fold.channel_file(g)) if x["type"] == "message/posted"][-1]
    assert "bar_raiser" in row["data"]["mentions"]
    assignees = {x["to"] for x in fold.fold_channel(tmp_path, g)["assignments"].values()}
    assert assignees == {b, c, d}
    # other non-lead words are still refused; no bar raiser in a DM
    assert send.post(tmp_path, a, channel_id=g, text="x", kind="request", mentions=["secretary"],
                     now=T0 + 2)["reason"] == "not_a_member"
    assert send.post(tmp_path, a, to=b, text="x", kind="request", mentions=["bar_raiser"],
                     now=T0 + 3)["reason"] == "dm_main_only"


def test_closed_chain_refuses_until_owner_speaks(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    root = send.post(tmp_path, a, channel_id=g, text="root", now=T0)
    tid = f"T-{root['seq']}"
    send.post(tmp_path, b, channel_id=g, text="reply", thread="new", root_seq=root["seq"], now=T0 + 1)
    ledger.append(tmp_path, fold.channel_file(g), "chain/closed", "bar_raiser:C-1",
                  {"thread_id": tid, "root_seq": root["seq"], "case_id": "C-1"})
    r = send.post(tmp_path, a, channel_id=g, text="more", thread=tid, now=T0 + 50)
    assert r["status"] == "refused" and r["reason"] == "thread_closed" and "do not retry" in r["advice"]
    # an also_main reply from that thread is refused too; main itself stays open
    assert send.post(tmp_path, b, channel_id=g, text="to main", thread=tid, also_main=True,
                     now=T0 + 51)["reason"] == "thread_closed"
    assert send.post(tmp_path, c, channel_id=g, text="main is fine", now=T0 + 52)["status"] == "accepted"
    # the owner reopens by speaking in the thread
    assert send.post(tmp_path, "owner", channel_id=g, text="go on", thread=tid, now=T0 + 60)["status"] == "accepted"
    assert send.post(tmp_path, a, channel_id=g, text="more", thread=tid, now=T0 + 70)["status"] == "accepted"


def test_closed_main_chain(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    send.post(tmp_path, a, channel_id=g, text="x", now=T0)
    ledger.append(tmp_path, fold.channel_file(g), "chain/closed", "bar_raiser:C-1",
                  {"thread_id": None, "root_seq": 0, "case_id": "C-1"})
    assert send.post(tmp_path, b, channel_id=g, text="y", now=T0 + 40)["reason"] == "thread_closed"
    send.post(tmp_path, "owner", channel_id=g, text="new topic", now=T0 + 50)
    assert send.post(tmp_path, b, channel_id=g, text="y", now=T0 + 60)["status"] == "accepted"


def test_secretary_rows_in_member_log_are_not_messages(tmp_path):
    a, b, *_ = _leads(tmp_path, 2)
    mf = fold.member_file(b)
    ledger.append(tmp_path, mf, "secretary/requested", "app",
                  {"brief_id": "B-1", "lead_id": b, "nonce_sha256": "0" * 64, "pointers": [], "expires": T0})
    ledger.append(tmp_path, mf, "secretary/submitted", "secretary:B-1",
                  {"brief_id": "B-1", "brief": {"schema": "secretary.brief.v1", "groups": []},
                   "text": "LOOKS LIKE A MESSAGE"})
    assert fold.unread(tmp_path, b) == []
    assert wake.inbox_read(tmp_path, b)["items"] == []
    m = fold.fold_member(tmp_path, b)
    assert m["dues"] == [] and m["briefs"] == {} and m["acked"] == {}
    chans = {}
    assert wake.next_wake(b, m, [], chans, T0 + 9999) is None


def test_assignment_answer_rules(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    send.post(tmp_path, a, channel_id=g, text="@b do it", mentions=[b], now=T0)
    aid = next(iter(fold.fold_channel(tmp_path, g)["assignments"]))
    assert send.post(tmp_path, c, channel_id=g, text="mine", answers=aid, response="take",
                     now=T0 + 1)["reason"] == "not_your_assignment"
    assert send.post(tmp_path, b, channel_id=g, text="no", answers=aid, response="decline",
                     now=T0 + 2)["reason"] == "decline_needs_reason"
    assert send.post(tmp_path, b, channel_id=g, text="taking it", answers=aid, response="take",
                     now=T0 + 3)["status"] == "accepted"
    assert fold.fold_channel(tmp_path, g)["assignments"][aid]["state"] == "taken"
    assert fold.fold_member(tmp_path, b)["todos"][aid]["state"] == "claimed"


def test_sender_bucket(tmp_path, monkeypatch):
    monkeypatch.setattr(limits, "WINDOW_MSGS", 1000)  # isolate the bucket from the channel window
    assert limits.bucket_ok([T0] * 29, T0) and not limits.bucket_ok([T0] * 30, T0)
    assert limits.bucket_ok([T0] * 30, T0 + 2)  # refills 0.5/s
    a, b, *_ = _leads(tmp_path, 2)
    dm = send.post(tmp_path, a, to=b, text="m0", now=T0)["channel_id"]
    results = [send.post(tmp_path, a, channel_id=dm, text=f"m{i}", now=T0) for i in range(1, 40)]
    assert results[28]["status"] == "accepted" and results[29]["reason"] == "sender_rate"


def test_channel_window_starts_cooldown(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    g = send.open_group(tmp_path, a, "room", [a, b, c])["channel_id"]
    for i in range(20):
        if i % 3 == 0:
            ledger.append(tmp_path, fold.channel_file(g), "chain/reset", "bar_raiser:C-1", {"thread_id": None})
        send.post(tmp_path, [a, b, c][i % 3], channel_id=g, text=f"w{i}", now=T0 + i)
    r = send.post(tmp_path, a, channel_id=g, text="one more", now=T0 + 30)
    assert r["status"] == "held" and r["reason"] == "channel_cooling"
    assert fold.fold_channel(tmp_path, g)["cooling_until"] == T0 + 30 + limits.COOLDOWN_SECS


# --------------------------------------------------------------------------- budget and stop


def test_global_wake_budget_stops_at_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(limits, "TOTAL_WAKES", 3)
    (a,) = _leads(tmp_path, 1)
    assert [limits.charge_wake(tmp_path, a, now=T0 + i * 1000) for i in range(4)] == [True, True, True, False]
    assert limits.stopped(tmp_path) and limits.stop_reason(tmp_path) == "budget"


def test_global_token_budget_stops(tmp_path, monkeypatch):
    monkeypatch.setattr(limits, "TOTAL_TOKENS_EST", 100_000)
    (a,) = _leads(tmp_path, 1)
    assert limits.charge_wake(tmp_path, a, now=T0) is True        # cold 96k
    assert limits.charge_wake(tmp_path, a, now=T0 + 10) is False  # hot 45k would cross 100k
    assert limits.stopped(tmp_path)
    rows = ledger.read(tmp_path, "control.jsonl")
    assert rows[-1]["data"]["limit"] == "total_tokens_est"


def test_hourly_cap_stops(tmp_path, monkeypatch):
    monkeypatch.setitem(limits.HOURLY, "message", 2)
    for i in range(2):
        assert limits.charge(tmp_path, "message", now=T0 + i)
    assert limits.charge(tmp_path, "message", now=T0 + 5) is False
    assert limits.stopped(tmp_path)


def test_per_lead_wake_cap_holds_only_that_lead(tmp_path):
    """Scenario run: one lead's 12 wakes/h stopped the whole app."""
    a, b = _leads(tmp_path, 2)
    for i in range(limits.WAKES_PER_LEAD_HOUR):
        assert limits.charge(tmp_path, "wake", lead_id=a, now=T0 + i)
    assert limits.charge(tmp_path, "wake", lead_id=a, now=T0 + 20) is False
    assert limits.charge(tmp_path, "wake", lead_id=a, now=T0 + 30) is False
    assert not limits.stopped(tmp_path)
    capped = [r for r in ledger.read(tmp_path, "control.jsonl") if r["type"] == "budget/lead_capped"]
    assert [r["data"]["lead_id"] for r in capped] == [a]  # one record, not one per retry
    assert limits.charge(tmp_path, "wake", lead_id=b, now=T0 + 40)  # the other lead still wakes
    assert limits.charge(tmp_path, "wake", lead_id=a, now=T0 + 3600 + 1)  # its hour rolled over


def test_budget_reset_clears_hourly_counts(tmp_path):
    (a,) = _leads(tmp_path, 1)
    for i in range(limits.WAKES_PER_LEAD_HOUR):
        assert limits.charge(tmp_path, "wake", lead_id=a, now=T0 + i)
    assert limits.charge(tmp_path, "wake", lead_id=a, now=T0 + 20) is False
    limits.resume(tmp_path, reset_budget=True)
    u = limits.usage(tmp_path, now=T0 + 30)
    assert u["per_lead_hour"] == {} and u["hour"]["wake"] == 0
    assert limits.charge(tmp_path, "wake", lead_id=a, now=T0 + 30)


def test_stopped_refuses_sends_and_resume_restores(tmp_path):
    a, b, *_ = _leads(tmp_path, 2)
    limits.stop(tmp_path, "owner")
    r = send.post(tmp_path, a, to=b, text="hello", now=T0)
    assert r["status"] == "refused" and r["reason"] == "stopped" and "do not retry" in r["advice"]
    assert limits.charge(tmp_path, "message") is False
    assert not [f for f in ledger.list_files(tmp_path, "channels")]
    limits.resume(tmp_path)
    assert send.post(tmp_path, a, to=b, text="hello", now=T0)["status"] == "accepted"


def test_budget_reset_on_resume(tmp_path, monkeypatch):
    monkeypatch.setattr(limits, "TOTAL_WAKES", 1)
    (a,) = _leads(tmp_path, 1)
    assert limits.charge_wake(tmp_path, a, now=T0)
    assert not limits.charge_wake(tmp_path, a, now=T0 + 1000)
    limits.resume(tmp_path)
    assert not limits.charge_wake(tmp_path, a, now=T0 + 2000)  # still over the total
    limits.resume(tmp_path, reset_budget=True)
    assert limits.charge_wake(tmp_path, a, now=T0 + 3000)


def test_inbox_read_respects_visibility(tmp_path):
    a, b, c, _ = _leads(tmp_path)
    send.post(tmp_path, a, to=b, text="for b only", now=T0)
    assert wake.inbox_read(tmp_path, c)["items"] == []
    assert len(wake.inbox_read(tmp_path, b)["items"]) == 1
