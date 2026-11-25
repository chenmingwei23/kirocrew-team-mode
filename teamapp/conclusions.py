"""Room decisions and the rolling summary, folded from explicit ledger rows only.

Two things a room remembers (research x-heli-15 #9 and #14):

* **Decisions.** A decision is an explicit row: a meeting ``outcome/recorded`` of kind
  consensus / vote / bar_raiser_ruling, or a lead's ``decision/recorded`` (tool
  ``team_decide``). Each has a ``topic`` (the structured key) and may name earlier
  decisions it ``supersedes``. Its status is computed here, never by a model:

  - ``superseded``: a later decision named it in ``supersedes``;
  - ``conflict``: another live decision has the same topic and neither supersedes the
    other (changing your mind must say ``supersedes``; the server flags it, a person
    or a lead resolves it with a new decision that supersedes both);
  - ``current``: otherwise.

  A meeting proposal that lost (``proposal/rejected``, written by the meeting planner
  in the same batch as the outcome) is kept with its reason, so a room can see what it
  already turned down.

* **Rolling summary.** One fixed set of sections, each with its own item and character
  cap. A full section is compressed on its own (newest kept, the rest counted as
  ``more``); it never borrows another section's room.

The secretary only carries pointers to these (``pointers.py``); it never decides a
status. Standard library only (imported by the gateway hook and the stdio server).
"""

from __future__ import annotations

import re
import time
from pathlib import Path

from . import fold, identity, ledger, limits

DECIDED_KINDS = ("consensus", "vote", "bar_raiser_ruling")
TOPIC_CHARS = 80
TEXT_CHARS = 600
MAX_SUPERSEDES = 3
LINE_CHARS = 160

# (key, title, max items, max characters over all its lines)
SECTIONS = (
    ("decisions", "Decisions", 6, 900),
    ("waiting", "Waiting for an answer", 6, 600),
    ("stuck", "Stuck", 4, 500),
    ("in_progress", "In progress", 6, 600),
)

_SPACE = re.compile(r"\s+")


def topic_key(topic: object) -> str:
    """The comparable form of a topic: lower case, single spaces."""
    return _SPACE.sub(" ", str(topic or "")).strip().lower()


def _refused(reason: str, **extra) -> dict:
    return {"status": "refused", "reason": reason, **extra}


# =========================================================================== decisions


def _agenda(rows: list[dict]) -> dict:
    """``(meeting_id, item_id) -> agenda item`` from every ``meeting/convened`` row."""
    out = {}
    for r in rows:
        if r.get("type") == "meeting/convened":
            d = r["data"]
            for it in d.get("agenda") or []:
                out[(d["meeting_id"], it["item_id"])] = {**it, "meeting_title": d.get("title", "")}
    return out


def fold_decisions(rows: list[dict]) -> dict:
    """``{"decisions": [...], "rejected": [...]}`` for one channel's rows (pure).

    Each decision: ``{seq, ts, source, topic, text, by, supersedes, status,
    superseded_by, conflict_with, meeting_id, item_id, kind}``. Each rejected
    proposal: ``{seq, ts, topic, text, by, reason, lost_to, objections, meeting_id,
    item_id}``. Both lists are in ledger order.
    """
    agenda = _agenda(rows)
    decisions: dict[int, dict] = {}
    rejected = []
    for r in rows:
        t, d = r.get("type"), r.get("data") or {}
        if t == "outcome/recorded" and d.get("kind") in DECIDED_KINDS:
            item = agenda.get((d.get("meeting_id"), d.get("item_id"))) or {}
            new = {"source": "meeting", "topic": item.get("topic") or item.get("title", ""),
                   "text": str(d.get("text", "")), "by": d.get("by", ""), "kind": d["kind"],
                   "supersedes": [s for s in item.get("supersedes") or [] if isinstance(s, int)],
                   "meeting_id": d.get("meeting_id"), "item_id": d.get("item_id")}
        elif t == "decision/recorded":
            new = {"source": "lead", "topic": d.get("topic", ""), "text": str(d.get("text", "")),
                   "by": fold.actor(r.get("by", "")), "kind": "decision",
                   "supersedes": [s for s in d.get("supersedes") or [] if isinstance(s, int)],
                   "meeting_id": None, "item_id": None, "msg_seq": d.get("msg_seq")}
        elif t == "proposal/rejected":
            item = agenda.get((d.get("meeting_id"), d.get("item_id"))) or {}
            rejected.append({"seq": r["seq"], "ts": r.get("ts", 0), "topic": item.get("topic") or item.get("title", ""),
                             "text": str(d.get("text", "")), "by": d.get("proposed_by"),
                             "reason": d.get("reason", ""), "lost_to": d.get("lost_to", ""),
                             "objections": list(d.get("objections") or []),
                             "meeting_id": d.get("meeting_id"), "item_id": d.get("item_id")})
            continue
        else:
            continue
        new.update(seq=r["seq"], ts=r.get("ts", 0), status="current", superseded_by=None, conflict_with=[])
        for s in new["supersedes"]:
            old = decisions.get(s)
            if old is not None and old["status"] != "superseded":
                old.update(status="superseded", superseded_by=r["seq"], conflict_with=[])
        key = topic_key(new["topic"])
        for old in decisions.values():
            if old["status"] == "superseded" or topic_key(old["topic"]) != key:
                continue
            old["status"] = "conflict"
            old["conflict_with"].append(r["seq"])
            new["status"] = "conflict"
            new["conflict_with"].append(old["seq"])
        # a conflict partner that has since been superseded no longer counts
        for dec in decisions.values():
            if dec["status"] == "conflict":
                dec["conflict_with"] = [c for c in dec["conflict_with"]
                                        if c == r["seq"] or decisions.get(c, {}).get("status") != "superseded"]
                if not dec["conflict_with"]:
                    dec["status"] = "current"
        decisions[r["seq"]] = new
    return {"decisions": list(decisions.values()), "rejected": rejected}


