"""The cross-owner pipe loop and the owner's actions on it (phase 1, DESIGN.md section 9).

Runs in the gateway process (``hooks.on_startup``) next to the wake loop, every
``LOOP_SECS``. One pass:

1. Outbox: sign each queued envelope, run its text through ``ctx.scrub.outbound``
   and post it to the pipe. A scrub that raises sends nothing.
2. Hub: publish the rows of every group I host that are not out yet (scrubbed the
   same way), with the member roster, to every mirror.
3. Read the pipe. Every envelope must verify against the key this gateway already
   holds for its sender (the join request carries its own key and a proof of the
   invite secret). Then:

   * hub, ``post``: the sender must be admitted and the lead must be one it brought.
     The text is screened (``screen``); a hit is dropped, logged with
     ``ctx.untrusted.record_dropped`` and answered with a ``nack``. An @ of my Bots
     from a peer I have not trusted waits for my owner (``assign/pending``). The rest
     goes through ``send.post`` as that lead, so every hop, rate and budget rule of a
     local group applies, plus ``PEER_POSTS_PER_HOUR``.
   * mirror, ``rows``: signed by the hub I joined. Copied with their own seqs
     (``ledger.append_copy``); a gap asks for a resync. Text from anyone but my own
     Bots is screened the same way and withheld on a hit. The hub owner's ``owner``
     becomes ``peer:P-x``, so my Bots never read it as their own owner.

Whose Bot, whose wake: nothing here wakes anyone. The wake loop wakes my own Bots
from my own ledger (``wake.tick`` skips ``kind: remote``), through
``POST /api/members/{id}/wake``. No envelope reaches any tool on this gateway.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
from pathlib import Path
from typing import Any

from . import fold, identity, ledger, limits, peer, send, shared_rules

log = logging.getLogger("kirocrew.app.team-mode")

LOOP_SECS = 3.0
PEER_POSTS_PER_HOUR = 60
ROWS_PER_ENVELOPE = 25
ENVELOPE_CHARS = 30_000
TEXT_ON_WIRE = 6_000
RESYNC_EVERY_SECS = 30
WITHHELD = "[withheld: failed content screening]"
SCRUBBED_KEYS = ("text", "reason", "summary", "title", "detail", "note", "purpose", "question")

# The app's own rule for words that come from ANOTHER owner's Bot, on top of the host's
# prompt-injection screen (ctx.untrusted.flagged), which it does not copy. A Bot of
# another owner has no business naming this machine's secrets or telling my Bot to drop
# its rules, so those are withheld before my Bot reads them.
_FOREIGN_RISK = [re.compile(p, re.IGNORECASE) for p in (
    r"~/\.(aws|ssh|gnupg|kube|docker|netrc|kiro|kirocrew|config/gcloud)\b",
    r"\.aws/credentials|\bid_(rsa|ed25519|ecdsa)\b|/etc/(passwd|shadow)\b",
    r"\b(ignore|disregard|bypass|override)\s+(the\s+|your\s+|all\s+|my\s+|these\s+|those\s+)*"
    r"(rules?|instructions?|guardrails?|polic(y|ies)|limits?|restrictions?)\b",
    r"(忽略|无视|绕过|跳过).{0,8}(规则|指令|提示|限制|要求|约束)",
    r"(读|读取|打开|发|发送|贴|上传|cat|print|send|show|paste|upload).{0,12}"
    r"(凭证|密钥|私钥|密码|credentials?|secrets?|private\s*keys?|passwords?|api[\s_-]*keys?|tokens?)",
)]


def screen(ctx: Any, text: object) -> bool:
    """True when text from another owner must be withheld from my Bots."""
    if not isinstance(text, str) or not text:
        return False
    untrusted = getattr(ctx, "untrusted", None)
    if untrusted is not None and untrusted.flagged(text):
        return True
    return any(p.search(text) for p in _FOREIGN_RISK)


def _drop(ctx: Any, root: Path, from_peer: str, room: str, reason: str, text: str = "") -> None:
    ledger.append(root, peer.PEERS, "envelope/dropped", "app",
                  {"peer": from_peer, "room": room, "reason": reason, "sample": text[:120]})
    untrusted = getattr(ctx, "untrusted", None)
    if untrusted is not None and text:
        try:
            untrusted.record_dropped("cross_owner_message", sample=text[:200])
        except Exception:  # noqa: BLE001 - an audit write is best effort; the text is already withheld
            log.exception("team-mode: record_dropped failed")


def _scrub(ctx: Any, text: str) -> str:
    """Only scrubbed text leaves this machine. Raises when the scrub cannot run."""
    return ctx.scrub.outbound(text).text


# --------------------------------------------------------------------------- owner actions


def join(root: Path, code: str, bots: list[str]) -> dict:
    """The other owner pastes an invite code and ticks which of their Bots go in."""
    body = peer.read_invite(code)
    if body["expires"] < time.time():
        raise peer.PeerError("invite_expired")
    with ledger.transaction(root):
        st = peer.fold(root)
        if not st["name"]:
            raise peer.PeerError("not_configured")
        if body["channel"] != st["channel"]:
            raise peer.PeerError("different_channel")
        if body["hub"] == peer.self_id(root) or body["room"] in st["hosted"]:
            raise peer.PeerError("own_group")
        if peer.mirror_open(st, body["room"]):
            raise peer.PeerError("already_joined")
        leads = identity.active_leads(root)
        if not isinstance(bots, list) or not (1 <= len(bots) <= 3) or any(
                leads.get(b, {}).get("kind") != "bot" for b in bots):
            raise peer.PeerError("bad_bots")
        file = fold.channel_file(body["room"])
        if ledger.tail_seq(root, file) and not ledger.is_mirror(root, file):
            raise peer.PeerError("own_group")
        ledger.mark_mirror(root, file)
        mine = [{"lead_id": b, "handle": leads[b]["handle"]} for b in bots]
        ledger.append(root, peer.PEERS, "room/joined", "owner",
                      {"room": body["room"], "hub": body["hub"], "hub_pubkey": body["hub_pubkey"],
                       "hub_name": body["hub_name"], "title": body["title"], "bots": mine})
        pub = peer.public_b64(root)
        peer.queue(root, body["room"], "join", {
            "invite": body["invite"], "name": st["name"], "pubkey": pub, "bots": mine,
            "proof": peer.join_proof(body["secret"], body["room"], peer.self_id(root), pub)})
    return {"status": "accepted", "room": body["room"], "hub_name": body["hub_name"], "title": body["title"]}


def admit(root: Path, from_peer: str, room: str) -> dict:
    """The hub owner lets a requesting owner's Bots into the group."""
    with ledger.transaction(root):
        st = peer.fold(root)
        req = st["requests"].get((from_peer, room))
        if not req or req["state"] != "requested":
            return send._refused("no_such_request")
        ch = fold.fold_channel(root, room)
        if ch.get("closed") or not ch["kind"]:
            return send._refused("group_closed")
        if len(ch["members"]) + len(req["bots"]) > limits.GROUP_MAX:
            return send._refused("group_size", limit=f"{limits.GROUP_MIN}-{limits.GROUP_MAX} leads")
        try:
            for b in req["bots"]:
                identity.register_remote(root, b["lead_id"], b["handle"], from_peer, req["name"])
        except identity.IdentityError as exc:
            return send._refused(exc.code)
        rows = [(fold.channel_file(room), "member/added", "owner", {"who": b["lead_id"], "by": "owner",
                                                                   "peer": from_peer})
                for b in req["bots"] if b["lead_id"] not in ch["members"]]
        rows.append((peer.PEERS, "peer/admitted", "owner", {"peer": from_peer, "room": room}))
        # the new mirror starts from row 1
        rows.append((peer.PEERS, "room/published", "app", {"room": room, "upto": 0}))
        ledger.append_many(root, rows)
    return {"status": "accepted"}


