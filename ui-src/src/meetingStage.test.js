// node --test src/meetingStage.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { itemNeedsYou, itemStages, meetingNeedsYou } from './meetingStage.js'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/state-meeting.json', import.meta.url)))
const share = fixture.meetings.find((m) => m.state === 'open')
const states = (r) => r.steps.map((s) => s.state).join(' ')
const clone = (x) => JSON.parse(JSON.stringify(x))

function item(over = {}) {
  return { item_id: 'I9', state: 'open', mode: 'discuss', round: 0, rounds: {}, speeches: [], ballots: {},
    proposals: {}, outcome: null, waiting: null, br_needed: [], ballot_open: null, ...over }
}
const meeting = (over = {}) => ({ state: 'open', actions: [], agenda: [], ...over })

test('a pending item has no current step', () => {
  const r = itemStages(item({ state: 'pending' }), meeting())
  assert.equal(states(r), 'todo todo todo todo todo')
  assert.equal(r.current, null)
})

test('opened, nobody spoke: Proposed is current', () => {
  assert.equal(states(itemStages(item({ round: 1, rounds: { 1: { sealed: false } } }), meeting())), 'current todo todo todo todo')
})

test('presenter spoke, round 1 still sealed: Evidence is current and says Sealed', () => {
  const it = item({ round: 1, rounds: { 1: { sealed: true, revealed: false, ended: null } }, speeches: [{ round: 1 }] })
  const r = itemStages(it, meeting())
  assert.equal(states(r), 'done current todo todo todo')
  assert.equal(r.steps[1].note, 'Sealed')
})

test('round 1 revealed: Discussion is current; an open decision on the item needs you on that step', () => {
  const it = item({ round: 2, rounds: { 1: { sealed: true, revealed: true, ended: {} } }, speeches: [{ round: 1 }],
    waiting: { case_id: 'C-1', question: 'Spend $40?' } })
  const r = itemStages(it, meeting({ meeting_id: 'MT-1' }), undefined,
    [{ state: 'open', kind: 'case', meeting_id: 'MT-1', item_id: 'I9' }])
  assert.equal(states(r), 'done done current todo todo')
  assert.equal(r.needsYou, true)
  assert.equal(r.steps[2].note, 'Needs you')
})

test('vote_first: an open ballot is Evidence, a closed one moves on', () => {
  const open = item({ mode: 'vote_first', ballots: { B1: { state: 'open' } }, ballot_open: 'B1' })
  assert.equal(states(itemStages(open, meeting())), 'done current todo todo todo')
  assert.equal(itemStages(open, meeting()).steps[1].note, 'Voting')
})

test('decided with one action still proposed: Actions is current and waits on that attendee, not on you', () => {
  const it = item({ state: 'closed', outcome: { kind: 'consensus' } })
  const m = meeting({ actions: [{ item_id: 'I9', owner: 'L-a', state: 'accepted' }, { item_id: 'I9', owner: 'L-b', state: 'proposed' }] })
  const r = itemStages(it, m, (w) => ({ 'L-b': 'Juniper' }[w] || w))
  assert.equal(states(r), 'done done done done current')
  assert.equal(r.steps[4].note, 'Waiting on Juniper')
  assert.equal(r.needsYou, false)
})

test('decided, every action answered: the bar is complete', () => {
  const it = item({ state: 'closed', outcome: { kind: 'vote' } })
  const r = itemStages(it, meeting({ actions: [{ item_id: 'I9', owner: 'L-a', state: 'declined' }] }))
  assert.equal(states(r), 'done done done done done')
  assert.equal(r.current, null)
})

test('decided with no action items: Actions is skipped; meeting-level actions do not count', () => {
  const it = item({ state: 'closed', outcome: { kind: 'deferred' } })
  assert.equal(states(itemStages(it, meeting({ actions: [{ item_id: null, owner: 'L-a', state: 'proposed' }] }))), 'done done done done skipped')
})

test('meeting closed with actions nobody answered: Actions is skipped', () => {
  const it = item({ state: 'closed', outcome: { kind: 'vote' } })
  assert.equal(states(itemStages(it, meeting({ state: 'closed', actions: [{ item_id: 'I9', owner: 'L-a', state: 'proposed' }] }))), 'done done done done skipped')
})

test('fixture: the live Share API meeting reads closed, closed, then sealed round 1 on item 3', () => {
  const [i1, i2, i3] = share.agenda
  assert.equal(states(itemStages(i1, share)), 'done done done done skipped')
  assert.equal(states(itemStages(i2, share)), 'done done done done skipped')
  assert.equal(states(itemStages(i3, share)), 'done current todo todo todo')
})

test('needs you comes only from an open decision that points at this meeting item', () => {
  const m = clone(share)
  const d = { state: 'open', kind: 'meeting_item', meeting_id: m.meeting_id, item_id: 'I3' }
  assert.deepEqual(meetingNeedsYou(m, [d]).map((a) => a.item_id), ['I3'])
  // item.waiting alone is not enough: the decision is the one source
  m.agenda[2].waiting = { case_id: null, question: 'A speaker asked for a person.' }
  assert.deepEqual(meetingNeedsYou(m, []), [])
  assert.equal(itemNeedsYou(m.agenda[2], m, [{ ...d, state: 'answered' }]), false)
  assert.equal(itemNeedsYou(m.agenda[2], m, [{ ...d, state: 'withdrawn' }]), false)
  assert.equal(itemNeedsYou(m.agenda[2], m, [{ ...d, item_id: 'I2' }]), false)
  assert.equal(itemNeedsYou(m.agenda[2], m, [{ ...d, meeting_id: 'MT-other' }]), false)
})
