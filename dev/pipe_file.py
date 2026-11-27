"""DEV ONLY: a local stand-in for the Slack pipe, so two gateways on one host can test
cross-owner groups without a Slack channel.

It has the same interface as ``teamapp.pipe_slack.SlackPipe`` (``ready``, ``post``,
``read``) and appends to one shared JSONL file both gateways can reach. The app uses
it only when the owner of a test instance writes the path of that file into
``<app data dir>/dev-pipe``; with no such file the real Slack pipe is used. Never
ship a ``dev-pipe`` file: nothing here authenticates, any local process can write the file.
"""

from __future__ import annotations

import fcntl
import json
import os
import time
from pathlib import Path


class FilePipe:
    def __init__(self, path: Path, channel: str):
        self.path = Path(path)
        self.channel = channel

    def ready(self) -> bool:
        return self.path.parent.is_dir()

    def _rows(self) -> list[dict]:
        try:
            lines = self.path.read_text().splitlines()
        except FileNotFoundError:
            return []
        return [json.loads(l) for l in lines if l.strip()]

    async def post(self, text: str) -> str:
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            rows = self._rows()
            last = float(rows[-1]["ts"]) if rows else 0.0
            ts = f"{max(time.time(), last + 0.000001):.6f}"
            os.write(fd, (json.dumps({"ts": ts, "channel": self.channel, "text": text}) + "\n").encode())
            return ts
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    async def read(self, after_ts: str) -> list[dict]:
        after = float(after_ts or 0)
        return [{"ts": r["ts"], "text": r["text"]} for r in self._rows()
                if r.get("channel") == self.channel and float(r["ts"]) > after]
