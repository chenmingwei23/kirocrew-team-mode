"""In-gateway entry points named by app.json ``backend.hooks``.

Routes live under ``/api/apps/team-mode/`` on the gateway's own listener (no
listener of our own). Every route, reads included, is owner-only through
``ctx.require_owner``: ``/state`` shows every DM between leads. Installed apps must
not import ``kiro_crew``; the host is reached through ``ctx`` only.

``on_startup`` writes ``app/started`` and starts the wake loop; ``on_shutdown``
stops it and writes ``app/stopped``, after which every lead's probe stays quiet.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from aiohttp import web

from . import bot_wake, identity, ledger, lifecycle, limits, models, send, state, wake

MAX_BODY = 64 * 1024


@dataclass(frozen=True)
class Route:
    method: str
    path: str  # relative to /api/apps/team-mode/
    handler: Callable


def ledger_root(ctx: Any) -> Path:
    return Path(ctx.data_dir) / "ledger"


async def _body(request: web.Request) -> dict:
    if request.content_length is not None and request.content_length > MAX_BODY:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_BODY, actual_size=request.content_length)
    raw = await request.content.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_BODY, actual_size=len(raw))
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise web.HTTPBadRequest(text="body is not JSON")
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="body must be an object")
    return body


def _only(body: dict, allowed: set[str]) -> None:
    extra = set(body) - allowed
    if extra:
        raise web.HTTPBadRequest(text=f"unknown fields: {sorted(extra)}")


def _result(res: dict) -> web.Response:
    code = 200 if res.get("status") in ("accepted", "held", "redirected") else 409
    return web.json_response(res, status=code)


def _owner(op: str):
    def wrap(fn):
        async def handler(request: web.Request, ctx: Any) -> web.Response:
            refusal = await ctx.require_owner(request, op)
            if refusal is not None:
                return refusal
            root = ledger_root(ctx)
            try:
                if op != "health":  # the owner is here: batch wakes run (limits.owner_away)
                    await asyncio.to_thread(limits.note_owner_seen, root)
                return await fn(request, ctx, root)
            except ledger.LedgerCorrupt as exc:
                return web.json_response({"error": "ledger_corrupt", "detail": str(exc)}, status=500)
        return handler
    return wrap


@_owner("health")
async def _health(request, ctx, root):
    return web.json_response({"ok": True, "app": "team-mode", "stopped": limits.stopped(root)})


@_owner("state")
async def _state(request, ctx, root):
    return web.json_response(await asyncio.to_thread(state.build, root, request.query.get("since")))


@_owner("channel")
async def _channel(request, ctx, root):
    from . import fold

    cid = request.match_info.get("id", "")
    try:
        view = fold.channel_view(root, cid, fold.OWNER, thread=request.query.get("thread", "*"))
    except ledger.LedgerError:
        return web.json_response({"error": "no_such_channel"}, status=404)
    return web.json_response(view)


@_owner("leads.add")
async def _lead_add(request, ctx, root):
    """Add an existing Bot: ``{bot, slot_key, display_name?, project?}``. The legacy
    shape ``{session_label, handle, kind}`` still registers a lead chat (API only)."""
    body = await _body(request)
    try:
        if "bot" in body:
            _only(body, {"bot", "slot_key", "display_name", "project"})
            lead_id = identity.register_bot(root, body.get("bot"), body.get("slot_key"),
                                            body.get("display_name") or "", body.get("project") or "")
        else:
            _only(body, {"session_label", "handle", "kind"})
            lead_id = identity.register(root, body.get("session_label"), body.get("handle"),
                                        body.get("kind", "chat"))
    except identity.IdentityError as exc:
        return web.json_response({"status": "refused", "reason": exc.code}, status=409)
    res = {"status": "accepted", "lead_id": lead_id}
    if "bot" in body:
        res["wake"] = await _bot_wake_ready(ctx, body["bot"])
    return web.json_response(res)


async def _bot_wake_ready(ctx: Any, bot: str) -> str:
    """``"ready"`` when the host lists *bot* among the Bots this app may reach (so the
    wake loop can wake it through ``POST /api/members/{id}/wake``), else the refusal.
    Registration stands either way; ``POST /leads/{id}/wake`` tries a wake later."""
    found = await bot_wake.find_bot_id(ctx, bot)
    return found if found.startswith("refused") else "ready"


@_owner("leads.wake")
async def _lead_wake(request, ctx, root):
    """Wake a Bot lead now, through the host's Bot API. 409 with the host's reason when
    the host refuses, so the owner sees why instead of a Bot that never answers."""
    lead_id = request.match_info.get("lead_id", "")
    lead = identity.active_leads(root).get(lead_id)
    if not lead or not lead.get("bot"):
        return web.json_response({"status": "refused", "reason": "not_a_bot_lead"}, status=409)
    ref = f"{lead_id}.owner-{int(time.time())}"
    outcome = await bot_wake.wake_and_log(ctx, lead["bot"], ref)
    ok = not outcome.startswith("refused")
    return web.json_response({"status": "accepted" if ok else "refused", "wake": outcome},
                             status=200 if ok else 409)


@_owner("panel")
async def _panel(request, ctx, root):
    """Which Bot the side-panel tab is on. The host sends the owning chat as
    ``X-Session-Key`` (``dashboard:<slot_key>``); a chat that is no Bot gets ``bot: false``."""
    key = request.headers.get("X-Session-Key", "")
    slot = key[len("dashboard:"):] if key.startswith("dashboard:") else ""
    label = identity.bot_label(slot)
    lead_id = identity.resolve_lead(root, label)[0] if label else None
    return web.json_response({"bot": label is not None, "slot_key": slot if label else "", "lead_id": lead_id})


@_owner("leads.remove")
async def _lead_remove(request, ctx, root):
    try:
        identity.retire(root, request.match_info.get("lead_id", ""))
    except identity.IdentityError as exc:
        return web.json_response({"status": "refused", "reason": exc.code}, status=409)
    return web.json_response({"status": "accepted"})


@_owner("groups.open")
async def _group_open(request, ctx, root):
    body = await _body(request)
    _only(body, {"title", "members", "managers"})
    return _result(send.open_group(root, "owner", body.get("title"), body.get("members"), body.get("managers")))


@_owner("groups.members")
async def _group_members(request, ctx, root):
    body = await _body(request)
    _only(body, {"add", "remove"})
    return _result(send.change_members(root, request.match_info.get("id", ""), body.get("add") or [],
                                       body.get("remove") or []))


@_owner("messages.post")
async def _message(request, ctx, root):
    body = await _body(request)
    _only(body, {"channel_id", "to", "thread", "root_seq", "text", "mentions", "cc", "everyone",
                 "reply_to", "kind"})
    return _result(send.post(root, "owner", text=body.get("text"), channel_id=body.get("channel_id"),
                             to=body.get("to"), thread=body.get("thread", "main"), root_seq=body.get("root_seq"),
                             mentions=body.get("mentions"), cc=body.get("cc"),
                             everyone=bool(body.get("everyone")), reply_to=body.get("reply_to"),
                             kind=body.get("kind", "message")))


@_owner("cases.answer")
async def _case_answer(request, ctx, root):
    body = await _body(request)
    _only(body, {"decision", "card_hash", "text", "standing"})
    return _result(state.answer_case(root, request.match_info.get("case_id", ""), body.get("decision"),
                                     body.get("card_hash"), body.get("text"), body.get("standing")))


@_owner("decisions.answer")
async def _decision_answer(request, ctx, root):
    from . import decisions

    body = await _body(request)
    _only(body, {"key", "text", "skip", "card_hash", "decision", "standing"})
    return _result(decisions.answer(root, str(body.get("key", "")), body.get("text"), skip=body.get("skip") is True,
                                    card_hash=body.get("card_hash"), decision=body.get("decision"),
                                    standing=body.get("standing")))


@_owner("meetings.adjourn")
async def _meeting_adjourn(request, ctx, root):
    from . import meeting

    body = await _body(request)
    _only(body, {"reason"})
    return _result(meeting.adjourn(root, "owner", request.match_info.get("meeting_id", ""),
                                   body.get("reason") or "owner"))


@_owner("leads.impact")
async def _lead_impact(request, ctx, root):
    res = lifecycle.removal_impact(root, request.match_info.get("lead_id", ""))
    return web.json_response(res, status=200 if res["status"] == "accepted" else 404)


@_owner("groups.close")
async def _group_close(request, ctx, root):
    return _result(lifecycle.close_group(root, request.match_info.get("id", "")))


@_owner("limits")
async def _limits(request, ctx, root):
    body = await _body(request)
    _only(body, {"limits"})
    return _result(limits.set_limits(root, body.get("limits")))


@_owner("models")
async def _models(request, ctx, root):
    body = await _body(request)
    _only(body, {"routes", "roles"})
    return _result(models.set_config(root, body.get("routes"), body.get("roles")))


@_owner("stop")
async def _stop(request, ctx, root):
    limits.stop(root, "owner")
    return web.json_response({"status": "accepted", "stopped": True})


@_owner("resume")
async def _resume(request, ctx, root):
    body = await _body(request)
    _only(body, {"reset_budget"})
    limits.resume(root, reset_budget=bool(body.get("reset_budget")))
    return web.json_response({"status": "accepted", "stopped": limits.stopped(root)})


# --------------------------------------------------------------------------- cross-owner groups


def _cross_view(ctx: Any, root: Path) -> dict:
    from . import fold, peer, pipe_slack

    st = peer.fold(root)
    leads = fold.directory(root)["leads"]
    names = {p: r.get("name", "") for (p, _), r in st["requests"].items()}

    def title(room):
        try:
            return fold.fold_channel(root, room)["title"]
        except ledger.LedgerError:
            return ""
    hosted = []
    for room in sorted(st["hosted"]):
        hosted.append({
            "room": room, "title": title(room),
            "peers": [{"peer": p, "name": names.get(p, ""), "trusted": p in st["trusted"],
                       "bots": [l["handle"] for l in leads.values() if l.get("peer") == p and l["active"]]}
                      for (p, r) in st["admitted"] if r == room],
            "requests": [{"peer": p, "name": q["name"], "bots": [b["handle"] for b in q["bots"]]}
                         for (p, r), q in st["requests"].items() if r == room and q["state"] == "requested"]})
    joined = [{"room": room, "title": j.get("title", ""), "hub_name": j.get("hub_name", ""), "state": j["state"],
               "bots": [b["handle"] for b in j.get("bots", [])], "synced": ledger.tail_seq(root, fold.channel_file(room))}
              for room, j in sorted(st["joined"].items())]
    pending = [{"pending_id": k, "name": names.get(p["peer"], ""), "room": p["room"], "title": title(p["room"]),
                "text": str(p["post"].get("text", ""))[:300],
                "mentions": [leads.get(m, {}).get("handle", m) for m in p["post"].get("mentions") or []]}
               for k, p in st["pending"].items() if p["state"] == "pending"]
    outbox = {s: sum(1 for o in st["outbox"].values() if o["state"] == s) for s in ("queued", "sent", "refused")}
    try:
        me = peer.self_id(root) if st["name"] else ""
    except peer.PeerError:
        me = ""
    return {"self": me, "name": st["name"], "channel": st["channel"],
            "token_set": pipe_slack.token_path(Path(ctx.data_dir)).exists(),
            "hosted": hosted, "joined": joined, "pending": pending, "outbox": outbox,
            "dropped": [{k: d.get(k) for k in ("peer", "room", "reason", "sample", "ts")}
                        for d in st["dropped"][-20:]][::-1]}


def _cross(op: str):
    """Owner-only, with a peer refusal turned into a 409."""
    def wrap(fn):
        @_owner(op)
        async def handler(request, ctx, root):
            from . import peer
            try:
                return await fn(request, ctx, root)
            except (peer.PeerError, identity.IdentityError) as exc:
                return web.json_response({"status": "refused", "reason": exc.code}, status=409)
        return handler
    return wrap


@_cross("cross.view")
async def _cross_get(request, ctx, root):
    return web.json_response(await asyncio.to_thread(_cross_view, ctx, root))


@_cross("cross.setup")
async def _cross_setup(request, ctx, root):
    from . import peer, pipe_slack

    body = await _body(request)
    _only(body, {"name", "channel", "token"})
    if body.get("token"):
        try:
            pipe_slack.save_token(Path(ctx.data_dir), body["token"])
        except ValueError:
            return web.json_response({"status": "refused", "reason": "bad_token"}, status=409)
    await asyncio.to_thread(peer.configure, root, body.get("name"), body.get("channel"))
    return web.json_response({"status": "accepted"})


@_cross("cross.invite")
async def _cross_invite(request, ctx, root):
    from . import fold, peer

    body = await _body(request)
    _only(body, {"channel_id"})
    room = body.get("channel_id")
    if not isinstance(room, str) or not room.startswith("G-"):
        return web.json_response({"status": "refused", "reason": "not_a_group"}, status=409)
    try:
        ch = fold.fold_channel(root, room)
    except ledger.LedgerError:
        return web.json_response({"status": "refused", "reason": "no_such_channel"}, status=409)
    if ch["kind"] != "group" or ch.get("closed") or ledger.is_mirror(root, fold.channel_file(room)):
        return web.json_response({"status": "refused", "reason": "not_your_group"}, status=409)
    code = await asyncio.to_thread(peer.make_invite, root, room, ch["title"])
    return web.json_response({"status": "accepted", "code": code})


@_cross("cross.join")
async def _cross_join(request, ctx, root):
    from . import crossowner

    body = await _body(request)
    _only(body, {"code", "bots"})
    return web.json_response(await asyncio.to_thread(crossowner.join, root, str(body.get("code", "")),
                                                     body.get("bots")))


@_cross("cross.admit")
async def _cross_admit(request, ctx, root):
    from . import crossowner

    body = await _body(request)
    _only(body, {"peer", "room", "approve"})
    fn = crossowner.admit if body.get("approve", True) else crossowner.reject
    return _result(await asyncio.to_thread(fn, root, str(body.get("peer", "")), str(body.get("room", ""))))


@_cross("cross.remove")
async def _cross_remove(request, ctx, root):
    from . import crossowner

    body = await _body(request)
    _only(body, {"peer", "room"})
    return _result(await asyncio.to_thread(crossowner.remove, root, str(body.get("peer", "")),
                                           str(body.get("room", ""))))


@_cross("cross.leave")
async def _cross_leave(request, ctx, root):
    from . import crossowner

    return _result(await asyncio.to_thread(crossowner.leave, root, request.match_info.get("room", "")))


@_cross("cross.pending")
async def _cross_pending(request, ctx, root):
    from . import crossowner

    body = await _body(request)
    _only(body, {"approve", "trust"})
    return _result(await asyncio.to_thread(crossowner.answer_pending, root, request.match_info.get("pid", ""),
                                           body.get("approve") is True, body.get("trust") is True))


def register_routes(ctx: Any) -> list[Route]:
    return [
        Route("GET", "/cross", _cross_get),
        Route("POST", "/cross/setup", _cross_setup),
        Route("POST", "/cross/invite", _cross_invite),
        Route("POST", "/cross/join", _cross_join),
        Route("POST", "/cross/admit", _cross_admit),
        Route("POST", "/cross/remove", _cross_remove),
        Route("POST", "/cross/rooms/{room}/leave", _cross_leave),
        Route("POST", "/cross/pending/{pid}/answer", _cross_pending),
        Route("GET", "/health", _health),
        Route("GET", "/state", _state),
        Route("GET", "/channels/{id}", _channel),
        Route("POST", "/leads", _lead_add),
        Route("GET", "/panel", _panel),
        Route("DELETE", "/leads/{lead_id}", _lead_remove),
        Route("POST", "/leads/{lead_id}/wake", _lead_wake),
        Route("GET", "/leads/{lead_id}/impact", _lead_impact),
        Route("POST", "/groups", _group_open),
        Route("POST", "/groups/{id}/members", _group_members),
        Route("POST", "/groups/{id}/close", _group_close),
        Route("POST", "/limits", _limits),
        Route("POST", "/models", _models),
        Route("POST", "/messages", _message),
        Route("POST", "/cases/{case_id}/answer", _case_answer),
        Route("POST", "/decisions/answer", _decision_answer),
        Route("POST", "/meetings/{meeting_id}/adjourn", _meeting_adjourn),
        Route("POST", "/stop", _stop),
        Route("POST", "/resume", _resume),
    ]


_tasks: dict[str, tuple[asyncio.Task, asyncio.Event]] = {}


def _dev_pipe(ctx: Any, channel: str):
    """DEV ONLY: ``dev/pipe_file.py`` when ``<data dir>/dev-pipe`` names a shared file
    (two test gateways on one host, no Slack). Without that file: None, the real pipe."""
    marker = Path(ctx.data_dir) / "dev-pipe"
    if not marker.is_file():
        return None
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "team_mode_dev_pipe", Path(__file__).resolve().parents[1] / "dev" / "pipe_file.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    import logging
    logging.getLogger("kirocrew.app.team-mode").warning("team-mode: DEV pipe in use (%s), not Slack", marker)
    return mod.FilePipe(Path(marker.read_text().strip()), channel)


async def on_startup(ctx: Any) -> None:
    root = ledger_root(ctx)
    ledger.append(root, limits.CONTROL, "app/started", "app", {})
    stop = asyncio.Event()
    task = asyncio.create_task(wake.run_loop(ctx, root, stop), name="team-mode-wake-loop")
    _tasks[str(root)] = (task, stop)
    from . import crossowner, pipe_slack

    pipes: dict[str, Any] = {}

    def pipe_for(channel: str):
        if channel not in pipes:
            pipes[channel] = _dev_pipe(ctx, channel) or pipe_slack.SlackPipe(Path(ctx.data_dir), channel)
        return pipes[channel]
    cross = asyncio.create_task(crossowner.run_loop(ctx, root, pipe_for, stop), name="team-mode-cross-owner")
    _tasks[str(root) + "#cross"] = (cross, stop)


async def on_shutdown(ctx: Any) -> None:
    root = ledger_root(ctx)
    for key in (str(root), str(root) + "#cross"):
        entry = _tasks.pop(key, None)
        if entry is None:
            continue
        task, stop = entry
        stop.set()
        try:
            await asyncio.wait_for(task, 10)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()
    ledger.append(root, limits.CONTROL, "app/stopped", "app", {})
