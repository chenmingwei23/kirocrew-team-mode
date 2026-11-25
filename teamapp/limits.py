"""Limits counted from the ledger: stop switch, budgets, hops, rates.

Every number here is recomputed from the files on each call, so a gateway or MCP
server restart neither resets a counter nor lets a check drift from its charge.
Callers that check and then write hold ``ledger.transaction(root)`` around both.

Budgets have two layers:

* **Global demo caps** (the conductor's hard ceiling): 200 wake deliveries in total
  and ≈ 2M estimated tokens in total since the last owner budget reset. Reaching
  either writes ``control/stopped {reason: "budget"}``.
* **Hourly caps** (the platform map, section 2): 60 wakes/h overall, 12/h per lead,
  60 secretary runs/h, 6 bar raiser cases/h, 200 messages/h. Exceeding one also stops,
  except the per-lead wake cap: that one only holds the lead's wakes until its hour
  rolls over (``budget/lead_capped``). An owner budget reset clears the hourly counts.

Tokens are an estimate only (≈ 45k a hot wake, ≈ 96k a cold one): the app cannot
read real usage.

**Hard caps only tighten.** The numbers above are the hard caps (:func:`hard_caps`).
The owner may set lower ones (``budget/limits_set``); a value above a hard cap is kept
as asked but not applied: the hard cap applies and the page says so
(:func:`effective_caps`). Nothing, owner included, raises a hard cap at run time;
leads have no tool that sets limits at all.

**Owner away.** The page notes the owner's presence (``owner/seen``, at most once per
:data:`SEEN_EVERY_SECS`). After :data:`OWNER_AWAY_SECS` (or the owner's tighter
``owner_away_secs``) with no sign of the owner, batch wakes pause; they resume the
next time the owner shows up (:func:`owner_away`).
"""

from __future__ import annotations

import time
from pathlib import Path

from . import ledger

CONTROL = "control.jsonl"

# --- global demo ceiling
TOTAL_WAKES = 200
TOTAL_TOKENS_EST = 2_000_000
# --- hourly
HOURLY = {"wake": 60, "secretary": 60, "bar_raiser": 6, "message": 200}
WAKES_PER_LEAD_HOUR = 12
HOT_WAKE_TOKENS = 45_000
COLD_WAKE_TOKENS = 96_000
HOT_WINDOW_SECS = 300

# --- hops (per timeline)
HOP_LIMIT = 4
BACKSTOP_SAME_NODE = 10
BACKSTOP_CHAIN = 28

# --- rates
BUCKET_SIZE = 30
BUCKET_REFILL = 0.5
DUP_TEXT_SECS = 30
WINDOW_SECS = 300
WINDOW_MSGS = 20
COOLDOWN_SECS = 600
COOLING_HOLD_MAX = 32
UNSOLICITED_MAIN_REPLIES = 2
MAX_MENTIONS = 3
MAX_CC = 8
MAX_OPEN_ASSIGN_PAIR = 6
EVERYONE_PER_SENDER_HOUR = 2
EVERYONE_PER_GROUP_HOUR = 6
MAX_TEXT = 16_000
GROUP_MIN, GROUP_MAX = 2, 6

ADVICE_STOP = "do not retry; end this turn"

# --- owner away (botroster idle_routines pauses routines after 14 days nobody looked;
# a demo spends per hour, so the hard cap here is 2 hours and the owner may only shorten it)
OWNER_AWAY_SECS = 2 * 3600
SEEN_EVERY_SECS = 60

LIMIT_KEYS = ("total_wakes", "total_tokens_est", "hourly_wake", "hourly_secretary", "hourly_bar_raiser",
              "hourly_message", "wakes_per_lead_hour", "owner_away_secs")
MIN_CAPS = {"owner_away_secs": 60}


def hard_caps() -> dict[str, int]:
    """The hard caps (read at call time). The owner's limits may only be lower."""
    return {"total_wakes": TOTAL_WAKES, "total_tokens_est": TOTAL_TOKENS_EST,
            **{f"hourly_{k}": HOURLY[k] for k in ("wake", "secretary", "bar_raiser", "message")},
            "wakes_per_lead_hour": WAKES_PER_LEAD_HOUR, "owner_away_secs": OWNER_AWAY_SECS}


def _control(root: Path) -> list[dict]:
    return ledger.read(root, CONTROL)


