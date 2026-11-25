"""Who should wake, and the backend loop that writes ``wake/due``.

:func:`next_wake` is a pure function of a lead's member fold, its unread items, the
channel folds and the clock: no model, no I/O. The loop (:func:`run_loop`, started
by ``hooks.on_startup``) runs every 2 seconds: unanswered assignments -> bar raiser
``detect`` / ``summon`` / ``apply_due`` -> ``next_wake`` for each lead -> budget charge
-> secretary brief -> ``wake/due``. A lead's own script cron (``crons/inbox_probe.py``)
sees the new ``wake/due`` within about 60 seconds and wakes its session with a fixed
pointer text; the session then calls ``team_inbox_read``, which acknowledges.

B's modules (``secretary``, ``bar_raiser``) are imported lazily. Missing or broken,
the loop falls back to a rules brief and summons nobody.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import logging
import time
from pathlib import Path
from typing import Any

from . import fold, identity, ledger, limits

log = logging.getLogger("kirocrew.app.team-mode")

BATCH_WINDOW_SECS = 180
BATCH_OFFSET_MAX = 45
BATCHED_PER_HOUR = 12
AT_ONCE_PER_SENDER_HOUR = 6
ANSWER_SECS = 900
# shortcut: one fixed result window (2 x ANSWER_SECS) for every assignment; real tree work
# can take longer, so let the assigner set a due time when leads start missing it.
RESULT_SECS = 2 * ANSWER_SECS
REWAKE_AFTER_SECS = 120
LOOP_SECS = 2.0
INBOX_BODY_CHARS = 4000


def is_notice(item: dict) -> bool:
    """A ``kind="notice"`` message ("I am missing X"): brief only, no wake, no hop."""
    return item.get("type") in ("message/posted", "message/released") and \
        (item.get("data") or {}).get("kind") == "notice"


def assignment_due(a: dict, now: float, delivered_ts: list[float] = ()) -> dict:
    """Where one assignment stands, from its channel fold alone: no model, no I/O.

    The single rule for "@-ed and not answered", used by the unanswered check, the
    page (``GET /state`` ``assignments``) and the Leads now card. An @ has two steps:

    * ``ack`` -- the assignee owes take, decline or ask. Late after ``ANSWER_SECS``
      from the @, or two delivered wakes + ``REWAKE_AFTER_SECS`` (``delivered_ts``,
      from the assignee's member file; leave empty where it is not known).
    * ``result`` -- taken, the assignee owes a result (an empty one counts:
      ``no_result``). Late ``RESULT_SECS`` after the take.
    * ``asker`` -- the assignee asked; the assigner owes the reply. Never late here.
    * ``done`` -- declined or closed with a result.
    * ``marked`` -- already marked unanswered; ``step_missed`` says which step.

    Returns ``{step, owed_by, due_ts, late}`` (``due_ts`` None when nothing is due).
    """
    s = a.get("state", "open")
    if s == "open":
        due = a["opened_ts"] + ANSWER_SECS
        twice = len(delivered_ts) >= 2 and now - max(delivered_ts) >= REWAKE_AFTER_SECS
        return {"step": "ack", "owed_by": a["to"], "due_ts": due, "late": now >= due or twice}
    if s == "taken":
        due = (a.get("acked_ts") or a.get("updated_ts") or a["opened_ts"]) + RESULT_SECS
        return {"step": "result", "owed_by": a["to"], "due_ts": due, "late": now >= due}
    if s == "asked":
        return {"step": "asker", "owed_by": a["from"], "due_ts": None, "late": False}
    if s == "unanswered":
        return {"step": "marked", "owed_by": a["to"], "due_ts": None, "late": True,
                "step_missed": "result" if a.get("reason") == "no_result" else "ack"}
    return {"step": "done", "owed_by": None, "due_ts": None, "late": False}


def offset_secs(lead_id: str) -> int:
    return int(hashlib.sha256(lead_id.encode()).hexdigest(), 16) % (BATCH_OFFSET_MAX + 1)


def _immediate(item: dict, channel: dict, lead_id: str) -> str:
    """Reason this item wakes at once, or ``""`` for the batch."""
    t, d = item["type"], item["data"]
    who = fold.actor(item["by"])
    if t == "assignment/opened" and d.get("to") == lead_id:
        return f"assign:{d['assignment_id']}"
    if t in fold.ASSIGN_ANSWERS or t == "assignment/unanswered":
        a = channel["assignments"].get(d.get("assignment_id"), {})
        if a.get("from") == lead_id:
            return f"answer:{d['assignment_id']}"
        return ""
    if t == "thread/member_added" and d.get("who") == lead_id:
        return "pulled_in"
    if t in fold.MEETING_TARGETED:
        if lead_id not in fold.meeting_targets(d):
            return ""
        return {"meeting/invited": f"meeting_invite:{d.get('meeting_id')}",
                "turn/granted": f"meeting_turn:{d.get('turn_id')}",
                "progress/requested": f"meeting_chair:{d.get('meeting_id')}:{d.get('item_id')}:{d.get('round')}",
                "ballot/opened": f"meeting_vote:{d.get('meeting_id')}:{d.get('ballot_id')}",
                }.get(t, "")  # an action proposed to me rides the batch (RFC "Wakes for meetings")
    if t not in ("message/posted", "message/released"):
        return ""
    if who == fold.OWNER:
        # An owner post that @s someone wakes only them at once; the rest of the room reads it
        # in the batch like any main post (S34: '@Ada' woke Ada, Uma and Ira). No @ or
        # @everyone still wakes everyone at once.
        named = list(d.get("mentions") or []) + list(d.get("cc") or [])
        if named and not d.get("everyone") and lead_id not in named:
            return ""
        return "owner"
    if channel["kind"] == "dm":
        return "dm"
    if d.get("everyone"):
        return "everyone"
    if lead_id in (d.get("cc") or []):
        return "cc"
    if lead_id in (d.get("mentions") or []):
        return "mention"
    return ""


def next_wake(lead_id: str, member: dict, items: list[dict], channels: dict[str, dict],
              now: float, batch_paused: bool = False) -> dict | None:
    """``{upto, reasons, senders, summary}`` when ``lead_id`` should wake now, else None.

    * Items already covered by an earlier ``wake/due`` never wake again.
    * At once: an assignment to me, an answer to mine, being pulled into a thread,
      a cc, an @everyone, a DM, anything from the owner. One sender's at-once wakes
      to me are capped at 6 an hour (the owner and assignments are exempt); past
      that its items wait for the batch.
    * Batch: the oldest new item is ``180 s + offset(lead)`` old, and fewer than 12
      batched wakes happened in the last hour. ``batch_paused`` (the owner is away,
      :func:`limits.owner_away`) skips the batch; the items wait, unread, for the owner.
    * Re-wake once: an assignment still open ``120 s`` after the wake that carried
      it was delivered.
    * Every due points at everything unread (``upto`` per channel), so batched
      items ride along on an at-once wake.
    """
    pointed: dict[str, int] = {}
    at_once_hour: dict[str, int] = {}
    batched_hour = 0
    assign_dues: dict[str, list[int]] = {}
    for due in member["dues"]:
        for cid, seq in (due.get("upto") or {}).items():
            pointed[cid] = max(pointed.get(cid, 0), int(seq))
        recent = now - due["ts"] < 3600
        if recent and "batch" in due.get("reasons", []):
            batched_hour += 1
        for s in due.get("senders", []) if recent else []:
            at_once_hour[s] = at_once_hour.get(s, 0) + 1
        for r in due.get("reasons", []):
            if r.startswith(("assign:", "rewake:")):
                assign_dues.setdefault(r.split(":", 1)[1], []).append(due["seq"])

    reasons: list[str] = []
    senders: list[str] = []
    batch_oldest: float | None = None
    for item in items:
        cid = item["channel_id"]
        if item["seq"] <= pointed.get(cid, 0) or is_notice(item):
            continue  # already pointed at, or a notice: neither wakes nor starts a batch
        ch = channels[cid]
        why = _immediate(item, ch, lead_id)
        who = fold.actor(item["by"])
        if why and not why.startswith(("assign:", "answer:")) and who != fold.OWNER and who != "app":
            if at_once_hour.get(who, 0) >= AT_ONCE_PER_SENDER_HOUR:
                why = ""
            elif who not in senders:
                senders.append(who)
        if why:
            if why not in reasons:
                reasons.append(why)
        elif batch_oldest is None or item["ts"] < batch_oldest:
            batch_oldest = item["ts"]
    if not reasons and not batch_paused and batch_oldest is not None and batched_hour < BATCHED_PER_HOUR \
            and now - batch_oldest >= BATCH_WINDOW_SECS + offset_secs(lead_id):
        reasons.append("batch")

    # one re-wake for an assignment still open after the wake that carried it
    for aid, todo in member["todos"].items():
        if todo["state"] != "open":
            continue
        ch = channels.get(todo["channel_id"])
        a = (ch or {}).get("assignments", {}).get(aid)
        if not a or a["state"] != "open":
            continue
        carried = assign_dues.get(aid, [])
        if len(carried) == 1 and carried[0] in member["delivered_ts"] \
                and now - member["delivered_ts"][carried[0]] >= REWAKE_AFTER_SECS:
            reasons.append(f"rewake:{aid}")
    if not reasons:
        return None
    upto: dict[str, int] = {}
    per_channel: dict[str, int] = {}
    for item in items:
        upto[item["channel_id"]] = max(upto.get(item["channel_id"], 0), item["seq"])
        per_channel[item["channel_id"]] = per_channel.get(item["channel_id"], 0) + 1
    for cid, seq in pointed.items():
        upto[cid] = max(upto.get(cid, 0), seq)
    open_assign = sum(1 for aid, t in member["todos"].items() if t["state"] == "open")
    summary = {"channels": [{"channel_id": cid, "title": channels[cid]["title"], "kind": channels[cid]["kind"],
                             "n": n} for cid, n in sorted(per_channel.items())],
               "assignments": open_assign}
    return {"upto": upto, "reasons": reasons, "senders": senders, "summary": summary}


# --------------------------------------------------------------------------- inbox


def _snippet(text: str, n: int = 40) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[:n].rstrip() + "..."


def say_names(root: Path, channel_id: str, handles: dict[str, str]) -> dict:
    """Words a Bot uses to people for one channel's group, threads and assignments, so it
    never repeats ``G-``/``T-``/``A-`` ids in its own chat (round4 A-F3)."""
    rows = ledger.read(root, fold.channel_file(channel_id))
    ch = fold.fold_channel(root, channel_id, rows)

    def nm(w: str) -> str:
        return "the owner" if w == fold.OWNER else handles.get(w, "a lead")
    text = {r["seq"]: (r.get("data") or {}).get("text", "") for r in rows if r.get("type") == "message/posted"}
    if ch["kind"] == "dm":
        where = "the DM between " + " and ".join(nm(w) for w in (ch["members"] + ch["people"])[:2])
    else:
        where = f"the group '{ch['title']}'"
    return {"channel": where,
            "threads": {tid: f"the thread '{_snippet(text.get(th['root_seq'], ''))}'"
                        for tid, th in ch["threads"].items()},
            "assignments": {aid: f"{nm(a['from'])}'s request to {nm(a['to'])}"
                            for aid, a in ch["assignments"].items()}}


def _say(d: dict, names: dict) -> str:
    parts = [names["channel"]]
    if names["threads"].get(d.get("thread_id") or ""):
        parts.append(names["threads"][d["thread_id"]])
    ans = d.get("answers")
    # A message that answered an @ stores answers as {assignment_id, response, ...}, not an id.
    aid = d.get("assignment_id") or (ans.get("assignment_id") if isinstance(ans, dict) else ans)
    if isinstance(aid, str) and names["assignments"].get(aid):
        parts.append(names["assignments"][aid])
    return ", ".join(parts)


def _wrap(item: dict, handles: dict[str, str], names: dict | None = None) -> dict:
    d = item["data"]
    who = fold.actor(item["by"])
    name = handles.get(who, who)
    base = {"channel_id": item["channel_id"], "seq": item["seq"], "type": item["type"], "from": name,
            "ts": item["ts"]}
    if names:
        base["say"] = _say(d, names)
    if item["type"] in ("message/posted", "message/released"):
        text = d.get("text", "")
        cut = len(text) > INBOX_BODY_CHARS
        text = text[:INBOX_BODY_CHARS].replace("</peer-message", "<\\/peer-message")
        base.update(msg_id=d.get("msg_id"), thread_id=d.get("thread_id"), kind=d.get("kind"),
                    mentions=d.get("mentions", []), cc=d.get("cc", []), everyone=d.get("everyone", False),
                    reply_to=d.get("reply_to"), answers=d.get("answers"), truncated=cut,
                    released=bool(item.get("released")),
                    body=(f'<peer-message from="{name}" channel="{item["channel_id"]}" seq="{item["seq"]}">'
                          f"{text}</peer-message>"))
    else:
        base.update({k: v for k, v in d.items() if k in (
            "assignment_id", "thread_id", "who", "via", "reason", "meeting_id", "item_id", "round", "turn_id",
            "action_id", "title", "item_title", "expires_at", "respond_by", "deadline",
            "ballot_id", "options", "closes_at")})
        if item["type"] in fold.MEETING_TARGETED:
            base["note"] = fold.system_text(item, handles)
    return base


def inbox_read(root: Path, lead_id: str, limit: int = 20, ack: bool = True) -> dict:
    """Return up to ``limit`` unread items; acknowledge them first when ``ack``.

    The ``inbox/acked`` rows (one per channel, ``upto`` = highest returned seq) and
    ``wake/delivered`` for every pending due are written before anything is
    returned; if that write fails the call fails and nothing counts as read.
    """
    limit = max(1, min(int(limit), 50))
    with ledger.transaction(root):
        items = fold.unread(root, lead_id)
        total = len(items)
        items = items[:limit]
        member = fold.fold_member(root, lead_id)
        upto: dict[str, int] = {}
        hops: dict[str, dict[str, int]] = {}
        channels = {cid: fold.fold_channel(root, cid) for cid in {i["channel_id"] for i in items}}
        for i in items:
            upto[i["channel_id"]] = max(upto.get(i["channel_id"], 0), i["seq"])
            if i["type"] in ("message/posted", "message/released"):
                m = channels[i["channel_id"]]["messages"].get(i["data"]["msg_id"], {})
                tl = fold.timeline_key(i["data"].get("thread_id"))
                hops.setdefault(i["channel_id"], {})[tl] = max(hops.get(i["channel_id"], {}).get(tl, 0),
                                                               int(m.get("hops", 0)))
        pending = [d for d in member["dues"] if d["seq"] not in member["delivered"]]
        latest_brief = None
        if member["dues"]:
            bid = member["dues"][-1].get("brief_id")
            latest_brief = member["briefs"].get(bid, {}).get("brief") if bid else None
        if ack:
            rows = [(fold.member_file(lead_id), "inbox/acked", f"lead:{lead_id}",
                     {"channel_id": cid, "upto": seq, "max_hops_read": hops.get(cid, {})})
                    for cid, seq in sorted(upto.items())]
            rows += [(fold.member_file(lead_id), "wake/delivered", "app", {"due_seq": d["seq"]}) for d in pending]
            if rows:
                ledger.append_many(root, rows)
    handles = {k: v["handle"] for k, v in fold.directory(root)["leads"].items()}
    # A notice the latest brief already covers is read there only. One newer than that
    # brief comes back as an item, so acknowledging it here never drops it unseen.
    briefed = (member["dues"][-1].get("upto") or {}) if member["dues"] and latest_brief else {}
    shown = [i for i in items if not (is_notice(i) and i["seq"] <= int(briefed.get(i["channel_id"], 0)))]
    names = {cid: say_names(root, cid, handles) for cid in {i["channel_id"] for i in shown}}
    return {"brief": latest_brief, "items": [_wrap(i, handles, names[i["channel_id"]]) for i in shown],
            "upto": upto, "remaining": max(0, total - len(items)), "acked": bool(ack)}


def inbox_peek(root: Path, lead_id: str) -> dict:
    items = fold.unread(root, lead_id)
    member = fold.fold_member(root, lead_id)
    per: dict[str, int] = {}
    for i in items:
        per[i["channel_id"]] = per.get(i["channel_id"], 0) + 1
    return {"unread": len(items), "by_channel": per,
            "open_assignments": sorted(a for a, t in member["todos"].items() if t["state"] == "open")}


# --------------------------------------------------------------------------- loop


def check_unanswered(root: Path, now: float) -> int:
    """Mark an assignment unanswered when :func:`assignment_due` says its step is late:
    no ack after 900 s or two delivered wakes + 120 s, or taken with no result after
    ``RESULT_SECS`` (reason ``no_result``). Both reach the bar raiser the same way."""
    written = 0
    with ledger.transaction(root):
        members = {lid: fold.fold_member(root, lid) for lid in identity.active_leads(root)}
        names = fold.handles(root)

        def nm(who: str) -> str:  # people read this line: handles, never L-/A- ids (video round 2, S21)
            return "Owner" if who == fold.OWNER else names.get(who, "a member")
        for cid in fold.list_channels(root):
            ch = fold.fold_channel(root, cid)
            for aid, a in ch["assignments"].items():
                m = members.get(a["to"])
                delivered = []
                if m and a["state"] == "open":
                    carried = [d["seq"] for d in m["dues"]
                               if any(r in (f"assign:{aid}", f"rewake:{aid}") for r in d.get("reasons", []))]
                    delivered = [m["delivered_ts"][s] for s in carried if s in m["delivered_ts"]]
                due = assignment_due(a, now, delivered)
                if due["step"] not in ("ack", "result") or not due["late"]:
                    continue
                if due["step"] == "result":
                    reason = "no_result"
                    text = f"{nm(a['to'])} took {nm(a['from'])}'s request but has not sent a result yet."
                else:
                    reason = "timeout" if now >= due["due_ts"] else "two_turns"
                    text = f"{nm(a['to'])} has not answered {nm(a['from'])}'s request yet."
                file = fold.channel_file(cid)
                ledger.append_many(root, [
                    (file, "assignment/unanswered", "app", {"assignment_id": aid, "reason": reason}),
                    (file, "message/posted", "app",
                     {"msg_id": "M-" + hashlib.sha256(f"{cid}{aid}".encode()).hexdigest()[:8],
                      "thread_id": a["thread_id"], "kind": "system", "mentions": [], "cc": [],
                      "everyone": False, "also_main": False, "reply_to": None, "answers": None,
                      "chain": None, "text": text}),
                ], now=now)
                written += 1
    return written


def _optional(name: str):
    try:
        # relative: the gateway loads hooks into a synthetic package, not as "teamapp"
        return importlib.import_module(f".{name}", __package__)
    except Exception as exc:  # noqa: BLE001 - B's module missing or broken: degrade
        log.warning("team-mode: %s unavailable (%s); degrading", name, exc)
        return None


def _meetings(mt, root: Path, now: float) -> None:
    """Run the meeting planner once over every live meeting (deadlines, round ends, minutes)."""
    if mt is None:
        return
    try:
        mt.step_all(root, now)
    except Exception:  # noqa: BLE001 - one bad pass must not kill the loop
        log.exception("team-mode: meeting pass failed")


def _rules_brief(root: Path, lead_id: str, items: list[dict]) -> dict:
    """Fallback brief when the secretary is missing or failed: ``secretary.brief.v1``
    with one item per message (summary = first line) and the same history pointers."""
    groups: dict[tuple, list[dict]] = {}
    inp = []
    names = {lid: lead.get("handle") or lid for lid, lead in fold.directory(root)["leads"].items()}
    for i in items:
        text = str(i["data"].get("text") or fold.system_text(i, names))
        first = (text.strip().splitlines() or [""])[0].strip()[:160]
        groups.setdefault((i["channel_id"], i["data"].get("thread_id")), []).append(
            {"seqs": [i["seq"]], "summary": first})
        inp.append({"channel_id": i["channel_id"], "seq": i["seq"], "ts": i.get("ts", 0), "text": text})
    brief = {"schema": "secretary.brief.v1",
             "groups": [{"channel_id": c, "thread_id": t, "items": its} for (c, t), its in groups.items()]}
    ptr = _optional("pointers")
    if ptr is not None:
        return ptr.with_pointers(root, lead_id, brief, inp)
    empty = {"seen_before": [], "answered_before": None, "repeat_count": 0}
    return {**brief, "groups": [{**g, "items": [{**it, "pointers": dict(empty)} for it in g["items"]]}
                                for g in brief["groups"]]}


def _batch_pause(root: Path, now: float) -> bool:
    """True while the owner is away; writes ``wake/batch_paused`` once when a pause starts.
    ``limits.note_owner_seen`` writes the matching ``wake/batch_resumed``."""
    with ledger.transaction(root):
        rows = ledger.read(root, limits.CONTROL)
        away = limits.owner_away(rows, now)
        if away and limits.batch_paused_since(rows) is None:
            ledger.append(root, limits.CONTROL, "wake/batch_paused", "app",
                          {"reason": "owner_away", "seen_ts": limits.owner_seen_ts(rows)}, now=now)
    return away


async def tick(ctx: Any, root: Path, now: float | None = None) -> dict:
    """One pass of the loop. Returns what it did (for logs and tests)."""
    now = time.time() if now is None else now
    did = {"unanswered": 0, "cases": 0, "dues": []}
    if limits.stopped(root) or not limits.app_running(ledger.read(root, limits.CONTROL)):
        return did
    did["unanswered"] = check_unanswered(root, now)
    mt = _optional("meeting")
    _meetings(mt, root, now)
    br = _optional("bar_raiser")
    if br is not None:
        try:
            for cid in fold.list_channels(root):
                for case in br.detect(root, cid, now):
                    if limits.stopped(root):
                        return did
                    await br.summon(ctx, root, case)
                    did["cases"] += 1
            br.apply_due(root, now)
        except Exception:  # noqa: BLE001 - one bad pass must not kill the loop
            log.exception("team-mode: bar raiser pass failed")
        _meetings(mt, root, now)  # act on a bar raiser answer in the same tick
    sec = _optional("secretary")
    away = _batch_pause(root, now)
    for lead_id in identity.active_leads(root):
        if limits.stopped(root):
            break
        member = fold.fold_member(root, lead_id)
        items = fold.unread(root, lead_id)
        channels = {cid: fold.fold_channel(root, cid) for cid in fold.list_channels(root)}
        decision = next_wake(lead_id, member, items, channels, now, batch_paused=away)
        if decision is None:
            continue
        must = any(r.startswith(("assign:", "rewake:")) or r == "dm" for r in decision.get("reasons", []))
        if not limits.charge_wake(root, lead_id, now, must_answer=must):
            if limits.stopped(root):
                break  # a global cap wrote control/stopped
            continue  # this lead hit its hourly wake cap; the others still wake
        brief_id = None
        if sec is not None:
            try:
                brief_id = (await sec.brief_for(ctx, root, lead_id, items)).get("brief_id")
            except Exception:  # noqa: BLE001 - brief_for promises not to raise; belt and braces
                log.exception("team-mode: secretary failed")
        if brief_id is None:
            brief_id = "B-" + hashlib.sha256(f"{lead_id}{now}".encode()).hexdigest()[:8]
            ledger.append(root, fold.member_file(lead_id), "secretary/briefed", "app",
                          {"brief_id": brief_id, "lane": "rules",
                           "brief": _rules_brief(root, lead_id, items)})
        seq = ledger.append(root, fold.member_file(lead_id), "wake/due", "app",
                            {**decision, "brief_id": brief_id})
        did["dues"].append((lead_id, seq))
    return did


async def run_loop(ctx: Any, root: Path, stop: asyncio.Event, interval: float = LOOP_SECS) -> None:
    while not stop.is_set():
        try:
            await tick(ctx, root)
        except Exception:  # noqa: BLE001 - keep the loop alive; the next tick retries
            log.exception("team-mode: wake tick failed")
        try:
            await asyncio.wait_for(stop.wait(), interval)
        except asyncio.TimeoutError:
            pass
