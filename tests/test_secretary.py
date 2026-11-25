"""Secretary: strict brief schema with no judgement field, visibility of its input,
server order, and the rules-lane fallback. No real model: spawn is a fake ctx."""

from __future__ import annotations

import asyncio
import copy
import json
import random
import re
import sys
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
sys.path.insert(0, str(APP / "mcp"))

import staff_server  # noqa: E402
from teamapp import fold, ledger, limits, pointers, secretary  # noqa: E402

A, B, C = "L-0000000a", "L-0000000b", "L-0000000c"
G, G2, D = "G-00000001", "G-00000002", "D-00000003"


def _post(root, cid, by, text, *, thread=None, mentions=(), seq_ts=None):
    return ledger.append(root, fold.channel_file(cid), "message/posted", by, {
        "msg_id": f"m{random.getrandbits(32):08x}", "thread_id": thread, "text": text,
        "kind": "message", "mentions": list(mentions), "cc": [], "everyone": False,
        "also_main": False, "reply_to": None, "answers": None,
        "chain": {"root_seq": 0, "hops": 1, "br_resets": 0}}, now=seq_ts)


@pytest.fixture
def room(tmp_path):
    """G: A, B, C. Thread T-2 holds B and C only. G2: B and C only. D: A and B."""
    root = tmp_path / "ledger"
    for cid, kind, members in ((G, "group", [A, B, C]), (G2, "group", [B, C]), (D, "dm", [A, B])):
        ledger.append(root, fold.channel_file(cid), "channel/opened", "owner", {
            "kind": kind, "title": cid, "members": members, "people": ["owner"],
            "creator": B, "managers": [], "bar_raiser": "default"})
    s_main = _post(root, G, f"lead:{B}", "Can someone review the API plan?", seq_ts=100)
    ledger.append(root, fold.channel_file(G), "thread/opened", f"lead:{B}",
                  {"thread_id": "T-2", "root_seq": s_main, "opener": B})
    for who in (B, C):
        ledger.append(root, fold.channel_file(G), "thread/member_added", "app",
                      {"thread_id": "T-2", "who": who, "via": "post"})
    s_thread = _post(root, G, f"lead:{C}", "SECRET thread text", thread="T-2", seq_ts=101)
    s_dup = _post(root, G, f"lead:{C}", "Can someone review the API plan?", mentions=[A], seq_ts=102)
    s_g2 = _post(root, G2, f"lead:{B}", "SECRET other room", seq_ts=103)
    s_dm = _post(root, D, f"lead:{B}", "Ping about the deploy\nsecond line", seq_ts=104)
    return {"root": root, "main": s_main, "thread": s_thread, "dup": s_dup, "g2": s_g2, "dm": s_dm}


def _pointers(room):
    return [{"channel_id": G, "seq": room["main"]}, {"channel_id": G, "seq": room["thread"]},
            {"channel_id": G, "seq": room["dup"]}, {"channel_id": G2, "seq": room["g2"]},
            {"channel_id": D, "seq": room["dm"]}]


def _valid(room):
    return {"schema": secretary.SCHEMA, "groups": [
        {"channel_id": D, "thread_id": None, "items": [{"seqs": [room["dm"]], "summary": "deploy ping"}]},
        {"channel_id": G, "thread_id": None,
         "items": [{"seqs": [room["main"], room["dup"]], "summary": "API plan review asked twice"}]},
    ]}


def _inp(room):
    return secretary.build_input(room["root"], A, [[p["channel_id"], p["seq"]] for p in _pointers(room)])


# --- schema: no judgement field ---------------------------------------------------

def test_secretary_schema_has_no_judgement_field():
    assert secretary.ALLOWED_KEYS == {"schema", "groups", "channel_id", "thread_id", "items",
                                      "seqs", "summary"}


def test_valid_brief_parses(room):
    out = secretary.parse_brief(_valid(room), _inp(room)["items"])
    assert sum(len(g["items"]) for g in out["groups"]) == 2


@pytest.mark.parametrize("where,key", [
    ("top", "priority"), ("top", "decision"),
    ("group", "recommendation"), ("group", "importance"),
    ("item", "priority"), ("item", "skip"), ("item", "wake"), ("item", "recommendation"),
])
def test_judgement_or_extra_key_refused(room, where, key):
    brief = _valid(room)
    target = {"top": brief, "group": brief["groups"][0], "item": brief["groups"][0]["items"][0]}[where]
    target[key] = "high"
    with pytest.raises(secretary.BriefInvalid):
        secretary.parse_brief(brief, _inp(room)["items"])


