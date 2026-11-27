"""Cross-owner groups, phase 1: keys, invite codes, signed envelopes and ``peers.jsonl``.

A group stays on the gateway of the owner who made it (the hub): that ledger is the
only real copy, and ``send.post`` there decides every message, hop and limit as it
always has. Another owner's gateway keeps a mirror (the same ``channels/G-*.jsonl``,
row for row) written only from rows the hub signed. The two talk through a pipe
(``pipe_slack.py``) by envelopes this module signs and checks.

Rules this module holds (DESIGN.md section 6):

1. Every envelope is Ed25519-signed. A gateway is ``P-<first 8 hex of sha256(public
   key)>``, so the ``from`` field can only be the key that signed it, and a peer may
   speak only for the Bots it brought (``crossowner.py`` checks the lead's ``peer``).
2. Joining takes both owners: the hub owner makes a one-time invite code and later
   admits the request; the other owner pastes the code and ticks which Bots go in.
3. Nothing here runs a turn. Envelopes are data the app's Python reads.

``peers.jsonl`` rows (all by ``app`` or ``owner``):

* ``self/configured`` {name, channel}            -- this owner's short name and pipe channel
* ``room/hosted`` {room}                          -- I am the hub of this group
* ``invite/created`` {invite_id, room, secret, expires} ; ``invite/used`` {invite_id, peer}
* ``peer/requested`` {peer, room, name, pubkey, bots}   (hub) ; ``peer/admitted`` / ``peer/rejected``
* ``peer/removed`` {peer, room}                   -- hub removed it; also written by a mirror told so
* ``peer/assign_trusted`` {peer}                  -- this peer's Bots may @ mine without a card
* ``assign/pending`` {pending_id, peer, room, post} ; ``assign/answered`` {pending_id, approve}
* ``room/joined`` {room, hub, hub_pubkey, hub_name, title, bots}  (mirror) ; ``room/left`` {room}
* ``outbox/queued`` {out_id, room, kind, data} ; ``outbox/sent`` / ``outbox/refused`` {out_id, ...}
* ``room/published`` {room, upto}                 -- hub: rows up to here are out
* ``pipe/cursor`` {ts}                            -- last pipe message read
* ``envelope/dropped`` {peer, room, reason, sample}

The private key and the Slack token live in files next to the ledger (0600), never in
a row. shortcut: both are plain files until the core gives apps a secret store
(DESIGN.md C2, phase 2).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import zlib
from pathlib import Path

from . import ledger

PEERS = "peers.jsonl"
VERSION = 1
INVITE_SECS = 24 * 3600
KINDS = ("join", "post", "say", "leave", "resync", "rows", "nack", "removed")
_PEER_RE = re.compile(r"^P-[0-9a-f]{8}$")
_ROOM_RE = re.compile(r"^G-[0-9a-f]{8}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,20}$")
_CHANNEL_RE = re.compile(r"^[CG][A-Z0-9]{6,20}$")
CODE_PREFIX = "tmi1."
WIRE_PREFIX = "tm1:"


class PeerError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# --------------------------------------------------------------------------- keys


def _crypto():
    try:
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives import serialization
    except ImportError as exc:  # pragma: no cover - the gateway ships cryptography
        raise PeerError("no_crypto") from exc
    return ed25519, serialization


def _key_path(root: Path) -> Path:
    return Path(root) / ".peer_key"


def _private(root: Path):
    ed25519, serialization = _crypto()
    path = _key_path(root)
    if not path.exists():
        key = ed25519.Ed25519PrivateKey.generate()
        raw = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                serialization.NoEncryption())
        Path(root).mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
    return ed25519.Ed25519PrivateKey.from_private_bytes(path.read_bytes())


def public_b64(root: Path) -> str:
    _, serialization = _crypto()
    raw = _private(root).public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


def peer_id(pubkey_b64: str) -> str:
    return "P-" + hashlib.sha256(base64.b64decode(pubkey_b64)).hexdigest()[:8]


def self_id(root: Path) -> str:
    return peer_id(public_b64(root))


def _canon(env: dict) -> bytes:
    return json.dumps({k: v for k, v in env.items() if k != "sig"}, sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False).encode()


def sign(root: Path, kind: str, room: str, data: dict) -> dict:
    env = {"v": VERSION, "app": "team-mode", "kind": kind, "room": room, "from": self_id(root),
           "id": secrets.token_hex(8), "ts": round(time.time(), 3), "data": data}
    env["sig"] = base64.b64encode(_private(root).sign(_canon(env))).decode()
    return env


def verify(env: dict, pubkey_b64: str) -> bool:
    """True when ``env`` is signed by ``pubkey_b64`` and its ``from`` is that key."""
    ed25519, _ = _crypto()
    try:
        if env.get("from") != peer_id(pubkey_b64):
            return False
        key = ed25519.Ed25519PublicKey.from_public_bytes(base64.b64decode(pubkey_b64))
        key.verify(base64.b64decode(env.get("sig") or ""), _canon(env))
        return True
    except Exception:  # noqa: BLE001 - any bad key, signature or encoding is "not signed"
        return False


# --------------------------------------------------------------------------- wire


def encode(env: dict) -> str:
    raw = zlib.compress(json.dumps(env, separators=(",", ":"), ensure_ascii=False).encode())
    return WIRE_PREFIX + base64.urlsafe_b64encode(raw).decode()


def decode(text: str) -> dict | None:
    """The envelope in one pipe message, or None for anything else (people may talk there)."""
    if not isinstance(text, str):
        return None
    at = text.find(WIRE_PREFIX)
    if at < 0:
        return None
    blob = re.match(r"[A-Za-z0-9_=-]+", text[at + len(WIRE_PREFIX):])
    try:
        env = json.loads(zlib.decompress(base64.urlsafe_b64decode(blob.group(0) if blob else ""),
                                         bufsize=1 << 16))
    except Exception:  # noqa: BLE001 - not ours, or damaged
        return None
    ok = (isinstance(env, dict) and env.get("app") == "team-mode" and env.get("v") == VERSION
          and env.get("kind") in KINDS and isinstance(env.get("data"), dict)
          and isinstance(env.get("from"), str) and _PEER_RE.match(env["from"])
          and isinstance(env.get("room"), str) and _ROOM_RE.match(env["room"]))
    return env if ok else None


# --------------------------------------------------------------------------- state


def fold(root: Path) -> dict:
    """Everything ``peers.jsonl`` says, folded."""
    st = {"name": "", "channel": "", "hosted": set(), "invites": {}, "requests": {}, "admitted": {},
          "removed": set(), "trusted": set(), "pending": {}, "joined": {}, "outbox": {},
          "published": {}, "cursor": "", "dropped": []}
    for row in ledger.read(root, PEERS):
        t, d = row["type"], row["data"]
        if t == "self/configured":
            st["name"], st["channel"] = d.get("name", ""), d.get("channel", "")
        elif t == "room/hosted":
            st["hosted"].add(d["room"])
        elif t == "invite/created":
            st["invites"][d["invite_id"]] = {**d, "used": ""}
        elif t == "invite/used":
            if d["invite_id"] in st["invites"]:
                st["invites"][d["invite_id"]]["used"] = d["peer"]
        elif t == "peer/requested":
            st["requests"][(d["peer"], d["room"])] = {**d, "state": "requested", "ts": row["ts"]}
        elif t in ("peer/admitted", "peer/rejected"):
            req = st["requests"].get((d["peer"], d["room"]))
            if req:
                req["state"] = t.split("/")[1]
            if t == "peer/admitted":
                st["admitted"][(d["peer"], d["room"])] = req or d
                st["removed"].discard((d["peer"], d["room"]))
        elif t == "peer/removed":
            st["removed"].add((d["peer"], d["room"]))
            st["admitted"].pop((d["peer"], d["room"]), None)
            if d["room"] in st["joined"]:
                st["joined"][d["room"]]["state"] = "removed"
        elif t == "peer/assign_trusted":
            st["trusted"].add(d["peer"])
        elif t == "assign/pending":
            st["pending"][d["pending_id"]] = {**d, "state": "pending", "ts": row["ts"]}
        elif t == "assign/answered":
            if d["pending_id"] in st["pending"]:
                st["pending"][d["pending_id"]]["state"] = "approved" if d.get("approve") else "rejected"
        elif t == "room/joined":
            st["joined"][d["room"]] = {**d, "state": "joined"}
        elif t == "room/left":
            if d["room"] in st["joined"]:
                st["joined"][d["room"]]["state"] = "left"
        elif t == "outbox/queued":
            st["outbox"][d["out_id"]] = {**d, "state": "queued", "ts": row["ts"]}
        elif t in ("outbox/sent", "outbox/refused"):
            if d["out_id"] in st["outbox"]:
                st["outbox"][d["out_id"]].update(state=t.split("/")[1], reason=d.get("reason", ""))
        elif t == "room/published":
            st["published"][d["room"]] = int(d["upto"])
        elif t == "pipe/cursor":
            st["cursor"] = d["ts"]
        elif t == "envelope/dropped":
            st["dropped"].append({**d, "ts": row["ts"]})
    return st


def role(root: Path, room: object) -> str:
    """``hub`` / ``mirror`` / ``""`` (a plain local group or a DM)."""
    if not isinstance(room, str) or not _ROOM_RE.match(room):
        return ""
    try:
        st = fold(root)
    except ledger.LedgerError:
        return ""
    if room in st["hosted"]:
        return "hub"
    return "mirror" if room in st["joined"] else ""


def mirror_open(st: dict, room: str) -> bool:
    return st["joined"].get(room, {}).get("state") == "joined"


def configure(root: Path, name: str, channel: str) -> None:
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise PeerError("bad_name")
    if not isinstance(channel, str) or not _CHANNEL_RE.match(channel):
        raise PeerError("bad_channel")
    with ledger.transaction(root):
        self_id(root)  # make the key now, so the page can show this gateway's id
        if not fold(root)["cursor"]:
            ledger.append(root, PEERS, "pipe/cursor", "app", {"ts": f"{time.time():.6f}"})
        ledger.append(root, PEERS, "self/configured", "owner", {"name": name, "channel": channel})


# --------------------------------------------------------------------------- invites


def make_invite(root: Path, room: str, title: str, now: float | None = None) -> str:
    """A one-time code the hub owner sends the other owner through a person's channel."""
    now = time.time() if now is None else now
    with ledger.transaction(root):
        st = fold(root)
        if not st["name"]:
            raise PeerError("not_configured")
        if room in st["joined"]:
            raise PeerError("not_your_group")
        rows = []
        if room not in st["hosted"]:
            rows.append((PEERS, "room/hosted", "owner", {"room": room}))
            # in the group's own file, so every mirror copies it too (shared_rules.py)
            rows.append((f"channels/{room}.jsonl", "channel/shared", "owner", {"hub": self_id(root)}))
        invite_id, secret = "I-" + secrets.token_hex(4), secrets.token_hex(16)
        rows.append((PEERS, "invite/created", "owner",
                     {"invite_id": invite_id, "room": room, "secret": secret, "expires": now + INVITE_SECS}))
        ledger.append_many(root, rows, now=now)
    body = {"v": VERSION, "invite": invite_id, "room": room, "title": title[:80], "hub": self_id(root),
            "hub_pubkey": public_b64(root), "hub_name": st["name"], "channel": st["channel"],
            "secret": secret, "expires": now + INVITE_SECS}
    return CODE_PREFIX + base64.urlsafe_b64encode(json.dumps(body, separators=(",", ":")).encode()).decode()


