"""The owner page's ``GET /state`` body (shape fixed by ui-src/fixtures/state-13-quota.json).

Owner view: every channel, thread, DM and held message. ``cursor`` is
``"<channel_id>:<seq>,..."``; with ``since=<cursor>`` only rows newer than the cursor
come back in ``entries``, every other key is whole (the page replaces them).
"""

from __future__ import annotations

import re
import time
from pathlib import Path

from . import bar_raiser, conclusions, decisions, fold, ledger, lifecycle, limits, meeting, models, wake

CASES = "cases.jsonl"
_CURSOR_RE = re.compile(r"^[GD]-[0-9a-f]{8}:\d{1,9}$")


def parse_cursor(cursor: str | None) -> dict[str, int]:
    out: dict[str, int] = {}
    for part in (cursor or "").split(","):
        if _CURSOR_RE.match(part):
            cid, seq = part.split(":")
            out[cid] = int(seq)
    return out


def _owner_unread(channel: dict) -> int:
    """Lead messages after the owner's own last post in that channel.

    shortcut: the page has no read marker for the owner; upgrade to an
    ``owner/viewed`` row when the page wants real unread counts.
    """
    msgs = sorted(channel["messages"].values(), key=lambda m: m["seq"])
    last_owner = max((m["seq"] for m in msgs if m["by"] == fold.OWNER), default=0)
    return sum(1 for m in msgs if m["seq"] > last_owner and m["by"].startswith("L-"))


def cases(root: Path, now: float | None = None) -> list[dict]:
    """Every case for the page. Model-written text shows lead handles, never lead ids;
    ``cases.jsonl`` keeps what the model wrote."""
    names = fold.handles(root)
    labels: dict[str, dict[int, str]] = {}
    out: dict[str, dict] = {}
    for row in ledger.read(root, CASES):
        d, t = row["data"], row["type"]
        cid = d.get("case_id")
        if t == "bar_raiser/summoned":
            out[cid] = {"case_id": cid, "seq": row["seq"], "ts": row["ts"],
                        "channel_id": d.get("channel_id"), "thread_id": d.get("thread_id"),
                        "root_seq": d.get("root_seq"), "triggers": list(d.get("triggers", [])),
                        "continues_left": d.get("continues_left"), "deadline": d.get("deadline"),
                        "model": d.get("model"), "acted": None, "defaulted": None, "applied": False,
                        "called_person": None, "answer": None, "lapsed": False}
            continue
        c = out.get(cid)
        if c is None:
            continue
        if t == "bar_raiser/joined" and d.get("trigger"):
            c["triggers"].append(d["trigger"])
        elif t == "bar_raiser/acted":
            # round5 S42: a 'seq 14' the model wrote reads as 'Ada at 16:03' on the page
            if c["channel_id"] not in labels:
                labels[c["channel_id"]] = bar_raiser.seq_labels(root, c["channel_id"])
            lab = labels[c["channel_id"]]
            args = d.get("args")
            if isinstance(args, dict):
                args = {k: bar_raiser.readable(meeting.readable_ids(fold.scrub_ids(v, names)), lab)
                        for k, v in args.items()}
            c["acted"] = {"action": d.get("action"), "args": args,
                          # a meeting ruling's rationale names proposals as people read them (F-MS2)
                          "rationale": bar_raiser.readable(
                              meeting.readable_ids(fold.scrub_ids(d.get("rationale"), names)), lab),
                          "evidence_seqs": d.get("evidence_seqs")}
        elif t == "bar_raiser/defaulted":
            c["defaulted"] = {k: v for k, v in d.items() if k != "case_id"}
        elif t == "bar_raiser/applied":
            c["applied"] = True
        elif t == "bar_raiser/called_person":
            card = d.get("card")
            c["called_person"] = {"class": d.get("class"),
                                  "question": bar_raiser.readable(fold.scrub_ids(d.get("question"), names),
                                                                  labels.setdefault(c["channel_id"],
                                                                                    bar_raiser.seq_labels(root, c["channel_id"]))),
                                  # card_hash is what the page sends back: an approval binds to it
                                  "card": card, "card_hash": (d.get("binding") or {}).get("hash"),
                                  "standing": bool(d.get("standing_seq"))}
        elif t == "bar_raiser/answered":
            c["answer"] = {"text": d.get("text", ""), "decision": d.get("decision", "change"),
                           "standing": d.get("standing"), "ts": row["ts"], "seq": row["seq"]}
        elif t == "bar_raiser/card_lapsed":
            c["lapsed"] = True
    st = bar_raiser.cases_state(root)
    sources: dict[str, dict[int, str]] = {}
    for cid, c in out.items():
        cp = c["called_person"]
        if cp and cp.get("card") and not c["answer"] and not c.get("lapsed") and not cp["standing"]:
            cp["void"] = bar_raiser.card_void(st, cid, cp["card_hash"],
                                              time.time() if now is None else now)  # None = may answer
        if c["acted"]:
            if c["channel_id"] not in sources:
                sources[c["channel_id"]] = evidence_sources(root, c["channel_id"])
            src = sources[c["channel_id"]]
            c["acted"]["evidence"] = [{"seq": s, "source": src.get(s, "record")}
                                      for s in (c["acted"].get("evidence_seqs") or [])]
    return sorted(out.values(), key=lambda c: c["seq"])


