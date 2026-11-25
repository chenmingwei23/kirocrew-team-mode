// node --test src/model.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  foldChannel, mergeState, parseOwnerMentions, leadIndex, splitMentions, reasonLabel, threadLabel,
  caseStatus, cardOpen, cardRows, evidenceParts, readableIds,
} from './model.js'
import * as model from './model.js'

test('a person card offers Skip, sent as skip bound to the card version (round4 C)', () => {
  assert.deepEqual(model.CARD_ACTIONS, ['approve', 'change', 'no', 'skip'])
  const c = { case_id: 'C-1', called_person: { card_hash: 'h1', card: { if_no: 'hold' } } }
  assert.deepEqual(model.cardAnswerBody(c, 'skip'), { skip: true, card_hash: 'h1' })
  assert.deepEqual(model.cardAnswerBody(c, 'approve', { standing: true }), { decision: 'approve', card_hash: 'h1', standing: { hours: 24 } })
  assert.deepEqual(model.cardAnswerBody(c, 'change', { text: ' later ', standing: true }), { decision: 'change', card_hash: 'h1', text: 'later' })
})

const fixture = JSON.parse(readFileSync(new URL('../fixtures/state-13-quota.json', import.meta.url)))

test('mergeState appends new rows and replaces rows with the same seq', () => {
  const a = { cursor: 1, entries: { G: [{ seq: 1, type: 'x' }, { seq: 2, type: 'old' }] } }
  const b = { cursor: 2, entries: { G: [{ seq: 2, type: 'new' }, { seq: 3, type: 'y' }] } }
  const m = mergeState(a, b)
  assert.deepEqual(m.entries.G.map((r) => [r.seq, r.type]), [[1, 'x'], [2, 'new'], [3, 'y']])
  assert.equal(m.cursor, 2)
})

test('foldChannel: thread replies stay out of main, held and assignment states land on their messages', () => {
  const f = foldChannel(fixture.entries['G-5e1a9c20'])
  assert.ok(f.main.every((m) => !m.thread_id))
  const th = f.threads.get('T-2')
  assert.equal(th.count, 5)
  assert.equal(th.replies.find((m) => m.msg_id === 'M-05').held, true)
  assert.equal(f.bySeq.get(13).assignments[0].state, 'taken')
  assert.equal(f.bySeq.get(18).assignments[0].state, 'unanswered')
  assert.equal(f.relays.length, 2)
})

test('owner mentions resolve by handle, ignore unknown names and flag @everyone', () => {
  const leads = leadIndex(fixture)
  const r = parseOwnerMentions('@tm-demo-ui-lead @nobody @everyone hi @tm-demo-ui-lead', leads)
  assert.deepEqual(r.mentions, ['L-b2d4f602'])
  assert.equal(r.everyone, true)
  const parts = splitMentions('hi @nobody @everyone', new Set())
  assert.deepEqual(parts.filter((p) => p.mention).map((p) => p.mention), ['everyone'])
})

