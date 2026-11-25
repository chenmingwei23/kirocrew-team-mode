"""Wake a Bot lead through the host's Bot API (``permissions.bots: read, wake``).

The host route is ``POST /api/members/{id}/wake`` with body ``{"ref": "<id>"}`` and an
app token (docs/app-kit/api-reference.md, "Bots"). It carries no text: the Bot reads a
fixed line the gateway writes, naming this app and the ref, and then reads its inbox
through the ``team`` tools mounted in its own chat.

``id`` is the Bot's member slug, which only the host knows, so it is looked up from
``GET /api/members`` (scope ``read``: the Bots the owner ticked for this app).

Every outcome is a short string, never an exception, so the wake loop can record it:
``started`` / ``queued`` on success, else ``refused: <why>``. A refusal is logged at
WARNING and written to the lead's member file as ``wake/refused`` by the caller, so a
Bot that cannot be woken shows up instead of going quiet.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import quote, urlsplit

import aiohttp

log = logging.getLogger("kirocrew.app.team-mode")

TIMEOUT_SECS = 10
_REF_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def due_ref(lead_id: str, due_seq: int) -> str:
    """The wake ref for one ``wake/due`` row: opaque, within the host's ref alphabet."""
    ref = f"{lead_id}.due-{int(due_seq)}"
    assert _REF_RE.match(ref), ref
    return ref


def _matches(row: dict, bot: str) -> bool:
    key = bot.strip().lower()
    return key in (str(row.get("id", "")).lower(), str(row.get("name", "")).lower())


async def _session(ctx: Any) -> tuple[str, dict] | str:
    """``(origin, headers)`` for app-token calls, or a refusal string."""
    gateway_origin = getattr(ctx, "gateway_origin", None)
    app_token = getattr(ctx, "app_token", None)
    if gateway_origin is None or app_token is None:
        return "refused: host_without_app_token (needs App Kit sdk_level >= 5)"
    origin = gateway_origin()
    if not origin:
        return "refused: no_gateway_origin"
    token = await app_token()
    if not token:
        return "refused: no_app_token (is the app disabled?)"
    # A Cookie header, not a cookie jar: aiohttp's default jar drops cookies for an
    # IP host such as 127.0.0.1, which would send the call with no token at all.
    port = urlsplit(origin).port
    return origin, {"Cookie": f"mc_token_{port}={token}"}


async def _error(resp: aiohttp.ClientResponse) -> str:
    try:
        body = await resp.json(content_type=None)
        code = body.get("code") or body.get("error") or ""
    except Exception:  # noqa: BLE001 - a non-JSON refusal still has a status
        code = ""
    return f"refused: http_{resp.status}" + (f" {str(code)[:80]}" if code else "")


async def find_bot_id(ctx: Any, bot: str) -> str:
    """The member slug of *bot* among the Bots this app may reach, or ``refused: ...``."""
    sess = await _session(ctx)
    if isinstance(sess, str):
        return sess
    origin, headers = sess
    timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECS)
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as http:
        async with http.get(f"{origin}/api/members") as resp:
            if resp.status != 200:
                return await _error(resp)
            rows = (await resp.json(content_type=None)).get("data") or []
    for row in rows:
        if isinstance(row, dict) and _matches(row, bot) and row.get("id"):
            return str(row["id"])
    return "refused: bot_not_ticked (tick it under Bots this app can reach)"


async def wake_bot(ctx: Any, bot: str, ref: str) -> str:
    """Wake *bot* once with *ref*. Returns ``started``, ``queued`` or ``refused: ...``."""
    try:
        bot_id = await find_bot_id(ctx, bot)
        if bot_id.startswith("refused:"):
            return bot_id
        sess = await _session(ctx)
        if isinstance(sess, str):
            return sess
        origin, headers = sess
        timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECS)
        url = f"{origin}/api/members/{quote(bot_id, safe='')}/wake"
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as http:
            async with http.post(url, json={"ref": ref}) as resp:
                if resp.status != 202:
                    return await _error(resp)
                return str((await resp.json(content_type=None)).get("status") or "started")
    except (aiohttp.ClientError, TimeoutError, ValueError) as exc:
        return f"refused: {type(exc).__name__}: {str(exc)[:120]}"


async def wake_and_log(ctx: Any, bot: str, ref: str) -> str:
    """:func:`wake_bot`, with any refusal logged at WARNING."""
    outcome = await wake_bot(ctx, bot, ref)
    if outcome.startswith("refused"):
        log.warning("team-mode: could not wake Bot %s (%s): %s", bot, ref, outcome)
    return outcome
