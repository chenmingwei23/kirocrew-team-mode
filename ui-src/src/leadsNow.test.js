// node --test src/leadsNow.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { fmtAge, leadsNow } from './leadsNow.js'
import { waitingItems } from './waitingSource.js'

const NOW = 1_800_000_000
const roster = [{ id: 'L-a', name: 'api-lead' }, { id: 'L-b', name: 'ui-lead' }, { id: 'L-c', name: 'docs-lead' }]
const group = { id: 'G-1', kind: 'group', title: 'release-train', members: ['L-a', 'L-b', 'L-c'], people: ['owner'] }

let seq = 0
const row = (type, by, ts, data) => ({ seq: ++seq, ts, type, by, data })
const post = (by, ts, msg_id, extra = {}) => row('message/posted', by, ts, { msg_id, thread_id: null, ...extra })
const st = (entries, more = {}) => ({ channels: [group], entries: { 'G-1': entries }, cases: [], budget: {}, ...more })
const card = (r, id) => r.cards.find((c) => c.id === id)
// One /state `assignments` row: what teamapp/state.py:assignments sends, with
// wake.py assignment_due's {step, owed_by, due_ts, late} applied.
const asg = (assignment_id, from, to, step, extra = {}) => ({
  channel_id: 'G-1', assignment_id, from, to, thread_id: null, msg_seq: 1, opened_ts: NOW - 300, updated_ts: NOW - 300,
  empty: false, step, owed_by: step === 'asker' ? from : step === 'done' ? null : to, due_ts: null, late: step === 'marked', ...extra,
})
const IDS = /\b[LACTGDM]-[0-9a-z]+\b|dashboard:|chat-\d/

// "Waiting on you" items come from needsYou.js via waitingSource.js; these stand in.
const wait = (key, lead_id, ts, extra = {}) => ({ key, lead_id, ts, channel_id: 'G-1', thread_id: null, label: 'Spend approval', ...extra })

test('waiting on you: each item from the waiting source lands on its lead and counts once', () => {
  const s = st([post('lead:L-c', NOW - 100, 'M-3')])
  const r = leadsNow(s, roster, NOW, [
    wait('d1', 'L-b', NOW - 600),
    wait('d2', 'L-b', NOW - 300, { channel_id: null }),
    wait('d3', 'L-gone', NOW - 50), // a lead no longer in the roster: counted, no card
  ])
  assert.equal(r.waiting, 3)
  const b = card(r, 'L-b')
  assert.equal(b.status, 'waiting_you')
  assert.equal(b.label, 'Waiting on you')
  assert.equal(b.since, NOW - 600) // the oldest item shows
  assert.equal(b.reason, 'Spend approval · #release-train')
  assert.deepEqual(b.target, { channel_id: 'G-1', thread_id: null })
  assert.equal(b.more, 1)
  assert.equal(card(r, 'L-c').status, 'working')
  assert.equal(r.cards.length, 3)
})

test('waiting on you is never computed here: an owner @ answered with ask, or a case calling a person, adds nothing', () => {
  const r = leadsNow(st([
    post('owner', NOW - 300, 'M-1', { mentions: ['L-c'] }),
    row('assignment/opened', 'app', NOW - 300, { assignment_id: 'A-1', from: 'owner', to: 'L-c', msg_seq: 1, thread_id: null }),
    row('assignment/asked', 'app', NOW - 120, { assignment_id: 'A-1' }),
  ], { cases: [{ case_id: 'C-1', ts: NOW - 60, channel_id: 'G-1', thread_id: null, triggers: [], called_person: { class: 'spend' }, answer: null }] }), roster, NOW)
  assert.equal(r.waiting, 0)
  assert.ok(r.cards.every((c) => c.status !== 'waiting_you'))
})