test('brief wake reasons and thread place read as words, never ids (video round 2, S13/S15)', () => {
  const reasons = ['mention', 'assign:A-cf8d581f', 'answer:A-0a1b2c3d', 'rewake:A-0a1b2c3d', 'owner', 'cc', 'dm',
    'pulled_in', 'everyone', 'batch', 'meeting_invite:MT-1a2b3c4d', 'meeting_turn:TU-0123456789ab',
    'meeting_chair:MT-1a2b3c4d:I1:2', 'meeting_vote:MT-1a2b3c4d:I1-B1', 'future_kind:X-99']
  const labels = reasons.map(reasonLabel)
  assert.equal(reasonLabel('assign:A-cf8d581f'), 'new assignment')
  assert.equal(reasonLabel('mention'), '@-mentioned')
  assert.equal(reasonLabel('future_kind:X-99'), 'future kind')
  for (const l of labels) assert.doesNotMatch(l, /[A-Z]{1,2}-[0-9a-f]|:/, l)
  // round5 S42: a thread is named by its first words, never 'thread at #12' (a root seq)
  const titles = { 'T-12': 'Ada, Uma, settle this between you,…' }
  assert.equal(threadLabel('T-12', titles), 'thread: “Ada, Uma, settle this between you,…”')
  assert.equal(threadLabel('T-12'), 'thread')
  assert.equal(threadLabel('T-13', titles), 'thread')
  assert.doesNotMatch(threadLabel('T-12', titles), /#\d|T-\d/)
})

test('an @ is answered twice: taken, then closed with an empty result', () => {
  const row = (seq, type, by, data) => ({ seq, ts: seq, type, by, data })
  const f = foldChannel([
    row(1, 'message/posted', 'lead:L-a', { msg_id: 'M-1', text: '@b find it' }),
    row(2, 'assignment/opened', 'app', { assignment_id: 'A-1', from: 'L-a', to: 'L-b', msg_seq: 1 }),
    row(3, 'assignment/taken', 'lead:L-b', { assignment_id: 'A-1' }),
    row(4, 'assignment/closed', 'lead:L-b', { assignment_id: 'A-1', empty: true }),
  ])
  const a = f.assignments.get('A-1')
  assert.equal(a.state, 'closed')
  assert.equal(a.empty, true)
})

// ───────────────────────────────────────────── W-LC: limits, models, remove impact

import { errText, impactLines, limitRows, limitsBody, modelRows } from './model.js'

test('limitRows: the applied cap, the hard cap and a clamped ask; minutes for the away pause', () => {
  const budget = { limits: {
    caps: { hourly_message: 3, total_wakes: 200, owner_away_secs: 600 },
    hard: { hourly_message: 200, total_wakes: 200, owner_away_secs: 7200 },
    asked: { hourly_message: 3, total_wakes: 700, owner_away_secs: 600 },
    clamped: ['total_wakes'],
  } }
  const by = Object.fromEntries(limitRows(budget).map((r) => [r.key, r]))
  assert.equal(by.hourly_message.applied, 3)
  assert.equal(by.total_wakes.clamped, true)
  assert.equal(by.total_wakes.asked, 700)
  assert.equal(by.total_wakes.applied, 200)
  assert.equal(by.owner_away_secs.applied, 10)
  assert.equal(by.owner_away_secs.hard, 120)
  assert.equal(by.hourly_wake.asked, null)
})

test('limitsBody: blank fields are left out, minutes become seconds, a bad number is refused', () => {
  assert.deepEqual(limitsBody({ hourly_message: ' 5 ', total_wakes: '', owner_away_secs: '2' }),
    { limits: { hourly_message: 5, owner_away_secs: 120 } })
  assert.match(limitsBody({ hourly_wake: '0' }).error, /Wakes per hour/)
  assert.match(limitsBody({ hourly_wake: '1.5' }).error, /whole number/)
})

test('modelRows: role -> intent -> model id', () => {
  const rows = modelRows({ routes: { easy: 'claude-haiku-4.5', default: 'claude-sonnet-5.5' },
    roles: { secretary: 'easy', bar_raiser: 'default' } })
  assert.deepEqual(rows.map((r) => [r.label, r.intent, r.model]),
    [['Secretary', 'easy', 'claude-haiku-4.5'], ['Bar raiser', 'default', 'claude-sonnet-5.5']])
})

test('impactLines: groups left short, open items, and no ids', () => {
  const lines = impactLines({ handle: 'api', dms: 1,
    groups: [{ title: 'pair', left: 1, short: true }, { title: 'trio', left: 2, short: false }],
    requests: [{ group: 'trio', state: 'open', text: "@ui's request to @api" }],
    actions: [{ group: 'trio', title: 'Fix the alarm', state: 'unanswered' }],
    meetings: [{ group: 'trio', title: 'Sync', role: 'attendee' }],
    cases: [{ group: 'trio', state: 'waiting on you' }] })
  assert.equal(lines[0].kind, 'keep')  // Remove takes it out of the team; the Bot stays
  assert.match(lines[0].text, /^The Bot itself is kept/)
  assert.equal(lines[1].kind, 'warn')
  assert.match(lines[1].text, /only 1 active lead left/)
  assert.equal(lines[2].kind, 'info')
  assert.ok(lines.some((l) => /1 direct message stops/.test(l.text)))
  assert.ok(lines.some((l) => /Fix the alarm.*loses its owner/.test(l.text)))
  assert.ok(lines.every((l) => !/L-|G-|A-/.test(l.text)))
  assert.deepEqual(impactLines(null), [])
  const twice = impactLines({ requests: [1, 2, 3].map(() => ({ group: 'g', state: 'open', text: "@a's request to @b" })) })
  assert.deepEqual(twice.slice(1).map((l) => l.text), ["@a's request to @b in #g is still open (3 times)"])
  assert.equal(impactLines({}).length, 1)  // even with nothing open, the dialog says the Bot is kept
})

test('errText: known refusals read as sentences', () => {
  assert.equal(errText({ body: JSON.stringify({ reason: 'open_items' }) }), 'Clear the open items first.')
  assert.equal(errText(new Error('boom')), 'boom')
})

test('a person card shows fixed fields in a fixed order and only an open card can be answered', () => {
  const card = { what: 'Run the $40 load test', who: '#release › main · api-lead', cost: '$40', reversible: 'no',
    attempt: 2, tried: ['continue'], expires: 1000 + 3600, class: 'spend', question: 'q', if_no: 'close_thread' }
  const rows = cardRows(card, 1000)
  assert.deepEqual(rows.map((r) => r[0]), ['What', 'Who', 'Cost', 'Can undo', 'Attempt', 'Tried before', 'Expires', 'If you say no'])
  assert.equal(rows[3][1], 'No')
  assert.equal(rows[5][1], 'Continue')
  assert.match(rows[6][1], /in 1h 0m/)
  assert.equal(rows[7][1], 'Close this chain')
  const c = { acted: { action: 'call_person' }, called_person: { card, card_hash: 'h', void: null }, answer: null }
  assert.equal(cardOpen(c), true)
  assert.deepEqual(caseStatus(c), ['Needs your answer', 'is-err'])
  // a newer card on the chain, an answer, a lapse or a standing approval close it
  assert.equal(cardOpen({ ...c, called_person: { ...c.called_person, void: 'new_attempt' } }), false)
  assert.deepEqual(caseStatus({ ...c, called_person: { ...c.called_person, void: 'new_attempt' } })[0], 'Replaced')
  assert.equal(cardOpen({ ...c, answer: { decision: 'no' } }), false)
  assert.deepEqual(caseStatus({ ...c, answer: { decision: 'no' } })[0], 'You said no')
  assert.equal(cardOpen({ ...c, lapsed: true }), false)
  assert.equal(caseStatus({ ...c, called_person: { ...c.called_person, standing: true } })[0], 'Within your standing approval')
})

test('HOLD and BLOCK read apart, and party claims are marked in the evidence line', () => {
  assert.deepEqual(caseStatus({ acted: { action: 'veto' } }), ['BLOCK', 'is-err'])
  assert.deepEqual(caseStatus({ acted: { action: 'hold' } }), ['HOLD', 'is-warn'])
  assert.deepEqual(evidenceParts([{ seq: 4, source: 'record' }, { seq: 3, source: 'party_claim' }, { seq: 2, source: 'owner' }])
    .map((p) => p.label), ['record #4', 'claim #3', 'you #2'])
})

test('readableIds: proposal ids read as "Proposal N" (F-MS2)', () => {
  assert.equal(readableIds('I object to I1-P1.', 'I1'), 'I object to Proposal 1.')
  assert.equal(readableIds('I2-P3', 'I1'), 'Proposal 3 of item 2')
  assert.equal(readableIds(undefined, 'I1'), undefined)
})

test('readableIds: cited seqs and ballot ids read as words (round4 F4)', () => {
  const refs = { 116: "Ada's speech", 119: "Uma's speech", 120: "Ira's speech", 130: 'the vote result' }
  assert.equal(
    readableIds('Ballot I2-B1 is a 1-1-1 tie (record seq 130). Claims (seqs 116, 119, 120); Ada, seq 116; seq 999; ballot I1-B2.', 'I2', refs),
    "Vote 1 is a 1-1-1 tie (the vote result). Claims (Ada's speech, Uma's speech and Ira's speech); Ada, Ada's speech; an earlier entry; vote 2 of item 1.")
  assert.equal(readableIds('seq 130', 'I2'), 'seq 130')
  assert.equal(readableIds('Owner message seq 2 sets it', 'I1', { 2: "the owner's message" }), "the owner's message sets it")
})

// ───────────────────────────────────────────────────────────── team tree

import {
  appLeadSource, clampZoom, countWorkers, fitZoom, hasInternalId, layoutTree, roleCardFields, teamTree, TREE, ZOOM_MAX, ZOOM_MIN,
  BOTS_PAGE, botLeadSource, crewWorkersToTree, rosterLeadSource, LEGACY_LABEL, leadKindLabel,
  EXPANDED_STORE_KEY, expandAllKeys, hiddenWorkerCount, loadExpanded, saveExpanded, visibleTree,
} from './model.js'
import { botRows } from './botSource.js'

/** Everything a tree node or role card puts on screen: no key, slot or hue. */
function shownText(tree) {
  const out = [tree.owner.name]
  for (const l of tree.leads) {
    const { key, slotKey, hue, ...shown } = l
    out.push(JSON.stringify(shown), JSON.stringify(roleCardFields(l)))
  }
  return out.join('\n')
}

const treeFixture = JSON.parse(readFileSync(new URL('../fixtures/state-13-quota.json', import.meta.url)))

test('teamTree: owner -> every active lead, with groups, status, waits and routines from /state', () => {
  const t = teamTree(treeFixture)
  assert.equal(t.owner.name, 'Owner')
  assert.equal(t.owner.leadCount, 3)
  assert.equal(t.owner.groupCount, 1)
  assert.deepEqual(t.leads.map((l) => l.name), ['api-lead', 'ui-lead', 'infra-lead'])
  for (const l of t.leads) {
    assert.equal(l.project, '') // the app's own lead list has no project
    assert.equal(l.workers, null) // ...and cannot see a lead's workers
    assert.deepEqual(l.groups, ['release-train']) // DMs are not groups
    assert.equal(l.status, 'waiting') // the open call_person case sits in their group
    assert.equal(l.waits.length, 1)
    assert.equal(l.waits[0].where, '#release-train')
    assert.equal(l.routines.briefs, 1)
    assert.equal(l.routines.cronJobs, null)
    assert.match(l.slotKey, /^chat-10\d-/)
  }
  assert.equal(t.leads[2].assignments.unanswered, 1)
  const answered = structuredClone(treeFixture)
  answered.cases.forEach((c) => { c.answer = { text: 'no', ts: 1 } })
  assert.equal(teamTree(answered).leads[2].status, 'no_answer')
  assert.equal(teamTree(answered).leads[0].status, 'quiet')
  assert.equal(teamTree({ ...treeFixture, stopped: true }).leads[0].statusLabel, 'Stopped')
})

test('teamTree: retired leads drop out and a missing role draws the empty state', () => {
  const s = structuredClone(treeFixture)
  s.leads[1].active = false
  s.leads[0].duty = 'Owns the public API'
  const t = teamTree(s)
  assert.deepEqual(t.leads.map((l) => l.name), ['api-lead', 'infra-lead'])
  assert.equal(roleCardFields(t.leads[0]).Owns, 'Owns the public API')
  assert.equal(roleCardFields(t.leads[1]).Owns, 'No role written yet.')
  assert.equal(teamTree({}).leads.length, 0)
})

test('a lead that is not a Bot is kept and reads "Legacy lead"; a Bot reads "Bot"', () => {
  const s = structuredClone(treeFixture)
  s.leads[0].kind = 'bot'
  s.leads[1].kind = 'legacy'
  const t = teamTree(s)
  assert.deepEqual(t.leads.map((l) => [l.name, l.kind, l.legacy]), [
    ['api-lead', 'Bot', false], ['ui-lead', LEGACY_LABEL, true], ['infra-lead', LEGACY_LABEL, true],
  ])
  assert.equal(LEGACY_LABEL, 'Legacy lead')
  assert.equal(leadKindLabel('bot'), 'Bot')
  assert.equal(leadKindLabel(undefined), 'Legacy lead')
})

const botWorkers = [
  { name: 'schema-worker', role: 'API schema', workers: [{ name: 'lint-helper', status: 'running' }] },
  { name: 'docs-worker' },
]

test('teamTree: the lead source is a swappable adapter carrying project and worker subtree', () => {
  const bots = () => [{ key: 'L-a1c3e501', hue: 0, name: 'Bot Ada', role: 'Plans releases', project: 'Payments API', kind: 'Bot', slotKey: null, workers: botWorkers }]
  const t = teamTree(treeFixture, bots)
  assert.deepEqual(t.leads.map((l) => [l.name, l.kind, l.project, l.groups[0]]), [['Bot Ada', 'Bot', 'Payments API', 'release-train']])
  assert.equal(countWorkers(t.leads[0].workers), 3)
  const s = structuredClone(treeFixture)
  s.leads[0].project = 'Web app'
  s.leads[0].workers = [...botWorkers, { role: 'no name' }]
  const n = appLeadSource(s)[0]
  assert.equal(n.project, 'Web app')
  assert.deepEqual(n.workers.map((w) => w.name), ['schema-worker', 'docs-worker'])
  assert.equal(n.workers[0].workers[0].name, 'lint-helper')
  assert.deepEqual(appLeadSource(s)[1].workers, null)
})

test('rosterLeadSource reads botRows: Bot leads get name, project, role, worker tree; legacy leads stay as they are', () => {
  const s = structuredClone(treeFixture)
  Object.assign(s.leads[0], { kind: 'bot', bot: 'ada', session_label: 'dashboard:member-ada' })
  Object.assign(s.leads[1], { kind: 'bot', bot: 'uma', session_label: 'dashboard:member-uma' })
  // s.leads[2] stays the old lead chat (legacy)
  const members = { members: [
    { name: 'ada', display_name: 'Ada', slot_key: 'member-ada', workspace: 'payments-api', description: 'Owns payments' },
    { name: 'uma', display_name: 'Uma', slot_key: 'member-uma', workspace: '' },
    { name: 'default', slot_key: 'member-default' },
  ] }
  const workspaces = { workspaces: [{ name: 'payments-api', path: '/w/p' }, { name: 'checkout-web', path: '/w/c' }], default: 'checkout-web' }
  const workersBySlot = { 'member-ada': { workers: [
    { key: 'chat-31', title: 'schema pass', status: 'working', dispatched_by: 'member-ada' },
    { key: 'chat-32', title: 'lint helper', status: 'done', dispatched_by: 'chat-31' },
  ] } } // uma's crew-workers call did not answer
  const t = teamTree(s, rosterLeadSource(botRows(members, workspaces, workersBySlot)))
  assert.deepEqual(t.leads.map((l) => [l.name, l.project, l.kind, l.legacy]), [
    ['Ada', 'payments-api', 'Bot', false], ['Uma', 'checkout-web', 'Bot', false], ['infra-lead', '', 'Legacy lead', true],
  ])
  assert.equal(t.leads[0].role, 'Owns payments')
  assert.equal(countWorkers(t.leads[0].workers), 2)
  assert.equal(t.leads[0].workers[0].workers[0].name, 'lint helper')
  // pod kc-r4-tree: a worker that reported done is idle + group done; botRows must carry the group.
  const done = { 'member-ada': { workers: [{ key: 'chat-41', title: 'Cache check', status: 'idle', group: 'done', dispatched_by: 'member-ada' }] } }
  assert.equal(teamTree(s, rosterLeadSource(botRows(members, workspaces, done))).leads[0].workers[0].status, 'Done')
  assert.equal(t.leads[1].workers, null) // no data: no toggle
  assert.equal(visibleTree(t.leads, new Set()).filter((l) => l.canToggle).length, 1)
  assert.deepEqual(t.leads.map((l) => l.groups[0]), ['release-train', 'release-train', 'release-train'])
  assert.ok(!hasInternalId(shownText(t)))
  // No Bot rows (load failed or not yet back): every lead keeps its own fields.
  assert.equal(teamTree(s, rosterLeadSource([])).leads[0].name, 'api-lead')
})

test('role card: project and workers draw their empty states', () => {
  const lead = teamTree(treeFixture).leads[0]
  assert.equal(roleCardFields(lead).Project, 'No project on record.')
  assert.deepEqual(roleCardFields(lead).Workers, ['Team Mode cannot see this lead’s workers yet.'])
  assert.deepEqual(roleCardFields({ ...lead, workers: [] }).Workers, ['No workers.'])
  assert.deepEqual(roleCardFields({ ...lead, project: 'Payments API', workers: botWorkers }).Workers,
    ['schema-worker — API schema', '· lint-helper', 'docs-worker'])
})

test('layoutTree: each lead’s worker tree sits to its right, parents centred, nothing overlaps', () => {
  const g = layoutTree([{ workers: botWorkers }, { workers: null }, { workers: [] }])
  assert.equal(g.workers.length, 3)
  assert.equal(g.edges.length, 6)
  assert.deepEqual(g.edges.map((e) => e.lead), [0, 0, 0, 0, 1, 2])
  const [schema, lint, docs] = g.workers
  assert.ok(schema.x >= g.leads[0].x + g.leads[0].w && lint.x >= schema.x + schema.w)
  const mid = (b) => b.y + b.h / 2
  assert.equal(mid(g.leads[0]), (mid(schema) + mid(docs)) / 2)
  const all = [g.owner, ...g.leads, ...g.workers]
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]; const b = all[j]
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `boxes ${i} and ${j} overlap`)
    }
  }
  assert.equal(g.width, lint.x + TREE.workerW + TREE.pad)
})