def reject(root: Path, from_peer: str, room: str) -> dict:
    with ledger.transaction(root):
        req = peer.fold(root)["requests"].get((from_peer, room))
        if not req or req["state"] != "requested":
            return send._refused("no_such_request")
        ledger.append(root, peer.PEERS, "peer/rejected", "owner", {"peer": from_peer, "room": room})
    return {"status": "accepted"}


def remove(root: Path, from_peer: str, room: str, by: str = "owner") -> dict:
    """Take a peer's Bots out of a group I host; its envelopes are ignored from now on."""
    with ledger.transaction(root):
        st = peer.fold(root)
        if (from_peer, room) not in st["admitted"]:
            return send._refused("not_admitted")
        ch = fold.fold_channel(root, room)
        theirs = [lid for lid, l in identity.active_leads(root).items() if l.get("peer") == from_peer]
        rows = [(fold.channel_file(room), "member/left", by, {"who": lid, "by": by})
                for lid in theirs if lid in ch["members"]]
        rows.append((peer.PEERS, "peer/removed", by, {"peer": from_peer, "room": room}))
        ledger.append_many(root, rows)
        for lid in theirs:
            if not any(lid in fold.fold_channel(root, c)["members"] for c in fold.list_channels(root)):
                identity.retire(root, lid)
        peer.queue(root, room, "removed", {"peer": from_peer})
    return {"status": "accepted"}