test('@ unanswered: the ack step says when the bar raiser takes it; late says due now; marked stays until its case acts', () => {
  const opened = NOW - 360
  const rows = [post('lead:L-b', opened - 3000, 'M-1', { mentions: ['L-a'] })]
  let r = leadsNow(st(rows, { assignments: [asg('A-1', 'L-b', 'L-a', 'ack', { opened_ts: opened, due_ts: opened + 900 })] }), roster, NOW)
  const c = card(r, 'L-a')
  assert.equal(c.status, 'unanswered')
  assert.equal(c.reason, `@ from ui-lead not answered · bar raiser takes it in ${fmtAge(540)}`)
  assert.equal(c.since, opened)
  // late before the due time (two delivered wakes): the backend's `late` wins
  r = leadsNow(st(rows, { assignments: [asg('A-1', 'L-b', 'L-a', 'ack', { opened_ts: opened, due_ts: opened + 900, late: true })] }), roster, NOW)
  assert.equal(card(r, 'L-a').reason, '@ from ui-lead not answered · bar raiser due now')
  const cs = [{ case_id: 'C-1', ts: NOW, channel_id: 'G-1', thread_id: null, triggers: [{ trigger: 'unanswered_assignment', key: 'unanswered:A-1' }], acted: null }]
  const marked = [asg('A-1', 'L-b', 'L-a', 'marked', { opened_ts: opened, step_missed: 'ack' })]
  r = leadsNow(st(rows, { cases: cs, assignments: marked }), roster, NOW)
  assert.equal(card(r, 'L-a').reason, '@ from ui-lead not answered · bar raiser has it')
  cs[0].acted = { action: 'continue' }
  r = leadsNow(st(rows, { cases: cs, assignments: marked }), roster, NOW + 3600)
  assert.equal(card(r, 'L-a').status, 'no_signal')
})

test('an @ is answered twice: a taken @ owes a result (working, then late); result or no_result closes it', () => {
  const rows = [post('lead:L-a', NOW - 9000, 'M-1')]
  const taken = asg('A-1', 'owner', 'L-a', 'result', { updated_ts: NOW - 600, due_ts: NOW + 1200 })
  let r = leadsNow(st(rows, { assignments: [taken] }), roster, NOW)
  assert.equal(card(r, 'L-a').status, 'working')
  assert.equal(card(r, 'L-a').reason, `Took @ from Owner · result due in ${fmtAge(1200)} · #release-train`)
  assert.equal(card(r, 'L-a').since, NOW - 600)
  r = leadsNow(st(rows, { assignments: [{ ...taken, due_ts: NOW - 60, late: true }] }), roster, NOW)
  assert.equal(card(r, 'L-a').status, 'unanswered')
  assert.equal(card(r, 'L-a').reason, 'No result for @ from Owner · overdue')
  r = leadsNow(st(rows, { assignments: [asg('A-1', 'owner', 'L-a', 'marked', { step_missed: 'result' })] }), roster, NOW)
  assert.equal(card(r, 'L-a').reason, 'No result for @ from Owner · bar raiser has it')
  // closed by result or no_result (step done), or the assignee asked back (the assigner owes)
  for (const step of ['done', 'asker']) {
    r = leadsNow(st(rows, { assignments: [asg('A-1', 'L-b', 'L-a', step)] }), roster, NOW)
    assert.ok(r.cards.every((x) => x.status === 'no_signal'), step)
  }
})

test('"@ not answered" reads only /state assignments, never the channel rows or a timer of its own', () => {
  // rows alone say the @ is open and 2 hours old; the backend says it was closed with a result
  const rows = [
    row('assignment/opened', 'app', NOW - 7200, { assignment_id: 'A-1', from: 'L-b', to: 'L-a', msg_seq: 1, thread_id: null }),
  ]
  let r = leadsNow(st(rows, { assignments: [asg('A-1', 'L-b', 'L-a', 'done')] }), roster, NOW)
  assert.equal(card(r, 'L-a').status, 'no_signal')
  r = leadsNow(st(rows), roster, NOW) // no assignments in /state: nothing to say
  assert.equal(card(r, 'L-a').status, 'no_signal')
  // and the backend says late while no row exists at all
  r = leadsNow(st([], { assignments: [asg('A-2', 'L-b', 'L-c', 'ack', { due_ts: NOW + 600, late: true })] }), roster, NOW)
  assert.equal(card(r, 'L-c').reason, '@ from ui-lead not answered · bar raiser due now')
})

test('held back: held message, wake cap, team budget stop', () => {
  const rows = [post('lead:L-a', NOW - 50, 'M-1'), row('message/held', 'app', NOW - 50, { msg_id: 'M-1', reason: 'hop_limit' })]
  let r = leadsNow(st(rows, { budget: { lead_wakes_hour: { 'L-b': 12, cap: 12 } } }), roster, NOW)
  assert.equal(card(r, 'L-a').status, 'limited')
  assert.equal(card(r, 'L-a').reason, 'Message held · hop over 4 · #release-train')
  assert.equal(card(r, 'L-b').reason, 'Wake cap hit · 12/12 this hour')
  rows.push(row('message/released', 'app', NOW, { msg_id: 'M-1' }))
  r = leadsNow(st(rows, { stopped: true, stop_reason: 'budget' }), roster, NOW + 3600)
  for (const c of r.cards) assert.equal(c.reason, 'Team budget used up · nobody is woken')
  r = leadsNow(st(rows, { stopped: true, stop_reason: 'owner' }), roster, NOW + 3600)
  assert.ok(r.cards.every((c) => c.status !== 'limited'))
})