test('role card fields: every section is present and falls back to an empty-state line', () => {
  const f = roleCardFields(teamTree(treeFixture).leads[0])
  assert.deepEqual(Object.keys(f), ['Name', 'Project', 'Owns', 'Workers', 'Status', 'Waiting on a person', 'Assignments', 'Routines', 'Groups'])
  assert.match(f['Waiting on a person'][0], /^Owner: /)
  assert.match(f.Routines[0], /^Secretary brief · 1 so far · last \d\d:\d\d$/)
  const bare = structuredClone(treeFixture)
  bare.cases = []; bare.briefs = []; bare.channels = []
  const g = roleCardFields(teamTree(bare).leads[0])
  assert.deepEqual(g['Waiting on a person'], ['Nothing is waiting on a person.'])
  assert.deepEqual(g.Groups, ['Not in a group yet.'])
  assert.equal(g.Routines[0], 'Secretary brief · none yet')
})

test('tree and role card show no internal id or session key', () => {
  assert.ok(hasInternalId('L-a1c3e501') && hasInternalId('A-02') && hasInternalId('dashboard:chat-101') && hasInternalId('member-ada'))
  assert.ok(!hasInternalId('api-lead · release-train · Waiting on you'))
  const s = structuredClone(treeFixture)
  s.cases[1].called_person.question = 'Should L-b2d4f602 pause the lane?'
  const text = shownText(teamTree(s))
  assert.ok(!hasInternalId(text), text)
  assert.match(text, /Should ui-lead pause the lane\?/)
})