def leave(root: Path, room: str) -> dict:
    """The other owner takes their Bots out of a group someone else hosts."""
    with ledger.transaction(root):
        if not peer.mirror_open(peer.fold(root), room):
            return send._refused("not_joined")
        ledger.append(root, peer.PEERS, "room/left", "owner", {"room": room})
        peer.queue(root, room, "leave", {})
    return {"status": "accepted"}


def answer_pending(root: Path, pending_id: str, approve: bool, trust: bool = False) -> dict:
    """The hub owner answers a peer's first @ of my Bots. ``trust`` lets that peer's
    Bots @ mine from now on without asking (undone by removing the peer)."""
    with ledger.transaction(root):
        st = peer.fold(root)
        p = st["pending"].get(pending_id)
        if not p or p["state"] != "pending":
            return send._refused("no_such_request")
        if (p["peer"], p["room"]) not in st["admitted"]:
            return send._refused("not_admitted")
        rows = [(peer.PEERS, "assign/answered", "owner", {"pending_id": pending_id, "approve": bool(approve)})]
        if approve and trust:
            rows.append((peer.PEERS, "peer/assign_trusted", "owner", {"peer": p["peer"]}))
        ledger.append_many(root, rows)
        if not approve:
            peer.queue(root, p["room"], "nack", {"to": p["peer"], "out_id": p["post"].get("out_id", ""),
                                                 "reason": "owner_declined"})
            return {"status": "accepted"}
        res = _admit_post(root, p["peer"], p["room"], p["post"])
    return {"status": "accepted", "post": res}


# --------------------------------------------------------------------------- hub side


def _post_args(data: dict) -> dict | None:
    """The ``send.post`` keywords a peer's ``post`` may carry, type-checked; None if malformed."""
    def ids(v):
        return v if v is None or (isinstance(v, list) and len(v) <= 8 and all(isinstance(x, str) for x in v)) else 0
    out = {"text": data.get("text"), "thread": data.get("thread", "main"), "root_seq": data.get("root_seq"),
           "also_main": bool(data.get("also_main")), "mentions": ids(data.get("mentions")),
           "cc": ids(data.get("cc")), "answers": data.get("answers"), "response": data.get("response"),
           "reason": data.get("reason"), "reply_to": data.get("reply_to"), "kind": data.get("kind", "message")}
    ok = (isinstance(out["text"], str) and (out["thread"] is None or isinstance(out["thread"], str))
          and out["mentions"] != 0 and out["cc"] != 0
          and all(out[k] is None or (isinstance(out[k], int) and not isinstance(out[k], bool))
                  for k in ("root_seq", "reply_to"))
          and all(out[k] is None or isinstance(out[k], str) for k in ("answers", "response", "reason"))
          and out["kind"] in ("message", "request", "reply", "notice"))
    return out if ok else None


