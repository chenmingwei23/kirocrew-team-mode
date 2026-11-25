"""Decisions waiting on the owner: one kind of record for every place the app calls a person.

Today two places wait on the owner:

* a bar raiser case that chose ``call_person`` (``cases.jsonl`` ``bar_raiser/called_person``);
* an owner ``@`` that the lead answered with ``ask`` (channel ``assignment/asked``).

Each one gets a ``decision/opened`` row in ``decisions.jsonl`` written in the same
append as the row that starts the wait. The owner closes it with ``decision/answered``
or ``decision/skipped``; a skip counts as "No" and is posted as the owner's answer.
A wait that ends without the owner (the lead took or declined on its own) is
``withdrawn``. Keys match the page's ``waitingOnYou``: ``case:<case_id>`` and
``ask:<channel_id>:<assignment_id>``.

Other kinds (``meeting_item``, later ``mention``) need no code here: a module that
opens a wait appends ``decision/opened`` with the fields in ``OPENED_FIELDS`` and,
when it ends, ``decision/answered`` or ``decision/skipped`` (``reason`` says why,
e.g. ``deferred``) for the same key. A closing row always wins over what a source
ledger says, so a case answered in a meeting box (``case.answer`` still empty) leaves
the queue once that box writes ``decision/answered`` for ``case:<case_id>``.
"""

from __future__ import annotations

from pathlib import Path

from . import fold, ledger, limits

FILE = "decisions.jsonl"
SKIP_TEXT = "No. (Skipped in Needs you, which counts as No.)"
# Higher impact first: bar_raiser.PERSON_CLASSES ordered by what is hardest to undo,
# then a lead's question about the owner's own @. Same order as needsYou.js IMPACT.
IMPACT = {"irreversible": 0, "spend": 1, "security": 2, "exhausted": 3, "requested": 4, "ask": 5}


#: Kinds the page knows how to word; any other kind still counts and is shown plainly.
KINDS = ("case", "ask", "meeting_item", "mention")
#: ``decision/opened`` data: key and kind required; the rest optional. ``ref`` holds the
#: kind's own ids (e.g. ``{"meeting_id", "item_id"}``) and is never shown to people.
OPENED_FIELDS = ("key", "kind", "impact", "channel_id", "thread_id", "question", "ref")
#: Rows that end a wait. ``withdrawn``: it ended without the owner (a meeting adjourned
#: or ran out of time); the first closing row for a key wins.
CLOSING = ("decision/answered", "decision/skipped", "decision/withdrawn")
#: Kinds the owner answers from the Needs you card; others are answered where they live.
ANSWER_HERE = ("case", "ask")


def case_key(case_id: str) -> str:
    return f"case:{case_id}"


def ask_key(channel_id: str, assignment_id: str) -> str:
    return f"ask:{channel_id}:{assignment_id}"


def opened_row(key: str, kind: str, **ref) -> tuple[str, str, str, dict]:
    """The ``decision/opened`` row to append next to the row that starts the wait."""
    return (FILE, "decision/opened", "app", {"key": key, "kind": kind, **ref})


def fold_decisions(rows: list[dict], sources: list[dict]) -> list[dict]:
    """Pure fold: ``sources`` (every wait the ledgers show, open or not) + ``decisions.jsonl``.

    A source is ``{key, kind, ts, open, answered_text?, ...}``: ``open`` is whether its
    own ledger still waits on the owner, ``answered_text`` is an answer that ledger
    already holds (a case answered before decision rows existed). A source with no
    ``decision/opened`` row (written before this file existed) still counts.
    """
    opened: dict[str, dict] = {}
    closed: dict[str, dict] = {}
    for r in rows:
        d = r.get("data") or {}
        k = d.get("key")
        if r.get("type") == "decision/opened" and isinstance(k, str) and k not in opened:
            opened[k] = {"ts": r["ts"], "seq": r["seq"], "data": d}
        elif r.get("type") in CLOSING and k not in closed:
            closed[k] = {"state": r["type"].split("/", 1)[1], "text": d.get("text", ""), "ts": r["ts"],
                         "reason": d.get("reason", "")}
    known = {s["key"] for s in sources}
    # A kind with no source fold here (meeting_item, mention, ...) is its opened row.
    sources = list(sources) + [
        {"kind": "other", "ts": o["ts"], "open": True,
         **{f: o["data"][f] for f in OPENED_FIELDS if f in o["data"]}}
        for k, o in opened.items() if k not in known]
    out = []
    for s in sources:
        k = s["key"]
        o = opened.get(k)
        c = closed.get(k)
        if c is not None:
            st, answer = c["state"], {"text": c["text"], "ts": c["ts"], "reason": c["reason"]}
        elif s.get("answered_text") is not None:
            st, answer = "answered", {"text": s["answered_text"], "ts": s.get("answered_ts")}
        elif s["open"]:
            st, answer = "open", None
        else:
            st, answer = "withdrawn", None
        out.append({**{k2: v for k2, v in s.items() if k2 not in ("open", "answered_text", "answered_ts")},
                    "opened_ts": o["ts"] if o else s["ts"], "state": st, "answer": answer})
    return sort_by_impact(out)


def sort_by_impact(items: list[dict]) -> list[dict]:
    """Open first; then higher impact; then the one waiting longest."""
    return sorted(items, key=lambda d: (d["state"] != "open", IMPACT.get(d.get("impact"), 9), d["opened_ts"]))


def dm_key(channel_id: str, seq: int) -> str:
    return f"dm:{channel_id}:{seq}"


