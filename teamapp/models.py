"""Pick a model by intent: ``easy`` / ``default`` / ``smartest``.

Roles name an intent, never a model id; one route table maps each intent to an id
(multiBot ``examples/routes.example.json`` + ``bin/multibot`` ``resolve_intent``).
A model id goes stale; the intent does not, so only the table needs editing.

The owner may change the table and which intent each role uses
(``models/set`` in ``control.jsonl``). Defaults keep today's models: the secretary
on ``easy`` (claude-haiku-4.5), the bar raiser on ``default`` (claude-sonnet-5.5).
"""

from __future__ import annotations

import re
from pathlib import Path

from . import ledger, limits

INTENTS = ("easy", "default", "smartest")
#: Real ids from ``kiro-cli chat --list-models`` on 2026-11-08.
DEFAULT_ROUTES = {"easy": "claude-haiku-4.5", "default": "claude-sonnet-5.5", "smartest": "claude-opus-5.5"}
DEFAULT_ROLES = {"secretary": "easy", "bar_raiser": "default"}
_MODEL_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]{0,63}$")


def config(rows: list[dict]) -> dict:
    """``{routes, roles}`` from the newest ``models/set`` over the defaults (pure)."""
    routes, roles = dict(DEFAULT_ROUTES), dict(DEFAULT_ROLES)
    for row in rows:
        if row["type"] == "models/set":
            d = row["data"]
            routes.update({k: v for k, v in (d.get("routes") or {}).items() if k in INTENTS})
            roles.update({k: v for k, v in (d.get("roles") or {}).items() if k in DEFAULT_ROLES and v in INTENTS})
    return {"routes": routes, "roles": roles}


def resolve(cfg: dict, role: str) -> str:
    """The model id for ``role``: role -> intent -> id (pure)."""
    return cfg["routes"][cfg["roles"].get(role, "default")]


def model_for(root: Path, role: str) -> str:
    return resolve(config(ledger.read(root, limits.CONTROL)), role)


def set_config(root: Path, routes: object = None, roles: object = None, by: str = "owner") -> dict:
    routes = {} if routes is None else routes
    roles = {} if roles is None else roles
    if not isinstance(routes, dict) or not isinstance(roles, dict):
        return {"status": "refused", "reason": "bad_models"}
    for k, v in routes.items():
        if k not in INTENTS:
            return {"status": "refused", "reason": "unknown_intent", "key": k}
        if not isinstance(v, str) or not _MODEL_RE.match(v):
            return {"status": "refused", "reason": "bad_model_id", "key": k}
    for k, v in roles.items():
        if k not in DEFAULT_ROLES:
            return {"status": "refused", "reason": "unknown_role", "key": k}
        if v not in INTENTS:
            return {"status": "refused", "reason": "unknown_intent", "key": k}
    with ledger.transaction(root):
        ledger.append(root, limits.CONTROL, "models/set", by, {"routes": routes, "roles": roles})
        return {"status": "accepted", **config(ledger.read(root, limits.CONTROL))}