def _admit_post(root: Path, from_peer: str, room: str, data: dict) -> dict:
    args = _post_args(data)
    if args is None or send.BAR_RAISER in (args["mentions"] or []):
        return send._refused("bad_post")  # the bar raiser and @everyone stay with my own owner
    return send.post(root, data["lead"], channel_id=room, **args)


def _on_hub(ctx: Any, root: Path, st: dict, env: dict) -> None:
    kind, room, src, d = env["kind"], env["room"], env["from"], env["data"]
    if kind == "join":
        _on_join(ctx, root, st, env)
        return
    if (src, room) not in st["admitted"]:
        _drop(ctx, root, src, room, "not_admitted")
        return
    if not peer.verify(env, st["requests"][(src, room)]["pubkey"]):
        _drop(ctx, root, src, room, "bad_signature")
        return
    if kind == "leave":
        remove(root, src, room, by="app")
        return
    if kind == "resync":
        upto = max(0, int(d.get("from_seq", 1)) - 1) if isinstance(d.get("from_seq"), int) else 0
        if upto < st["published"].get(room, 0):
            ledger.append(root, peer.PEERS, "room/published", "app", {"room": room, "upto": upto})
        return
    if kind == "say":
        _on_say(ctx, root, src, room, d)
        return
    if kind != "post":
        return
    lead = identity.active_leads(root).get(d.get("lead"))
    if not lead or lead.get("peer") != src:
        _drop(ctx, root, src, room, "not_its_bot")  # rule 1: a peer speaks only for its own Bots
        return
    nack = {"to": src, "out_id": d.get("out_id", "")}
    text = d.get("text") if isinstance(d.get("text"), str) else ""
    if screen(ctx, text):
        _drop(ctx, root, src, room, "screened", text)
        peer.queue(root, room, "nack", {**nack, "reason": "screened"})
        return
    if _peer_hour(root, src) >= PEER_POSTS_PER_HOUR:
        _drop(ctx, root, src, room, "peer_rate")
        peer.queue(root, room, "nack", {**nack, "reason": "peer_rate"})
        return
    mine = {lid for lid, l in identity.active_leads(root).items() if l.get("kind") != "remote"}
    named = [m for m in (d.get("mentions") or []) if isinstance(m, str)]
    if src not in st["trusted"] and any(m in mine for m in named):
        pid = "Q-" + secrets.token_hex(4)
        ledger.append(root, peer.PEERS, "assign/pending", "app",
                      {"pending_id": pid, "peer": src, "room": room, "post": d})
        return  # rule 4: the first @ of my Bots from another owner waits for my owner
    res = _admit_post(root, src, room, d)
    if res.get("status") in ("accepted", "held", "redirected"):
        ledger.append(root, peer.PEERS, "envelope/admitted", "app", {"peer": src, "room": room})
    else:
        peer.queue(root, room, "nack", {**nack, "reason": res.get("reason", "refused")})


def _peer_hour(root: Path, src: str) -> int:
    return sum(1 for r in ledger.read(root, peer.PEERS) if r["type"] == "envelope/admitted"
               and r["data"].get("peer") == src and time.time() - r["ts"] < 3600)


def _on_say(ctx: Any, root: Path, src: str, room: str, d: dict) -> None:
    """The other owner (a person) speaks in my group: written as ``peer:<src>``, text only.
    It is still outside text to my Bots, so it is screened like a Bot's."""
    text = d.get("text") if isinstance(d.get("text"), str) else ""
    nack = {"to": src, "out_id": d.get("out_id", "")}
    if not text.strip() or len(text) > limits.MAX_TEXT:
        peer.queue(root, room, "nack", {**nack, "reason": "bad_text"})
        return
    if screen(ctx, text):
        _drop(ctx, root, src, room, "screened", text)
        peer.queue(root, room, "nack", {**nack, "reason": "screened"})
        return
    if _peer_hour(root, src) >= PEER_POSTS_PER_HOUR:
        _drop(ctx, root, src, room, "peer_rate")
        peer.queue(root, room, "nack", {**nack, "reason": "peer_rate"})
        return
    with ledger.transaction(root):
        ch = fold.fold_channel(root, room)
        if ch.get("closed") or limits.stopped(root):
            peer.queue(root, room, "nack", {**nack, "reason": "group_closed"})
            return
        ledger.append_many(root, [
            (fold.channel_file(room), "message/posted", f"peer:{src}",
             {"msg_id": "M-" + secrets.token_hex(4), "thread_id": None, "text": shared_rules.clean(text),
              "kind": "message", "mentions": [], "cc": [], "everyone": False, "also_main": False,
              "reply_to": None, "answers": None, "chain": None}),
            (peer.PEERS, "envelope/admitted", "app", {"peer": src, "room": room})])


