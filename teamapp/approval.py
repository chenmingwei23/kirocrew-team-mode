"""Rules for approvals and verdicts. Pure functions: no ledger, no clock.

Learned from the X-thread study (``research/x-heli-15/summary`` items 1, 2, 4, 5, 13):

* An approval is bound to ``(seq, content hash, attempt)``. Changed content, a new
  attempt, an expired card or a second use voids it (:func:`bind`, :func:`void_reason`).
  The same binding is stored on an ``@`` take and on a bar raiser ruling.
* A person card has fixed fields (:func:`person_card`). A standing approval may only
  cover actions that stop or undo (:data:`REDUCE_ONLY`, :func:`standing_error`,
  :func:`standing_covers`).
* A verdict needs evidence that is not only the parties' own words
  (:func:`classify_rows`, :func:`evidence_error`). "Cannot judge" (``hold``) and
  "fails" (``veto``) are separate actions.
* ``veto`` and ``rule`` carry fixed templates (:func:`veto_error`, :func:`ruling_error`).
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

#: Actions a standing approval or an ``if_no`` may take. Each one only stops or holds
#: work; none releases a held message, spends, or widens anything.
REDUCE_ONLY = ("close_thread", "hold", "defer")
STANDING_MAX_HOURS = 24
#: App rows a verdict may cite as a record (written by the gateway, not by a lead).
RECORD_TYPES = (
    "message/held", "message/released", "channel/cooling", "chain/reset", "chain/closed",
    "assignment/opened", "assignment/taken", "assignment/declined", "assignment/asked",
    "assignment/unanswered", "ballot/opened", "ballot/closed", "outcome/recorded",
    "meeting/bar_raiser_needed", "alert/backstop",
)
TEXT_MAX = 500


def content_hash(content: Any) -> str:
    """sha256 of *content* as canonical JSON (sorted keys, no spaces)."""
    raw = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def bind(seq: int, content: Any, attempt: int, expires: float | None = None) -> dict:
    """What an approval (or a take, or a ruling) is bound to."""
    return {"seq": int(seq), "hash": content_hash(content), "attempt": int(attempt), "expires": expires}


def void_reason(binding: dict, *, seq: int, content_sha: str, attempt: int, now: float,
                used: bool = False) -> str | None:
    """``None`` while *binding* still holds for this exact item; else why it is void."""
    if used:
        return "already_used"
    if binding.get("seq") != seq:
        return "other_item"
    if binding.get("hash") != content_sha:
        return "changed"
    if binding.get("attempt") != attempt:
        return "new_attempt"
    exp = binding.get("expires")
    if exp is not None and now >= exp:
        return "expired"
    return None


# --- person card (item 2) ------------------------------------------------------------

CARD_FIELDS = ("what", "who", "cost", "reversible", "attempt", "tried", "expires",
               "class", "question", "if_no")


def person_card(args: dict, *, who: str, attempt: int, tried: list[str], expires: float) -> dict:
    """The fixed-field card a person sees. ``who``/``attempt``/``tried``/``expires`` come
    from the server, never from the bar raiser."""
    return {
        "what": args["what"], "who": who, "cost": args["cost"],
        "reversible": args["reversible"], "attempt": int(attempt), "tried": list(tried),
        "expires": float(expires), "class": args["class"], "question": args["question"],
        "if_no": args["if_no"],
    }


def card_args_error(args: dict, allowed_if_no: tuple[str, ...]) -> str | None:
    """Checks the model-written card fields of ``call_person``."""
    for key in ("what", "cost"):
        v = args.get(key)
        if not isinstance(v, str) or not v.strip() or len(v) > TEXT_MAX:
            return f"args.{key} must be 1..{TEXT_MAX} chars"
    if args.get("reversible") not in ("yes", "no", "partly"):
        return "args.reversible must be yes, no or partly"
    if args.get("if_no") not in allowed_if_no:
        return f"args.if_no must be one of {list(allowed_if_no)} (it only stops or holds work)"
    return None


def standing_error(actions: Any, hours: Any) -> str | None:
    """A standing approval may only name stop-or-hold actions, for at most 24 hours."""
    if not isinstance(actions, list) or not actions:
        return "standing.actions must be a non-empty list"
    bad = [a for a in actions if a not in REDUCE_ONLY]
    if bad:
        return f"standing approval only covers {list(REDUCE_ONLY)}; not {bad}"
    if not isinstance(hours, (int, float)) or isinstance(hours, bool) or not 0 < hours <= STANDING_MAX_HOURS:
        return f"standing.hours must be 1..{STANDING_MAX_HOURS}"
    return None


def standing_covers(standings: list[dict], *, channel_id: str, cls: str, action: str,
                    now: float) -> dict | None:
    """The newest live standing approval for this room, class and action, if any."""
    if action not in REDUCE_ONLY:
        return None
    for s in sorted(standings, key=lambda s: -s.get("seq", 0)):
        if (s.get("channel_id") == channel_id and s.get("class") == cls
                and action in (s.get("actions") or []) and now < float(s.get("expires", 0))):
            return s
    return None


# --- evidence (items 4 and 5) ----------------------------------------------------------

def classify_rows(rows: list[dict], timeline_of) -> dict[int, str]:
    """``seq -> "record" | "owner" | "party_claim"`` for one case timeline.

    A lead's message is a ``party_claim`` (what a side says about itself). Owner
    messages and app-written rows are not. *timeline_of(row)* returns the row's
    timeline key or ``None`` when the row is outside the case.
    """
    out: dict[int, str] = {}
    for r in rows:
        if timeline_of(r) is None:
            continue
        t, by = r.get("type"), str(r.get("by", ""))
        if t == "message/posted":
            out[r["seq"]] = "owner" if by == "owner" else "party_claim" if by.startswith("lead:") else "record"
        elif t in RECORD_TYPES:
            out[r["seq"]] = "record"
        else:  # any other row a lead wrote (a vote, a stance, a relay note) is still its own word
            out[r["seq"]] = "party_claim" if by.startswith("lead:") else "record"
    return out


#: Actions that must cite evidence at all.
NEEDS_EVIDENCE = ("close_thread", "veto", "rule")
#: Verdicts (it fails / this side wins): they need evidence beyond the parties' own words.
#: ``close_thread`` only stops a chain, so the leads' own loop is evidence enough for it.
VERDICTS = ("veto", "rule")


def evidence_error(action: str, evidence_seqs: list[int], sources: dict[int, str]) -> str | None:
    """A verdict cites at least one record or owner message; only party claims is not enough."""
    if action not in NEEDS_EVIDENCE:
        return None
    if not evidence_seqs:
        return "evidence_seqs required"
    if action in VERDICTS and not any(sources.get(s) in ("record", "owner") for s in evidence_seqs):
        return ("evidence is only party claims (what the leads said about themselves); cite a "
                "record or an owner message, or answer hold and name what is missing")
    return None


# --- templates (item 13) ----------------------------------------------------------------

def _text(v: Any) -> bool:
    return isinstance(v, str) and bool(v.strip()) and len(v) <= TEXT_MAX


def veto_error(args: dict) -> str | None:
    """A veto names the rule broken, the number that breaks it, and what to change."""
    for key in ("rule", "number", "change"):
        if not _text(args.get(key)):
            return f"args.{key} must be 1..{TEXT_MAX} chars"
    return None


def ruling_error(args: dict, choices: list[str], known_seqs: set[int]) -> str | None:
    """A ruling lists each side's claim with its evidence and what settles it, then
    picks one side's choice exactly. No middle value."""
    if args.get("choice") not in choices:
        return f"args.choice must be exactly one of {choices}; a middle value is not allowed"
    pos = args.get("positions")
    if not isinstance(pos, list) or len(pos) < 2:
        return "args.positions must list at least 2 sides"
    seen = set()
    for p in pos:
        if not isinstance(p, dict) or not _text(p.get("by")) or not _text(p.get("claim")):
            return "each position needs by and claim (1..500 chars)"
        ev = p.get("evidence_seqs")
        if not isinstance(ev, list) or any(not isinstance(x, int) or isinstance(x, bool) for x in ev):
            return "each position needs evidence_seqs (a list of ints, may be empty)"
        if not set(ev) <= known_seqs:
            return "position evidence_seqs not in this room"
        if p["by"] in seen:
            return "each side appears once in positions"
        seen.add(p["by"])
    if not _text(args.get("decides")):
        return f"args.decides (what settles it) must be 1..{TEXT_MAX} chars"
    return None


def hold_error(args: dict) -> str | None:
    """A hold names what is missing."""
    if not _text(args.get("missing")):
        return f"args.missing must be 1..{TEXT_MAX} chars"
    return None