test('layoutTree: owner centred on the lead column, one edge per lead', () => {
  const g = layoutTree(3)
  assert.equal(g.edges.length, 3)
  const col = g.leads.at(-1).y + g.leads.at(-1).h - g.leads[0].y
  assert.equal(g.owner.y + g.owner.h / 2, g.leads[0].y + col / 2)
  for (let i = 1; i < 3; i++) assert.ok(g.leads[i].y >= g.leads[i - 1].y + g.leads[i - 1].h)
  assert.equal(g.width, g.leads[0].x + TREE.leadW + TREE.pad)
  assert.ok(layoutTree(0).height >= TREE.ownerH)
})

test('fitZoom shows the whole tree, never above 100%, inside the zoom range', () => {
  const g = layoutTree(6)
  const z = fitZoom({ width: 700, height: 460 }, g)
  assert.ok(g.height * z <= 460 && g.width * z <= 700)
  assert.ok(z >= ZOOM_MIN && z <= 1)
  assert.equal(fitZoom({ width: 5000, height: 5000 }, layoutTree(2)), 1)
  assert.equal(clampZoom(9), ZOOM_MAX)
  assert.equal(clampZoom(0.01), ZOOM_MIN)
})

test('crewWorkersToTree links crew-workers rows by dispatched_by under the Bot slot, any depth, no keys kept', () => {
  const rows = [
    { key: 'chat-21', title: 'schema pass', status: 'working', dispatched_by: 'member-ada' },
    { key: 'chat-22', title: 'lint helper', status: 'done', dispatched_by: 'chat-21' },
    { key: 'chat-23', title: 'docs', status: 'waiting' },
    { key: 'chat-24', title: 'loop', dispatched_by: 'chat-24' }, // self-parent: never drawn
  ]
  const t = crewWorkersToTree(rows, 'member-ada')
  assert.deepEqual(t.map((w) => [w.name, w.status]), [['schema pass', 'Working'], ['docs', 'Waiting']])
  assert.deepEqual(t[0].workers.map((w) => w.name), ['lint helper'])
  assert.ok(!hasInternalId(JSON.stringify(t)))
})

