// The back of a message card. The front of a message shows only avatar, name, time
// and body; everything the old status line and header tags said is here, shown when
// the owner flips the card. Pure functions, no React.
//
// Reads only what the page already has (the folded channel message, the lead index,
// state.briefs). It changes no status data: Leads now, Needs you and the ledger still
// read their own sources.

import { OWNER, fmtClock, shortHandle } from './model.js'
import { leadKind } from './botSource.js'

const ASSIGN_STATE = {
  open: 'Waiting for an answer',
  taken: 'Taken · result due',
  declined: 'Declined',
  asked: 'Asked back',
  closed: 'Result sent',
  unanswered: 'No answer · bar raiser called',
}

/** Where an @ stands: it is answered twice, take / decline / ask, then result / no_result. */
export function assignStep(a) {
  if (a.state === 'closed' && a.empty) return 'Closed · no result'
  if (a.state === 'unanswered' && a.reason === 'no_result') return 'No result · bar raiser called'
  return ASSIGN_STATE[a.state] || ASSIGN_STATE.open
}

const ANSWER = {
  take: 'Took the assignment',
  ask: 'Asked a question',
  result: 'Sent the result',
  no_result: 'No result · still a reply',
}

/** Lead ids woken with this message in their brief (every wake writes one, see teamapp/wake.py). */
export function wokenBy(briefs, channelId, seq) {
  const out = []
  for (const b of briefs || []) {
    if (out.includes(b.lead_id)) continue
    const hit = (b.brief?.groups || []).some((g) => g.channel_id === channelId && (g.items || []).some((it) => (it.seqs || []).includes(seq)))
    if (hit) out.push(b.lead_id)
  }
  return out
}

/**
 * Did this post itself wake `lead` at once? Mirrors teamapp/wake.py _immediate: an @ or
 * assignment to them, a cc, @everyone, a DM, or an owner post that names nobody.
 */
function addresses(m, lead, dm) {
  const named = [...(m.mentions || []), ...(m.cc || [])]
  if ((m.assignments || []).some((a) => a.to === lead) || named.includes(lead)) return true
  if (m.everyone || dm) return true
  return m.by === OWNER && named.length === 0
}

/**
 * Who this post woke now, and who only read it later in a batch wake (round4: '@Ada' read
 * "Woke Ada, Uma, Ira" once the batch had run, which looked like it woke all three).
 * A lead counts as woken now when the post addresses them and the brief that carried it
 * came from an at-once wake (any reason other than "batch").
 */
export function wokeSplit(briefs, channelId, m, dm = false) {
  const now = []
  const later = []
  for (const b of briefs || []) {
    const hit = (b.brief?.groups || []).some((g) => g.channel_id === channelId && (g.items || []).some((it) => (it.seqs || []).includes(m.seq)))
    if (!hit || now.includes(b.lead_id)) continue
    const atOnce = (b.reasons || []).some((r) => r !== 'batch')
    if (atOnce && addresses(m, b.lead_id, dm)) {
      now.push(b.lead_id)
      const i = later.indexOf(b.lead_id)
      if (i >= 0) later.splice(i, 1)
    } else if (!later.includes(b.lead_id)) later.push(b.lead_id)
  }
  return { now, later }
}

const DM_STEP = { open: 'Waiting on you', answered: 'You answered', skipped: 'You said no', withdrawn: 'Withdrawn' }

/**
 * The DM wait (teamapp/decisions.py:dm_asks) this lead post belongs to, or null. A wait
 * starts at its ask_seq and covers the lead's posts until the owner answers.
 */
export function dmAsk(decisions, channelId, m) {
  let best = null
  for (const d of decisions || []) {
    if (d.via !== 'dm' || d.channel_id !== channelId || d.ask_seq > m.seq) continue
    if (!best || d.ask_seq > best.ask_seq) best = d
  }
  if (!best) return null
  return best.state === 'open' || best.ask_seq === m.seq || (best.answer?.ts ?? 0) >= m.ts ? best : null
}