def effective_caps(rows: list[dict]) -> dict:
    """``{caps, asked, clamped}`` from the newest ``budget/limits_set`` (pure).

    ``caps`` is what is enforced: ``min(asked, hard cap)`` per key. ``clamped`` names
    every key the owner asked looser than its hard cap; for those the hard cap applies.
    """
    hard = hard_caps()
    asked: dict[str, int] = {}
    for row in rows:
        if row["type"] == "budget/limits_set":
            asked = {k: int(v) for k, v in (row["data"].get("limits") or {}).items() if k in hard}
    caps = {k: min(asked.get(k, h), h) for k, h in hard.items()}
    clamped = sorted(k for k, v in asked.items() if v > hard[k])
    return {"caps": caps, "asked": asked, "clamped": clamped, "hard": hard}


def set_limits(root: Path, values: object, by: str = "owner") -> dict:
    """The owner's limits replace the previous ones. Unknown keys and non-positive
    numbers are refused; a value above a hard cap is stored as asked and clamped."""
    if not isinstance(values, dict):
        return {"status": "refused", "reason": "bad_limits"}
    clean: dict[str, int] = {}
    for k, v in values.items():
        if k not in LIMIT_KEYS:
            return {"status": "refused", "reason": "unknown_limit", "key": k}
        if not isinstance(v, int) or isinstance(v, bool) or v < MIN_CAPS.get(k, 1) or v > 10 ** 9:
            return {"status": "refused", "reason": "bad_limit", "key": k}
        clean[k] = v
    with ledger.transaction(root):
        ledger.append(root, CONTROL, "budget/limits_set", by, {"limits": clean})
        return {"status": "accepted", **effective_caps(_control(root))}


def owner_seen_ts(rows: list[dict]) -> float | None:
    seen = None
    for row in rows:
        if row["type"] == "owner/seen":
            seen = row["ts"]
    return seen


def owner_away(rows: list[dict], now: float) -> bool:
    """True when the owner was last seen longer ago than the away cap (pure).

    Never seen at all counts as present (an older install has no ``owner/seen`` row;
    botroster also skips the pause when its last-seen marker is missing)."""
    seen = owner_seen_ts(rows)
    return seen is not None and now - seen >= effective_caps(rows)["caps"]["owner_away_secs"]


def batch_paused_since(rows: list[dict]) -> float | None:
    """ts of the open ``wake/batch_paused`` (no ``wake/batch_resumed`` after it), else None."""
    since = None
    for row in rows:
        if row["type"] == "wake/batch_paused":
            since = row["ts"]
        elif row["type"] == "wake/batch_resumed":
            since = None
    return since


def note_owner_seen(root: Path, now: float | None = None) -> None:
    """Record the owner's presence (at most once a minute) and end a pause it ends."""
    now = time.time() if now is None else now
    rows = _control(root)
    seen = owner_seen_ts(rows)
    paused = batch_paused_since(rows) is not None
    if not paused and seen is not None and now - seen < SEEN_EVERY_SECS:
        return
    with ledger.transaction(root):
        out = [(CONTROL, "owner/seen", "owner", {})]
        if batch_paused_since(_control(root)) is not None:
            out.append((CONTROL, "wake/batch_resumed", "app", {"reason": "owner_back"}))
        ledger.append_many(root, out, now=now)


def stopped(root: Path, rows: list[dict] | None = None) -> bool:
    """True after ``control/stopped`` with no later ``control/resumed``."""
    state = False
    for row in rows if rows is not None else _control(root):
        if row["type"] == "control/stopped":
            state = True
        elif row["type"] == "control/resumed":
            state = False
    return state


def stop_reason(root: Path) -> str:
    reason = ""
    for row in _control(root):
        if row["type"] == "control/stopped":
            reason = row["data"].get("reason", "")
        elif row["type"] == "control/resumed":
            reason = ""
    return reason


def app_running(rows: list[dict]) -> bool:
    """True when the newest ``app/started`` is after the newest ``app/stopped``."""
    started = stopped_at = 0
    for row in rows:
        if row["type"] == "app/started":
            started = row["seq"]
        elif row["type"] == "app/stopped":
            stopped_at = row["seq"]
    return started > stopped_at