@pytest.mark.parametrize("mutate", [
    lambda b: b.pop("schema"),
    lambda b: b["groups"][0].pop("thread_id"),
    lambda b: b["groups"][0]["items"][0].pop("summary"),
    lambda b: b["groups"][1]["items"][0]["seqs"].pop(),            # a seq left out
    lambda b: b["groups"].pop(0),                                  # a whole item left out
    lambda b: b["groups"][0]["items"][0]["seqs"].append(9999),     # unknown seq
    lambda b: b["groups"][0]["items"].append(copy.deepcopy(b["groups"][0]["items"][0])),  # dup seq
    lambda b: b["groups"][1].update(thread_id="T-2"),              # wrong place
    lambda b: b["groups"][0]["items"][0].update(seqs=[True]),      # bool is not a seq
    lambda b: b["groups"][0]["items"][0].update(summary="x" * 161),
    lambda b: b.update(schema="secretary.brief.v2"),
])
def test_malformed_brief_refused(room, mutate):
    brief = _valid(room)
    mutate(brief)
    with pytest.raises(secretary.BriefInvalid):
        secretary.parse_brief(brief, _inp(room)["items"])


def test_brief_order_is_server_order(room):
    items = _inp(room)["items"]
    expected = secretary.server_order(secretary.parse_brief(_valid(room), items), items)
    for seed in range(5):
        shuffled = _valid(room)
        random.Random(seed).shuffle(shuffled["groups"])
        assert secretary.server_order(secretary.parse_brief(shuffled, items), items) == expected
    # addressed to me (the @A in G) comes before the DM
    assert [g["channel_id"] for g in expected["groups"]] == [G, D]


# --- visibility -------------------------------------------------------------------

def test_input_has_nothing_the_viewer_cannot_see(room):
    inp = _inp(room)
    blob = json.dumps(inp)
    assert "SECRET" not in blob
    assert {(i["channel_id"], i["seq"]) for i in inp["items"]} == {
        (G, room["main"]), (G, room["dup"]), (D, room["dm"])}


def test_staff_input_read_has_nothing_the_viewer_cannot_see(room):
    ctx = _Ctx(room["root"], answer=None)
    asyncio.run(secretary.brief_for(ctx, room["root"], A, _pointers(room), timeout=0.3))
    out = ctx.input
    assert "SECRET" not in json.dumps(out)
    assert len(out["items_from_other_agents_data"]) == 3


def test_credential_is_withheld(room):
    s = _post(room["root"], D, f"lead:{B}", "key AKIAABCDEFGHIJKLMNOP here", seq_ts=105)
    inp = secretary.build_input(room["root"], A, [[D, s]])
    assert inp["items"] == [] and inp["withheld"] == 1


# --- brief_for with a fake spawn ----------------------------------------------------

class _Spawn:
    def __init__(self, owner):
        self.owner, self.calls = owner, []

    async def run(self, task, agent, *, silent=False, model=""):
        self.calls.append((agent, model))
        o = self.owner
        o.brief_id = re.search(r"brief_id=(\S+)", task).group(1)
        o.nonce = re.search(r"nonce=(\S+)", task).group(1)
        o.input = staff_server.brief_input_read(o.root, o.brief_id, o.nonce)
        if o.answer is not None:
            async def later():
                await asyncio.sleep(0.05)
                o.submit_result = staff_server.secretary_submit(o.root, o.brief_id, o.nonce,
                                                                o.answer(o))
            asyncio.get_running_loop().create_task(later())
        return "run-1"

    def is_done(self, run_id):
        return False


class _Ctx:
    def __init__(self, root, answer):
        self.root, self.answer, self.brief_id, self.nonce = root, answer, None, None
        self.submit_result = self.input = None
        self.spawn = _Spawn(self)