/** `2026-11-08 14:09:33` in local time: the time of the message's own ledger row. */
export function fmtStamp(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtClock(ts)}:${p(d.getSeconds())}`
}

function name(id, leads) {
  if (id === OWNER) return 'Owner'
  return shortHandle(leads.get(id)?.handle) || 'a lead'
}

/**
 * Rows `{ label, value }` for the back of one message, in reading order. Every value
 * is words or numbers; no lead, message, assignment or channel id is ever shown.
 *
 * `ctx`: `{ leads }` (model.js leadIndex), `channelId`, `briefs` (state.briefs),
 * `replyTo` (the folded message this one replies to, or null), `everyoneCount`,
 * `dm` (the channel is a direct message), `decisions` (state.decisions).
 */
export function messageBack(m, { leads = new Map(), channelId = null, briefs = [], replyTo = null, everyoneCount = '', dm = false, decisions = [] } = {}) {
  const rows = []
  const owner = m.by === OWNER
  const lead = leads.get(m.by)
  rows.push({ label: 'Source', value: owner ? 'Owner' : lead ? (lead.kind === 'bot' ? 'Bot lead' : leadKind(lead).label) : 'Team Mode' })
  for (const a of m.assignments || []) {
    rows.push({ label: 'Assigned to', value: `${name(a.to, leads)} · must answer` })
    rows.push({ label: 'Current step', value: assignStep(a) })
  }
  if (m.answers) {
    const r = m.answers.response
    const said = r === 'decline' ? `Declined${m.answers.reason ? `: ${m.answers.reason}` : ''}` : ANSWER[r] || ANSWER.ask
    const again = r === 'take' && m.answers.binding?.attempt > 1 ? ` · ask ${m.answers.binding.attempt}` : ''
    rows.push({ label: 'Answer', value: `${said}${again}` })
  }
  if (m.kind === 'notice') rows.push({ label: 'Kind', value: 'Notice · goes to briefs · wakes nobody · not a hop' })
  if (m.everyone) rows.push({ label: 'Addressed', value: `@everyone · wakes all${everyoneCount ? ` ${everyoneCount}` : ''}` })
  // a DM has no @: a lead's DM to the owner waits in Needs you (decisions.py:dm_asks)
  const ask = dm && !owner ? dmAsk(decisions, channelId, m) : null
  if (ask) {
    rows.push({ label: 'Asked', value: 'Owner · shows in Needs you' })
    rows.push({ label: 'Current step', value: DM_STEP[ask.state] || 'Waiting on you' })
  }
  const unaddressed = !dm && !owner && !m.everyone && !m.mentions?.length && !m.answers && !m.thread_id
  if (unaddressed && m.kind !== 'notice') rows.push({ label: 'Addressed', value: 'No @ · each lead decides whether to answer' })
  const hops = m.chain?.hops || 0
  rows.push({ label: 'Hop', value: hops > 0 ? `${hops} · past 4 the bar raiser takes over` : owner ? '0 · your post resets the count' : '0' })
  if (m.held) rows.push({ label: 'Held', value: `Hop ${m.chain?.hops ?? '?'} is over 4 · waiting for bar raiser` })
  else if (m.released) rows.push({ label: 'Held', value: 'Released by bar raiser' })
  const woke = wokeSplit(briefs, channelId, m, dm)
  if (woke.now.length) rows.push({ label: 'Woke now', value: woke.now.map((id) => name(id, leads)).join(', ') })
  if (woke.later.length) rows.push({ label: 'Read later', value: woke.later.map((id) => name(id, leads)).join(', ') })
  if (m.redirected?.length) {
    const n = Math.max(...m.redirected.map((x) => x.answers || 2))
    rows.push({ label: 'Redirected', value: `${m.redirected.map((x) => name(x.who, leads)).join(', ')} · ${n} answers in main already` })
  }
  if (replyTo) {
    const t = String(replyTo.text || '')
    rows.push({ label: 'Reply to', value: `${name(replyTo.by, leads)}: ${t.slice(0, 36)}${t.length > 36 ? '…' : ''}` })
  }
  rows.push({ label: 'Recorded', value: fmtStamp(m.ts) })
  return rows
}

/** Enter or Space on a focused card flips it. */
export function flipOnKey(key) {
  return key === 'Enter' || key === ' ' || key === 'Spacebar'
}

/**
 * Whether a click on the card flips it. A click on a link or control inside does its
 * own job, and a click that ends a text selection keeps the selection.
 */
export function clickFlips(target, selectedText = '') {
  if (selectedText) return false
  return !target?.closest?.('a, button, input, textarea, select')
}
