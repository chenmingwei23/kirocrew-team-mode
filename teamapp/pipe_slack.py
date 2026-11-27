"""A Slack private channel as a dumb pipe for cross-owner envelopes (phase 1).

Each owner gives the app a bot token of their own Slack app, invited into one private
channel both owners share. The app only posts there (``chat.postMessage``) and reads
it back (``conversations.history``); it never acts on what a person types there, and a
message that is not an envelope (``peer.decode`` -> None) is skipped.

Scopes the token needs: ``chat:write`` and ``groups:history`` (a private channel).

shortcut: the token is a 0600 file in the app's data dir (``slack-token``) until the
core gives apps a secret store (DESIGN.md C2, phase 2).
"""

from __future__ import annotations

import os
from pathlib import Path

import aiohttp

API = "https://slack.com/api/"
TIMEOUT_SECS = 15
TOKEN_FILE = "slack-token"


def token_path(data_dir: Path) -> Path:
    return Path(data_dir) / TOKEN_FILE


def save_token(data_dir: Path, token: str) -> None:
    if not isinstance(token, str) or not token.startswith("xoxb-") or len(token) > 256 or any(
            c.isspace() for c in token):
        raise ValueError("bad_token")
    path = token_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    os.replace(tmp, path)


class SlackPipe:
    """``post(text)`` and ``read(after_ts)`` on one channel."""

    def __init__(self, data_dir: Path, channel: str):
        self.channel = channel
        self._token_file = token_path(data_dir)

    def ready(self) -> bool:
        return self._token_file.exists()

    async def _call(self, method: str, payload: dict, get: bool = False) -> dict:
        token = self._token_file.read_text().strip()
        headers = {"Authorization": f"Bearer {token}"}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=TIMEOUT_SECS), headers=headers) as http:
            if get:
                req = http.get(API + method, params=payload)
            else:
                req = http.post(API + method, json=payload)
            async with req as resp:
                body = await resp.json(content_type=None)
        if not body.get("ok"):
            raise RuntimeError(f"slack {method}: {body.get('error') or resp.status}")
        return body

    async def post(self, text: str) -> str:
        body = await self._call("chat.postMessage", {"channel": self.channel, "text": text,
                                                     "unfurl_links": False, "unfurl_media": False})
        return str(body.get("ts", ""))

    async def read(self, after_ts: str) -> list[dict]:
        """Messages newer than ``after_ts``, oldest first: ``[{ts, text}]``."""
        out: list[dict] = []
        cursor = ""
        for _ in range(20):  # at most 20 pages (4000 messages) per read
            params = {"channel": self.channel, "oldest": after_ts or "0", "limit": "200", "inclusive": "false"}
            if cursor:
                params["cursor"] = cursor
            body = await self._call("conversations.history", params, get=True)
            out += [{"ts": m.get("ts", ""), "text": m.get("text", "")} for m in body.get("messages") or []]
            cursor = (body.get("response_metadata") or {}).get("next_cursor") or ""
            if not body.get("has_more") or not cursor:
                break
        return sorted(out, key=lambda m: float(m["ts"] or 0))