def evidence_sources(root: Path, channel_id: str) -> dict[int, str]:
    """``seq -> record | owner | party_claim`` for one room (for the page's evidence chips)."""
    from . import approval
    return approval.classify_rows(ledger.read(root, fold.channel_file(channel_id)), lambda r: 1)


# Object ids a model may copy into a summary (A-/C-/M-/MT-/G-/D- + hex), as the words a person reads.
_OBJ_ID_RE = re.compile(r"\b(A|C|M|MT|G|D)-[0-9a-f]{8}\b")
_OBJ_WORD = {"A": "the assignment", "C": "the case", "M": "a message", "MT": "the meeting",
             "G": "the group", "D": "the DM"}


def _brief_text(text: object, names: dict[str, str]) -> object:
    """Brief summary as shown: lead ids -> handles, other object ids -> plain words (video round 2, S13/S15)."""
    text = fold.scrub_ids(text, names)
    return _OBJ_ID_RE.sub(lambda m: _OBJ_WORD[m.group(1)], text) if isinstance(text, str) else text


def _scrub_brief(brief: object, names: dict[str, str]) -> object:
    """A brief with every item summary showing handles and words instead of ids."""
    if not isinstance(brief, dict) or not isinstance(brief.get("groups"), list):
        return brief
    groups = []
    for g in brief["groups"]:
        if isinstance(g, dict) and isinstance(g.get("items"), list):
            g = {**g, "items": [{**it, "summary": _brief_text(it.get("summary"), names)}
                                if isinstance(it, dict) else it for it in g["items"]]}
        groups.append(g)
    return {**brief, "groups": groups}


def briefs(root: Path, leads: list[str]) -> list[dict]:
    names = fold.handles(root)
    out = []
    for lead_id in leads:
        m = fold.fold_member(root, lead_id)
        reasons = {d.get("brief_id"): d.get("reasons", []) for d in m["dues"]}
        for bid, b in m["briefs"].items():
            out.append({"lead_id": lead_id, "brief_id": bid, "lane": b.get("lane"), "ts": b["ts"],
                        "reasons": reasons.get(bid, []),
                        "fallback_reason": b.get("error") if b.get("lane") == "rules" else None,
                        "brief": _scrub_brief(b.get("brief"), names)})
    return sorted(out, key=lambda b: b["ts"])


