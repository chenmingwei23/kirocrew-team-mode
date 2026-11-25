// node --test src/needsYou.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerLastSpoke, sinceYouSpoke, waitingOnYou } from './needsYou.js'

const IDS = /\b[LACTGDM]-[0-9a-z]+\b|dashboard:|chat-\d/
const dec = (key, impact, opened_ts, state = 'open') => ({ key, kind: impact === 'ask' ? 'ask' : 'case', impact, opened_ts, state })

test('waitingOnYou: only open ones, highest impact first, then waiting longest', () => {
  const s = { decisions: [
    dec('ask:G-1:A-1', 'ask', 1), dec('case:C-1', 'security', 5), dec('case:C-2', 'spend', 9),
    dec('case:C-3', 'spend', 4), dec('case:C-4', 'irreversible', 8, 'skipped'), dec('case:C-5', 'exhausted', 2, 'answered'),
    dec('ask:G-1:A-2', 'ask', 3, 'withdrawn'),
  ] }
  assert.deepEqual(waitingOnYou(s).map((d) => d.key), ['case:C-3', 'case:C-2', 'case:C-1', 'ask:G-1:A-1'])
  assert.deepEqual(waitingOnYou({}), [])
})

test('waitingOnYou: once the owner has replied, it is no longer waiting', () => {
  const s = { decisions: [dec('ask:G-1:A-1', 'ask', 1), dec('case:C-1', 'spend', 2)] }
  assert.equal(waitingOnYou(s).length, 2)
  s.decisions[0].state = 'answered' // the owner answered the lead's ask
  assert.deepEqual(waitingOnYou(s).map((d) => d.key), ['case:C-1'])
  s.decisions[1].state = 'answered' // the owner answered the bar raiser
  assert.equal(waitingOnYou(s).length, 0)
})

test('waitingOnYou: any kind counts while open (meeting_item); a deferred one is skipped and leaves', () => {
  const s = { decisions: [{ key: 'meeting_item:MT-1:I2', kind: 'meeting_item', impact: 'requested', opened_ts: 1, state: 'open' }] }
  assert.equal(waitingOnYou(s).length, 1)
  s.decisions[0].state = 'skipped'
  assert.equal(waitingOnYou(s).length, 0)
})

test('waitingOnYou: skip counts as an answer, so the count drops by one', () => {
  const s = { decisions: [dec('case:C-1', 'spend', 1), dec('case:C-2', 'security', 2)] }
  assert.equal(waitingOnYou(s).length, 2)
  s.decisions[0].state = 'skipped'
  assert.equal(waitingOnYou(s).length, 1)
})

let seq = 0
const row = (type, by, ts, data) => ({ seq: ++seq, ts, type, by, data })
const post = (by, ts, extra = {}) => row('message/posted', by, ts, { msg_id: `M-${seq}`, thread_id: null, ...extra })
const names = new Map([['L-a', 'tm-demo-api-lead'], ['L-b', 'tm-demo-ui-lead']])
const group = { id: 'G-1', kind: 'group', title: 'release-train', members: ['L-a', 'L-b'] }

test('sinceYouSpoke: counts only what came after the owner\'s last real post', () => {
  const s = {
    channels: [group],
    entries: { 'G-1': [
      post('lead:L-a', 10),
      post('owner', 20, { mentions: ['L-b'] }),
      row('assignment/opened', 'app', 20, { assignment_id: 'A-1', from: 'owner', to: 'L-b' }),
      post('owner', 21, { kind: 'system' }), // not the owner speaking
      post('lead:L-a', 30), post('lead:L-a', 31), post('lead:L-b', 32),
      row('assignment/asked', 'lead:L-b', 32, { assignment_id: 'A-1' }),
      row('message/held', 'app', 33, { msg_id: 'M-x', reason: 'hop_limit' }),
      post('bar_raiser:C-1', 34, { kind: 'system' }),
    ] },
    cases: [{ case_id: 'C-0', ts: 5 }, { case_id: 'C-1', ts: 33 }],
  }
  assert.equal(ownerLastSpoke(s), 20)
  const r = sinceYouSpoke(s, names)
  assert.equal(r.since, 20)
  assert.deepEqual(r.lines.map((l) => `${l.place}: ${l.text}`), [
    '#release-train: api-lead posted 2, ui-lead posted 1 · ui-lead asked about an @ · 1 message held · 1 bar raiser note',
    'Bar raiser: opened 1 case',
  ])
  for (const l of r.lines) assert.doesNotMatch(`${l.place} ${l.text}`, IDS)
})

test('sinceYouSpoke: owner never spoke -> everything, since is null', () => {
  const s = { channels: [group], entries: { 'G-1': [post('lead:L-a', 1)] }, cases: [] }
  const r = sinceYouSpoke(s, names)
  assert.equal(r.since, null)
  assert.deepEqual(r.lines.map((l) => l.text), ['api-lead posted 1'])
})
