"""Bar raiser: each trigger, nonce checks, actions, defaults and budgets.
No real model: spawn is a fake ctx that records calls."""

from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
sys.path.insert(0, str(APP / "mcp"))

import staff_server  # noqa: E402
from teamapp import bar_raiser as br  # noqa: E402
from teamapp import fold, ledger, limits  # noqa: E402

A, B = "L-0000000a", "L-0000000b"
G = "G-00000001"
F = fold.channel_file(G)
_n = iter(range(10_000))


def _post(root, by, text="hi", *, thread=None, kind="message", mentions=(), ts=None):
    mid = f"m{next(_n):08x}"
    seq = ledger.append(root, F, "message/posted", by, {
        "msg_id": mid, "thread_id": thread, "text": text, "kind": kind,
        "mentions": list(mentions), "cc": [], "everyone": False, "also_main": False,
        "reply_to": None, "answers": None, "chain": {"root_seq": 0, "hops": 1, "br_resets": 0}},
        now=ts)
    return seq, mid


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "ledger"
    ledger.append(r, F, "channel/opened", "owner", {
        "kind": "group", "title": "g", "members": [A, B], "people": ["owner"], "creator": A,
        "managers": [], "bar_raiser": "default"})
    _post(r, "owner", "please plan the launch")
    return r


class _Spawn:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    async def run(self, task, agent, *, silent=False, model=""):
        if self.fail:
            raise RuntimeError("declined")
        self.calls.append({"agent": agent, "model": model,
                           "case_id": re.search(r"case_id=(\S+)", task).group(1),
                           "nonce": re.search(r"nonce=(\S+)", task).group(1)})
        return "run"


class _Ctx:
    def __init__(self, fail=False):
        self.spawn = _Spawn(fail)


def _hold(root, by=f"lead:{B}", thread=None):
    _, mid = _post(root, by, "hop 5 reply", thread=thread)
    ledger.append(root, F, "message/held", "app", {"msg_id": mid, "reason": "hop_limit"})
    return mid


def _held_seq(root):
    """The newest ``message/held`` row: an app record, not a lead's own words."""
    return [r["seq"] for r in ledger.read(root, F) if r["type"] == "message/held"][-1]


CARD = {"what": "Run the $40 load test", "cost": "$40", "reversible": "no", "if_no": "close_thread"}


def _open_one(root, ctx=None):
    ctx = ctx or _Ctx()
    cases = br.detect(root, G, 0)
    assert len(cases) == 1, cases
    case_id = asyncio.run(br.summon(ctx, root, cases[0]))
    return case_id, ctx


def _act(root, case_id, nonce, *rest):
    """``br.act`` bound to the packet the bar raiser just read (as a real one would)."""
    return br.act(root, case_id, nonce, *rest,
                  packet_hash=br.case_packet(root, case_id, nonce).get("packet_hash"))


def _types(root, file=F):
    return [r["type"] for r in ledger.read(root, file)]


# --- triggers -------------------------------------------------------------------------

def test_hop_limit_trigger(root):
    _hold(root)
    [case] = br.detect(root, G, 0)
    assert case["triggers"][0]["trigger"] == "hop_limit" and not case["exhausted"]


def test_round_budget_trigger_after_ten_lead_messages(root):
    for i in range(9):
        _post(root, f"lead:{A if i % 2 else B}")
    assert br.detect(root, G, 0) == []
    _post(root, f"lead:{A}")
    [case] = br.detect(root, G, 0)
    assert case["triggers"][0]["trigger"] == "round_budget"


def test_cooldown_trigger(root):
    _post(root, f"lead:{A}")
    ledger.append(root, F, "channel/cooling", "app", {"until": 999})
    [case] = br.detect(root, G, 0)
    assert case["triggers"][0]["trigger"] == "cooldown"


def test_unanswered_assignment_trigger(root):
    seq, _ = _post(root, f"lead:{A}", "@B take this", mentions=[B])
    ledger.append(root, F, "assignment/opened", f"lead:{A}",
                  {"assignment_id": "as1", "from": A, "to": B, "msg_seq": seq, "thread_id": None})
    ledger.append(root, F, "assignment/unanswered", "app", {"assignment_id": "as1"})
    [case] = br.detect(root, G, 0)
    assert case["triggers"][0]["trigger"] == "unanswered_assignment"