test('working: a taken @ with its result not yet due, or posted in the last 10 minutes', () => {
  const r = leadsNow(st([post('owner', NOW - 1000, 'M-1'), post('lead:L-c', NOW - 30, 'M-2')],
    { assignments: [asg('A-1', 'owner', 'L-b', 'result', { updated_ts: NOW - 900, due_ts: NOW + 900 })] }), roster, NOW)
  assert.equal(card(r, 'L-b').status, 'working')
  assert.equal(card(r, 'L-b').reason, `Took @ from Owner · result due in ${fmtAge(900)} · #release-train`)
  assert.equal(card(r, 'L-c').reason, 'Posted in #release-train')
  assert.equal(leadsNow(st([post('lead:L-c', NOW - 30, 'M-2')]), roster, NOW + 700).cards.find((c) => c.id === 'L-c').status, 'no_signal')
})

test('no signal says "No indicator fired", never healthy', () => {
  const r = leadsNow(st([post('lead:L-a', NOW - 5000, 'M-1'), post('lead:L-a', NOW - 4000, 'M-2')]), roster, NOW)
  const a = card(r, 'L-a')
  assert.equal(a.label, 'No indicator fired')
  assert.equal(a.reason, '2 posts')
  assert.equal(card(r, 'L-b').reason, 'No posts yet')
  assert.deepEqual(a.target, { channel_id: 'G-1', thread_id: null })
  assert.equal(card(r, 'L-b').target, null)
  for (const c of r.cards) assert.doesNotMatch(`${c.label} ${c.reason}`, /healthy/i)
})

test('several hits: the highest wins and the rest are counted', () => {
  const r = leadsNow(st([
    post('lead:L-a', NOW - 50, 'M-1'),
    row('message/held', 'app', NOW - 50, { msg_id: 'M-1', reason: 'hop_limit' }),
  ], { assignments: [asg('A-1', 'L-b', 'L-a', 'ack', { opened_ts: NOW - 100, due_ts: NOW + 800 })] }), roster, NOW, [wait('d1', 'L-a', NOW - 10)])
  const a = card(r, 'L-a')
  assert.equal(a.status, 'waiting_you')
  assert.equal(a.more, 3) // held + unanswered + posted recently
})

test('order: waiting > unanswered > held > working > no signal; older first within a status', () => {
  const ro = [...roster, { id: 'L-d', name: 'infra-lead' }, { id: 'L-e', name: 'web-lead' }, { id: 'L-f', name: 'zz-lead' }]
  const g = { ...group, members: ro.map((l) => l.id) }
  const rows = [post('lead:L-f', NOW - 20, 'M-1')] // working
  const assignments = [
    asg('A-1', 'owner', 'L-d', 'ack', { opened_ts: NOW - 100, due_ts: NOW + 800 }), // unanswered (newer)
    asg('A-2', 'owner', 'L-b', 'ack', { opened_ts: NOW - 200, due_ts: NOW + 700 }), // unanswered (older)
  ]
  const r = leadsNow({ channels: [g], entries: { 'G-1': rows }, cases: [], assignments, budget: { lead_wakes_hour: { 'L-a': 12, cap: 12 } } }, ro, NOW,
    [wait('d1', 'L-e', NOW - 30)]) // waiting on you
  assert.deepEqual(r.cards.map((c) => c.name), ['web-lead', 'ui-lead', 'infra-lead', 'api-lead', 'zz-lead', 'docs-lead'])
  assert.deepEqual(r.cards.map((c) => c.status), ['waiting_you', 'unanswered', 'unanswered', 'limited', 'working', 'no_signal'])
})