def test_llm_lane_when_secretary_submits(room):
    ctx = _Ctx(room["root"], answer=lambda o: _valid(room))
    out = asyncio.run(secretary.brief_for(ctx, room["root"], A, _pointers(room), timeout=3))
    assert out["lane"] == "llm", out
    assert ctx.spawn.calls == [("secretary", "claude-haiku-4.5")]
    briefed = [r for r in ledger.read(room["root"], fold.member_file(A)) if r["type"] == "secretary/briefed"]
    assert briefed[-1]["data"]["lane"] == "llm"


def test_timeout_falls_back_to_rules_lane(room):
    ctx = _Ctx(room["root"], answer=None)
    out = asyncio.run(secretary.brief_for(ctx, room["root"], A, _pointers(room), timeout=0.3))
    assert out["lane"] == "rules"
    seqs = sorted(s for g in out["brief"]["groups"] for it in g["items"] for s in it["seqs"])
    assert seqs == sorted([room["main"], room["dup"], room["dm"]])
    # the identical question merged into one line; DM summary is its first line
    lines = {it["summary"] for g in out["brief"]["groups"] for it in g["items"]}
    assert lines == {"Can someone review the API plan?", "Ping about the deploy"}


def test_invalid_submission_refused_and_rules_lane(room):
    bad = lambda o: {**_valid(room), "priority": "high"}  # noqa: E731
    ctx = _Ctx(room["root"], answer=bad)
    out = asyncio.run(secretary.brief_for(ctx, room["root"], A, _pointers(room), timeout=0.5))
    assert ctx.submit_result["reason"] == "invalid"
    assert out["lane"] == "rules"


def test_wrong_nonce_refused(room):
    ctx = _Ctx(room["root"], answer=None)
    asyncio.run(secretary.brief_for(ctx, room["root"], A, _pointers(room), timeout=0.2))
    assert staff_server.brief_input_read(room["root"], ctx.brief_id, "nope") == {"error": "bad_brief_or_nonce"}
    res = staff_server.secretary_submit(room["root"], ctx.brief_id, "nope", _valid(room))
    assert res["reason"] == "bad_brief_or_nonce"
    msg = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
           "params": {"name": "staff_brief_input_read", "arguments": {"brief_id": ctx.brief_id, "nonce": "x"}}}
    assert staff_server._handle(room["root"], msg)["result"]["isError"] is True


def test_stopped_means_rules_without_spawn(room):
    limits.stop(room["root"], "test")
    ctx = _Ctx(room["root"], answer=lambda o: _valid(room))
    out = asyncio.run(secretary.brief_for(ctx, room["root"], A, _pointers(room), timeout=1))
    assert out["lane"] == "rules" and ctx.spawn.calls == []


def test_never_raises(tmp_path):
    broken = tmp_path / "file"
    broken.write_text("not a dir")
    out = asyncio.run(secretary.brief_for(_Ctx(broken, None), broken, A,
                                          [{"channel_id": G, "seq": 1}], timeout=0.1))
    assert out["lane"] == "rules" and out["brief"]["groups"] == []


# --- history pointers (e2e item 8) -------------------------------------------------

_JUDGEMENT = re.compile(r"priority|rank|score|recommend|urgent|action|skip|importan|wake")