def test_requested_trigger(root):
    _post(root, f"lead:{A}", "bar raiser please rule", kind="request", mentions=["bar_raiser"])
    [case] = br.detect(root, G, 0)
    assert case["triggers"][0]["trigger"] == "requested"


def test_detect_writes_nothing_and_does_not_refire(root):
    _hold(root)
    before = (_types(root), _types(root, br.CASES))
    assert br.detect(root, G, 0) == br.detect(root, G, 0)
    assert (_types(root), _types(root, br.CASES)) == before
    case_id, ctx = _open_one(root)
    assert ctx.spawn.calls[0]["agent"] == "bar-raiser"
    assert ctx.spawn.calls[0]["model"] == "claude-sonnet-5.5"
    assert br.detect(root, G, 0) == []          # same trigger is not fired again
    _hold(root)                                  # a new trigger on the open chain joins it
    [join] = br.detect(root, G, 0)
    assert join["join"] == case_id


# --- nonce -----------------------------------------------------------------------------

def test_wrong_nonce_refused_and_writes_nothing(root):
    _hold(root)
    case_id, ctx = _open_one(root)
    before = _types(root, br.CASES)
    assert br.case_packet(root, case_id, "bad") == {"error": "bad_case_or_nonce"}
    res = _act(root, case_id, "bad", "continue", {}, "", [])
    assert res == {"status": "refused", "reason": "bad_case_or_nonce"}
    assert _types(root, br.CASES) == before
    msg = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "staff_bar_raiser_act",
        "arguments": {"case_id": case_id, "nonce": "bad", "action": "continue", "args": {},
                      "rationale": "", "evidence_seqs": []}}}
    assert staff_server._handle(root, msg)["result"]["isError"] is True
    assert "error" not in br.case_packet(root, case_id, ctx.spawn.calls[0]["nonce"])


def test_packet_only_holds_the_case_timeline(root):
    _post(root, f"lead:{A}", "THREAD ONLY", thread="T-9")
    _hold(root)
    case_id, ctx = _open_one(root)
    packet = br.case_packet(root, case_id, ctx.spawn.calls[0]["nonce"])
    assert "THREAD ONLY" not in json.dumps(packet)
    assert packet["allowed_actions"] == list(br.ACTIONS)


def test_packet_states_the_args_each_action_takes(root):
    # A real model, given only action names, guessed args twice and was defaulted.
    _hold(root)
    case_id, ctx = _open_one(root)
    nonce = ctx.spawn.calls[0]["nonce"]
    packet = br.case_packet(root, case_id, nonce)
    assert packet["action_args"]["close_thread"] == []
    assert packet["action_args"]["call_person"] == ["class", "cost", "if_no", "question", "reversible", "what"]
    assert packet["action_args"]["veto"] == ["change", "number", "rule"]
    assert set(packet["templates"]) >= {"veto", "hold", "call_person"}
    assert packet["person_classes"] == list(br.PERSON_CLASSES)
    # args built from the packet alone are accepted
    args = {k: None for k in packet["action_args"]["close_thread"]}
    assert br._coerce_args(None) == {} and br._coerce_args("{}") == {}
    assert br._coerce_args('{"question": "q"}') == {"question": "q"}
    assert br._coerce_args("[1]") == "[1]"  # a non-object string still fails validation
    res = _act(root, case_id, nonce, "close_thread", "{}", "the two leads are looping", [3, 4])
    assert res["status"] == "accepted"


# --- actions ------------------------------------------------------------------------------

def test_continue_resets_chain_and_releases_held(root):
    mid = _hold(root)
    case_id, ctx = _open_one(root)
    assert _act(root, case_id, ctx.spawn.calls[0]["nonce"], "continue", {}, "go on", [])["status"] == "accepted"
    assert _act(root, case_id, ctx.spawn.calls[0]["nonce"], "continue", {}, "", [])["reason"] == "case_closed"
    br.apply_due(root, 0)
    rows = ledger.read(root, F)
    assert any(r["type"] == "chain/reset" for r in rows)
    assert any(r["type"] == "message/released" and r["data"]["msg_id"] == mid for r in rows)
    assert not fold.fold_channel(root, G)["messages"][mid]["held"]
    br.apply_due(root, 0)                        # applied once only
    assert len(ledger.read(root, F)) == len(rows)