def dm_asks(cid: str, ch: dict, rows: list[dict], names: dict[str, str]) -> list[dict]:
    """A lead's DM to the owner waits on the owner until the owner posts in that DM.

    Kind ``ask`` (answered from Needs you, which replies in the DM); ``via: "dm"``. One wait
    per run of lead posts: it starts at the first delivered lead post after the owner's
    last post. A notice (brief only) or a held post does not start one."""
    out: list[dict] = []
    cur = None
    for r in rows:
        if r["type"] != "message/posted":
            continue
        d = r["data"]
        if r["by"] == fold.OWNER:
            if cur is not None:
                out.append({**cur, "open": False, "answered_text": d.get("text", ""), "answered_ts": r["ts"]})
                cur = None
            continue
        m = ch["messages"].get(d.get("msg_id"))
        if cur is None and str(r["by"]).startswith("lead:") and m is not None and not m["held"] \
                and d.get("kind") != "notice":
            cur = {"key": dm_key(cid, r["seq"]), "kind": "ask", "impact": "ask", "via": "dm",
                   "ts": r["ts"], "channel_id": cid, "thread_id": None, "lead": fold.actor(r["by"]),
                   "ask_seq": r["seq"], "question": fold.scrub_ids(d.get("text", ""), names), "open": True}
    if cur is not None:
        out.append(cur)
    return out


def _sources(root: Path) -> list[dict]:
    from . import bar_raiser, meeting, state

    names = fold.handles(root)
    out = []
    for c in state.cases(root):
        cp = c.get("called_person")
        if not cp:
            continue
        mt = bar_raiser._meeting_of(c)
        out.append({"key": case_key(c["case_id"]), "kind": "case", "impact": cp.get("class"),
                    "meeting_id": mt.get("meeting_id"), "item_id": mt.get("item_id"),
                    "ts": c["ts"], "channel_id": c["channel_id"], "thread_id": c["thread_id"],
                    "question": cp.get("question") or "", "card_hash": cp.get("card_hash"),
                    # a lapsed, replaced or standing-answered card no longer waits on the owner
                    "open": c["answer"] is None and not c.get("lapsed") and not cp.get("standing")
                    and not cp.get("void"),
                    "answered_text": c["answer"]["text"] if c["answer"] else None,
                    "answered_ts": c["answer"]["ts"] if c["answer"] else None})
    for cid in fold.list_channels(root):
        rows = ledger.read(root, fold.channel_file(cid))
        ch = fold.fold_channel(root, cid, rows)
        for a in ch["assignments"].values():
            if a["from"] != fold.OWNER:
                continue
            ask = next((r for r in reversed(rows) if r["type"] == "message/posted"
                        and ((r["data"].get("answers") or {}).get("assignment_id") == a["assignment_id"])
                        and (r["data"].get("answers") or {}).get("response") == "ask"), None)
            if ask is None:
                continue
            out.append({"key": ask_key(cid, a["assignment_id"]), "kind": "ask", "impact": "ask",
                        "ts": ask["ts"], "channel_id": cid, "thread_id": a["thread_id"],
                        "lead": a["to"], "ask_seq": ask["seq"],
                        "question": fold.scrub_ids(ask["data"].get("text", ""), names),
                        "open": a["state"] == "asked"})
        if ch["kind"] == "dm" and fold.OWNER in ch["people"]:
            out += dm_asks(cid, ch, rows, names)
    # Meeting items waiting on a person (feat/team-mode-app-r2-mtg); absent on older bases.
    meeting_sources = getattr(meeting, "decision_sources", None)
    if meeting_sources is not None:
        out += meeting_sources(root)
    return out


def listing(root: Path) -> list[dict]:
    """Every decision for ``GET /state``; open ones first, highest impact first."""
    return fold_decisions(ledger.read(root, FILE), _sources(root))


def answer(root: Path, key: str, text: str | None, *, skip: bool = False, card_hash: object = None,
           decision: object = None, standing: object = None) -> dict:
    """Owner answers (or skips = says No to) one open decision; post it where the wait is.

    A case answer goes through ``state.answer_case`` and so is bound to ``card_hash``."""
    from . import send, state

    own = text if isinstance(text, str) and text.strip() and not skip else None
    if skip:
        text = SKIP_TEXT
    elif decision in ("approve", "no") and own is None:
        text = {"approve": "Approved.", "no": "No."}[decision]  # the case post words it from the card
    if not isinstance(text, str) or not text.strip() or len(text) > limits.MAX_TEXT:
        return {"status": "refused", "reason": "bad_text"}
    with ledger.transaction(root):
        if limits.stopped(root):
            return {"status": "refused", "reason": "stopped"}
        d = next((x for x in listing(root) if x["key"] == key), None)
        if d is None:
            return {"status": "refused", "reason": "no_such_decision"}
        if d["state"] != "open":
            return {"status": "refused", "reason": f"already_{d['state']}"}
        if d["kind"] not in ANSWER_HERE:
            return {"status": "refused", "reason": "answer_where_asked"}  # e.g. in the meeting box
        if d["kind"] == "case":
            # bound to the card version the owner saw (W-BR): skip = "no", text = "change"
            # unless the page names the decision; no card_hash from the page = refused
            how = "no" if skip else decision if decision in ("approve", "change", "no") else "change"
            res = state.answer_case(root, key.split(":", 1)[1], how, card_hash, own, standing)
        else:
            res = send.post(root, fold.OWNER, text=text, channel_id=d["channel_id"],
                            thread=d["thread_id"] or "main", reply_to=d["ask_seq"])
            res = {"status": res["status"], "post": res} if res.get("status") in ("accepted", "held") else res
        if res.get("status") not in ("accepted", "held"):
            return res
        seq = ledger.append(root, FILE, "decision/skipped" if skip else "decision/answered", "owner",
                            {"key": key, "text": text})
        return {"status": "accepted", "seq": seq, "state": "skipped" if skip else "answered"}
