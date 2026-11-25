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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from aiohttp import web

from . import identity, ledger, lifecycle, limits, models, send, state, wake

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
        res["wake"] = await _arm_bot_wake(ctx, lead_id, body["bot"])
    return web.json_response(res)


def _wake_job_name(lead_id: str) -> str:
    return f"team-mode-inbox-{lead_id}"


async def _arm_bot_wake(ctx: Any, lead_id: str, bot: str) -> str:
    """Hang the inbox probe on the Bot's own chat (host ``cron.add_job(bot=...)``).

    ``"armed"``, or why not: the host refuses until the owner turns on Team Mode's tools
    for this Bot (``bot_chat_app_tools``), and an older host has no ``bot=`` at all.
    Registration stands either way; ``POST /leads/{id}/wake`` arms it later.
    """
    cron = getattr(ctx, "cron", None)
    if cron is None:
        return "no_cron_permission"
    name = _wake_job_name(lead_id)
    if any(getattr(j, "name", "") == name for j in await asyncio.to_thread(cron.list_jobs)):
        return "armed"
    try:
        await cron.add_job_async(name, json.dumps({"lead_id": lead_id}), every_secs=60,
                                 script="crons/inbox_probe.py:watch", timeout=10, bot=bot)
    except TypeError:
        return "host_without_bot_wake"
    except ValueError as exc:
        return f"refused: {str(exc)[:160]}"
    return "armed"


async def _disarm_bot_wake(ctx: Any, lead_id: str) -> None:
    cron = getattr(ctx, "cron", None)
    if cron is None:
        return
    for job in await asyncio.to_thread(cron.list_jobs):
        if getattr(job, "name", "") == _wake_job_name(lead_id):
            await cron.remove_job_async(job.id)


@_owner("leads.wake")
async def _lead_wake(request, ctx, root):
    lead = identity.active_leads(root).get(request.match_info.get("lead_id", ""))
    if not lead or not lead.get("bot"):
        return web.json_response({"status": "refused", "reason": "not_a_bot_lead"}, status=409)
    wake_state = await _arm_bot_wake(ctx, request.match_info["lead_id"], lead["bot"])
    return web.json_response({"status": "accepted" if wake_state == "armed" else "refused",
                              "wake": wake_state}, status=200 if wake_state == "armed" else 409)


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
    await _disarm_bot_wake(ctx, request.match_info.get("lead_id", ""))
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


def register_routes(ctx: Any) -> list[Route]:
    return [
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


async def rearm_bot_wakes(ctx: Any, root: Path) -> dict[str, str]:
    """Arm the inbox probe again for every active Bot lead: ``{lead_id: wake state}``.

    The host removes an app's crons when the app is disabled and does not bring them
    back on enable, so without this a re-enabled app has its tools back in the Bot's
    chat but can no longer wake it. A Bot whose owner switch is off is refused by the
    host, as on add; that is reported, not raised.
    """
    out: dict[str, str] = {}
    for lead_id, lead in identity.active_leads(root).items():
        if lead.get("bot"):
            try:
                out[lead_id] = await _arm_bot_wake(ctx, lead_id, lead["bot"])
            except Exception as exc:  # noqa: BLE001 - one lead must not stop the startup
                out[lead_id] = f"error: {str(exc)[:120]}"
    return out


async def on_startup(ctx: Any) -> None:
    root = ledger_root(ctx)
    ledger.append(root, limits.CONTROL, "app/started", "app", {})
    await rearm_bot_wakes(ctx, root)
    stop = asyncio.Event()
    task = asyncio.create_task(wake.run_loop(ctx, root, stop), name="team-mode-wake-loop")
    _tasks[str(root)] = (task, stop)


async def on_shutdown(ctx: Any) -> None:
    root = ledger_root(ctx)
    entry = _tasks.pop(str(root), None)
    if entry is not None:
        task, stop = entry
        stop.set()
        try:
            await asyncio.wait_for(task, 10)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()
    ledger.append(root, limits.CONTROL, "app/stopped", "app", {})