def usage(root: Path, now: float | None = None, rows: list[dict] | None = None) -> dict:
    """Counters since the last ``budget/reset`` (totals) and in the last hour."""
    now = time.time() if now is None else now
    rows = rows if rows is not None else _control(root)
    totals = {"wake": 0, "tokens": 0, "secretary": 0, "bar_raiser": 0, "message": 0}
    hour = dict.fromkeys(totals, 0)
    per_lead_hour: dict[str, int] = {}
    last_wake: dict[str, float] = {}
    hot = cold = 0
    for row in rows:
        if row["type"] == "budget/reset":
            # The owner's reset clears the hourly counters too, or a resumed app
            # stops again on the next charge (scenario run: reset kept the hour).
            totals = dict.fromkeys(totals, 0)
            hour = dict.fromkeys(totals, 0)
            per_lead_hour = {}
            hot = cold = 0
        if row["type"] == "budget/charged" and row["data"].get("kind") == "tokens":
            n = int(row["data"].get("n", 0))
            hot += n == HOT_WAKE_TOKENS
            cold += n == COLD_WAKE_TOKENS
        if row["type"] != "budget/charged":
            continue
        d = row["data"]
        kind, n = d.get("kind", ""), int(d.get("n", 1))
        if kind not in totals:
            continue
        totals[kind] += n
        if now - row["ts"] < 3600:
            hour[kind] += n
            if kind == "wake" and d.get("lead_id"):
                per_lead_hour[d["lead_id"]] = per_lead_hour.get(d["lead_id"], 0) + n
        if kind == "wake" and d.get("lead_id"):
            last_wake[d["lead_id"]] = row["ts"]
    caps = effective_caps(rows)["caps"]
    return {"totals": totals, "hour": hour, "per_lead_hour": per_lead_hour, "last_wake": last_wake,
            "hot_wakes": hot, "cold_wakes": cold,
            "caps": {"total_wakes": caps["total_wakes"], "total_tokens_est": caps["total_tokens_est"],
                     "hourly": {k: caps[f"hourly_{k}"] for k in HOURLY},
                     "wakes_per_lead_hour": caps["wakes_per_lead_hour"]}}


def wake_tokens_estimate(root: Path, lead_id: str, now: float | None = None) -> int:
    now = time.time() if now is None else now
    last = usage(root, now)["last_wake"].get(lead_id)
    return HOT_WAKE_TOKENS if last is not None and now - last < HOT_WINDOW_SECS else COLD_WAKE_TOKENS


def charge(root: Path, kind: str, n: int = 1, *, lead_id: str | None = None,
           now: float | None = None, over_lead_cap: bool = False) -> bool:
    """Record ``n`` units of ``kind``; False (and ``control/stopped``) past any cap.

    The per-lead hourly wake cap is the exception: it returns False for that lead
    only and writes ``budget/lead_capped``, not ``control/stopped``.

    ``kind`` is one of ``wake``, ``tokens``, ``secretary``, ``bar_raiser``,
    ``message``. A charge that would cross a cap is not recorded; the stop is.
    Already stopped also returns False, so nothing is spent while stopped.
    """
    now = time.time() if now is None else now
    with ledger.transaction(root):
        rows = _control(root)
        if stopped(root, rows):
            return False
        u = usage(root, now, rows)
        caps = u["caps"]
        over = ""
        if kind == "wake" and u["totals"]["wake"] + n > caps["total_wakes"]:
            over = "total_wakes"
        elif kind == "tokens" and u["totals"]["tokens"] + n > caps["total_tokens_est"]:
            over = "total_tokens_est"
        elif kind in HOURLY and u["hour"][kind] + n > caps["hourly"][kind]:
            over = f"hourly_{kind}"
        elif (kind == "wake" and lead_id and not over_lead_cap
              and u["per_lead_hour"].get(lead_id, 0) + n > caps["wakes_per_lead_hour"]):
            # Only this lead waits for its hour to roll over; the app keeps running.
            # One record per lead per hour, so the loop retrying every tick adds nothing.
            if not any(r["type"] == "budget/lead_capped" and r["data"].get("lead_id") == lead_id
                       and now - r["ts"] < 3600 for r in rows):
                ledger.append(root, CONTROL, "budget/lead_capped", "app",
                              {"lead_id": lead_id, "limit": "hourly_wake_per_lead"}, now=now)
            return False
        if over:
            ledger.append(root, CONTROL, "control/stopped", "app",
                          {"reason": "budget", "limit": over, "kind": kind}, now=now)
            return False
        data = {"kind": kind, "n": n}
        if lead_id:
            data["lead_id"] = lead_id
        ledger.append(root, CONTROL, "budget/charged", "app", data, now=now)
        return True


