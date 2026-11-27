"""Group close and lead removal: list what is left before anything ends.

* :func:`close_blockers` / :func:`close_group`. A group closes only once its action
  items are cleared (grok-factory ``skills/research-book/SKILL.md`` "Discontinued":
  stop what is in flight, confirm nothing can still publish, then mark cancelled).
  Blocking: a meeting still running, an action item nobody answered, an accepted
  action item whose to-do its owner has not marked done or cancelled. A to-do owned by
  a removed lead cannot be cleared by anyone, so it is listed but does not block.
* :func:`removal_impact`. What removing a lead touches, shown before the owner
  confirms (botroster ``Bots::delete`` returns ``Deleted {messages, routines, left,
  emptied}``). Removing still only retires the lead (``identity.retire``); nothing
  here changes the lead record or deletes history.

Every function here reads the ledger and returns lists for people: handles and
titles, never ids.
"""

from __future__ import annotations

from pathlib import Path

from . import fold, ledger, meeting

OWNER = fold.OWNER
LIVE_MEETING = ("convening", "open", "adjourning")


def _refused(reason: str, **extra) -> dict:
    return {"status": "refused", "reason": reason, **extra}


def _group_meetings(root: Path, cid: str) -> list[dict]:
    rows = ledger.read(root, fold.channel_file(cid))
    return [m for m in (meeting.fold_meeting(rows, mid) for mid in meeting.meetings_in(rows)) if m]


def _todo_states(root: Path, lead_id: str) -> dict[str, dict]:
    return meeting.todo_states(ledger.read(root, fold.member_file(lead_id)))


def close_blockers(root: Path, cid: str) -> dict:
    """``{blocking: [...], notes: [...]}`` for closing group ``cid``; each entry is
    ``{kind, text}``. Empty ``blocking`` means the group may close."""
    d = fold.directory(root)
    names = {k: v["handle"] for k, v in d["leads"].items()}
    active = {k for k, v in d["leads"].items() if v["active"]}

    def nm(who: str) -> str:
        return "Owner" if who == OWNER else "@" + names.get(who, "a member")
    blocking: list[dict] = []
    notes: list[dict] = []
    todos: dict[str, dict[str, dict]] = {}
    for m in _group_meetings(root, cid):
        if m["state"] in LIVE_MEETING:
            blocking.append({"kind": "meeting", "text": f"Meeting “{m['title']}” is still running"})
        for a in m["actions"].values():
            who = a["owner"]
            if a["state"] == "proposed":
                if who in active:
                    blocking.append({"kind": "action",
                                     "text": f"Action item “{a['title']}” for {nm(who)} has no answer yet"})
                else:
                    notes.append({"kind": "action", "text": f"Action item “{a['title']}” was never answered; "
                                                            f"{nm(who)} was removed"})
            elif a["state"] == "accepted" and a.get("todo_ref"):
                if who not in todos:
                    todos[who] = _todo_states(root, who)
                st = todos[who].get(a["todo_ref"], {"state": "open"})["state"]
                if st != "open":
                    continue
                if who in active:
                    blocking.append({"kind": "todo",
                                     "text": f"Action item “{a['title']}” is still open in {nm(who)}'s to-dos"})
                else:
                    notes.append({"kind": "todo", "text": f"Action item “{a['title']}” stays open; "
                                                          f"{nm(who)} was removed"})
    ch = fold.fold_channel(root, cid)
    for a in ch["assignments"].values():
        if a["state"] in ("open", "asked"):
            notes.append({"kind": "request", "text": f"{nm(a['from'])}'s request to {nm(a['to'])} is still open"})
    return {"blocking": blocking, "notes": notes}


