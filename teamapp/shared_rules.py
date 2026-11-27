"""Extra rules for a group two owners share (``channel/shared`` row, cross-owner phase 1).

Who talks stays the Team Mode RFC model: every Bot reads the group and decides itself
whether and where to answer; an @ wakes the Bot it names; hop chains and wake caps
stop a storm. On top of that, taken from Joe's multi-Bot plan v3:

* Markers. A reply whose last line is ``[PASS]`` posts nothing. A reply ending in
  ``[ASK HUMAN]`` is posted without the marker, with "Waiting for <name>." added, and
  then no Bot posts in that group until a person speaks. Both markers are cut from
  every stored and sent text.
* One count both owners get. At most ``POST_LIMIT`` Bot posts after the newest message
  from a person (either owner), and ``POSTS_PER_HOUR`` Bot posts a group an hour. The
  mirror is a row-for-row copy, so both gateways count the same rows.
* Labels. Who said a message is written by the app (``wake._wrap``: ``speaker=owner|
  other_owner|own_bot|outside_bot``), never read from the text. Square brackets in a
  shared group's text become round ones, so a text cannot forge a label or a marker.
* Another owner's Bot is data: its posts count toward both limits, and it has no
  route to a card or a tool here (``crossowner`` admits text through ``send.post`` only).
"""

from __future__ import annotations

import re

from . import fold

POST_LIMIT = 6
POSTS_PER_HOUR = 60
_PASS = re.compile(r"\[\s*pass\s*\]", re.IGNORECASE)
_ASK = re.compile(r"\[\s*ask\s+human\s*\]", re.IGNORECASE)


def is_shared(rows: list[dict]) -> bool:
    return any(r["type"] == "channel/shared" for r in rows)


def is_person(by: object) -> bool:
    """The hub's owner (``owner``) or the other owner (``peer:P-x``)."""
    return by == fold.OWNER or str(by).startswith("peer:")


def marker(text: str) -> str:
    """``pass`` / ``ask_human`` / ``""`` from the reply's last non-empty line."""
    lines = [l for l in (text or "").strip().splitlines() if l.strip()]
    last = lines[-1].strip() if lines else ""
    if _PASS.fullmatch(last):
        return "pass"
    if _ASK.search(last):
        return "ask_human"
    return ""


def clean(text: str) -> str:
    """Cut both markers everywhere, then turn every square bracket into a round one."""
    text = _ASK.sub("", _PASS.sub("", text or ""))
    return text.replace("[", "(").replace("]", ")").strip()


def counts(rows: list[dict], now: float) -> dict:
    """``{since_person, hour, waiting, paused}`` for one shared group."""
    since = hour = 0
    waiting = paused = False
    for r in rows:
        if r["type"] != "message/posted":
            continue
        d = r["data"]
        if is_person(r["by"]):
            since, waiting, paused = 0, False, False
        elif str(r["by"]).startswith("lead:"):
            since += 1
            hour += 1 if now - r["ts"] < 3600 else 0
            waiting = waiting or bool(d.get("ask_human"))
        elif r["by"] == "app" and d.get("kind") == "pause":
            paused = True
    return {"since_person": since, "hour": hour, "waiting": waiting, "paused": paused}


def refusal(rows: list[dict], now: float) -> str:
    """Why a Bot may not post in this shared group now, or ``""``."""
    c = counts(rows, now)
    if c["waiting"]:
        return "waiting_for_person"
    if c["since_person"] >= POST_LIMIT:
        return "post_limit"
    if c["hour"] >= POSTS_PER_HOUR:
        return "hourly_posts"
    return ""


def pause_text(reason: str) -> str:
    if reason == "post_limit":
        return f"Paused after {POST_LIMIT} Bot posts. Reply to go on."
    return f"Paused: {POSTS_PER_HOUR} Bot posts this hour. Reply to go on."