def _on_join(ctx: Any, root: Path, st: dict, env: dict) -> None:
    room, src, d = env["room"], env["from"], env["data"]
    pub = d.get("pubkey")
    if not isinstance(pub, str) or not peer.verify(env, pub):
        _drop(ctx, root, src, room, "bad_signature")
        return
    inv = st["invites"].get(d.get("invite"))
    bots = d.get("bots")
    ok_bots = isinstance(bots, list) and 1 <= len(bots) <= 3 and all(
        isinstance(b, dict) and isinstance(b.get("lead_id"), str) and re.match(r"^L-[0-9a-f]{8}$", b["lead_id"])
        and isinstance(b.get("handle"), str) and 1 <= len(b["handle"]) <= 40 for b in bots)
    name = d.get("name")
    if not inv or inv["room"] != room or inv["used"] or inv["expires"] < time.time():
        _drop(ctx, root, src, room, "bad_invite")
    elif not isinstance(d.get("proof"), str) or not peer.hmac.compare_digest(
            d["proof"], peer.join_proof(inv["secret"], room, src, pub)):
        _drop(ctx, root, src, room, "bad_proof")
    elif not ok_bots or not isinstance(name, str) or not peer._NAME_RE.match(name):
        _drop(ctx, root, src, room, "bad_join")
    else:
        ledger.append_many(root, [
            (peer.PEERS, "invite/used", "app", {"invite_id": inv["invite_id"], "peer": src}),
            (peer.PEERS, "peer/requested", "app", {"peer": src, "room": room, "name": name, "pubkey": pub,
                                                    "bots": [{"lead_id": b["lead_id"], "handle": b["handle"]}
                                                             for b in bots]})])


def _roster(root: Path, room: str, st: dict) -> list[dict]:
    ch = fold.fold_channel(root, room)
    leads = fold.directory(root)["leads"]
    me = peer.self_id(root)
    out = []
    for lid in ch["members"]:
        l = leads.get(lid, {})
        remote = l.get("kind") == "remote"
        out.append({"lead_id": lid, "handle": l.get("handle", lid), "peer": l.get("peer") if remote else me,
                    "name": "" if remote else st["name"]})
    return out


def _wire_row(ctx: Any, row: dict) -> dict:
    data = dict(row["data"])
    for k in SCRUBBED_KEYS:
        if isinstance(data.get(k), str) and data[k]:
            text = data[k] if len(data[k]) <= TEXT_ON_WIRE else data[k][:TEXT_ON_WIRE] + " [cut]"
            data[k] = _scrub(ctx, text)
    return {**row, "data": data}


async def _publish(ctx: Any, root: Path, pipe: Any, st: dict) -> None:
    for room in sorted(st["hosted"]):
        if not any(r == room for (_, r) in st["admitted"]):
            continue
        rows = ledger.read(root, fold.channel_file(room))[st["published"].get(room, 0):]
        while rows:
            batch: list[dict] = []
            size = 0
            for row in rows[:ROWS_PER_ENVELOPE]:
                wire = _wire_row(ctx, row)
                size += len(str(wire))
                if batch and size > ENVELOPE_CHARS:
                    break
                batch.append(wire)
            env = peer.sign(root, "rows", room, {"rows": batch, "roster": _roster(root, room, st)})
            await pipe.post(peer.encode(env))
            ledger.append(root, peer.PEERS, "room/published", "app", {"room": room, "upto": batch[-1]["seq"]})
            rows = rows[len(batch):]


