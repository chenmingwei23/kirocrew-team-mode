"""Team Mode wake probe: a script cron each demo lead registers on its own session.

    cron_add(name="team-mode-inbox",
             script="~/.kirocrew/apps/team-mode/crons/inbox_probe.py:watch",
             every=60, timeout=10, message='{"lead_id": "L-xxxxxxxx"}')

Each tick reads only ``control.jsonl`` and the lead's own member log. When the
newest ``wake/due`` has not been delivered yet it raises one IMMEDIATE observation
whose text is a fixed template: channel names, item count, open assignment count
and "call team_inbox_read". It never contains a message body. Stopped, or the app
not running (no ``app/started`` after the last ``app/stopped``): quiet tick.

Self-contained on purpose (standard library + ``kiro_crew.irq`` at call time): the
cron launcher does not put the app directory on ``sys.path``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "data" / "ledger"
_LEAD_RE = re.compile(r"^L-[0-9a-f]{8}$")
_NAME_RE = re.compile(r"[^\w .,:#()-]")
TEMPLATE = "Team Mode: {n} new item(s) in {where}; {k} open assignment(s). Call team_inbox_read."


class ProbeError(Exception):
    pass


def _rows(path: Path) -> list[dict]:
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return []
    if raw and not raw.endswith(b"\n"):
        raise ProbeError("torn line")
    rows = []
    for n, line in enumerate(raw.split(b"\n")[:-1], start=1):
        row = json.loads(line)
        if row.get("seq") != n:
            raise ProbeError("seq gap")
        rows.append(row)
    return rows


def _name(ch: dict) -> str:
    title = ch.get("title") or ("DM" if ch.get("kind") == "dm" else "group")
    return _NAME_RE.sub("_", str(title))[:40]


def brief_for_due(due: dict) -> str:
    """The fixed wake text for one ``wake/due`` row's ``summary``. No body bytes."""
    s = due.get("data", {}).get("summary") or {}
    chans = [c for c in s.get("channels", []) if isinstance(c, dict)]
    n = sum(int(c.get("n", 0)) for c in chans)
    where = ", ".join(_name(c) for c in chans[:4]) + (" and more" if len(chans) > 4 else "")
    return TEMPLATE.format(n=n, where=where or "Team Mode", k=int(s.get("assignments", 0)))


def observe_files(root: Path, lead_id: str) -> tuple[str, int, str] | None:
    """``("due", seq, brief)`` for an undelivered newest due, ``None`` when quiet."""
    control = _rows(root / "control.jsonl")
    stopped = started = app_stopped = 0
    for row in control:
        t = row["type"]
        if t == "control/stopped":
            stopped = 1
        elif t == "control/resumed":
            stopped = 0
        elif t == "app/started":
            started = row["seq"]
        elif t == "app/stopped":
            app_stopped = row["seq"]
    if stopped or started <= app_stopped:
        return None
    member = _rows(root / "members" / f"{lead_id}.jsonl")
    delivered = {r["data"].get("due_seq") for r in member if r["type"] == "wake/delivered"}
    dues = [r for r in member if r["type"] == "wake/due"]
    if not dues or dues[-1]["seq"] in delivered:
        return None
    return ("due", dues[-1]["seq"], brief_for_due(dues[-1]))


def _make_probe():
    from kiro_crew.irq import Observation, Probe, Severity, Tick

    class InboxProbe(Probe):
        def identity(self, ctx):
            try:
                msg = json.loads(getattr(ctx, "message", "") or "{}")
            except ValueError as exc:
                raise ValueError("message must be JSON with lead_id") from exc
            lead_id = msg.get("lead_id") if isinstance(msg, dict) else None
            if not isinstance(lead_id, str) or not _LEAD_RE.match(lead_id):
                raise ValueError("lead_id must look like L-xxxxxxxx")
            self.lead_id = lead_id
            return ("team-mode-inbox", lead_id)

        def observe(self, ctx):
            try:
                got = observe_files(ROOT, self.lead_id)
            except (OSError, ValueError, ProbeError) as exc:
                return Tick(fetch_ok=False, detail=f"ledger unreadable: {type(exc).__name__}")
            if got is None:
                return Tick()
            _, seq, brief = got
            return Tick(observations=[Observation(f"due:{seq}", Severity.IMMEDIATE, brief)])

    return InboxProbe()


def watch(ctx) -> None:
    from kiro_crew.irq import run

    run(ctx, _make_probe(), coalesce_secs=0)