def close_group(root: Path, cid: str, by: str = OWNER) -> dict:
    """Close group ``cid`` when nothing blocks. Closed: no posts, member changes or meetings."""
    if not isinstance(cid, str) or not cid.startswith("G-"):
        return _refused("not_a_group")
    with ledger.transaction(root):
        try:
            ch = fold.fold_channel(root, cid)
        except ledger.LedgerError:
            return _refused("no_such_channel")
        if ch["kind"] != "group":
            return _refused("no_such_channel")
        if ch.get("closed"):
            return _refused("group_closed")
        if ledger.is_mirror(root, fold.channel_file(cid)):
            return _refused("remote_group")  # the other owner hosts it; leave it from Across owners
        left = close_blockers(root, cid)
        if left["blocking"]:
            return _refused("open_items", **left)
        ledger.append(root, fold.channel_file(cid), "channel/closed", by, {"by": by})
        return {"status": "accepted", "notes": left["notes"]}


def removal_impact(root: Path, lead_id: str) -> dict:
    """What removing ``lead_id`` touches. Writes nothing."""
    d = fold.directory(root)
    lead = d["leads"].get(lead_id)
    if not lead or not lead["active"]:
        return _refused("unknown_lead")
    names = {k: v["handle"] for k, v in d["leads"].items()}
    active = {k for k, v in d["leads"].items() if v["active"]}

    def nm(who: str) -> str:
        return "Owner" if who == OWNER else "@" + names.get(who, "a member")
    groups, requests, actions, meetings_, cases = [], [], [], [], []
    dms = 0
    for cid in fold.list_channels(root):
        ch = fold.fold_channel(root, cid)
        if lead_id not in ch["members"] or ch.get("closed"):
            continue
        if ch["kind"] == "dm":
            dms += 1
            continue
        left = sum(1 for m in ch["members"] if m != lead_id and m in active)
        groups.append({"title": ch["title"], "left": left, "short": left < 2})
        for a in ch["assignments"].values():
            if a["state"] in ("open", "asked", "taken") and lead_id in (a["from"], a["to"]):
                requests.append({"group": ch["title"], "state": a["state"],
                                 "text": f"{nm(a['from'])}'s request to {nm(a['to'])}"})
        for m in _group_meetings(root, cid):
            seat = lead_id in m["speakers"] or (m["invitees"].get(lead_id) or {}).get("state") == "invited"
            if m["state"] in LIVE_MEETING and seat:
                role = "chair" if m["chair"] == lead_id else "convener" if m["convener"] == lead_id else "attendee"
                meetings_.append({"group": ch["title"], "title": m["title"], "role": role})
            for a in m["actions"].values():
                if a["owner"] != lead_id:
                    continue
                open_ = a["state"] == "proposed" or (
                    a["state"] == "accepted" and a.get("todo_ref")
                    and _todo_states(root, lead_id).get(a["todo_ref"], {"state": "open"})["state"] == "open")
                if open_:
                    actions.append({"group": ch["title"], "title": a["title"],
                                    "state": "unanswered" if a["state"] == "proposed" else "open to-do"})
    from . import decisions  # decisions imports state, which imports meeting; keep the imports local
    from . import state as page_state

    titles = {g["title"] for g in groups}
    in_groups = {cid for cid in fold.list_channels(root)
                 if lead_id in fold.fold_channel(root, cid)["members"]}
    # "waiting on you" is the page's waitingOnYou: an open decision. A replaced, lapsed,
    # standing-answered or elsewhere-answered card is not waiting (MERGED-SMOKE B-MS1).
    open_keys = {d["key"] for d in decisions.listing(root) if d["state"] == "open"}
    for c in page_state.cases(root):
        if c["channel_id"] not in in_groups:
            continue
        waiting = decisions.case_key(c["case_id"]) in open_keys
        working = c["acted"] is None and c["defaulted"] is None
        if waiting or working:
            title = fold.fold_channel(root, c["channel_id"])["title"]
            cases.append({"group": title if title in titles else "a direct message",
                          "state": "waiting on you" if waiting else "bar raiser working"})
    return {"status": "accepted", "handle": lead["handle"], "groups": groups, "dms": dms,
            "requests": requests, "actions": actions, "meetings": meetings_, "cases": cases}