def _key_paths(obj, prefix=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield f"{prefix}{k}"
            yield from _key_paths(v, f"{prefix}{k}.")
    elif isinstance(obj, list):
        for v in obj:
            yield from _key_paths(v, prefix)


def test_every_brief_item_carries_history_pointers(room):
    root = room["root"]
    old = _post(root, G, f"lead:{C}", "Can someone review the API plan?", seq_ts=50)
    reply = ledger.append(root, fold.channel_file(G), "message/posted", f"lead:{A}", {
        "msg_id": "mreply000", "thread_id": None, "text": "Reviewed, see notes.", "kind": "reply",
        "mentions": [], "cc": [], "everyone": False, "also_main": False, "reply_to": old,
        "answers": None, "chain": {"root_seq": 0, "hops": 1, "br_resets": 0}}, now=60)
    # same question in a thread A is not in: must never be pointed at
    _post(root, G, f"lead:{B}", "Can someone review the API plan?", thread="T-2", seq_ts=70)

    for answer in (lambda o: _valid(room), None):  # llm lane, then rules lane
        ctx = _Ctx(root, answer=answer)
        out = asyncio.run(secretary.brief_for(ctx, root, A, _pointers(room), timeout=1 if answer else 0.3))
        items = {tuple(it["seqs"]): it for g in out["brief"]["groups"] for it in g["items"]}
        api = items[(room["main"], room["dup"])]["pointers"]
        assert api["seen_before"] == [{"channel_id": G, "seq": old, "ts": 50, "thread_id": None}]
        assert api["answered_before"] == {"channel_id": G, "seq": reply, "ts": 60}
        assert api["repeat_count"] == 3
        assert items[(room["dm"],)]["pointers"] == {"seen_before": [], "answered_before": None,
                                                    "repeat_count": 1, "decided_before": None,
                                                    "rejected_before": None}
        for it in items.values():
            assert set(it) == {"seqs", "summary", "pointers"}
            assert set(it["pointers"]) == secretary.POINTER_KEYS
        paths = set(_key_paths(out["brief"]))
        assert not [p for p in paths if _JUDGEMENT.search(p.split(".")[-1])], paths
        # the audit row holds the same pointers
        briefed = [r for r in ledger.read(root, fold.member_file(A)) if r["type"] == "secretary/briefed"]
        assert briefed[-1]["data"]["brief"]["groups"] == out["brief"]["groups"]


def test_model_cannot_supply_pointers(room):
    forged = _valid(room)
    forged["groups"][0]["items"][0]["pointers"] = {"repeat_count": 99}
    with pytest.raises(secretary.BriefInvalid):
        secretary.parse_brief(forged, _inp(room)["items"])


def test_pointer_lookup_failure_leaves_empty_pointers(room, monkeypatch):
    def boom(*a, **k):
        raise OSError("disk")
    monkeypatch.setattr(pointers, "attach_pointers", boom)
    out = asyncio.run(secretary.brief_for(_Ctx(room["root"], None), room["root"], A,
                                          _pointers(room), timeout=0.2))
    its = [it for g in out["brief"]["groups"] for it in g["items"]]
    assert its and all(it["pointers"] == pointers.empty_pointers() for it in its)


# --- summary language follows the message (e2e item 16) -----------------------------

@pytest.mark.parametrize("text,want", [
    ("Pause PR reruns until the quota resets", "latin"),
    ("暂停 PR 重新运行直到配额重置", "cjk"),
    ("把 session_send 加回 mcpTools", None),   # mixed: never checked
    ("ok", None),                              # too short
])
def test_script_of(text, want):
    assert secretary.script_of(text) == want


def test_wrong_language_summary_falls_back_to_first_line(room):
    """The e2e case: English messages summarized in Chinese. Code puts the first line back."""
    def answer(o):
        brief = _valid(room)
        brief["groups"][1]["items"][0]["summary"] = "暂停 PR 重新运行直到配额重置,然后一次运行一条线。"
        return brief

    ctx = _Ctx(room["root"], answer=answer)
    out = asyncio.run(secretary.brief_for(ctx, room["root"], A, _pointers(room), timeout=3))
    assert out["lane"] == "llm", out
    lines = {it["summary"] for g in out["brief"]["groups"] for it in g["items"]}
    assert lines == {"deploy ping", "Can someone review the API plan?"}
    briefed = [r for r in ledger.read(room["root"], fold.member_file(A)) if r["type"] == "secretary/briefed"]
    assert briefed[-1]["data"]["lang_fixed"] == 1


def test_same_language_summary_is_kept(room):
    zh = _post(room["root"], D, f"lead:{B}", "部署之前先跑一遍集成测试", seq_ts=106)

    def answer(o):
        brief = _valid(room)
        brief["groups"][0]["items"].append({"seqs": [zh], "summary": "部署前先跑集成测试"})
        return brief

    pts = _pointers(room) + [{"channel_id": D, "seq": zh}]
    ctx = _Ctx(room["root"], answer=answer)
    out = asyncio.run(secretary.brief_for(ctx, room["root"], A, pts, timeout=3))
    assert out["lane"] == "llm", out
    lines = {it["summary"] for g in out["brief"]["groups"] for it in g["items"]}
    assert lines == {"deploy ping", "API plan review asked twice", "部署前先跑集成测试"}


def test_system_rows_read_as_english_sentences_not_type_names(tmp_path):
    """e2e round 2: thread/member_added and assignment/opened showed as type names."""
    root = tmp_path / "ledger"
    ledger.append(root, "directory.jsonl", "lead/registered", "owner",
                  {"lead_id": B, "handle": "api-lead", "session_label": "dashboard:b", "kind": "chat"})
    ledger.append(root, fold.channel_file(G), "channel/opened", "owner", {
        "kind": "group", "title": G, "members": [A, B], "people": ["owner"],
        "creator": A, "managers": [], "bar_raiser": "default"})
    s1 = ledger.append(root, fold.channel_file(G), "assignment/opened", "app",
                       {"assignment_id": "A-1", "from": "owner", "to": B, "msg_seq": 0, "thread_id": None})
    s2 = ledger.append(root, fold.channel_file(G), "assignment/declined", f"lead:{B}",
                       {"assignment_id": "A-1", "reason": "out of scope."})
    texts = [i["text"] for i in secretary.build_input(root, B, [[G, s1], [G, s2]])["items"]]
    assert texts[0] == "Owner assigned this to api-lead."
    assert texts[1] == "api-lead declined the assignment: out of scope."
    assert not any("/" in t for t in texts)
    assert fold.system_text({"type": "thread/member_added", "data": {"who": B}}, {B: "api-lead"}) \
        == "api-lead joined the thread."


def test_secretary_and_page_see_handles_not_lead_ids(room):
    # Video round 2: lead ids must not reach the secretary's summaries or the page.
    from teamapp import state

    for lid, handle in ((A, "api-lead"), (B, "ui-lead"), (C, "infra-lead")):
        ledger.append(room["root"], "directory.jsonl", "lead/registered", "owner",
                      {"lead_id": lid, "handle": handle, "session_label": f"chat-{lid}", "kind": "chat"})
    s = _post(room["root"], D, f"lead:{B}", f"{A} please check lead:{B}'s plan", seq_ts=106)
    ctx = _Ctx(room["root"], answer=None)
    asyncio.run(secretary.brief_for(ctx, room["root"], A, [{"channel_id": D, "seq": s}], timeout=0.2))
    [item] = ctx.input["items_from_other_agents_data"]
    assert item["by"] == "ui-lead"
    assert item["text"] == "api-lead please check ui-lead's plan"
    ledger.append(room["root"], fold.member_file(A), "secretary/briefed", "app", {
        "brief_id": "B-00000001", "lane": "llm", "brief": {"schema": secretary.SCHEMA, "groups": [
            {"channel_id": D, "thread_id": None, "items": [{"seqs": [s], "summary": f"{B} asks for review"}]}]}})
    shown = [b for b in state.briefs(room["root"], [A]) if b["brief_id"] == "B-00000001"]
    assert shown[0]["brief"]["groups"][0]["items"][0]["summary"] == "ui-lead asks for review"


def test_page_brief_summary_shows_no_object_ids(room):
    # Video round 2 (S13/S15): the brief panel showed "assign:A-cf8d581f". A summary the model
    # wrote with an assignment/case/message id shows words instead; the ledger keeps the ids.
    from teamapp import state

    ledger.append(room["root"], "directory.jsonl", "lead/registered", "owner",
                  {"lead_id": B, "handle": "ui-lead", "session_label": f"chat-{B}", "kind": "chat"})
    raw = f"{B} took A-cf8d581f; C-0a1b2c3d and M-deadbeef and MT-12345678 are in G-5e1a9c20"
    ledger.append(room["root"], fold.member_file(A), "secretary/briefed", "app", {
        "brief_id": "B-00000002", "lane": "llm", "brief": {"schema": secretary.SCHEMA, "groups": [
            {"channel_id": D, "thread_id": None, "items": [{"seqs": [1], "summary": raw}]}]}})
    [shown] = [b for b in state.briefs(room["root"], [A]) if b["brief_id"] == "B-00000002"]
    summary = shown["brief"]["groups"][0]["items"][0]["summary"]
    assert summary == ("ui-lead took the assignment; the case and a message and the meeting are in the group")
    assert not re.search(r"\b[A-Z]{1,2}-[0-9a-f]{8}\b", summary)
    stored = [r for r in ledger.read(room["root"], fold.member_file(A)) if r["type"] == "secretary/briefed"]
    assert stored[-1]["data"]["brief"]["groups"][0]["items"][0]["summary"] == raw
