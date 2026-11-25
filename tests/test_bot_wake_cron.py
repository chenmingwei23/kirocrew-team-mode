"""Adding a Bot lead hangs the inbox probe on the Bot's own chat (host ``cron.add_job(bot=)``).

Reddens if: ``_lead_add`` stops calling ``_arm_bot_wake`` (armed test); the ``bot=`` keyword
is dropped (armed test); a host refusal is no longer reported (refused test); removing the
lead stops removing the job (remove test).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import hooks  # noqa: E402


class _Cron:
    def __init__(self, refuse=None):
        self.jobs, self.calls, self.refuse = [], [], refuse

    def list_jobs(self):
        return list(self.jobs)

    async def add_job_async(self, name, message, **kw):
        if self.refuse:
            raise ValueError(self.refuse)
        self.calls.append((name, json.loads(message), kw))
        self.jobs.append(SimpleNamespace(id=f"j{len(self.jobs)}", name=name))

    async def remove_job_async(self, job_id):
        self.jobs = [j for j in self.jobs if j.id != job_id]


def _client(tmp_path, cron):
    async def require_owner(request, op):
        return None

    ctx = SimpleNamespace(data_dir=str(tmp_path), require_owner=require_owner, cron=cron)
    app = web.Application()
    for r in hooks.register_routes(ctx):
        app.router.add_route(r.method, "/x" + r.path, lambda req, h=r.handler: h(req, ctx))
    return TestClient(TestServer(app))


BOT = {"bot": "atlas", "slot_key": "member-atlas", "display_name": "Atlas"}


@pytest.mark.asyncio
async def test_adding_a_bot_arms_its_wake_on_its_own_chat(tmp_path):
    cron = _Cron()
    async with _client(tmp_path, cron) as client:
        body = await (await client.post("/x/leads", json=BOT)).json()
        assert body["wake"] == "armed"
        name, msg, kw = cron.calls[0]
        assert (msg["lead_id"], kw["bot"], kw["every_secs"]) == (body["lead_id"], "atlas", 60)
        assert kw["script"] == "crons/inbox_probe.py:watch"
        await client.delete(f"/x/leads/{body['lead_id']}")
    assert cron.jobs == []


@pytest.mark.asyncio
async def test_a_host_refusal_is_reported_and_the_bot_still_joins(tmp_path):
    cron = _Cron(refuse="cron bot= refused: not_turned_on: ...")
    async with _client(tmp_path, cron) as client:
        resp = await client.post("/x/leads", json=BOT)
        body = await resp.json()
        assert resp.status == 200 and body["wake"].startswith("refused: cron bot= refused: not_turned_on")
        cron.refuse = None
        again = await client.post(f"/x/leads/{body['lead_id']}/wake")
        assert (again.status, (await again.json())["wake"]) == (200, "armed")


def test_name_is_per_lead():
    assert hooks._wake_job_name("L-0000abcd") == "team-mode-inbox-L-0000abcd"


@pytest.mark.asyncio
async def test_startup_arms_the_wake_again_after_the_host_dropped_it(tmp_path):
    """Reddens if ``on_startup`` stops calling ``rearm_bot_wakes``: a disable removes the
    app's crons, and an enable must hang the probe on each Bot lead's chat again."""
    cron = _Cron()
    async with _client(tmp_path, cron) as client:
        lead_id = (await (await client.post("/x/leads", json=BOT)).json())["lead_id"]
    cron.jobs = []  # what the host's disable does
    ctx = SimpleNamespace(data_dir=str(tmp_path), cron=cron)
    await hooks.on_startup(ctx)
    try:
        assert [j.name for j in cron.jobs] == [hooks._wake_job_name(lead_id)]
        assert cron.calls[-1][2]["bot"] == "atlas"
    finally:
        await hooks.on_shutdown(ctx)
