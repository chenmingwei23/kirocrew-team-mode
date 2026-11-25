"""Admission for every write a lead or the owner makes: messages, groups, relay notes.

One function per action. Each holds ``ledger.transaction(root)`` across its checks
and its writes, so a limit is checked and charged in the same critical section.

Results are ``{status: accepted|held|refused|redirected, ...}``. ``held`` and
``refused`` always carry ``advice = "do not retry; end this turn"``. A refused send
writes nothing and spends nothing; a redirected one spends nothing and writes only a
``reply/redirected`` trace (once per message and lead) for the owner's card back.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from pathlib import Path

from . import decisions, fold, identity, ledger, limits

OWNER = fold.OWNER
CONTROL = limits.CONTROL
BAR_RAISER = "bar_raiser"


def _closed(rows: list[dict], timeline: str) -> bool:
    """A ``chain/closed`` in ``timeline`` with no owner message there after it."""
    closed = reopened = 0
    for row in rows:
        d = row["data"]
        if row["type"] == "chain/closed" and fold.timeline_key(d.get("thread_id")) == timeline:
            closed = row["seq"]
        elif row["type"] == "message/posted" and row["by"] == OWNER and (
                fold.timeline_key(d.get("thread_id")) == timeline
                or (timeline == "main" and d.get("also_main"))):
            reopened = row["seq"]
    return closed > reopened


def take_binding(ch: dict, a: dict) -> dict:
    """What an ``@`` take is bound to (the same shape as an approval): the assignment
    message's seq, a hash of what was asked, and which ask of this pair in this
    timeline it is. Messages are append-only, so a changed ask is a new assignment
    with a new id and ``attempt + 1``; a take answers one assignment once."""
    from . import approval

    msg = next((m for m in ch["messages"].values() if m["seq"] == a["msg_seq"]), {})
    attempt = sum(1 for x in ch["assignments"].values()
                  if x["from"] == a["from"] and x["to"] == a["to"] and x["thread_id"] == a["thread_id"]
                  and x["msg_seq"] <= a["msg_seq"])
    content = {"from": a["from"], "to": a["to"], "thread_id": a["thread_id"], "text_sha16": msg.get("digest")}
    return approval.bind(a["msg_seq"], content, attempt)


def _refused(reason: str, **extra) -> dict:
    return {"status": "refused", "reason": reason, "advice": limits.ADVICE_STOP, **extra}


def _new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def _by(sender: str) -> str:
    return OWNER if sender == OWNER else f"lead:{sender}"


def _ids(value, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValueError(field)
    return list(dict.fromkeys(value))


# --------------------------------------------------------------------------- channels


def _find_dm(root: Path, a: str, b: str) -> str | None:
    want = sorted([a, b])
    for cid in fold.list_channels(root):
        if not cid.startswith("D-"):
            continue
        ch = fold.fold_channel(root, cid)
        parties = sorted(ch["members"] + ch["people"])
        if parties == want:
            return cid
    return None


def _assignment_home(root: Path, assignment_id: str) -> tuple[str, str | None] | None:
    """(channel_id, thread_id) of the channel that holds ``assignment_id``, or None."""
    for cid in fold.list_channels(root):
        a = fold.fold_channel(root, cid)["assignments"].get(assignment_id)
        if a is not None:
            return cid, a["thread_id"]
    return None


def _open_dm(root: Path, sender: str, to: str, now: float) -> tuple[str | None, dict | None]:
    leads = identity.active_leads(root)
    if to != OWNER and to not in leads:
        # Inbox items name the sender by handle (wake._wrap "from"), so a lead answering a DM
        # naturally passes to=<handle>; map an active lead's handle to its lead_id.
        to = next((lid for lid, l in leads.items() if l.get("handle") == to), to)
    if to != OWNER and to not in leads:
        return None, _refused("not_a_lead")
    if sender != OWNER and sender not in leads:
        return None, _refused("not_a_lead")
    if to == sender:
        return None, _refused("dm_self")
    cid = _find_dm(root, sender, to)
    if cid:
        return cid, None
    cid = _new_id("D")
    members = [p for p in (sender, to) if p != OWNER]
    people = [OWNER] if OWNER in (sender, to) else []
    ledger.append(root, fold.channel_file(cid), "channel/opened", _by(sender),
                  {"kind": "dm", "title": "", "members": members, "people": people,
                   "creator": sender, "managers": [], "bar_raiser": "default"}, now=now)
    return cid, None


def open_group(root: Path, creator: str, title: str, members: list[str],
               managers: list[str] | None = None, now: float | None = None) -> dict:
    """``creator`` is a lead id or ``"owner"``. A lead creator is always a member."""
    now = time.time() if now is None else now
    if not isinstance(title, str) or not (1 <= len(title.strip()) <= 80):
        return _refused("bad_title")
    try:
        members = _ids(members, "members")
        managers = _ids(managers, "managers")
    except ValueError as exc:
        return _refused(f"bad_{exc}")
    with ledger.transaction(root):
        if limits.stopped(root):
            return _refused("stopped")
        leads = identity.active_leads(root)
        if creator != OWNER:
            if creator not in leads:
                return _refused("not_a_lead")
            if creator not in members:
                members.insert(0, creator)
        if any(m not in leads for m in members) or any(m not in members for m in managers):
            return _refused("not_a_lead")
        if not (limits.GROUP_MIN <= len(members) <= limits.GROUP_MAX):
            return _refused("group_size", limit=f"{limits.GROUP_MIN}-{limits.GROUP_MAX} leads")
        # Opening the same group twice reuses it (agent-org-chart PROTOCOL.md "created vs reused").
        same = reusable_group(root, title, members)
        if same:
            return {"status": "accepted", "channel_id": same, "created": [], "reused": [same]}
        cid = _new_id("G")
        # Opening a group writes no inbox row, so it wakes nobody; the first message does.
        ledger.append(root, fold.channel_file(cid), "channel/opened", _by(creator),
                      {"kind": "group", "title": title.strip(), "members": members, "people": [OWNER],
                       "creator": creator, "managers": managers, "bar_raiser": "default"}, now=now)
        return {"status": "accepted", "channel_id": cid, "created": [cid], "reused": []}


def reusable_group(root: Path, title: str, members: list[str]) -> str | None:
    """An open group with the same title (case and spaces ignored) and the same members."""
    want = (" ".join(title.split()).casefold(), sorted(members))
    for cid in fold.list_channels(root):
        if not cid.startswith("G-"):
            continue
        ch = fold.fold_channel(root, cid)
        if not ch.get("closed") and (" ".join(ch["title"].split()).casefold(), sorted(ch["members"])) == want:
            return cid
    return None


def change_members(root: Path, channel_id: str, add: list[str], remove: list[str],
                   by: str = OWNER) -> dict:
    """Owner (or a manager lead) adds or removes group members."""
    try:
        add, remove = _ids(add, "add"), _ids(remove, "remove")
    except ValueError as exc:
        return _refused(f"bad_{exc}")
    if not isinstance(channel_id, str) or not channel_id.startswith("G-"):
        return _refused("not_a_group")
    with ledger.transaction(root):
        try:
            ch = fold.fold_channel(root, channel_id)
        except ledger.LedgerError:
            return _refused("no_such_channel")
        if not ch["kind"]:
            return _refused("no_such_channel")
        if ch.get("closed"):
            return _refused("group_closed")
        if by != OWNER and by not in ch["managers"]:
            return _refused("not_allowed")
        leads = identity.active_leads(root)
        final = [m for m in ch["members"] if m not in remove] + [a for a in add if a not in ch["members"]]
        if any(a not in leads for a in add):
            return _refused("not_a_lead")
        if not (limits.GROUP_MIN <= len(final) <= limits.GROUP_MAX):
            return _refused("group_size", limit=f"{limits.GROUP_MIN}-{limits.GROUP_MAX} leads")
        rows = [(fold.channel_file(channel_id), "member/added", _by(by), {"who": a, "by": by})
                for a in add if a not in ch["members"]]
        rows += [(fold.channel_file(channel_id), "member/left", _by(by), {"who": r, "by": by})
                 for r in remove if r in ch["members"]]
        if rows:
            ledger.append_many(root, rows)  # member/added is no inbox row: adding wakes nobody
        return {"status": "accepted", "members": final,
                # created/reused name the group only; members are existing leads, never created here
                "added": [a for a in add if a not in ch["members"]],
                "already_members": [a for a in add if a in ch["members"]]}


# --------------------------------------------------------------------------- send


def _sender_post_ts(root: Path, sender: str) -> list[float]:
    out = []
    for cid in fold.list_channels(root):
        ch = fold.fold_channel(root, cid)
        out += [m["ts"] for m in ch["messages"].values() if m["by"] == sender]
    return out


def _segment_root(rows: list[dict], channel: dict, thread_id: str | None) -> int:
    """Seq where the current chain segment of a timeline starts (B keys cases on it)."""
    tl = fold.timeline_key(thread_id)
    start = channel["threads"][thread_id]["root_seq"] if thread_id else 0
    return max(start, limits._reset_seq(rows, channel, tl))


def post(root: Path, sender: str, *, text: str, channel_id: str | None = None, to: str | None = None,
         thread: str | None = "main", root_seq: int | None = None, also_main: bool = False,
         mentions: list[str] | None = None, cc: list[str] | None = None, everyone: bool = False,
         answers: str | None = None, response: str | None = None, reason: str | None = None,
         reply_to: int | None = None, kind: str = "message", now: float | None = None) -> dict:
    """Admit one message from ``sender`` (a lead id, or ``"owner"``)."""
    now = time.time() if now is None else now
    is_owner = sender == OWNER
    if not isinstance(text, str) or not text.strip():
        return _refused("empty_text")
    if len(text) > limits.MAX_TEXT:
        return _refused("text_too_long", limit=limits.MAX_TEXT)
    if kind not in ("message", "request", "reply", "notice"):
        return _refused("bad_kind")
    # a notice ("I am missing X") goes to briefs only: it names nobody and answers nothing
    if kind == "notice" and (mentions or cc or everyone or answers is not None):
        return _refused("notice_names_nobody",
                        advice="a notice cannot @, cc, @everyone or answer; @ someone with a normal message "
                               "to ask them; fix the arguments and call again")
    try:
        mentions, cc = _ids(mentions, "mentions"), _ids(cc, "cc")
    except ValueError as exc:
        return _refused(f"bad_{exc}")
    # Inbox and directory name leads by handle, so a lead naturally @s "Uma"; map an active
    # lead's handle to its lead_id, as _open_dm does for to=<handle>.
    by_handle = {l.get("handle"): lid for lid, l in identity.active_leads(root).items() if l.get("handle")}
    mentions = [by_handle.get(m, m) for m in mentions]
    cc = [by_handle.get(m, m) for m in cc]
    # "bar_raiser" is a reserved word, not a lead: it asks for the room's bar raiser
    # (B's `requested` trigger reads it), opens no assignment and takes no @ slot.
    summon_br = BAR_RAISER in mentions
    mentions = [m for m in mentions if m != BAR_RAISER]
    if summon_br and kind != "request":
        return _refused("bar_raiser_needs_request")
    if len(mentions) > limits.MAX_MENTIONS:
        return _refused("too_many_mentions", limit=limits.MAX_MENTIONS)
    if len(cc) > limits.MAX_CC:
        return _refused("too_many_cc", limit=limits.MAX_CC)
    if sender in mentions or sender in cc:
        return _refused("self_mention")
    if (channel_id is None) == (to is None):
        return _refused("need_channel_or_to")

    with ledger.transaction(root):
        if limits.stopped(root):
            return _refused("stopped")
        if not is_owner and sender not in identity.active_leads(root):
            return _refused("not_a_lead")
        if to is not None and isinstance(answers, str):
            # an answer to an @ belongs where the @ is, even when the lead sends it as a DM
            home = _assignment_home(root, answers)
            if home is not None:
                channel_id, to, thread = home[0], None, home[1] or "main"
        if to is not None:
            if thread not in (None, "main") or mentions or cc or everyone or summon_br:
                return _refused("dm_main_only")
            channel_id, err = _open_dm(root, sender, to, now)
            if err:
                return err
        file = fold.channel_file(channel_id)
        try:
            rows = ledger.read(root, file)
        except ledger.LedgerError:
            return _refused("no_such_channel")
        ch = fold.fold_channel(root, channel_id, rows)
        if not ch["kind"]:
            return _refused("no_such_channel")
        if ch.get("closed"):
            return _refused("group_closed")
        if not is_owner and sender not in ch["members"]:
            return _refused("not_a_member")
        if ch["kind"] == "dm" and (thread not in (None, "main") or mentions or cc or everyone or summon_br):
            return _refused("dm_main_only")
        out_rows: list[tuple[str, str, str, dict]] = []
        by = _by(sender)

        # --- timeline
        thread_id: str | None = None
        if thread == "new":
            if not isinstance(root_seq, int):
                return _refused("root_seq_required")
            root_msg = next((m for m in ch["messages"].values() if m["seq"] == root_seq), None)
            if root_msg is None or root_msg["thread_id"] is not None:
                return _refused("bad_root_seq")
            thread_id = f"T-{root_seq}"
            if thread_id not in ch["threads"]:
                out_rows.append((file, "thread/opened", by,
                                 {"thread_id": thread_id, "root_seq": root_seq, "opener": sender}))
                out_rows.append((file, "thread/member_added", "app",
                                 {"thread_id": thread_id, "who": root_msg["by"], "via": "root"}))
                if sender != root_msg["by"]:
                    out_rows.append((file, "thread/member_added", "app",
                                     {"thread_id": thread_id, "who": sender, "via": "post"}))
            elif not is_owner and sender not in ch["threads"][thread_id]["participants"]:
                return _refused("not_a_participant")
        elif thread not in (None, "main"):
            if thread not in ch["threads"]:
                return _refused("no_such_thread")
            thread_id = thread
            if sender not in ch["threads"][thread_id]["participants"]:
                if not is_owner:
                    return _refused("not_a_participant")
                out_rows.append((file, "thread/member_added", "app",
                                 {"thread_id": thread_id, "who": OWNER, "via": "post"}))
        # a meeting thread has a floor: leads speak there only with a granted turn
        if not is_owner and thread_id in ch["threads"] and ch["threads"][thread_id].get("mode") == "meeting":
            return _refused("meeting_thread", advice="speak in a meeting only with team_meeting_speak and your "
                                                     "turn_id; end this turn")
        if also_main and thread_id is None:
            also_main = False
        participants = set(ch["threads"][thread_id]["participants"]) if thread_id in ch["threads"] else set()
        if thread_id and thread_id not in ch["threads"]:
            participants |= {sender, next(m["by"] for m in ch["messages"].values() if m["seq"] == root_seq)}

        # --- mentions, cc
        for who in mentions + cc:
            if who == OWNER:
                return _refused("cannot_assign_person")
            if who not in ch["members"]:
                return _refused("not_a_member", who=who)
        if not is_owner:
            for who in mentions:
                open_pair = sum(1 for a in ch["assignments"].values()
                                if a["from"] == sender and a["to"] == who and a["state"] in ("open", "asked"))
                if open_pair >= limits.MAX_OPEN_ASSIGN_PAIR:
                    return _refused("too_many_open_assignments", limit=limits.MAX_OPEN_ASSIGN_PAIR,
                                    advice="wait for answers")

        # --- @everyone
        if everyone:
            if thread_id is not None:
                return _refused("everyone_main_only")
            if not is_owner and sender != ch["creator"] and sender not in ch["managers"]:
                return _refused("everyone_not_allowed")
            hour = [m for m in ch["messages"].values() if m["everyone"] and now - m["ts"] < 3600]
            if len(hour) >= limits.EVERYONE_PER_GROUP_HOUR:
                return _refused("everyone_rate", limit=limits.EVERYONE_PER_GROUP_HOUR)
            if not is_owner and sum(1 for m in hour if m["by"] == sender) >= limits.EVERYONE_PER_SENDER_HOUR:
                return _refused("everyone_rate", limit=limits.EVERYONE_PER_SENDER_HOUR)

        # --- answers
        answer = None
        if answers is not None:
            a = ch["assignments"].get(answers)
            if a is None:
                return _refused("no_such_assignment")
            if a["to"] != sender:
                return _refused("not_your_assignment")
            if response not in ("take", "decline", "ask", "result", "no_result"):
                return _refused("bad_response")
            # ack step (take/decline/ask) while open or asked; result step also after a take
            allowed = ("open", "asked", "taken") if response in ("result", "no_result") else ("open", "asked")
            if a["state"] not in allowed:
                return _refused("assignment_taken" if a["state"] == "taken" else "assignment_closed",
                                **({"advice": "you already took it; send response result or no_result "
                                              "when done; fix the arguments and call again"}
                                   if a["state"] == "taken" else {}))
            if response == "decline" and (not isinstance(reason, str) or len(reason.strip()) < 8):
                return _refused("decline_needs_reason")
            answer = {"assignment_id": answers, "response": response, "reason": reason or ""}
            if response == "take":
                answer["binding"] = take_binding(ch, a)

        # --- reply_to
        reply_msg = None
        if reply_to is not None:
            reply_msg = next((m for m in ch["messages"].values() if m["seq"] == reply_to), None)
            if reply_msg is None:
                return _refused("bad_reply_to")

        digest = hashlib.sha256(text.encode()).hexdigest()[:16]
        hold_reason = ""
        timelines = [fold.timeline_key(thread_id)] + (["main"] if also_main else [])
        hops = 0
        br_resets = sum(1 for r in rows if r["type"] == "chain/reset"
                        and (r["data"].get("thread_id") or "main") == timelines[0])
        if not is_owner:
            # a chain the bar raiser closed stays closed until the owner speaks there
            if any(_closed(rows, tl) for tl in timelines):
                return _refused("thread_closed")
            # unsolicited replies in main
            if reply_msg is not None and thread_id is None and reply_msg["thread_id"] is None \
                    and sender not in reply_msg["mentions"]:
                unsolicited = sum(1 for m in ch["messages"].values()
                                  if m["reply_to"] == reply_to and m["thread_id"] is None
                                  and m["by"].startswith("L-") and m["by"] not in reply_msg["mentions"]
                                  and not m["held"])
                if unsolicited >= limits.UNSOLICITED_MAIN_REPLIES:
                    # round4 A-F2: one trace per (message, lead) so the owner's card back can
                    # say who was held back; it wakes nobody and is not a post or a hop.
                    if not any(r["type"] == "reply/redirected" and r["data"].get("reply_to") == reply_to
                               and r["data"].get("who") == sender for r in rows):
                        ledger.append(root, fold.channel_file(ch["id"]), "reply/redirected", "app",
                                      {"reply_to": reply_to, "who": sender, "reason": "unsolicited_reply_cap",
                                       "answers_in_main": unsolicited}, now=now)
                    return {"status": "redirected", "reason": "unsolicited_reply_cap",
                            "advice": "two members already answered in main; reply in a thread or stay quiet"}
            # duplicate text, sender bucket
            if any(m["by"] == sender and m["digest"] == digest and now - m["ts"] < limits.DUP_TEXT_SECS
                   for m in ch["messages"].values()):
                return _refused("duplicate_text")
            if not limits.bucket_ok(_sender_post_ts(root, sender), now):
                return _refused("sender_rate")
            # hops and backstops
            h = limits.next_hops(rows, ch, sender, timelines)
            hops = 0 if kind == "notice" else h["hops"]  # a notice is not a hop (next_hops skips it too)
            if h["chain_len"] + 1 > limits.BACKSTOP_CHAIN or h["same_node"] + 1 >= limits.BACKSTOP_SAME_NODE:
                ledger.append(root, file, "alert/backstop", "app",
                              {"sender": sender, "chain_len": h["chain_len"] + 1,
                               "same_node": h["same_node"] + 1, "thread_id": thread_id}, now=now)
                return _refused("chain_backstop", limit=f"chain {limits.BACKSTOP_CHAIN}, same node "
                                                        f"{limits.BACKSTOP_SAME_NODE}")
            if hops > limits.HOP_LIMIT:
                hold_reason = "hop_limit"
            # channel window / cool-down
            if not hold_reason:
                if ch["cooling_until"] > now:
                    held_cooling = sum(1 for mid in ch["held"]
                                       if ch["messages"][mid].get("held_reason") == "channel_cooling")
                    if held_cooling >= limits.COOLING_HOLD_MAX:
                        return _refused("channel_cooling")
                    hold_reason = "channel_cooling"
                elif limits.window_count(ch, now) >= limits.WINDOW_MSGS:
                    out_rows.append((file, "channel/cooling", "app",
                                     {"until": now + limits.COOLDOWN_SECS, "from": now}))
                    hold_reason = "channel_cooling"
        if not limits.charge(root, "message", now=now):
            return _refused("stopped", limit="budget")

        msg_id = _new_id("M")
        new_seq_base = len(rows) + sum(1 for r in out_rows if r[0] == file)
        msg_seq = new_seq_base + 1
        if thread_id is not None and thread_id not in ch["threads"]:
            segment = root_seq  # the thread opens in this very write
        else:
            segment = _segment_root(rows, ch, thread_id)
        chain = {"thread_id": thread_id, "root_seq": segment, "hops": hops, "br_resets": br_resets}
        out_rows.append((file, "message/posted", by, {
            "msg_id": msg_id, "thread_id": thread_id, "text": text, "kind": kind,
            "mentions": mentions + ([BAR_RAISER] if summon_br else []),
            "cc": cc, "everyone": bool(everyone), "also_main": bool(also_main), "reply_to": reply_to,
            "answers": answer, "chain": chain}))
        if hold_reason:
            out_rows.append((file, "message/held", "app", {"msg_id": msg_id, "reason": hold_reason}))
        else:
            if thread_id and sender not in participants and not is_owner:
                out_rows.append((file, "thread/member_added", "app",
                                 {"thread_id": thread_id, "who": sender, "via": "post"}))
            in_meeting = thread_id in ch["threads"] and ch["threads"][thread_id].get("mode") == "meeting"
            for who in mentions:
                if in_meeting:
                    continue  # the owner's @ in a meeting names the next speakers (meeting.py rule 2), no assignment
                if thread_id and who not in participants:
                    out_rows.append((file, "thread/member_added", "app",
                                     {"thread_id": thread_id, "who": who, "via": "mention"}))
                    participants.add(who)
                aid = _new_id("A")
                out_rows.append((file, "assignment/opened", "app",
                                 {"assignment_id": aid, "from": sender, "to": who, "msg_seq": msg_seq,
                                  "thread_id": thread_id}))
                out_rows.append((fold.member_file(who), "todo/assigned", "app",
                                 {"assignment_id": aid, "channel_id": channel_id}))
            for who in cc:
                if thread_id and who not in participants:
                    out_rows.append((file, "thread/member_added", "app",
                                     {"thread_id": thread_id, "who": who, "via": "cc"}))
                    participants.add(who)
            if answer:
                state = {"take": "taken", "decline": "declined", "ask": "asked",
                         "result": "closed", "no_result": "closed"}[answer["response"]]
                row = {"assignment_id": answers, "reason": answer["reason"]}
                if state == "closed":
                    row["empty"] = answer["response"] == "no_result"
                if "binding" in answer:
                    row["binding"] = answer["binding"]
                out_rows.append((file, f"assignment/{state}", by, row))
                out_rows.append((fold.member_file(sender), "todo/updated", "app",
                                 {"assignment_id": answers,
                                  "state": {"taken": "claimed", "declined": "declined", "asked": "asked",
                                            "closed": "done"}[state]}))
                if state == "asked" and ch["assignments"][answers]["from"] == OWNER:
                    out_rows.append(decisions.opened_row(decisions.ask_key(channel_id, answers), "ask",
                                                         channel_id=channel_id, assignment_id=answers,
                                                         msg_id=msg_id))
            # a lead's DM to the owner waits on the owner (decisions.dm_asks) until the owner posts there
            if ch["kind"] == "dm" and OWNER in ch["people"] and not is_owner and kind != "notice" \
                    and not any(s["open"] for s in decisions.dm_asks(channel_id, ch, rows, {})):
                out_rows.append(decisions.opened_row(decisions.dm_key(channel_id, msg_seq), "ask",
                                                     channel_id=channel_id, msg_id=msg_id, via="dm"))
        seqs = ledger.append_many(root, out_rows, now=now)
        seq = seqs[[r[1] for r in out_rows].index("message/posted")]
        result = {"status": "held" if hold_reason else "accepted", "msg_id": msg_id, "seq": seq,
                  "channel_id": channel_id, "thread_id": thread_id, "hops": hops}
        if hold_reason:
            result.update(reason=hold_reason, advice="end this turn; the room's bar raiser will decide"
                          if hold_reason == "hop_limit" else limits.ADVICE_STOP)
        return result


def relay_note(root: Path, sender: str, channel_id: str, from_session: str, via_session: str,
               to_session: str, summary: str) -> dict:
    """Record a hop of word passed inside one tree (display only), in a channel I am in."""
    for v in (from_session, via_session, to_session):
        if not isinstance(v, str) or not (1 <= len(v) <= 200):
            return _refused("bad_session")
    if not isinstance(summary, str) or not (1 <= len(summary) <= 500):
        return _refused("bad_summary")
    with ledger.transaction(root):
        if limits.stopped(root):
            return _refused("stopped")
        try:
            ch = fold.fold_channel(root, channel_id)
        except (ledger.LedgerError, TypeError):
            return _refused("no_such_channel")
        if not ch["kind"]:
            return _refused("no_such_channel")
        if sender != OWNER and sender not in ch["members"]:
            return _refused("not_a_member")
        seq = ledger.append(root, fold.channel_file(channel_id), "relay/noted", _by(sender),
                            {"from_session": from_session, "via_session": via_session,
                             "to_session": to_session, "summary": summary})
        return {"status": "accepted", "seq": seq}