def live(decisions: list[dict]) -> list[dict]:
    return [d for d in decisions if d["status"] != "superseded"]


# =========================================================================== write


def record(root: Path, sender: str, channel_id: str, topic: str, text: str,
           supersedes: list | None = None, now: float | None = None) -> dict:
    """A lead records a decision in a group's main timeline.

    The decision is posted as an ordinary message (so the room sees it and the usual
    rate, hop and wake rules apply) and a ``decision/recorded`` row points at it.
    ``supersedes`` names seqs of earlier decisions in this channel that are not
    already superseded.
    """
    from . import send

    now = time.time() if now is None else now
    if not isinstance(topic, str) or not (1 <= len(topic.strip()) <= TOPIC_CHARS):
        return _refused("bad_topic", limit=f"1-{TOPIC_CHARS} chars")
    if not isinstance(text, str) or not (1 <= len(text.strip()) <= TEXT_CHARS):
        return _refused("bad_text", limit=f"1-{TEXT_CHARS} chars")
    supersedes = [] if supersedes is None else supersedes
    if (not isinstance(supersedes, list) or len(supersedes) > MAX_SUPERSEDES
            or any(not isinstance(s, int) or isinstance(s, bool) for s in supersedes)):
        return _refused("bad_supersedes", limit=f"at most {MAX_SUPERSEDES} decision seqs")
    with ledger.transaction(root):
        if sender not in identity.active_leads(root):
            return _refused("not_a_lead")
        try:
            rows = ledger.read(root, fold.channel_file(channel_id))
        except (ledger.LedgerError, TypeError):
            return _refused("no_such_channel")
        ch = fold.fold_channel(root, channel_id, rows)
        if ch["kind"] != "group":
            return _refused("not_a_group")
        if sender not in ch["members"]:
            return _refused("not_a_member")
        # shortcut: supersedes names seqs in this channel only; switch to (channel_id, seq)
        # pairs when one group's decision must replace another group's.
        table = {d["seq"]: d for d in fold_decisions(rows)["decisions"]}
        for s in supersedes:
            if s not in table:
                return _refused("no_such_decision", seq=s, decisions=sorted(table))
            if table[s]["status"] == "superseded":
                return _refused("already_superseded", seq=s, superseded_by=table[s]["superseded_by"])
        names = fold.handles(root)
        line = f"Decision · {topic.strip()}: {text.strip()}"
        if supersedes:
            line += " (replaces: " + "; ".join(fold.scrub_ids(table[s]["text"], names)[:60]
                                               for s in supersedes) + ")"
        posted = send.post(root, sender, text=line[:limits.MAX_TEXT], channel_id=channel_id, now=now)
        if posted["status"] != "accepted":
            return posted
        seq = ledger.append(root, fold.channel_file(channel_id), "decision/recorded", f"lead:{sender}",
                            {"topic": topic.strip(), "text": text.strip(), "supersedes": supersedes,
                             "msg_seq": posted["seq"]}, now=now)
        status = next(d for d in fold_decisions(ledger.read(root, fold.channel_file(channel_id)))["decisions"]
                      if d["seq"] == seq)
        return {"status": "accepted", "seq": seq, "msg_seq": posted["seq"], "decision_status": status["status"],
                "conflict_with": status["conflict_with"]}


# =========================================================================== rolling summary


def _clip(text: object) -> str:
    s = _SPACE.sub(" ", str(text or "")).strip()
    return s if len(s) <= LINE_CHARS else s[:LINE_CHARS - 1] + "…"


def compress(lines: list[dict], max_items: int, max_chars: int) -> dict:
    """Keep the newest lines that fit both caps; count the rest. Lines come newest first."""
    kept, used = [], 0
    for ln in lines:
        if len(kept) >= max_items or used + len(ln["text"]) > max_chars:
            break
        kept.append(ln)
        used += len(ln["text"])
    return {"items": kept, "more": len(lines) - len(kept)}


