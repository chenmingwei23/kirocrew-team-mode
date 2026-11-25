// node --test src/msgBack.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { foldChannel, leadIndex } from './model.js'
import { clickFlips, flipOnKey, fmtStamp, messageBack, wokenBy } from './msgBack.js'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/state-13-quota.json', import.meta.url)))
const CID = 'G-5e1a9c20'
const leads = leadIndex(fixture)
const folded = foldChannel(fixture.entries[CID])
const back = (seq, extra = {}) => messageBack(folded.bySeq.get(seq), { leads, channelId: CID, briefs: fixture.briefs, ...extra })
const get = (rows, label) => rows.filter((r) => r.label === label).map((r) => r.value)
const ID_RE = /\b(L|M|A|C|G|D|T|B|MT)-[0-9a-f]{2,}\b/

test('back of an @ message: to whom, must answer, current step, hop, source, ledger time', () => {
  const m = folded.bySeq.get(13)
  const rows = back(13)
  const to = leads.get(m.assignments[0].to).handle.replace(/^tm-demo-/, '')
  assert.deepEqual(get(rows, 'Assigned to'), [`${to} · must answer`])
  assert.deepEqual(get(rows, 'Current step'), ['Taken · result due'])
  assert.equal(get(rows, 'Source')[0], 'Legacy lead') // fixture leads are kind "chat"
  assert.equal(get(rows, 'Recorded')[0], fmtStamp(m.ts))
  assert.match(get(rows, 'Recorded')[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
  assert.equal(get(rows, 'Hop').length, 1)
  assert.equal(get(rows, 'Hop')[0].split(' ')[0], String(m.chain?.hops || 0))
})

test('an unanswered @ shows its step; a Bot lead reads "Bot lead"; nobody sees an id', () => {
  const botLeads = new Map([...leads].map(([k, v]) => [k, { ...v, kind: 'bot' }]))
  const rows = messageBack(folded.bySeq.get(18), { leads: botLeads, channelId: CID, briefs: fixture.briefs })
  assert.deepEqual(get(rows, 'Current step'), ['No answer · bar raiser called'])
  assert.equal(get(rows, 'Source')[0], 'Bot lead')
  for (const seq of folded.bySeq.keys()) {
    for (const r of back(seq)) assert.doesNotMatch(`${r.label} ${r.value}`, ID_RE, `seq ${seq}: ${r.value}`)
  }
})

test('who was woken comes from the briefs that carried this message', () => {
  assert.deepEqual(wokenBy(fixture.briefs, CID, 12), ['L-a1c3e501', 'L-b2d4f602'])
  assert.deepEqual(get(back(12), 'Woke now'), ['api-lead, ui-lead']) // @everyone wakes each at once
  // a plain thread reply wakes nobody by itself: it rode along in api-lead's wake
  assert.deepEqual(get(back(8), 'Woke now'), [])
  assert.deepEqual(get(back(8), 'Read later'), ['api-lead'])
  // the same seq in another channel is a different message
  assert.deepEqual(wokenBy(fixture.briefs, 'D-7b3f0e11', 12), [])
  assert.deepEqual(wokenBy(fixture.briefs, 'D-7b3f0e11', 2), ['L-b2d4f602'])
  // a message no brief carried has no wake rows at all
  assert.deepEqual(get(back(2, { briefs: [] }), 'Woke now'), [])
  assert.deepEqual(get(back(2, { briefs: [] }), 'Read later'), [])
})

test("owner '@Ada': Woke now Ada, Read later the others (round4 S34)", () => {
  const [a, b, c] = [...leads.keys()]
  const nm = (id) => leads.get(id).handle.replace(/^tm-demo-/, '')
  const m = { seq: 83, ts: 1, by: 'owner', text: '@Ada status?', mentions: [a], cc: [], assignments: [{ to: a, state: 'open' }] }
  const brief = (lead, reasons) => ({ lead_id: lead, reasons, brief: { groups: [{ channel_id: CID, items: [{ seqs: [83] }] }] } })
  const briefs = [brief(a, ['owner', 'assign:A-1']), brief(b, ['batch']), brief(c, ['batch'])]
  const rows = messageBack(m, { leads, channelId: CID, briefs })
  assert.deepEqual(get(rows, 'Woke now'), [nm(a)])
  assert.deepEqual(get(rows, 'Read later'), [`${nm(b)}, ${nm(c)}`])
  assert.deepEqual(get(rows, 'Woke'), [])
  // a lead woken at once by something else, whose brief also carried this post, read it later
  const other = messageBack(m, { leads, channelId: CID, briefs: [brief(a, ['owner', 'assign:A-1']), brief(b, ['dm'])] })
  assert.deepEqual(get(other, 'Read later'), [nm(b)])
})

test('owner post, no-@ post, notice and hold each say so on the back', () => {
  const owner = messageBack({ seq: 1, ts: 1794044400, by: 'owner', text: 'hi', assignments: [] }, { leads })
  assert.deepEqual(get(owner, 'Source'), ['Owner'])
  assert.deepEqual(get(owner, 'Hop'), ['0 · your post resets the count'])
  const plain = messageBack({ seq: 2, ts: 1, by: 'L-a1c3e501', text: 'x', assignments: [], mentions: [] }, { leads })
  assert.deepEqual(get(plain, 'Addressed'), ['No @ · each lead decides whether to answer'])
  const notice = messageBack({ seq: 3, ts: 1, by: 'L-a1c3e501', kind: 'notice', assignments: [] }, { leads })
  assert.deepEqual(get(notice, 'Kind'), ['Notice · goes to briefs · wakes nobody · not a hop'])
  assert.deepEqual(get(notice, 'Addressed'), [])
  const held = messageBack({ seq: 4, ts: 1, by: 'L-a1c3e501', thread_id: 'T-2', held: true, chain: { hops: 5 }, assignments: [] }, { leads })
  assert.deepEqual(get(held, 'Held'), ['Hop 5 is over 4 · waiting for bar raiser'])
  const answer = messageBack({ seq: 5, ts: 1, by: 'L-a1c3e501', answers: { response: 'ask' }, assignments: [] }, { leads })
  assert.deepEqual(get(answer, 'Answer'), ['Asked a question'])
})

test('a lead DM to the owner: no "No @" line; it waits on you until you answer', () => {
  const D = 'D-1'
  const lead = 'L-a1c3e501'
  // pod run shape: lead asks (2), owner answers (3), lead asks again (4, still open)
  const decisions = [
    { key: 'dm:D-1:4', via: 'dm', channel_id: D, ask_seq: 4, state: 'open', answer: null },
    { key: 'dm:D-1:2', via: 'dm', channel_id: D, ask_seq: 2, state: 'answered', answer: { text: 'Yes', ts: 30 } },
  ]
  const at = (seq, ts, by = lead) => messageBack({ seq, ts, by, text: 'x', assignments: [], mentions: [] }, { leads, channelId: D, dm: true, decisions })
  assert.deepEqual(get(at(2, 20), 'Addressed'), [])
  assert.deepEqual(get(at(2, 20), 'Asked'), ['Owner · shows in Needs you'])
  assert.deepEqual(get(at(2, 20), 'Current step'), ['You answered'])
  assert.deepEqual(get(at(4, 40), 'Current step'), ['Waiting on you'])
  assert.deepEqual(get(at(3, 30, 'owner'), 'Asked'), [])
  // a later lead post in the same unanswered run shares the open wait
  assert.deepEqual(get(at(5, 50), 'Current step'), ['Waiting on you'])
  // a lead post after the owner's answer, with no new wait, shows none
  assert.deepEqual(get(messageBack({ seq: 3, ts: 35, by: lead, assignments: [] }, { leads, channelId: D, dm: true, decisions: decisions.slice(1) }), 'Asked'), [])
  // another DM's waits do not leak in
  assert.deepEqual(get(messageBack({ seq: 4, ts: 40, by: lead, assignments: [] }, { leads, channelId: 'D-2', dm: true, decisions }), 'Asked'), [])
})

test('flip toggle: Enter and Space flip; other keys do not; clicks on controls or selections do not', () => {
  assert.equal(flipOnKey('Enter'), true)
  assert.equal(flipOnKey(' '), true)
  assert.equal(flipOnKey('Tab'), false)
  assert.equal(flipOnKey('a'), false)
  const plain = { closest: () => null }
  const inButton = { closest: (sel) => (sel.includes('button') ? {} : null) }
  assert.equal(clickFlips(plain), true)
  assert.equal(clickFlips(inButton), false)
  assert.equal(clickFlips(plain, 'selected words'), false)
})

test('an @everyone card back names who was redirected by the 2-answers cap (round4 A-F2)', () => {
  const [a, b, c] = [...leads.keys()]
  const rows = [
    { seq: 1, ts: 1, type: 'message/posted', by: 'owner', data: { msg_id: 'M-1', text: 'Status?', everyone: true, mentions: [] } },
    { seq: 2, ts: 2, type: 'message/posted', by: `lead:${a}`, data: { msg_id: 'M-2', text: 'fine', reply_to: 1, mentions: [] } },
    { seq: 3, ts: 3, type: 'message/posted', by: `lead:${b}`, data: { msg_id: 'M-3', text: 'ok', reply_to: 1, mentions: [] } },
    { seq: 4, ts: 4, type: 'reply/redirected', by: 'app', data: { reply_to: 1, who: c, reason: 'unsolicited_reply_cap', answers_in_main: 2 } },
    { seq: 5, ts: 5, type: 'reply/redirected', by: 'app', data: { reply_to: 1, who: c, reason: 'unsolicited_reply_cap', answers_in_main: 2 } },
  ]
  const f = foldChannel(rows)
  const out = messageBack(f.bySeq.get(1), { leads, channelId: CID })
  const who = leads.get(c).handle.replace(/^tm-demo-/, '')
  assert.deepEqual(get(out, 'Redirected'), [`${who} · 2 answers in main already`])
  assert.deepEqual(get(messageBack(f.bySeq.get(2), { leads, channelId: CID }), 'Redirected'), [])
})
