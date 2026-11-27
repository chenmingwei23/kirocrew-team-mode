"""Folds over the ledger: directory, channel state, member state, unread, visibility.

Everything here is derived from the JSONL files in ``ledger.py``. The only cache is
``root/cache/channels/<id>.json`` (a channel fold plus the seq and row digest it was
taken at). It may be deleted at any time; a missing, stale or unreadable cache is
rebuilt from the file, so the files stay the single source of truth.

:func:`visible` is the one place that decides whether ``viewer`` may see an entry.
Every exit (inbox read, thread read, secretary input, bar raiser packet, page routes)
filters through it, directly or through :func:`channel_view` / :func:`unread`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from . import ledger

OWNER = "owner"

# Entry types a lead is told about (unread / inbox). System rows ride in the brief only.
#: Meeting rows addressed to one lead (``data.to``): only that lead is told about them.
#: ``ballot/opened`` names its voters in ``data.voters`` instead (every speaker).
MEETING_TARGETED = {"meeting/invited", "turn/granted", "progress/requested", "action/proposed", "ballot/opened"}


def meeting_targets(d: dict) -> list[str]:
    """The leads a meeting-targeted row asks to act: ``data.to``, or ``data.voters`` for a ballot."""
    return [d["to"]] if d.get("to") else list(d.get("voters") or [])

_INBOX_TYPES = {
    "message/posted", "message/released",
    "assignment/opened", "assignment/taken", "assignment/declined",
    "assignment/asked", "assignment/closed", "assignment/unanswered", "thread/member_added",
} | MEETING_TARGETED

#: Answers to an assignment, in the order a lead gives them: the ack step (take / decline /
#: ask) and then the result step (result / no_result; an empty result is still a reply).
ASSIGN_ANSWERS = ("assignment/taken", "assignment/declined", "assignment/asked", "assignment/closed")


def actor(by: str) -> str:
    """``lead:L-x`` -> ``L-x``; ``owner`` -> ``owner``; others unchanged."""
    return by[5:] if isinstance(by, str) and by.startswith("lead:") else by


_LEAD_ID_RE = re.compile(r"(?:\blead:)?\bL-[0-9a-f]{8}\b")


def handles(root: Path) -> dict[str, str]:
    """lead id -> handle (the id itself when a lead has no handle). The other owner of a
    shared group (``peer:P-x``, whose Bots this directory lists) reads "Other owner"."""
    leads = directory(root)["leads"]
    out = {f"peer:{l['peer']}": "Other owner" for l in leads.values() if l.get("peer")}
    out.update({lid: lead.get("handle") or lid for lid, lead in leads.items()})
    return out


def display_by(by: object, names: dict[str, str]) -> object:
    """``lead:L-x`` / ``L-x`` -> that lead's handle; anything else unchanged.

    For text a person or a model reads; ledger rows keep the id.
    """
    if not isinstance(by, str):
        return by
    who = actor(by)
    return names.get(who, by)


def scrub_ids(text: object, names: dict[str, str]) -> object:
    """Replace every known lead id (``L-xxxxxxxx`` or ``lead:L-xxxxxxxx``) in *text* by its handle.

    Video round 2 (S09/S12/S14): the bar raiser model read ``by: lead:L-...`` in its
    packet and wrote the ids into the case question and rationale the owner sees.
    An unknown id is left as it is.
    """
    if not isinstance(text, str) or not names:
        return text
    return _LEAD_ID_RE.sub(lambda m: names.get(actor(m.group(0)), m.group(0)), text)


def system_text(row: dict, names: dict[str, str]) -> str:
    """A short English sentence for a row with no text (a system row), never its type name.

    e2e round 2: ``thread/member_added`` and ``assignment/opened`` reached the brief
    as their bare type names, because a system row has no text to summarize.
    ``names`` maps lead id to handle.
    """
    d = row.get("data") or {}

    def name(who: object) -> str:
        if who == OWNER:
            return "Owner"
        if who == "bar_raiser":
            return "The bar raiser"
        who = actor(str(who or "someone"))
        return names.get(who, who)

    t = row.get("type", "")
    reason = d.get("reason")
    reason = f": {reason.strip().rstrip('.')}" if isinstance(reason, str) and reason.strip() else ""
    if t == "thread/member_added":
        return f"{name(d.get('who'))} joined the thread."
    if t == "assignment/opened":
        return f"{name(d.get('from'))} assigned this to {name(d.get('to'))}."
    if t in ("assignment/taken", "assignment/declined", "assignment/asked"):
        verb = {"taken": "took", "declined": "declined", "asked": "asked about"}[t.split("/")[1]]
        return f"{name(row.get('by'))} {verb} the assignment{reason}."
    if t == "assignment/closed":
        return (f"{name(row.get('by'))} closed the assignment: no result." if d.get("empty")
                else f"{name(row.get('by'))} sent the result of the assignment.")
    if t == "assignment/unanswered":
        return ("An assignment got no result in time." if d.get("reason") == "no_result"
                else "An assignment got no answer in time.")
    if t == "meeting/invited":
        return f"You are invited to the meeting \"{d.get('title', '')}\"; answer with team_meeting_respond."
    # round4 F4: people (the secretary brief) and Bots read these; "item 1", never I1 / I1-B1
    item = str(d.get("item_id") or "").lstrip("I") or "?"
    if t == "turn/granted":
        return (f"Your turn in the meeting \"{d.get('title', '')}\": item {item} "
                f"\"{d.get('item_title', '')}\", round {d.get('round')}/{d.get('rounds_cap', '?')}.")
    if t == "progress/requested":
        return f"As chair, give the progress check for round {d.get('round')} of item {item}."
    if t == "action/proposed":
        return f"{name(d.get('by'))} proposed an action item for you: {d.get('title', '')}."
    if t == "ballot/opened":
        return (f"Vote now on item {item}: "
                f"{', '.join(map(str, d.get('options') or []))}; answer with team_meeting_vote.")
    return f"System update: {t.replace('/', ' ').replace('_', ' ')}." if t else "System update."


def channel_file(channel_id: str) -> str:
    return f"channels/{channel_id}.jsonl"


def member_file(lead_id: str) -> str:
    return f"members/{lead_id}.jsonl"


def timeline_key(thread_id: str | None) -> str:
    return thread_id or "main"


# --------------------------------------------------------------------------- directory


def directory(root: Path) -> dict:
    """``{leads: {lead_id: {...}}, by_label: {label: lead_id}}``.

    A lead's ``kind`` is ``bot`` (an existing Bot; ``bot`` = its crew key, ``project``
    = its workspace name), ``chat`` (legacy lead chat) or ``remote`` (another owner's
    Bot in a cross-owner group; ``peer`` = that owner's gateway, never woken here). Old ``directory/seen`` rows
    from before Bots are ignored."""
    leads: dict[str, dict] = {}
    by_label: dict[str, str] = {}
    for row in ledger.read(root, "directory.jsonl"):
        d = row["data"]
        if row["type"] == "lead/registered":
            leads[d["lead_id"]] = {"lead_id": d["lead_id"], "handle": d.get("handle", ""),
                                   "session_label": d["session_label"], "kind": d.get("kind", "chat"),
                                   "bot": d.get("bot", ""), "project": d.get("project", ""),
                                   "peer": d.get("peer", ""), "registered_ts": row["ts"], "active": True}
            by_label[d["session_label"]] = d["lead_id"]
        elif row["type"] == "lead/retired":
            lead = leads.get(d.get("lead_id", ""))
            if lead:
                lead["active"] = False
                by_label.pop(lead["session_label"], None)
    return {"leads": leads, "by_label": by_label}


# --------------------------------------------------------------------------- channel


def _empty_channel(channel_id: str) -> dict:
    return {"id": channel_id, "kind": "", "title": "", "members": [], "people": [], "creator": "",
            "managers": [], "bar_raiser": "default", "threads": {}, "messages": {}, "held": [],
            "assignments": {}, "cooling_until": 0.0, "seq": 0, "opened_ts": 0.0,
            "revealed": [], "ballots_closed": [], "closed": False, "shared": False}


def _apply(state: dict, row: dict) -> None:
    t, d = row["type"], row["data"]
    state["seq"] = row["seq"]
    if t == "channel/opened":
        state.update(kind=d["kind"], title=d.get("title", ""), members=list(d.get("members", [])),
                     people=list(d.get("people", [])), creator=d.get("creator", ""),
                     managers=list(d.get("managers", [])), bar_raiser=d.get("bar_raiser", "default"),
                     opened_ts=row["ts"])
    elif t == "member/added":
        if d["who"] not in state["members"]:
            state["members"].append(d["who"])
    elif t == "member/left":
        if d["who"] in state["members"]:
            state["members"].remove(d["who"])
        for th in state["threads"].values():
            if d["who"] in th["participants"]:
                th["participants"].remove(d["who"])
    elif t == "thread/opened":
        state["threads"][d["thread_id"]] = {"root_seq": d["root_seq"], "opener": d["opener"],
                                            "participants": [], "count": 0, "last_ts": row["ts"],
                                            "mode": d.get("mode", "chat"), "meeting_id": d.get("meeting_id")}
    elif t == "thread/member_added":
        th = state["threads"].get(d["thread_id"])
        if th is not None and d["who"] not in th["participants"]:
            th["participants"].append(d["who"])
    elif t == "message/posted":
        state["messages"][d["msg_id"]] = {
            "seq": row["seq"], "by": actor(row["by"]), "thread_id": d.get("thread_id"),
            "also_main": bool(d.get("also_main")), "hops": int((d.get("chain") or {}).get("hops", 0)),
            "ts": row["ts"], "held": False, "kind": d.get("kind", "message"),
            "reply_to": d.get("reply_to"), "mentions": list(d.get("mentions") or []),
            "everyone": bool(d.get("everyone")), "digest": hashlib.sha256(d.get("text", "").encode()).hexdigest()[:16],
            "meeting": isinstance(d.get("meeting"), dict),
            "sealed_key": (d.get("meeting") or {}).get("sealed_key") if isinstance(d.get("meeting"), dict) else None,
        }
        th = state["threads"].get(d.get("thread_id") or "")
        if th is not None:
            th["count"] += 1
            th["last_ts"] = row["ts"]
    elif t == "message/held":
        m = state["messages"].get(d["msg_id"])
        if m is not None:
            m["held"] = True
            m["held_reason"] = d.get("reason", "")
            if d["msg_id"] not in state["held"]:
                state["held"].append(d["msg_id"])
    elif t == "message/released":
        m = state["messages"].get(d["msg_id"])
        if m is not None:
            m["held"] = False
            m["hops"] = 0
            m["released_seq"] = row["seq"]
            if d["msg_id"] in state["held"]:
                state["held"].remove(d["msg_id"])
    elif t == "assignment/opened":
        state["assignments"][d["assignment_id"]] = {
            "assignment_id": d["assignment_id"], "from": d["from"], "to": d["to"],
            "msg_seq": d["msg_seq"], "thread_id": d.get("thread_id"), "state": "open",
            "opened_ts": row["ts"], "reason": "", "updated_ts": row["ts"],
            "acked_ts": None, "empty": False}
    elif t in ASSIGN_ANSWERS or t == "assignment/unanswered":
        a = state["assignments"].get(d["assignment_id"])
        if a is not None:
            a["state"] = t.split("/", 1)[1]
            a["reason"] = d.get("reason", "")
            a["updated_ts"] = row["ts"]
            if t == "assignment/taken":
                a["acked_ts"] = row["ts"]
            if t == "assignment/closed":
                a["empty"] = bool(d.get("empty"))
            if d.get("binding"):
                a["binding"] = d["binding"]  # (msg seq, ask hash, attempt) the take is bound to
    elif t == "channel/closed":
        state["closed"] = True
    elif t == "channel/shared":
        state["shared"] = True  # a cross-owner group (shared_rules.py)
    elif t == "channel/cooling":
        state["cooling_until"] = float(d.get("until", 0))
    elif t == "agenda/round_revealed":
        state["revealed"].append(f"{d['meeting_id']}:{d['item_id']}:{d['round']}")
    elif t == "ballot/closed":
        state["ballots_closed"].append(d["ballot_id"])


def _row_digest(row: dict) -> str:
    return hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()


def _cache_path(root: Path, channel_id: str) -> Path:
    return Path(root) / "cache" / "channels" / f"{channel_id}.json"


def _load_cache(root: Path, channel_id: str, rows: list[dict]) -> dict | None:
    try:
        cached = json.loads(_cache_path(root, channel_id).read_text())
        seq = int(cached["seq"])
        if seq < 1 or seq > len(rows) or cached["digest"] != _row_digest(rows[seq - 1]):
            return None
        state = cached["state"]
        if state.get("seq") != seq or state.get("id") != channel_id or "revealed" not in state:
            return None  # "revealed" missing: a cache from before meetings, rebuild
        return state
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _save_cache(root: Path, channel_id: str, state: dict, rows: list[dict]) -> None:
    if not rows:
        return
    path = _cache_path(root, channel_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"seq": state["seq"], "digest": _row_digest(rows[state["seq"] - 1]),
                                   "state": state}))
        os.replace(tmp, path)
    except OSError:
        pass  # cache is optional


def fold_channel(root: Path, channel_id: str, rows: list[dict] | None = None, *, use_cache: bool = True) -> dict:
    """Fold a channel file into its state dict (JSON-serialisable)."""
    if rows is None:
        rows = ledger.read(root, channel_file(channel_id))
    state = _load_cache(root, channel_id, rows) if use_cache else None
    if state is None:
        state = _empty_channel(channel_id)
    for row in rows[state["seq"]:]:
        _apply(state, row)
    if use_cache and rows and state["seq"] == len(rows):
        _save_cache(root, channel_id, state, rows)
    return state


THREAD_TITLE_WORDS = 6


def thread_titles(root: Path, channel_id: str, rows: list[dict] | None = None) -> dict[str, str]:
    """``thread_id -> title``: the first ~6 words of the thread's first post (round5 S42).

    People see a thread by what it is about, never by the root seq its id carries."""
    if rows is None:
        rows = ledger.read(root, channel_file(channel_id))
    names = handles(root)
    out: dict[str, str] = {}
    for row in rows:
        d = row.get("data") or {}
        tid = d.get("thread_id")
        if row.get("type") != "message/posted" or not tid or tid in out:
            continue
        words = str(scrub_ids(str(d.get("text") or ""), names)).split()
        if words:
            out[tid] = " ".join(words[:THREAD_TITLE_WORDS]) + ("…" if len(words) > THREAD_TITLE_WORDS else "")
    return out


def thread_place(titles: dict[str, str], thread_id: object) -> str:
    """The words for a thread wherever a person reads its place: thread: "first words…"."""
    t = titles.get(str(thread_id or ""))
    return f'thread: "{t}"' if t else "thread"


def list_channels(root: Path) -> list[str]:
    return [f.split("/", 1)[1][:-6] for f in ledger.list_files(root, "channels")]


# --------------------------------------------------------------------------- visibility


def _entry_thread(entry: dict, channel: dict) -> str | None:
    d = entry.get("data") or {}
    if "thread_id" in d:
        return d.get("thread_id")
    if "msg_id" in d:
        m = channel["messages"].get(d["msg_id"])
        return m["thread_id"] if m else None
    if "assignment_id" in d:
        a = channel["assignments"].get(d["assignment_id"])
        return a["thread_id"] if a else None
    return None


def visible(entry: dict, channel: dict, viewer: str) -> bool:
    """May ``viewer`` (a lead_id or ``"owner"``) see ``entry`` of ``channel``?

    The owner sees everything. A lead sees nothing of a channel it is not a member
    of, nothing of a thread it is not a participant of (except a reply copied to main
    with ``also_main``), no held message but its own, and no ``alert/*`` row.

    Meetings: an invitee sees its own invitation and the meeting's convened row
    before it joins the thread; a sealed round-1 speech is seen only by its author
    until the round is revealed; a cast vote only by its voter until the ballot closes.
    """
    if viewer == OWNER:
        return True
    if viewer not in channel.get("members", []):
        return False
    t = entry.get("type", "")
    d = entry.get("data") or {}
    if t.startswith("alert/"):
        return False
    if t == "meeting/invited" and d.get("to") == viewer:
        return True
    if t == "meeting/convened" and viewer in (d.get("invitees") or []):
        return True
    if t == "ballot/cast" and d.get("ballot_id") not in channel.get("ballots_closed", []) \
            and actor(entry.get("by", "")) != viewer:
        return False
    msg = channel["messages"].get(d.get("msg_id", "")) if "msg_id" in d else None
    if msg is not None and t in ("message/posted", "message/held") and msg["held"] and msg["by"] != viewer:
        return False
    if msg is not None and t == "message/posted" and msg.get("sealed_key") \
            and msg["sealed_key"] not in channel.get("revealed", []) and msg["by"] != viewer:
        return False
    thread_id = _entry_thread(entry, channel)
    if thread_id:
        if t == "thread/opened":
            return True  # the stub of a thread is visible in main to every member
        if msg is not None and msg["also_main"] and t in ("message/posted", "message/released"):
            return True
        th = channel["threads"].get(thread_id)
        return th is not None and viewer in th["participants"]
    return True


def thread_stub(channel: dict, thread_id: str) -> dict:
    th = channel["threads"][thread_id]
    return {"thread_id": thread_id, "root_seq": th["root_seq"], "count": th["count"],
            "last_ts": th["last_ts"], "participants": list(th["participants"])}


def channel_view(root: Path, channel_id: str, viewer: str, *, thread: str | None = "*",
                 since_seq: int = 0) -> dict:
    """What ``viewer`` sees of one channel.

    ``thread="*"`` returns every visible entry; ``None`` / ``"main"`` only main;
    a thread id only that thread. Threads the viewer is not in come back as stubs.
    """
    rows = ledger.read(root, channel_file(channel_id))
    channel = fold_channel(root, channel_id, rows)
    if viewer != OWNER and viewer not in channel["members"]:
        return {"channel": None, "entries": [], "stubs": [], "visible": False}
    want = "main" if thread in (None, "main") else thread
    entries = []
    for row in rows[since_seq:]:
        if not visible(row, channel, viewer):
            continue
        if want != "*":
            tid = _entry_thread(row, channel)
            msg = channel["messages"].get((row.get("data") or {}).get("msg_id", ""))
            in_main = tid is None or (msg is not None and msg["also_main"]) or row["type"] == "thread/opened"
            if want == "main" and not in_main:
                continue
            if want != "main" and tid != want:
                continue
        entries.append(row)
    stubs = [thread_stub(channel, tid) for tid in channel["threads"]]
    meta = {k: channel[k] for k in ("id", "kind", "title", "members", "people", "creator", "managers",
                                     "bar_raiser", "cooling_until", "seq")}
    return {"channel": meta, "entries": entries, "stubs": stubs, "visible": True,
            "held": list(channel["held"]) if viewer == OWNER else []}


# --------------------------------------------------------------------------- members


def fold_member(root: Path, lead_id: str, rows: list[dict] | None = None) -> dict:
    if rows is None:
        rows = ledger.read(root, member_file(lead_id))
    acked: dict[str, int] = {}
    max_hops_read: dict[str, dict] = {}
    todos: dict[str, dict] = {}
    dues: list[dict] = []
    delivered: set[int] = set()
    delivered_ts: dict[int, float] = {}
    briefs: dict[str, dict] = {}
    for row in rows:
        t, d = row["type"], row["data"]
        if t == "inbox/acked":
            cid = d["channel_id"]
            acked[cid] = max(acked.get(cid, 0), int(d["upto"]))
            for tl, h in (d.get("max_hops_read") or {}).items():
                max_hops_read.setdefault(cid, {})[tl] = max(max_hops_read.get(cid, {}).get(tl, 0), int(h))
        elif t == "todo/assigned":
            todos[d["assignment_id"]] = {"assignment_id": d["assignment_id"], "channel_id": d["channel_id"],
                                         "state": "open", "ts": row["ts"]}
        elif t == "todo/updated":
            if d["assignment_id"] in todos:
                todos[d["assignment_id"]]["state"] = d["state"]
        elif t == "wake/due":
            dues.append({"seq": row["seq"], "ts": row["ts"], **d})
        elif t == "wake/delivered":
            delivered.add(int(d["due_seq"]))
            delivered_ts[int(d["due_seq"])] = row["ts"]
        elif t == "secretary/briefed":
            briefs[d["brief_id"]] = {"ts": row["ts"], **d}
    return {"lead_id": lead_id, "acked": acked, "max_hops_read": max_hops_read, "todos": todos,
            "dues": dues, "delivered": sorted(delivered), "delivered_ts": delivered_ts,
            "briefs": briefs, "seq": len(rows)}


def lead_channels(root: Path, lead_id: str) -> list[dict]:
    out = []
    for cid in list_channels(root):
        ch = fold_channel(root, cid)
        if lead_id in ch["members"]:
            out.append(ch)
    return out


def inbox_items(rows: list[dict], channel: dict, viewer: str, after_seq: int) -> list[dict]:
    """Visible inbox-worthy rows after ``after_seq`` for ``viewer``, newest last.

    A released message comes back as its original ``message/posted`` row, stamped
    with the release seq (so acknowledging it moves past the release).
    """
    by_msg = {}
    for row in rows:
        if row["type"] == "message/posted":
            by_msg[row["data"]["msg_id"]] = row
    items = []
    for row in rows[after_seq:]:
        t, d = row["type"], row["data"]
        if t not in _INBOX_TYPES or actor(row["by"]) == viewer:
            continue
        if t == "message/released":
            orig = by_msg.get(d["msg_id"])
            if orig is None or actor(orig["by"]) == viewer:
                continue
            row = {**orig, "seq": row["seq"], "released": True, "orig_seq": orig["seq"]}
        elif t == "message/posted":
            m = channel["messages"].get(d["msg_id"])
            if m is None or m["held"] or m.get("released_seq"):
                continue  # held now, or will surface at its release row
            if m.get("meeting"):
                continue  # meeting speeches are read through team_meeting_read; only grants wake
        elif t in MEETING_TARGETED:
            if viewer not in meeting_targets(d):
                continue
        elif t.startswith("assignment/"):
            a = channel["assignments"].get(d["assignment_id"], {})
            if viewer not in (a.get("from"), a.get("to")):
                continue
        elif t == "thread/member_added" and d.get("who") != viewer:
            continue
        if not visible(row, channel, viewer):
            continue
        items.append({**row, "channel_id": channel["id"]})
    return items


def unread(root: Path, lead_id: str) -> list[dict]:
    """Every unread, visible item for ``lead_id`` across its channels, oldest first."""
    member = fold_member(root, lead_id)
    items: list[dict] = []
    for cid in list_channels(root):
        rows = ledger.read(root, channel_file(cid))
        ch = fold_channel(root, cid, rows)
        if lead_id not in ch["members"]:
            continue
        items.extend(inbox_items(rows, ch, lead_id, member["acked"].get(cid, 0)))
    items.sort(key=lambda r: (r["ts"], r["channel_id"], r["seq"]))
    return items