def rolling_summary(rows: list[dict], names: dict[str, str] | None = None) -> dict:
    """The room's rolling summary from one channel's rows (pure).

    ``{"covers_seq", "sections": [{key, title, items: [{text, seq, tag}], more, cap}]}``.
    """
    from . import meeting

    names = names or {}
    ch = fold._empty_channel("")
    texts: dict[int, str] = {}
    for r in rows:
        fold._apply(ch, r)
        if r.get("type") == "message/posted":
            texts[r["seq"]] = str((r.get("data") or {}).get("text", ""))

    def nm(who: str) -> str:
        return names.get(who, who) if who != fold.OWNER else "Owner"

    def say(text: object) -> str:
        return _clip(fold.scrub_ids(text, names))

    lines: dict[str, list[dict]] = {k: [] for k, *_ in SECTIONS}
    dec = fold_decisions(rows)["decisions"]
    for d in sorted(live(dec), key=lambda d: (d["status"] != "conflict", -d["seq"])):
        lines["decisions"].append({"seq": d["seq"], "tag": d["status"],
                                   "text": say(f"{d['topic']}: {d['text']}")})
    for a in sorted(ch["assignments"].values(), key=lambda a: -a["msg_seq"]):
        ask = say(texts.get(a["msg_seq"], ""))
        if a["state"] in ("open", "asked"):
            lines["waiting"].append({"seq": a["msg_seq"], "tag": a["state"],
                                     "text": _clip(f"{nm(a['to'])} ← {nm(a['from'])}: {ask}")})
        elif a["state"] == "unanswered":
            lines["stuck"].append({"seq": a["msg_seq"], "tag": "unanswered",
                                   "text": _clip(f"{nm(a['to'])} has not answered {nm(a['from'])}: {ask}")})
        elif a["state"] == "taken":
            lines["in_progress"].append({"seq": a["msg_seq"], "tag": "taken",
                                         "text": _clip(f"{nm(a['to'])}: {ask}")})
    for mid in ch["held"]:
        m = ch["messages"].get(mid)
        if m is not None:
            lines["stuck"].append({"seq": m["seq"], "tag": "held",
                                   "text": _clip(f"Held ({m.get('held_reason') or 'limit'}): {say(texts.get(m['seq']))}")})
    for mid in meeting.meetings_in(rows):
        m = meeting.fold_meeting(rows, mid)
        if m is None or m["state"] not in meeting.LIVE:
            continue
        for iid in m["agenda"]:
            it = m["items"][iid]
            if it["waiting"]:
                lines["stuck"].append({"seq": m["convened_seq"], "tag": "needs_person",
                                       "text": _clip(f"Meeting “{m['title']}” waits on a person: {it['title']}")})
        cur = m["items"].get(m["current"] or "")
        lines["in_progress"].append({"seq": m["convened_seq"], "tag": "meeting",
                                     "text": _clip(f"Meeting “{m['title']}”" + (f" · on {cur['title']}" if cur else ""))})
    sections = []
    for key, title, n, chars in SECTIONS:
        got = sorted(lines[key], key=lambda ln: -ln["seq"]) if key != "decisions" else lines[key]
        sections.append({"key": key, "title": title, **compress(got, n, chars),
                         "cap": {"items": n, "chars": chars}})
    return {"covers_seq": rows[-1]["seq"] if rows else 0, "sections": sections}


# =========================================================================== views


def channel_memory(root: Path, channel_id: str, names: dict[str, str] | None = None,
                   viewer: str = fold.OWNER) -> dict:
    """Decisions, rejected proposals and the rolling summary for one channel, as *viewer* sees it.

    Statuses are computed over every row (a decision superseded in a thread the
    viewer cannot read is still superseded); only rows the viewer can see are listed,
    and the summary is built from those rows alone.
    """
    rows = ledger.read(root, fold.channel_file(channel_id))
    names = fold.handles(root) if names is None else names
    out = fold_decisions(rows)
    if viewer != fold.OWNER:
        ch = fold.fold_channel(root, channel_id, rows)
        by_seq = {r["seq"]: r for r in rows}
        rows = [r for r in rows if fold.visible(r, ch, viewer)]
        out = {k: [d for d in v if fold.visible(by_seq[d["seq"]], ch, viewer)] for k, v in out.items()}
    for d in out["decisions"] + out["rejected"]:
        d["text"] = fold.scrub_ids(d["text"], names)
        d["by_name"] = names.get(d.get("by") or "", "Owner" if d.get("by") == fold.OWNER else "")
    for r in out["rejected"]:
        r["reason"] = fold.scrub_ids(r["reason"], names)
        r["lost_to"] = fold.scrub_ids(r["lost_to"], names)
    return {**out, "summary": rolling_summary(rows, names)}