@pytest.mark.parametrize("action,args", [
    ("narrow", {"question": "Which date, 1 or 8 Dec?"}),
    ("suggest_meeting", {"question": "Launch order"}),
])
def test_system_note_actions(root, action, args):
    _hold(root)
    case_id, ctx = _open_one(root)
    assert _act(root, case_id, ctx.spawn.calls[0]["nonce"], action, args, "", [])["status"] == "accepted"
    br.apply_due(root, 0)
    last = ledger.read(root, F)[-1]
    assert last["type"] == "message/posted" and last["data"]["kind"] == "system"
    assert last["by"] == f"bar_raiser:{case_id}" and args["question"] in last["data"]["text"]


def test_close_thread_needs_rationale_and_evidence_then_stops_the_chain(root):
    seq, _ = _post(root, f"lead:{A}", "loop")
    _hold(root)
    case_id, ctx = _open_one(root)
    nonce = ctx.spawn.calls[0]["nonce"]
    assert _act(root, case_id, nonce, "close_thread", {}, "", [])["reason"] == "invalid"
    assert _act(root, case_id, nonce, "close_thread", {}, "looping", [seq, _held_seq(root)])["status"] == "accepted"
    br.apply_due(root, 0)
    assert "chain/closed" in _types(root)
    _hold(root)
    assert br.detect(root, G, 0) == []           # a closed chain fires nothing more


def test_chain_rows_carry_the_current_segment_root(root):
    ctx = _Ctx()
    _hold(root)
    case_id, _ = _open_one(root, ctx)
    _act(root, case_id, ctx.spawn.calls[-1]["nonce"], "continue", {}, "", [])
    br.apply_due(root, 0)
    reset = [r for r in ledger.read(root, F) if r["type"] == "chain/reset"][-1]
    assert reset["data"]["root_seq"] == 2            # segment started at the owner message
    _hold(root)
    case_id, _ = _open_one(root, ctx)
    seq, _ = _post(root, f"lead:{A}", "evidence")
    assert _act(root, case_id, ctx.spawn.calls[-1]["nonce"], "close_thread", {}, "loop",
                [seq, _held_seq(root)])["status"] == "accepted"
    br.apply_due(root, 0)
    closed = [r for r in ledger.read(root, F) if r["type"] == "chain/closed"][-1]
    assert closed["data"] == {"thread_id": None, "root_seq": reset["seq"], "case_id": case_id}


def test_call_person_records_the_question(root):
    _hold(root)
    case_id, ctx = _open_one(root)
    nonce = ctx.spawn.calls[0]["nonce"]
    assert _act(root, case_id, nonce, "call_person", {**CARD, "class": "vibes", "question": "?"}, "", [])["reason"] == "invalid"
    assert _act(root, case_id, nonce, "call_person", {**CARD, "class": "spend", "question": "$40 ok?"}, "", [])["status"] == "accepted"
    br.apply_due(root, 0)
    called = [r for r in ledger.read(root, br.CASES) if r["type"] == "bar_raiser/called_person"]
    assert called[0]["data"]["class"] == "spend"
    opened = [r["data"] for r in ledger.read(root, "decisions.jsonl")]
    assert [(d["key"], d["impact"]) for d in opened] == [(f"case:{case_id}", "spend")]


# --- defaults ---------------------------------------------------------------------------------

def test_two_invalid_answers_default_to_close_thread(root):
    _hold(root)
    case_id, ctx = _open_one(root)
    nonce = ctx.spawn.calls[0]["nonce"]
    _act(root, case_id, nonce, "rule", {}, "", [])
    _act(root, case_id, nonce, "narrow", {}, "", [])
    br.apply_due(root, 0)
    state = br.cases_state(root)[case_id]
    assert state["defaulted"]["reason"] == "invalid_twice"
    assert state["defaulted"]["action"] == "close_thread" and state["applied"]


def test_deadline_defaults(root):
    _hold(root)
    case_id, _ = _open_one(root)
    br.apply_due(root, 0)
    assert br.cases_state(root)[case_id]["defaulted"] is None
    br.apply_due(root, br.cases_state(root)[case_id]["summoned"]["deadline"] + 1)
    assert br.cases_state(root)[case_id]["defaulted"]["reason"] == "deadline"


