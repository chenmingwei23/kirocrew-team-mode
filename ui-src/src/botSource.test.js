// node --test src/botSource.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { addBody, addBotError, addCheck, botGroups, botHandle, botRows, chatToolsBody, chatToolsError, chatToolsSwitch, leadKind, removeFromTeam, teamLeadIds } from './botSource.js'
import { impactLines } from './model.js'

// Shapes as the pod answered them (GET /api/members, /api/workspaces, crew-workers), trimmed.
const MEMBERS = {
  members: [
    { name: 'default', slug: 'default', workspace: 'default', source: 'kirocrew', slot_key: '', display_name: '' },
    { name: 'mate', slug: 'mate', workspace: 'member-mate', source: 'builtin', slot_key: '', display_name: '' },
    { name: 'web-lead', workspace: 'member-web-lead', source: 'kirocrew', slot_key: 'member-web-lead.memory-w', display_name: '', running: true, description: 'Web' },
    { name: 'api-lead', workspace: 'member-api-lead', source: 'kirocrew', slot_key: 'member-api-lead.memory-a', display_name: 'API Lead', last_active_ts: 5 },
    { name: 'docs-lead', workspace: '', source: 'kirocrew', slot_key: '', display_name: '' },
  ],
}
const WS = { workspaces: [{ name: 'member-api-lead', path: 'workspace-member-api-lead', is_default: false }], default: 'default' }
const WORKERS = {
  'member-api-lead.memory-a': { root: 'member-api-lead.memory-a', root_kind: 'mate', workers: [{ key: 'chat-1', title: 'Fix', status: 'idle', group: 'done', dispatched_by: 'member-api-lead.memory-a', extra: 1 }] },
  'member-web-lead.memory-w': null, // the call failed
}

test('botRows: only Bots, project from workspace, workers only when crew-workers answered', () => {
  const rows = botRows(MEMBERS, WS, WORKERS)
  assert.deepEqual(rows.map((r) => r.bot), ['api-lead', 'docs-lead', 'web-lead'])
  const [api, docs, web] = rows
  assert.equal(api.name, 'API Lead')
  assert.equal(api.handle, 'API-Lead')
  assert.equal(api.project, 'member-api-lead')
  assert.equal(api.project_path, 'workspace-member-api-lead')
  assert.equal(api.session_label, 'dashboard:member-api-lead.memory-a')
  assert.deepEqual(api.workers, [{ key: 'chat-1', title: 'Fix', status: 'idle', group: 'done', dispatched_by: 'member-api-lead.memory-a' }])
  // No data is null, never an empty list.
  assert.equal(web.workers, null)
  assert.equal(docs.workers, null)
  // Empty workspace means the default workspace.
  assert.equal(docs.project, 'default')
  assert.equal(docs.slot_key, '')
  assert.equal(web.running, true)
})

test('botRows: a crew-workers answer with no workers is an empty list, not null', () => {
  const [api] = botRows(MEMBERS, WS, { 'member-api-lead.memory-a': { workers: [] } })
  assert.deepEqual(api.workers, [])
})

test('botRows: nothing readable gives no rows', () => {
  assert.deepEqual(botRows(null, null, null), [])
  assert.deepEqual(botRows({ members: [MEMBERS.members[0], MEMBERS.members[1]] }, WS, {}), [])
})

test('botHandle mirrors identity.py:bot_handle', () => {
  assert.equal(botHandle({ name: 'x', display_name: 'API Lead (shop)' }), 'API-Lead-shop')
  assert.equal(botHandle({ name: 'api-lead', display_name: '' }), 'api-lead')
  assert.equal(botHandle({ name: 'a'.repeat(90) }).length, 40)
})

test('addCheck: never-opened Bot, already in team, name clash', () => {
  const [api, docs, web] = botRows(MEMBERS, WS, {})
  const leads = new Map([['L-1', { lead_id: 'L-1', kind: 'bot', bot: 'web-lead', handle: 'web-lead', active: true }],
    ['L-2', { lead_id: 'L-2', kind: 'chat', handle: 'API-Lead', session_label: 'dashboard:chat-9', active: true }]])
  assert.match(addCheck(docs, leads).why, /Open this Bot once/)
  assert.equal(addCheck(web, leads).why, 'Already in the team.')
  assert.match(addCheck(api, leads).why, /A lead named API-Lead/)
  assert.equal(addCheck(api, new Map()).ok, true)
  // A retired lead does not block.
  assert.equal(addCheck(web, new Map([['L-1', { ...leads.get('L-1'), active: false }]])).ok, true)
})

test('addBody sends the display name only when the Bot has one', () => {
  const [api, , web] = botRows(MEMBERS, WS, {})
  assert.deepEqual(addBody(api), { bot: 'api-lead', slot_key: 'member-api-lead.memory-a', display_name: 'API Lead', project: 'member-api-lead' })
  assert.equal(addBody(web).display_name, '')
})

test('addBotError: clear English for each refusal', () => {
  assert.equal(addBotError({ body: '{"status": "refused", "reason": "already_in_team"}' }), 'This Bot is already in the team.')
  assert.match(addBotError({ body: '{"reason":"handle_taken"}' }), /already has this name/)
  assert.match(addBotError(new Error('API 500: boom')), /^Could not add the Bot/)
})