def charge_wake(root: Path, lead_id: str, now: float | None = None, *, must_answer: bool = False) -> bool:
    """One wake delivery plus its token estimate, both or neither.

    ``must_answer`` (the wake carries an assignment to this lead or a DM) skips the
    per-lead hourly cap: skipping it silently left an @-ed Bot unwoken and then blamed it
    for not answering (round4 A-F1). The global wake, hourly and token caps still apply.
    """
    now = time.time() if now is None else now
    with ledger.transaction(root):
        u = usage(root, now)
        tokens = wake_tokens_estimate(root, lead_id, now)
        if u["totals"]["tokens"] + tokens > u["caps"]["total_tokens_est"]:
            return charge(root, "tokens", tokens, now=now)  # writes the stop
        if not charge(root, "wake", 1, lead_id=lead_id, now=now, over_lead_cap=must_answer):
            return False
        return charge(root, "tokens", tokens, now=now)


def stop(root: Path, reason: str, by: str = "owner") -> int:
    return ledger.append(root, CONTROL, "control/stopped", by, {"reason": reason})


def resume(root: Path, *, reset_budget: bool = False, by: str = "owner") -> list[int]:
    rows = [(CONTROL, "control/resumed", by, {})]
    if reset_budget:
        rows.insert(0, (CONTROL, "budget/reset", by, {}))
    return ledger.append_many(root, rows)


# --------------------------------------------------------------------------- hops


def _in_timeline(m: dict, timeline: str) -> bool:
    if timeline == "main":
        return m["thread_id"] is None or m["also_main"]
    return m["thread_id"] == timeline


def _reset_seq(rows: list[dict], channel: dict, timeline: str) -> int:
    """Seq of the newest chain reset in ``timeline``: a person's message or ``chain/reset``."""
    last = 0
    for row in rows:
        t, d = row["type"], row["data"]
        if t == "message/posted" and row["by"] == "owner":
            m = channel["messages"].get(d["msg_id"])
            if m is not None and _in_timeline(m, timeline):
                last = row["seq"]
        elif t == "chain/reset" and (d.get("thread_id") or "main") == timeline:
            last = row["seq"]
    return last


def next_hops(rows: list[dict], channel: dict, sender: str, timelines: list[str]) -> dict:
    """Hop count a lead message would carry, and the backstop counters.

    hops = 1 + the highest hop of other authors' messages in the same timeline since
    the newer of (the sender's own last post there, the last reset there). With
    nothing new from others, a sender keeps its own last hop count (talking on its
    own is not a loop; the rate limits bound that). Released messages count as hop 0.
    For an ``also_main`` thread reply both timelines are measured and the higher wins.
    """
    best = 0
    for tl in timelines:
        reset = _reset_seq(rows, channel, tl)
        mine_seq, mine_hops = 0, 0
        others = -1
        for m in sorted(channel["messages"].values(), key=lambda m: m["seq"]):
            if m["seq"] <= reset or not _in_timeline(m, tl) or m["held"] or not m["by"].startswith("L-") \
                    or m.get("kind") == "notice":
                continue  # a notice is not a hop: it neither carries nor passes one on
            if m["by"] == sender:
                mine_seq, mine_hops, others = m["seq"], m["hops"], -1
            elif m["seq"] > mine_seq:
                others = max(others, m["hops"])
        hops = others + 1 if others >= 0 else (mine_hops if mine_seq else 1)
        best = max(best, hops)
    # backstops: whole channel since the last person message anywhere, never reset by bar raiser
    last_person = 0
    for row in rows:
        if row["type"] == "message/posted" and row["by"] == "owner":
            last_person = row["seq"]
    chain = [m for m in channel["messages"].values()
             if m["seq"] > last_person and not m["held"] and m["by"].startswith("L-")
             and m.get("kind") != "notice"]
    if len({m["by"] for m in chain} | {sender}) < 2:
        chain = []  # a monologue is not a loop; the sender bucket bounds it
    same = sum(1 for m in chain if m["by"] == sender)
    return {"hops": best, "chain_len": len(chain), "same_node": same}


# --------------------------------------------------------------------------- rates


def bucket_ok(sender_ts: list[float], now: float) -> bool:
    """Token bucket (size 30, refill 0.5/s) replayed over the sender's accepted posts."""
    tokens, last = float(BUCKET_SIZE), None
    for ts in sorted(sender_ts):
        if last is not None:
            tokens = min(BUCKET_SIZE, tokens + (ts - last) * BUCKET_REFILL)
        tokens -= 1
        last = ts
    if last is not None:
        tokens = min(BUCKET_SIZE, tokens + (now - last) * BUCKET_REFILL)
    return tokens >= 1


def window_count(channel: dict, now: float) -> int:
    return sum(1 for m in channel["messages"].values()
               if m["by"].startswith("L-") and not m["held"] and now - m["ts"] < WINDOW_SECS)