def test_requested_defaults_to_continue(root):
    _post(root, f"lead:{A}", "please rule", kind="request", mentions=["bar_raiser"])
    case_id, _ = _open_one(root)
    br.apply_due(root, 10**12)
    assert br.cases_state(root)[case_id]["defaulted"]["action"] == "continue"


def test_failed_spawn_defaults_at_once(root):
    _hold(root)
    case_id, _ = _open_one(root, _Ctx(fail=True))
    assert br.cases_state(root)[case_id]["defaulted"]["reason"].startswith("spawn_failed")


# --- budgets ------------------------------------------------------------------------------------

def test_third_case_on_a_chain_is_exhausted_without_spawn(root):
    ctx = _Ctx()
    for _ in range(2):
        _hold(root)
        case_id, _ = _open_one(root, ctx)
        _act(root, case_id, ctx.spawn.calls[-1]["nonce"], "continue", {}, "", [])
        br.apply_due(root, 0)
    assert len(ctx.spawn.calls) == 2
    _hold(root)
    [case] = br.detect(root, G, 0)
    assert case["exhausted"] and case["continues_left"] == 0
    case_id = asyncio.run(br.summon(ctx, root, case))
    assert len(ctx.spawn.calls) == 2
    d = br.cases_state(root)[case_id]["defaulted"]
    assert d["reason"] == "exhausted" and d["action"] == "close_thread" and d["notify_owner"]


def test_global_hourly_budget_stops_spawning(root, monkeypatch):
    monkeypatch.setitem(limits.HOURLY, "bar_raiser", 1)
    ctx = _Ctx()
    _hold(root)
    _open_one(root, ctx)
    _hold(root, thread="T-7")                    # another chain
    [case] = br.detect(root, G, 0)
    case_id = asyncio.run(br.summon(ctx, root, case))
    assert len(ctx.spawn.calls) == 1
    assert br.cases_state(root)[case_id]["defaulted"]["reason"] == "budget"
    assert limits.stopped(root)


def test_stopped_app_spawns_nothing(root):
    limits.stop(root, "test")
    _hold(root)
    ctx = _Ctx()
    case_id, _ = _open_one(root, ctx)
    assert ctx.spawn.calls == []
    assert br.cases_state(root)[case_id]["defaulted"]["reason"] == "stopped"


# --- lead ids never reach text a person reads (video round 2, S09/S12/S14) ------------------

def _register_handles(root):
    for lid, handle in ((A, "api-lead"), (B, "ui-lead")):
        ledger.append(root, "directory.jsonl", "lead/registered", "owner",
                      {"lead_id": lid, "handle": handle, "session_label": f"chat-{lid}", "kind": "chat"})


def test_case_text_shows_handles_not_lead_ids(root):
    from teamapp import state

    _register_handles(root)
    _hold(root, by=f"lead:{B}")
    _post(root, f"lead:{A}", f"I disagree with {B}")
    case_id, ctx = _open_one(root)
    nonce = ctx.spawn.calls[0]["nonce"]
    # the model reads handles only, so it has no id to copy into its answer
    msgs = br.case_packet(root, case_id, nonce)["messages_from_other_agents_data"]
    assert "L-0000000" not in json.dumps(msgs)
    assert {m["by"] for m in msgs} >= {"api-lead", "ui-lead"}
    # a model that writes an id anyway: the page and the posted line show the handle
    res = _act(root, case_id, nonce, "narrow", {"question": f"Should lead:{A} or {B} own the API?"},
                 f"Lead {A} and {B} looped", [])
    assert res["status"] == "accepted"
    br.apply_due(root, 0)
    [c] = state.cases(root)
    assert c["acted"]["args"]["question"] == "Should api-lead or ui-lead own the API?"
    assert c["acted"]["rationale"] == "Lead api-lead and ui-lead looped"
    posted = [r["data"]["text"] for r in ledger.read(root, F)
              if r["type"] == "message/posted" and r["by"].startswith("bar_raiser:")]
    assert posted == ["Bar raiser narrowed the question: Should api-lead or ui-lead own the API?"]
    # the ledger keeps what the model wrote
    acted = [r for r in ledger.read(root, br.CASES) if r["type"] == "bar_raiser/acted"]
    assert A in acted[0]["data"]["rationale"]