def budget(root: Path, now: float) -> dict:
    rows = ledger.read(root, limits.CONTROL)
    u = limits.usage(root, now, rows)
    c = u["caps"]
    eff = limits.effective_caps(rows)
    return {
        "deliveries": {"used": u["totals"]["wake"], "cap": c["total_wakes"]},
        "wakes_hour": {"used": u["hour"]["wake"], "cap": c["hourly"]["wake"]},
        "lead_wakes_hour": {**u["per_lead_hour"], "cap": c["wakes_per_lead_hour"]},
        "secretary_hour": {"used": u["hour"]["secretary"], "cap": c["hourly"]["secretary"]},
        "cases_hour": {"used": u["hour"]["bar_raiser"], "cap": c["hourly"]["bar_raiser"]},
        "messages_hour": {"used": u["hour"]["message"], "cap": c["hourly"]["message"]},
        "tokens_est": {"total": u["totals"]["tokens"], "cap": c["total_tokens_est"],
                       "hot": u["hot_wakes"], "cold": u["cold_wakes"],
                       "hot_each": limits.HOT_WAKE_TOKENS, "cold_each": limits.COLD_WAKE_TOKENS},
        "limits": {"caps": eff["caps"], "asked": eff["asked"], "clamped": eff["clamped"], "hard": eff["hard"]},
        "owner_away": {"paused_since": limits.batch_paused_since(rows),
                       "after_secs": eff["caps"]["owner_away_secs"],
                       "last_pause": _last_pause(rows)},
    }


def _last_pause(rows: list[dict]) -> dict | None:
    """The newest finished batch pause, ``{from, to}``, for the page's "while you were away" line."""
    out, start = None, None
    for row in rows:
        if row["type"] == "wake/batch_paused":
            start = row["ts"]
        elif row["type"] == "wake/batch_resumed" and start is not None:
            out, start = {"from": start, "to": row["ts"]}, None
    return out


