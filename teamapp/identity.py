"""Session label -> lead.

The only caller identity a stdio MCP server receives is ``KIROCREW_SESSION_LABEL``
(a session key, "a label, not a credential"). A session with a shell can bypass the
MCP server and write the ledger directly, so this is an approximation of the RFC's
``resolve_sender``; the demo touches no real repo or PR, so a forged row only affects
demo data. Only the owner (page route) registers a label as a lead.

Two kinds of lead (``kind``):
- ``bot``: an existing KiroCrew Bot, added by the owner from the host's Bot list. Its
  label is the Bot's own chat, ``dashboard:<slot_key>``, so a team tool called from
  that chat resolves to it. Nothing is created here.
- ``chat`` (legacy): a chat running this app's own ``lead`` agent, registered by
  label. Kept working until the owner decides how a Bot's chat gets the team tools
  (D1); the page labels it "Legacy lead". New ones are only added by API, not the page.
"""

from __future__ import annotations

import re
import secrets
from pathlib import Path

from . import fold, ledger

DIRECTORY = "directory.jsonl"
_LABEL_RE = re.compile(r"^[A-Za-z0-9:._@/-]{1,200}$")
_HANDLE_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")


class IdentityError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def resolve_lead(root: Path, label: str) -> tuple[str | None, str]:
    """``(lead_id, "ok")``, or ``(None, "lead_unverifiable" | "not_a_lead")``."""
    if not label:
        return None, "lead_unverifiable"
    lead_id = fold.directory(root)["by_label"].get(label)
    return (lead_id, "ok") if lead_id else (None, "not_a_lead")


#: A Bot's own chat key starts with this (core ``member_space.DM_SLOT_KEY_PREFIX``).
BOT_SLOT_PREFIX = "member-"
_BOT_KEY_RE = re.compile(r"^[A-Za-z0-9 ._@-]{1,80}$")
_PROJECT_RE = re.compile(r"^[A-Za-z0-9 ._@/-]{0,120}$")


def bot_handle(name: str, display_name: str = "") -> str:
    """The handle people @ a Bot by: its display name, else its crew key, made
    mention-safe (spaces -> '-', other characters dropped, at most 40). ``""`` when
    nothing is left. The page mirrors this in ``botSource.js:botHandle``."""
    raw = (display_name or "").strip() or (name or "").strip()
    out = re.sub(r"[^A-Za-z0-9._-]", "", re.sub(r"\s+", "-", raw))
    return out[:40]


def bot_label(slot_key: str) -> str | None:
    """``dashboard:<slot_key>`` for a Bot's own chat key, else ``None``."""
    if not isinstance(slot_key, str) or not slot_key.startswith(BOT_SLOT_PREFIX):
        return None
    label = f"dashboard:{slot_key}"
    return label if _LABEL_RE.match(label) else None


def register_bot(root: Path, bot: str, slot_key: str, display_name: str = "", project: str = "") -> str:
    """Add an existing Bot as a lead. ``bot`` is its crew key (``/api/members`` ``name``)."""
    if not isinstance(bot, str) or not _BOT_KEY_RE.match(bot):
        raise IdentityError("bad_bot")
    label = bot_label(slot_key)
    if label is None:
        raise IdentityError("not_a_bot")
    if not isinstance(display_name, str) or len(display_name) > 80:
        raise IdentityError("bad_handle")
    if not isinstance(project, str) or not _PROJECT_RE.match(project):
        raise IdentityError("bad_project")
    handle = bot_handle(bot, display_name)
    if not handle:
        raise IdentityError("bad_handle")
    with ledger.transaction(root):
        d = fold.directory(root)
        active = [l for l in d["leads"].values() if l["active"]]
        if label in d["by_label"] or any(l.get("bot") == bot for l in active):
            raise IdentityError("already_in_team")
        if any(l["handle"] == handle for l in active):
            raise IdentityError("handle_taken")
        lead_id = _new_id(d)
        ledger.append(root, DIRECTORY, "lead/registered", "owner",
                      {"lead_id": lead_id, "handle": handle, "session_label": label, "kind": "bot",
                       "bot": bot, "project": project})
        return lead_id


def _new_id(d: dict) -> str:
    lead_id = "L-" + secrets.token_hex(4)
    while lead_id in d["leads"]:
        lead_id = "L-" + secrets.token_hex(4)
    return lead_id


def register(root: Path, label: str, handle: str, kind: str = "chat") -> str:
    """Legacy: register a chat by its session label (API only; the page adds Bots)."""
    if not isinstance(label, str) or not _LABEL_RE.match(label):
        raise IdentityError("bad_session_label")
    if not isinstance(handle, str) or not _HANDLE_RE.match(handle):
        raise IdentityError("bad_handle")
    if kind not in ("chat", "bot"):
        raise IdentityError("bad_kind")
    with ledger.transaction(root):
        d = fold.directory(root)
        if label in d["by_label"]:
            raise IdentityError("already_registered")
        if any(l["handle"] == handle and l["active"] for l in d["leads"].values()):
            raise IdentityError("handle_taken")
        lead_id = _new_id(d)
        ledger.append(root, DIRECTORY, "lead/registered", "owner",
                      {"lead_id": lead_id, "handle": handle, "session_label": label, "kind": kind})
        return lead_id


_LEAD_ID_RE = re.compile(r"^L-[0-9a-f]{8}$")
_PEER_RE = re.compile(r"^P-[0-9a-f]{8}$")


def remote_label(peer: str, lead_id: str) -> str:
    return f"remote:{peer}/{lead_id}"


def register_remote(root: Path, lead_id: str, handle: str, peer: str, owner_name: str) -> str:
    """Add another owner's Bot (cross-owner group) under the id its own gateway gave it,
    so rows read the same on both gateways. Its handle gets ``.<owner_name>`` so two
    owners' "Sage" never collide. It has no ``bot`` key: this gateway never wakes it.
    Idempotent for the same (peer, lead_id); returns the handle used."""
    if not (isinstance(lead_id, str) and _LEAD_ID_RE.match(lead_id)) or not (
            isinstance(peer, str) and _PEER_RE.match(peer)):
        raise IdentityError("bad_remote_lead")
    base = re.sub(r"[^A-Za-z0-9._-]", "", f"{handle}.{owner_name}")[:40] or lead_id
    with ledger.transaction(root):
        d = fold.directory(root)
        old = d["leads"].get(lead_id)
        if old is not None:
            if old.get("peer") != peer:
                raise IdentityError("lead_id_taken")
            if old["active"]:
                return old["handle"]
        taken = {l["handle"] for l in d["leads"].values() if l["active"]}
        name, n = base, 2
        while name in taken:
            name, n = f"{base[:37]}-{n}", n + 1
        ledger.append(root, DIRECTORY, "lead/registered", "app",
                      {"lead_id": lead_id, "handle": name, "session_label": remote_label(peer, lead_id),
                       "kind": "remote", "peer": peer})
        return name


def retire(root: Path, lead_id: str) -> None:
    with ledger.transaction(root):
        lead = fold.directory(root)["leads"].get(lead_id)
        if not lead or not lead["active"]:
            raise IdentityError("unknown_lead")
        ledger.append(root, DIRECTORY, "lead/retired", "owner", {"lead_id": lead_id})


def active_leads(root: Path) -> dict[str, dict]:
    return {k: v for k, v in fold.directory(root)["leads"].items() if v["active"]}