def test_called_person_question_shows_handles(root):
    from teamapp import state

    _register_handles(root)
    _hold(root)
    case_id, ctx = _open_one(root)
    _act(root, case_id, ctx.spawn.calls[0]["nonce"], "call_person",
           {**CARD, "class": "spend", "question": f"Approve {A}'s $40 run?"}, "spend", [])
    br.apply_due(root, 0)
    [c] = state.cases(root)
    assert c["called_person"]["question"] == "Approve api-lead's $40 run?"
    assert fold.scrub_ids("L-deadbeef stays", fold.handles(root)) == "L-deadbeef stays"


def test_owner_reads_speakers_and_times_never_seq_numbers(root):
    """round5 S42: the bar raiser wrote 'Ada, seq 14' and 'Uma's seq 15' into text the owner
    reads. The packet labels every message 'speaker at HH:MM', the prompt asks for labels, and
    the page and the posted line swap any seq number left in for its label."""
    from teamapp import state

    _register_handles(root)
    s1, _ = _post(root, f"lead:{A}", "email goes out only when settled", ts=1794326580.0)  # 16:03 UTC
    s2, _ = _post(root, f"lead:{B}", "the list label shows alone", ts=1794326700.0)        # 16:05 UTC
    _hold(root)
    case_id, ctx = _open_one(root)
    nonce = ctx.spawn.calls[0]["nonce"]
    packet = br.case_packet(root, case_id, nonce)
    labels = {m["seq"]: m["label"] for m in packet["messages_from_other_agents_data"]}
    assert labels[s1] == "api-lead at 16:03" and labels[s2] == "ui-lead at 16:05"
    assert "never by seq number" in packet["writing_rule"]
    res = _act(root, case_id, nonce, "narrow",
               {"question": f"Does seq {s2} still hold after #{s1}?"},
               f"Each side pushed back (seqs {s1}, {s2}); seq {s1} answers the email point.", [s1, s2])
    assert res["status"] == "accepted"
    br.apply_due(root, 0)
    [c] = state.cases(root)
    shown = c["acted"]["rationale"] + c["acted"]["args"]["question"]
    assert not re.search(r"\bseqs?\s*\d|#\d", shown), shown
    assert c["acted"]["rationale"] == ("Each side pushed back (api-lead at 16:03, ui-lead at 16:05); "
                                       "api-lead at 16:03 answers the email point.")
    assert c["acted"]["args"]["question"] == "Does ui-lead at 16:05 still hold after api-lead at 16:03?"
    posted = [r["data"]["text"] for r in ledger.read(root, F)
              if r["type"] == "message/posted" and r["by"].startswith("bar_raiser:")]
    assert posted == ["Bar raiser narrowed the question: Does ui-lead at 16:05 still hold after api-lead at 16:03?"]
    assert c["acted"]["evidence_seqs"] == [s1, s2]  # the numbers stay where code reads them


def test_a_thread_is_named_by_its_first_words_never_its_root_seq(root):
    """round5 S42: the person card said '#g › thread at #10' (a ledger seq). It now names the
    thread by the first words of its first post, the same words the page shows."""
    from teamapp import state

    _register_handles(root)
    root_seq, _ = _post(root, "owner", "New topic: CI capacity.")
    tid = f"T-{root_seq}"
    ledger.append(root, F, "thread/opened", "owner", {"thread_id": tid, "root_seq": root_seq, "opener": "owner"})
    _post(root, "owner", f"@{A} the CI queue is 40 minutes and a bigger pool costs money", thread=tid)
    _hold(root, thread=tid)
    case_id, ctx = _open_one(root)
    _act(root, case_id, ctx.spawn.calls[0]["nonce"], "call_person",
         {**CARD, "class": "spend", "question": "Approve the $40 run?"}, "spend", [])
    br.apply_due(root, 0)
    [c] = state.cases(root)
    who = c["called_person"]["card"]["who"]
    assert who.startswith('#g › thread: "@api-lead the CI queue is 40…"'), who
    assert not re.search(r"#\d|T-\d", who), who
    [ch] = [x for x in state.build(root)["channels"] if x["id"] == G]
    assert ch["thread_titles"][tid] == "@api-lead the CI queue is 40…"
    assert fold.thread_place({}, tid) == "thread"
