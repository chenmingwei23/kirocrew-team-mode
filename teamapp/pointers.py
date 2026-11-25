"""History pointers on brief items, built from the ledger by code (never by a model).

rfc-v5 "Pointers from the Bot's own memory and history". Used by the secretary
(both lanes) and by ``wake._rules_brief`` (the fallback when the secretary is missing
or fails), so every brief item carries the same ``pointers`` object. Each pointer
names ledger rows the lead can open with ``team_thread_read``; none of them ranks or
recommends anything, and no item is dropped whatever its pointers say.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

from . import fold, ledger

POINTERS_KEY = "pointers"
POINTER_KEYS = frozenset({"seen_before", "answered_before", "repeat_count", "decided_before", "rejected_before"})
HISTORY_SECS = 7 * 24 * 3600
SIMILAR = 0.6  # term-set Jaccard at or above this counts as "the same question"
MAX_SEEN = 3
# shortcut: the app cannot read a Bot's own memory store, so every pointer comes from
# the ledger and memory_id is not attached; upgrade when the core secretary (PR-9) lands.
# decided_before / rejected_before match a room decision's explicit topic: every topic
# word appears in the item's text. Status comes from conclusions.fold_decisions.

_WORD = re.compile(r"[0-9a-z_]{2,}")
_CJK = re.compile(r"[\u3400-\u9fff]+")


def _terms(text: str) -> frozenset:
    """Lower-case words plus CJK character bigrams (CJK text has no spaces)."""
    text = (text or "").lower()
    terms = set(_WORD.findall(text))
    for run in _CJK.findall(text):
        terms.update(run[i:i + 2] for i in range(max(1, len(run) - 1)))
    return frozenset(terms)


def _similar(a: frozenset, b: frozenset) -> bool:
    return bool(a and b) and len(a & b) / len(a | b) >= SIMILAR


def _history(root: Path, lead_id: str, since: float) -> tuple[list[dict], dict]:
    """Messages *lead_id* can see since *since*, and the lead's own replies by target.

    Returns ``(rows, replies)``: rows are ``{channel_id, thread_id, seq, ts, by, terms}``;
    ``replies[(channel_id, seq)]`` is the lead's newest reply row to that seq.
    """
    rows, replies, me = [], {}, f"lead:{lead_id}"
    for cid in fold.list_channels(root):
        channel_rows = ledger.read(root, fold.channel_file(cid))
        channel = fold.fold_channel(root, cid, channel_rows)
        posted = {r["data"].get("msg_id"): r for r in channel_rows
                  if r.get("type") == "message/posted"}
        for row in channel_rows:
            if row.get("type") not in ("message/posted", "message/released"):
                continue
            if row.get("ts", 0) < since or not fold.visible(row, channel, lead_id):
                continue
            src = posted.get(row["data"].get("msg_id")) if row["type"] == "message/released" else row
            data = (src or row).get("data") or {}
            entry = {"channel_id": cid, "thread_id": fold._entry_thread(row, channel),
                     "seq": row["seq"], "ts": row.get("ts", 0), "by": (src or row).get("by")}
            if entry["by"] == me:
                if isinstance(data.get("reply_to"), int):
                    replies[(cid, data["reply_to"])] = entry
                continue
            rows.append({**entry, "terms": _terms(str(data.get("text") or ""))})
    return rows, replies


def _ref(entry: dict, *, thread: bool = True) -> dict:
    out = {"channel_id": entry["channel_id"], "seq": entry["seq"], "ts": entry["ts"]}
    if thread:
        out["thread_id"] = entry["thread_id"]
    return out


def empty_pointers() -> dict:
    return {"seen_before": [], "answered_before": None, "repeat_count": 0,
            "decided_before": None, "rejected_before": None}


def _room_memory(root: Path, lead_id: str) -> tuple[list[dict], list[dict]]:
    """Live decisions and rejected proposals this lead can see, each with its channel and topic terms."""
    from . import conclusions

    decided, rejected = [], []
    for cid in fold.list_channels(root):
        if not cid.startswith("G-"):
            continue
        mem = conclusions.channel_memory(root, cid, names={}, viewer=lead_id)
        for d in conclusions.live(mem["decisions"]):
            decided.append({**d, "channel_id": cid, "terms": _terms(d["topic"])})
        for r in mem["rejected"]:
            rejected.append({**r, "channel_id": cid, "terms": _terms(r["topic"])})
    return decided, rejected


def _topic_match(rows: list[dict], terms: frozenset) -> dict | None:
    hits = [r for r in rows if r["terms"] and r["terms"] <= terms]
    return max(hits, key=lambda r: (r["ts"], r["seq"])) if hits else None


def attach_pointers(root: Path, lead_id: str, brief: dict, input_items: list[dict]) -> dict:
    """Return *brief* with ``pointers`` on every item.

    *input_items* are ``{channel_id, seq, ts, text}`` for every seq in the brief.

    - ``seen_before``: up to 3 earlier near-identical messages this lead can see that
      are not in this brief (newest first), each a ``(channel_id, thread_id, seq)``
      pointer to the original row.
    - ``answered_before``: the lead's own newest reply to any of those messages.
    - ``repeat_count``: near-identical messages from others in the last 7 days,
      this item's own seqs included.
    """
    text = {(i["channel_id"], i["seq"]): i for i in input_items}
    in_brief = set(text)
    newest = max((i.get("ts", 0) for i in input_items), default=time.time())
    history, replies = _history(root, lead_id, newest - HISTORY_SECS)
    decided, rejected = _room_memory(root, lead_id)
    groups = []
    for g in brief.get("groups", []):
        items = []
        for it in g["items"]:
            own = [text[(g["channel_id"], s)] for s in it["seqs"] if (g["channel_id"], s) in text]
            terms = frozenset().union(*(_terms(i["text"]) for i in own)) if own else frozenset()
            first_ts = min((i.get("ts", 0) for i in own), default=newest)
            same = [h for h in history if _similar(terms, h["terms"])]
            seen = sorted((h for h in same if (h["channel_id"], h["seq"]) not in in_brief
                           and h["ts"] <= first_ts), key=lambda h: -h["ts"])
            answers = [replies[(h["channel_id"], h["seq"])] for h in same
                       if (h["channel_id"], h["seq"]) in replies]
            answered = max(answers, key=lambda r: r["ts"]) if answers else None
            dec = _topic_match(decided, terms)
            rej = _topic_match(rejected, terms)
            items.append({**it, POINTERS_KEY: {
                "seen_before": [_ref(h) for h in seen[:MAX_SEEN]],
                "answered_before": _ref(answered, thread=False) if answered else None,
                "repeat_count": max(len(same), len(it["seqs"])),
                "decided_before": {**_ref(dec, thread=False), "topic": dec["topic"], "status": dec["status"]}
                if dec else None,
                "rejected_before": {**_ref(rej, thread=False), "topic": rej["topic"]} if rej else None,
            }})
        groups.append({**g, "items": items})
    return {**brief, "groups": groups}


def with_empty(brief: dict) -> dict:
    return {**brief, "groups": [
        {**g, "items": [{**it, POINTERS_KEY: empty_pointers()} for it in g["items"]]}
        for g in brief.get("groups", [])]}


def with_pointers(root: Path, lead_id: str, brief: dict, input_items: list[dict]) -> dict:
    """:func:`attach_pointers`; a failed lookup leaves every item's pointers empty."""
    try:
        return attach_pointers(root, lead_id, brief, input_items)
    except Exception:  # noqa: BLE001 -- a lookup failure must not cost the brief
        return with_empty(brief)
