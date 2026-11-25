"""Make the app's stdio MCP servers inert, then gone, once the app is turned off.

kiro-cli starts one ``mcp/server.py`` per lead session and one ``mcp/staff_server.py``
per secretary or bar raiser run. Those processes belong to kiro-cli, not to the
gateway, so disabling the app does not stop them (e2e item 12: four servers still
running a minute after disable). The app cannot reach kiro-cli, so each server
watches for the off switch itself:

* every tool call is refused with ``app_disabled`` while the app is off;
* a background thread exits the process once the app has stayed off for
  :data:`GRACE_SECS`. The grace keeps an app update or a gateway restart
  (``app/stopped`` followed within seconds by ``app/started``) from killing a live
  lead's tools.

"Off" is either signal: the gateway's own ``installed.json`` beside the app says
``"enabled": false``, or the newest ``app/*`` control row is ``app/stopped``
(written by ``hooks.on_shutdown``). An unreadable ``installed.json`` is ignored, so a
missing file (tests, dev checkouts) never turns the app off by itself.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

from . import ledger, limits

GRACE_SECS = 30.0
POLL_SECS = 5.0
REASON = "app_disabled"


def _installed_says_off(app_root: Path | None) -> bool:
    if app_root is None:
        return False
    try:
        data = json.loads((app_root / "installed.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("enabled") is False


def _ledger_says_off(root: Path) -> bool:
    started = stopped = 0
    try:
        rows = ledger.read(root, limits.CONTROL)
    except Exception:  # noqa: BLE001 -- an unreadable ledger is refused by the tools themselves
        return False
    for row in rows:
        if row.get("type") == "app/started":
            started = row["seq"]
        elif row.get("type") == "app/stopped":
            stopped = row["seq"]
    return stopped > started


def app_off(root: Path, app_root: Path | None = None) -> bool:
    """True when the app is disabled (see the module docstring for both signals)."""
    return _installed_says_off(app_root) or _ledger_says_off(root)


def watch(root: Path, app_root: Path | None, *, grace: float = GRACE_SECS, poll: float = POLL_SECS,
          exit_fn=None, clock=time.monotonic, sleep=time.sleep) -> threading.Thread:
    """Start a daemon thread that calls *exit_fn* once the app has been off for *grace* s."""
    def _exit() -> None:
        sys.stdout.flush()
        os._exit(0)

    exit_fn = exit_fn or _exit

    def loop() -> None:
        off_since = None
        while True:
            if app_off(root, app_root):
                off_since = clock() if off_since is None else off_since
                if clock() - off_since >= grace:
                    exit_fn()
                    return
            else:
                off_since = None
            sleep(poll)

    thread = threading.Thread(target=loop, name="team-mode-offswitch", daemon=True)
    thread.start()
    return thread