test('a worker that reported done reads Done on the tree, not the idle turn state', () => {
  // Host crew-workers rows: `status` says whether a turn runs, `group` what the worker is doing.
  const rows = [
    { key: 'chat-31', title: 'Refund API', status: 'idle', group: 'done', dispatched_by: 'member-ada' },
    { key: 'chat-32', title: 'Ledger export', status: 'working', group: 'working', dispatched_by: 'member-ada' },
    { key: 'chat-33', title: 'Refund page', status: 'idle', group: 'with_conductor', dispatched_by: 'member-ada' },
    { key: 'chat-34', title: 'Old tab', status: 'closed', dispatched_by: 'member-ada' },
  ]
  assert.deepEqual(crewWorkersToTree(rows, 'member-ada').map((w) => w.status), ['Done', 'Working', 'Asking its Bot', 'Done'])
})

test('botLeadSource fills name, role, project and workers from /api/members rows on the Bot slot', () => {
  const s = structuredClone(treeFixture)
  s.leads[0].session_label = 'dashboard:member-ada'
  const members = [{ name: 'ada', display_name: 'Ada', slot_key: 'member-ada', workspace: 'payments-api', description: 'Owns the payments API' }]
  const workers = { 'member-ada': [{ key: 'chat-21', title: 'schema pass', status: 'working', dispatched_by: 'member-ada' }] }
  const ada = teamTree(s, botLeadSource(members, workers)).leads[0]
  assert.deepEqual([ada.name, ada.role, ada.project, ada.kind], ['Ada', 'Owns the payments API', 'payments-api', 'Bot'])
  assert.deepEqual(ada.workers.map((w) => w.name), ['schema pass'])
  assert.equal(teamTree(s, botLeadSource(members)).leads[0].workers, null)
  assert.equal(BOTS_PAGE, '/members')
})