def read_invite(code: str) -> dict:
    try:
        if not code.strip().startswith(CODE_PREFIX):
            raise ValueError
        body = json.loads(base64.urlsafe_b64decode(code.strip()[len(CODE_PREFIX):]))
        ok = (body.get("v") == VERSION and _ROOM_RE.match(body.get("room", ""))
              and peer_id(body["hub_pubkey"]) == body.get("hub") and _NAME_RE.match(body.get("hub_name", ""))
              and _CHANNEL_RE.match(body.get("channel", "")) and re.match(r"^[0-9a-f]{32}$", body.get("secret", ""))
              and re.match(r"^I-[0-9a-f]{8}$", body.get("invite", "")))
    except Exception:  # noqa: BLE001 - any malformed code is one refusal
        ok = False
    if not ok:
        raise PeerError("bad_invite")
    return body


def join_proof(secret: str, room: str, peer: str, pubkey: str) -> str:
    return hmac.new(secret.encode(), f"{room}|{peer}|{pubkey}".encode(), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------- outbox


def queue(root: Path, room: str, kind: str, data: dict) -> str:
    """Queue one envelope for the pipe loop to sign, scrub and send. Callable from the
    MCP server (no key or network needed there)."""
    out_id = "O-" + secrets.token_hex(4)
    ledger.append(root, PEERS, "outbox/queued", "app", {"out_id": out_id, "room": room, "kind": kind, "data": data})
    return out_id