# --------------------------------------------------------------------------- mirror side


_OWNER_FIELDS = ("from", "to", "creator", "who", "by", "opener")
_OWNER_LISTS = ("people", "members", "mentions", "cc")


def _as_mirror_row(row: dict, hub: str, me: str) -> dict:
    """Swap the two owners: the hub's ``owner`` is not my owner, so it becomes
    ``peer:<hub>``; ``peer:<me>`` (my own owner speaking there) becomes ``owner``."""
    other, mine = f"peer:{hub}", f"peer:{me}"

    def swap(v):
        return other if v == fold.OWNER else fold.OWNER if v == mine else v
    data = dict(row.get("data") or {})
    for k in _OWNER_FIELDS:
        if isinstance(data.get(k), str):
            data[k] = swap(data[k])
    for k in _OWNER_LISTS:
        if isinstance(data.get(k), list):
            data[k] = [swap(v) for v in data[k]]
    return {**row, "by": swap(row.get("by")), "data": data}


def _on_mirror(ctx: Any, root: Path, st: dict, env: dict) -> None:
    room, d = env["room"], env["data"]
    j = st["joined"][room]
    if env["from"] != j["hub"] or not peer.verify(env, j["hub_pubkey"]):
        _drop(ctx, root, env["from"], room, "bad_signature")
        return
    me = peer.self_id(root)
    if env["kind"] == "nack" and d.get("to") == me:
        if d.get("out_id") in st["outbox"]:
            ledger.append(root, peer.PEERS, "outbox/refused", "app",
                          {"out_id": d["out_id"], "reason": str(d.get("reason", ""))[:80]})
        return
    if env["kind"] == "removed" and d.get("peer") == me:
        ledger.append(root, peer.PEERS, "peer/removed", "app", {"peer": me, "room": room})
        return
    if env["kind"] != "rows" or j["state"] != "joined":
        return
    for r in d.get("roster") or []:
        if isinstance(r, dict) and r.get("peer") != me:
            try:
                identity.register_remote(root, r.get("lead_id"), str(r.get("handle", ""))[:40], r.get("peer"),
                                         str(r.get("name", ""))[:20])
            except identity.IdentityError as exc:
                log.warning("team-mode: roster entry refused (%s)", exc.code)
    file = fold.channel_file(room)
    mine = {lid for lid, l in identity.active_leads(root).items() if l.get("kind") != "remote"}
    tail = ledger.tail_seq(root, file)
    todo: list[tuple] = []
    copy: list[dict] = []
    for row in sorted((r for r in d.get("rows") or [] if isinstance(r, dict) and isinstance(r.get("seq"), int)),
                      key=lambda r: r["seq"]):
        if row["seq"] <= tail + len(copy):
            continue
        if row["seq"] != tail + len(copy) + 1:
            _ask_resync(root, st, room, tail + len(copy) + 1)
            break
        row = _as_mirror_row(row, j["hub"], me)
        data = row["data"]
        author = fold.actor(row["by"])
        if row["type"] == "message/posted" and author not in mine and author != fold.OWNER:
            if screen(ctx, data.get("text")):
                _drop(ctx, root, env["from"], room, "screened", data.get("text", ""))
                data = {**data, "text": WITHHELD, "withheld": True}
            elif isinstance(data.get("text"), str):
                data = {**data, "text": shared_rules.clean(data["text"]) or "(empty)"}
            row = {**row, "data": data}
        copy.append(row)
        if row["type"] == "assignment/opened" and data.get("to") in mine:
            todo.append((fold.member_file(data["to"]), "todo/assigned", "app",
                         {"assignment_id": data.get("assignment_id"), "channel_id": room}))
        elif row["type"] in fold.ASSIGN_ANSWERS and author in mine:
            state = {"assignment/taken": "claimed", "assignment/declined": "declined",
                     "assignment/asked": "asked", "assignment/closed": "done"}[row["type"]]
            todo.append((fold.member_file(author), "todo/updated", "app",
                         {"assignment_id": data.get("assignment_id"), "state": state}))
    if copy:
        try:
            ledger.append_copy(root, file, copy)
        except (ledger.LedgerError, TypeError, ValueError) as exc:
            log.warning("team-mode: mirror copy of %s refused: %s", room, exc)
            _ask_resync(root, st, room, ledger.tail_seq(root, file) + 1)
            return
    if todo:
        ledger.append_many(root, todo)