const chartLeads = [
  { key: 'a', name: 'api', workers: botWorkers }, // 3 workers, two levels
  { key: 'b', name: 'web', workers: [] }, // source sees it: none
  { key: 'c', name: 'infra', workers: null }, // source cannot see them
]

test('collapsed by default: only Owner -> leads are drawn, a collapsed lead shows its worker count', () => {
  const v = visibleTree(chartLeads, new Set())
  assert.deepEqual(v.map((l) => [l.key, l.open, l.hiddenCount, l.canToggle, l.workers]), [
    ['a', false, 3, true, null], ['b', false, 0, false, null], ['c', false, 0, false, null],
  ])
  assert.equal(layoutTree(v).workers.length, 0)
  assert.equal(hiddenWorkerCount(chartLeads[0]), 3)
})

test('expanding a lead draws its whole org chart; leads without worker data get no toggle', () => {
  const v = visibleTree(chartLeads, new Set(['a', 'b', 'c']))
  assert.deepEqual(v.map((l) => [l.key, l.open, l.hiddenCount]), [['a', true, 0], ['b', false, 0], ['c', false, 0]])
  assert.equal(layoutTree(v).workers.length, 3)
  assert.equal(hiddenWorkerCount(chartLeads[1]), null)
  assert.equal(hiddenWorkerCount(chartLeads[2]), null)
  assert.deepEqual([...expandAllKeys(chartLeads)], ['a'])
})