def build(root: Path, since: str | None = None, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    after = parse_cursor(since)
    d = fold.directory(root)
    channels, entries, cursor, folds = [], {}, [], {}
    for cid in fold.list_channels(root):
        view = fold.channel_view(root, cid, fold.OWNER, since_seq=after.get(cid, 0))
        ch = fold.fold_channel(root, cid)
        meta = dict(view["channel"])
        meta.update(unread=_owner_unread(ch), stubs=view["stubs"], held=view["held"],
                    closed=bool(ch.get("closed")), thread_titles=fold.thread_titles(root, cid),
                    shared=bool(ch.get("shared")), mirror=ledger.is_mirror(root, fold.channel_file(cid)))
        if ch["kind"] == "group" and not ch.get("closed"):
            meta["close_check"] = lifecycle.close_blockers(root, cid)
        channels.append(meta)
        entries[cid] = view["entries"]
        cursor.append(f"{cid}:{ch['seq']}")
        folds[cid] = ch
    stopped = limits.stopped(root)
    return {
        "cursor": ",".join(cursor), "now": now, "stopped": stopped,
        "stop_reason": (limits.stop_reason(root) or None) if stopped else None,
        "leads": sorted(d["leads"].values(), key=lambda l: l["registered_ts"]),
        "channels": channels, "entries": entries, "cases": cases(root, now),
        "briefs": briefs(root, list(d["leads"])), "budget": budget(root, now),
        "meetings": meeting.summaries(root), "decisions": decisions.listing(root),
        "assignments": assignments(root, folds, now),
        "memory": {cid: conclusions.channel_memory(root, cid) for cid in fold.list_channels(root)
                   if cid.startswith("G-")},
        "models": {**models.config(ledger.read(root, limits.CONTROL)), "intents": list(models.INTENTS)},
    }


def assignments(root: Path, folds: dict[str, dict], now: float) -> list[dict]:
    """Every assignment with :func:`wake.assignment_due` applied: the one "@-ed and not
    answered" rule, so the page and the Leads now card never re-derive it."""
    members: dict[str, dict] = {}
    out = []
    for cid, ch in folds.items():
        for aid, a in ch["assignments"].items():
            delivered: list[float] = []
            if a["state"] == "open":
                m = members.setdefault(a["to"], fold.fold_member(root, a["to"]))
                seqs = [d["seq"] for d in m["dues"]
                        if any(r in (f"assign:{aid}", f"rewake:{aid}") for r in d.get("reasons", []))]
                delivered = [m["delivered_ts"][s] for s in seqs if s in m["delivered_ts"]]
            out.append({"channel_id": cid, "assignment_id": aid, "from": a["from"], "to": a["to"],
                        "thread_id": a["thread_id"], "msg_seq": a["msg_seq"], "state": a["state"],
                        "opened_ts": a["opened_ts"], "updated_ts": a["updated_ts"],
                        "empty": bool(a.get("empty")), **wake.assignment_due(a, now, delivered)})
    return out


DECISIONS = ("approve", "change", "no")


def answer_case(root: Path, case_id: str, decision: object, card_hash: object, text: object = None,
                standing: object = None, now: float | None = None) -> dict:
    """Owner answers a person card, once, bound to the exact card version they saw.

    ``approve`` posts "Approved: <what>"; ``change`` posts the owner's text; ``no`` posts
    "No: <what>" and runs the card's frozen ``if_no``. A changed card (``card_hash``
    differs), a newer attempt on the same chain, an expired card or a second answer is
    refused. ``standing`` ({"hours": n}) lets the same ``if_no`` run without asking for
    this room and class; it is only accepted for stop-or-hold actions.
    """
    from . import approval, send

    now = time.time() if now is None else now
    if decision not in DECISIONS:
        return {"status": "refused", "reason": "bad_decision"}
    if text is not None and (not isinstance(text, str) or len(text) > limits.MAX_TEXT):
        return {"status": "refused", "reason": "bad_text"}
    text = (text or "").strip()
    if decision == "change" and not text:
        return {"status": "refused", "reason": "bad_text"}
    with ledger.transaction(root):
        st = bar_raiser.cases_state(root)
        case = st.get(case_id)
        if case is None:
            return {"status": "refused", "reason": "no_such_case"}
        void = bar_raiser.card_void(st, case_id, card_hash, now)
        if void:
            return {"status": "refused", "reason": void}
        s, card = case["summoned"], case["called"]["card"]
        grant = None
        if standing is not None:
            hours = standing.get("hours") if isinstance(standing, dict) else None
            err = approval.standing_error([card["if_no"]], hours)
            if err or decision == "change":
                return {"status": "refused", "reason": "bad_standing", "error": err or "not with change"}
            grant = {"channel_id": s["channel_id"], "class": card["class"], "actions": [card["if_no"]],
                     "expires": now + float(hours) * 3600, "case_id": case_id}
        what = card["what"].rstrip(".")
        words = {"approve": f"Approved: {what}", "no": f"No: {what}", "change": ""}[decision]
        body = " ".join(x for x in (words + ("." if words else ""), text) if x)
        meeting_no = decision == "no" and bar_raiser.is_meeting_case(s)
        posted = None
        if not meeting_no:
            # a meeting's "no" is not a person's word (that would buy an extra round): it runs if_no
            posted = send.post(root, fold.OWNER, text=body[:limits.MAX_TEXT], channel_id=s["channel_id"],
                               thread=s["thread_id"] or "main", now=now)
        rows = []
        if decision == "no":
            # after the owner's post, so a close stays closed (an owner post reopens a chain)
            rows += bar_raiser.if_no_rows(root, case_id, s, card, "the owner said no")
        rows.append((CASES, "bar_raiser/answered", "owner",
                     {"case_id": case_id, "decision": decision, "text": text, "card_hash": card_hash,
                      "binding": case["called"]["binding"], "standing": grant}))
        if grant:
            rows.append((CASES, bar_raiser.STANDING, "owner", grant))
        seqs = ledger.append_many(root, rows, now=now)
        return {"status": "accepted", "seq": seqs[-1], "post": posted}