_last_resync: dict[tuple, float] = {}


def _ask_resync(root: Path, st: dict, room: str, from_seq: int) -> None:
    key = (str(root), room)
    if time.time() - _last_resync.get(key, 0) < RESYNC_EVERY_SECS:
        return
    _last_resync[key] = time.time()
    peer.queue(root, room, "resync", {"from_seq": from_seq})


# --------------------------------------------------------------------------- loop


async def _flush_outbox(ctx: Any, root: Path, pipe: Any, st: dict) -> None:
    for out in sorted((o for o in st["outbox"].values() if o["state"] == "queued"), key=lambda o: o["ts"]):
        data = dict(out["data"])
        if out["kind"] in ("post", "say"):
            data["out_id"] = out["out_id"]  # the hub's nack names it (a nack's own out_id is the post's)
        try:
            for k in SCRUBBED_KEYS:
                if isinstance(data.get(k), str) and data[k]:
                    data[k] = _scrub(ctx, data[k])
        except Exception:  # noqa: BLE001 - a scrub that cannot run sends nothing (api-reference "Content Scrubbing")
            ledger.append(root, peer.PEERS, "outbox/refused", "app", {"out_id": out["out_id"], "reason": "scrub_failed"})
            continue
        env = peer.sign(root, out["kind"], out["room"], data)
        ts = await pipe.post(peer.encode(env))
        ledger.append(root, peer.PEERS, "outbox/sent", "app", {"out_id": out["out_id"], "pipe_ts": ts})


async def tick(ctx: Any, root: Path, pipe: Any) -> int:
    """One pass. Returns the number of envelopes read."""
    st = peer.fold(root)
    if not st["name"] or pipe is None or not pipe.ready() or limits.stopped(root):
        return 0
    await _flush_outbox(ctx, root, pipe, st)
    await _publish(ctx, root, pipe, peer.fold(root))
    me = peer.self_id(root)
    n = 0
    for msg in await pipe.read(st["cursor"]):
        env = peer.decode(msg.get("text", ""))
        if env is not None and env["from"] != me:
            n += 1
            cur = peer.fold(root)
            try:
                if env["room"] in cur["hosted"]:
                    _on_hub(ctx, root, cur, env)
                elif env["room"] in cur["joined"]:
                    _on_mirror(ctx, root, cur, env)
            except (ledger.LedgerCorrupt, peer.PeerError):
                raise
            except Exception:  # noqa: BLE001 - one bad envelope must not stall the pipe
                log.exception("team-mode: envelope %s from %s failed", env.get("kind"), env.get("from"))
        ledger.append(root, peer.PEERS, "pipe/cursor", "app", {"ts": msg["ts"]})
    if n:
        # replies the hub just admitted go out in this same pass
        await _publish(ctx, root, pipe, peer.fold(root))
        await _flush_outbox(ctx, root, pipe, peer.fold(root))
    return n


async def run_loop(ctx: Any, root: Path, pipe_for, stop: asyncio.Event, interval: float = LOOP_SECS) -> None:
    """``pipe_for(channel)`` builds the pipe once the owner has configured one."""
    while not stop.is_set():
        try:
            st = peer.fold(root)
            if st["channel"]:
                await tick(ctx, root, pipe_for(st["channel"]))
        except Exception:  # noqa: BLE001 - keep the loop alive; the next pass retries
            log.exception("team-mode: cross-owner pass failed")
        try:
            await asyncio.wait_for(stop.wait(), interval)
        except asyncio.TimeoutError:
            pass