test('Fit all fits only what is drawn: a collapsed tree is narrower than the expanded one', () => {
  const closed = layoutTree(visibleTree(chartLeads, new Set()))
  const open = layoutTree(visibleTree(chartLeads, new Set(['a'])))
  assert.ok(closed.width < open.width)
  assert.equal(closed.width, closed.leads[0].x + TREE.leadW + TREE.pad)
  assert.ok(fitZoom({ width: 900, height: 460 }, closed) >= fitZoom({ width: 900, height: 460 }, open))
})

test('open org charts are remembered in browser storage; bad or missing storage means all collapsed', () => {
  const mem = new Map()
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) }
  assert.deepEqual([...loadExpanded(storage)], [])
  saveExpanded(storage, new Set(['a', 'c']))
  assert.equal(mem.get(EXPANDED_STORE_KEY), '["a","c"]')
  assert.deepEqual([...loadExpanded(storage)], ['a', 'c'])
  mem.set(EXPANDED_STORE_KEY, '{not json')
  assert.deepEqual([...loadExpanded(storage)], [])
  mem.set(EXPANDED_STORE_KEY, '[1,"a",null]')
  assert.deepEqual([...loadExpanded(storage)], ['a'])
  const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') } }
  assert.deepEqual([...loadExpanded(throwing)], [])
  assert.doesNotThrow(() => saveExpanded(throwing, new Set(['a'])))
})

// pod kc-r4-tree: Ira removed then added back read "4 leads" in the header and "4 leads + Owner" on the group.
test('a removed lead is not counted in the header or in a group', async () => {
  const { activeLeadCount, leadIndex } = await import('./model.js')
  const leads = leadIndex({ leads: [
    { lead_id: 'L-a', active: true }, { lead_id: 'L-u', active: true },
    { lead_id: 'L-i1', active: false }, { lead_id: 'L-i2', active: true },
  ] })
  assert.equal(activeLeadCount(leads), 3)
  assert.equal(activeLeadCount(leads, ['L-a', 'L-u', 'L-i1', 'L-i2']), 3)
  assert.equal(activeLeadCount(leads, ['L-a', 'L-gone']), 1)
})