test('no card text carries an internal id or session key', () => {
  const r = leadsNow(st([
    post('lead:L-a', NOW - 50, 'M-1', { thread_id: 'T-9' }),
    row('message/held', 'app', NOW - 50, { msg_id: 'M-1', reason: 'channel_cooling' }),
    post('lead:L-b', NOW - 400, 'M-2', { thread_id: 'T-9' }),
  ], { assignments: [
    asg('A-1', 'L-b', 'L-c', 'ack', { thread_id: 'T-9', due_ts: NOW + 600 }),
    asg('A-2', 'owner', 'L-b', 'result', { thread_id: 'T-9', due_ts: NOW + 600 }),
  ] }), roster, NOW)
  for (const c of r.cards) assert.doesNotMatch(`${c.name} ${c.label} ${c.reason}`, IDS)
  assert.match(card(r, 'L-a').reason, /#release-train › thread/)
})

test('fmtAge', () => {
  assert.deepEqual([42, 600, 7200, 200000].map(fmtAge), ['<1 min', '10 min', '2 h', '2 d'])
})

test('each card carries its lead\'s project; leads of different projects share one group; no data shows none', () => {
  const ro = [{ id: 'L-a', name: 'api-lead', project: 'Payments API' }, { id: 'L-b', name: 'ui-lead', project: 'Checkout web' }, { id: 'L-c', name: 'docs-lead' }]
  const r = leadsNow(st([post('lead:L-a', NOW - 30, 'M-1'), post('lead:L-b', NOW - 20, 'M-2')]), ro, NOW)
  assert.equal(card(r, 'L-a').project, 'Payments API')
  assert.equal(card(r, 'L-b').project, 'Checkout web')
  assert.equal(card(r, 'L-c').project, null)
  assert.equal(card(r, 'L-a').reason, 'Posted in #release-train')
  assert.equal(card(r, 'L-b').reason, 'Posted in #release-train')
})

test('leadRoster reads existing leads only; with no Bot data a lead shows its handle and no project', async () => {
  const { leadRoster } = await import('./leadSource.js')
  const r = leadRoster({ leads: [
    { lead_id: 'L-a', handle: 'tm-demo-api-lead', kind: 'bot', active: true },
    { lead_id: 'L-b', handle: 'ui-lead', kind: 'chat', active: true },
    { lead_id: 'L-x', handle: 'gone-lead', kind: 'bot', active: false },
  ] })
  assert.deepEqual(r, [
    { id: 'L-a', name: 'api-lead', project: null, legacy: false, workers: null },
    { id: 'L-b', name: 'ui-lead', project: null, legacy: true, workers: null },
  ])
})

// Bots exactly as W-BOT's botSource.js botRows builds them from /api/members + /api/workspaces.
const BOT_MEMBERS = { members: [
  { name: 'payments', display_name: 'Payments Bot', slot_key: 'member-payments', workspace: 'payments-api', source: 'user' },
  { name: 'web', display_name: 'Web Bot', slot_key: 'member-web', workspace: '', source: 'user' }, // default workspace
  { name: 'other', display_name: 'Other', slot_key: 'member-other', workspace: 'x', source: 'user' }, // not added: no card
  { name: 'default', slot_key: 'member-default', source: 'builtin' },
] }
const BOT_WS = { workspaces: [{ name: 'payments-api', path: '/w/p' }, { name: 'checkout-web', path: '/w/c' }], default: 'checkout-web' }
const BOT_LEADS = [
  // a Bot lead as identity.register_bot records it (kind bot, crew key, the project at add time)
  // its handle is from before the Bot was renamed, so a join by handle would miss it
  { lead_id: 'L-a', handle: 'Pay-Bot', kind: 'bot', bot: 'payments', session_label: 'dashboard:member-payments', project: 'old-name', active: true },
  // matched by its chat's session label when the crew key is missing
  { lead_id: 'L-b', handle: 'Web-Bot', kind: 'bot', session_label: 'dashboard:member-web', active: true },
  { lead_id: 'L-c', handle: 'tm-demo-docs-lead', kind: 'chat', session_label: 'dashboard:chat-1', active: true }, // old `lead` agent chat
]

test('leadRoster joins botRows like leadForBot (crew key, else chat label): live name, project, workers', async () => {
  const { leadRoster } = await import('./leadSource.js')
  const { botRows } = await import('./botSource.js')
  const bots = botRows(BOT_MEMBERS, BOT_WS, { 'member-payments': { workers: [{ key: 'w1', title: 't', status: 'working', dispatched_by: '' }] } })
  assert.deepEqual(leadRoster({ leads: BOT_LEADS }, bots), [
    { id: 'L-a', name: 'Payments Bot', project: 'payments-api', legacy: false, workers: [{ key: 'w1', title: 't', status: 'working', dispatched_by: '', group: '' }] },
    { id: 'L-b', name: 'Web Bot', project: 'checkout-web', legacy: false, workers: null },
    { id: 'L-c', name: 'docs-lead', project: null, legacy: true, workers: null },
  ])
  // before the Bots are read: the project recorded at add time, the lead's handle
  assert.deepEqual(leadRoster({ leads: BOT_LEADS }).map((l) => [l.name, l.project]),
    [['Pay-Bot', 'old-name'], ['Web-Bot', null], ['docs-lead', null]])
})

test('a legacy lead card says so; Bot leads of different projects share a group; statuses unchanged', async () => {
  const { leadRoster } = await import('./leadSource.js')
  const { botRows } = await import('./botSource.js')
  const s = st([post('lead:L-a', NOW - 30, 'M-1')], {
    leads: BOT_LEADS,
    assignments: [asg('A-1', 'owner', 'L-b', 'ack', { due_ts: NOW + 600 })],
  })
  const ro = leadRoster(s, botRows(BOT_MEMBERS, BOT_WS, {}))
  const r = leadsNow(s, ro, NOW, [wait('d1', 'L-c', NOW - 100)])
  assert.deepEqual(r.cards.map((c) => [c.name, c.project, c.legacy, c.status]), [
    ['docs-lead', null, true, 'waiting_you'],
    ['Web Bot', 'checkout-web', false, 'unanswered'],
    ['Payments Bot', 'payments-api', false, 'working'],
  ])
})

// ───────────── waiting on you through the real source: needsYou.js waitingOnYou(state)

const decision = (key, kind, state, extra = {}) => ({ key, kind, state, impact: kind === 'ask' ? 'ask' : 'spend', question: 'q', channel_id: 'G-1', thread_id: null, opened_ts: NOW - 300, answer: null, ...extra })
const nowFrom = (s) => leadsNow(s, roster, NOW, waitingItems(s))

test('waitingOnYou decides: an open ask lands on its lead; answered or skipped drops the card and the count', () => {
  const rows = [post('lead:L-c', NOW - 5000, 'M-1')]
  for (const closed of ['answered', 'skipped', 'withdrawn']) {
    const s = st(rows, { decisions: [decision('ask:G-1:A-1', 'ask', 'open', { lead: 'L-c' })] })
    let r = nowFrom(s)
    assert.equal(r.waiting, 1)
    assert.equal(card(r, 'L-c').status, 'waiting_you')
    assert.equal(card(r, 'L-c').reason, 'Asked you · #release-train')
    assert.equal(card(r, 'L-c').since, NOW - 300)
    s.decisions[0].state = closed
    r = nowFrom(s)
    assert.equal(r.waiting, 0, closed)
    assert.equal(card(r, 'L-c').status, 'no_signal', closed)
  }
})

test('a case decision goes on the lead its trigger names, else the last poster before it opened', () => {
  const rows = [
    post('lead:L-a', NOW - 900, 'M-1'), post('lead:L-b', NOW - 800, 'M-2'), post('lead:L-c', NOW - 100, 'M-3'),
  ]
  const cases = [
    { case_id: 'C-1', ts: NOW - 600, channel_id: 'G-1', thread_id: null, triggers: [] },
    { case_id: 'C-2', ts: NOW - 650, channel_id: 'G-1', thread_id: null, triggers: [{ trigger: 'unanswered_assignment', key: 'unanswered:A-9' }] },
  ]
  // A-9 is closed now, so it adds no hit of its own; the case's trigger still names its assignee.
  const assignments = [asg('A-9', 'L-b', 'L-a', 'done')]
  const r = nowFrom(st(rows, { cases, assignments, decisions: [
    decision('case:C-1', 'case', 'open', { opened_ts: NOW - 600 }),
    decision('case:C-2', 'case', 'open', { impact: 'irreversible', opened_ts: NOW - 650 }),
  ] }))
  assert.equal(r.waiting, 2)
  assert.equal(card(r, 'L-b').reason, 'Bar raiser asks you · costs money · #release-train') // last poster before C-1
  assert.equal(card(r, 'L-a').reason, 'Bar raiser asks you · irreversible · #release-train') // C-2's trigger
  assert.equal(card(r, 'L-c').status, 'working')
  for (const c of r.cards) assert.doesNotMatch(c.reason, IDS)
})

test('the count equals waitingOnYou even when a decision names no lead on the roster', () => {
  const s = st([], { decisions: [decision('ask:G-1:A-1', 'ask', 'open', { lead: 'L-gone' }), decision('ask:G-1:A-2', 'ask', 'answered', { lead: 'L-a' })] })
  const r = nowFrom(s)
  assert.equal(r.waiting, 1)
  assert.ok(r.cards.every((c) => c.status === 'no_signal'))
})