test('leadKind: a legacy lead chat is labelled Legacy lead', () => {
  assert.equal(leadKind({ kind: 'bot' }).label, 'Bot')
  assert.equal(leadKind({ kind: 'chat' }).label, 'Legacy lead')
  assert.equal(leadKind({}).kind, 'legacy')
  assert.equal(leadKind({ kind: 'remote' }).label, "Other owner's Bot")
})

test('botGroups: one Bot in several groups; closed groups and DMs left out', () => {
  const state = { channels: [
    { id: 'G-1', kind: 'group', title: 'a', members: ['L-1', 'L-2'] },
    { id: 'G-2', kind: 'group', title: 'b', members: ['L-1', 'L-3'] },
    { id: 'G-3', kind: 'group', title: 'c', members: ['L-2', 'L-3'] },
    { id: 'G-4', kind: 'group', title: 'd', members: ['L-1'], closed: true },
    { id: 'D-1', kind: 'dm', members: ['L-1', 'L-2'] },
  ] }
  const g = botGroups(state, 'L-1')
  assert.deepEqual(g.in.map((c) => c.id), ['G-1', 'G-2'])
  assert.deepEqual(g.open.map((c) => c.id), ['G-3'])
  assert.deepEqual(botGroups(state, null).in, [])
})

test('teamLeadIds: a core Bot team picks the Bots already in Team Mode, in team order', () => {
  const leads = new Map([
    ['L-1', { lead_id: 'L-1', kind: 'bot', bot: 'web-lead', active: true }],
    ['L-2', { lead_id: 'L-2', kind: 'bot', bot: 'api-lead', active: true }],
    ['L-3', { lead_id: 'L-3', kind: 'bot', bot: 'docs-lead', active: false }],
  ])
  assert.deepEqual(teamLeadIds({ members: ['api-lead', 'docs-lead', 'web-lead', 'nobody'] }, leads), ['L-2', 'L-1'])
})

// The owner's switch on the Team Mode tab (host GET/PUT /api/apps/team-mode/bot-grants).
const GRANTS = { declaredScopes: ['tools'], scopes: ['tools'] }

test('the chat-tools switch shows when tools is declared, and is on for a ticked Bot', () => {
  assert.deepEqual(chatToolsSwitch({ ...GRANTS, bots: [] }, 'ira'), { show: true, approved: true, on: false })
  assert.deepEqual(chatToolsSwitch({ ...GRANTS, bots: ['ira'] }, 'ira'), { show: true, approved: true, on: true })
  assert.equal(chatToolsSwitch({ ...GRANTS, bots: ['ira'] }, 'other').on, false)
  assert.equal(chatToolsSwitch({ declaredScopes: ['tools'], scopes: [], bots: [] }, 'ira').approved, false)
  assert.equal(chatToolsSwitch({ declaredScopes: [], scopes: [], bots: [] }, 'ira').show, false)
  assert.equal(chatToolsSwitch(null, 'ira').show, false)
})

test('the chat-tools PUT body ticks or unticks this Bot only and keeps the other ticked Bots', () => {
  assert.deepEqual(chatToolsBody({ bots: ['ada'] }, 'ira', true), { bots: ['ada', 'ira'] })
  assert.deepEqual(chatToolsBody({ bots: ['ada', 'ira'] }, 'ira', false), { bots: ['ada'] })
  assert.deepEqual(chatToolsBody({ bots: ['ira'] }, 'ira', true), { bots: ['ira'] }) // no duplicate
})

test('a chat-tools refusal reads as plain English', () => {
  assert.match(chatToolsError({ body: '{"error":"x","code":"bot_grants_not_saved"}' }), /not saved/)
  assert.match(chatToolsError({ body: '{"code":"owner_only"}' }), /owner/)
  assert.equal(chatToolsError(new Error('boom')), 'Could not change the switch. Try again.')
})

// Remove takes the Bot out of the team and unticks it; the Bot stays (pod
// kc-r4-tree: before this, Ira's switch was still on after Remove, only the cron went).
function fakeApi(bots) {
  const calls = []
  return {
    calls,
    del: async (url) => { calls.push(['DELETE', url]) },
    get: async (url) => { calls.push(['GET', url]); return { ...GRANTS, bots } },
    put: async (url, body) => { calls.push(['PUT', url, body]); return { ...GRANTS, bots: body.bots } },
  }
}

test('removeFromTeam retires the lead, then unticks the Bot for Team Mode, keeping other ticked Bots', async () => {
  const api = fakeApi(['ada', 'ira'])
  await removeFromTeam(api, 'L-1', 'ira')
  assert.deepEqual(api.calls, [
    ['DELETE', '/api/apps/team-mode/leads/L-1'],
    ['GET', '/api/apps/team-mode/bot-grants'],
    ['PUT', '/api/apps/team-mode/bot-grants', { bots: ['ada'] }],
  ])
  const off = fakeApi(['ada'])
  await removeFromTeam(off, 'L-1', 'ira')
  assert.equal(off.calls.filter((c) => c[0] === 'PUT').length, 0) // already off: nothing to write
  const legacy = fakeApi(['ira'])
  await removeFromTeam(legacy, 'L-2', '')
  assert.deepEqual(legacy.calls, [['DELETE', '/api/apps/team-mode/leads/L-2']])
})

test('the Remove dialog says the switch and the wake job go, for a Bot only', () => {
  const said = (lines) => lines.some((l) => /switch and its wake job are turned off/.test(l.text))
  assert.ok(said(impactLines({ groups: [] }, { bot: true })))
  assert.ok(!said(impactLines({ groups: [] })))
})
