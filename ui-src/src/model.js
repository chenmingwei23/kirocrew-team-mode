// Turns GET /state responses into what the page draws. Pure functions, no React.
//
// The page polls /state?since=<cursor>. A response with `entries` holding rows we
// already have (same seq) replaces them; new rows are appended in seq order. Every
// other key replaces the previous value wholesale.

export const OWNER = 'owner'
// The app SDK exposes no owner display name (useAppInfo / useAppIdentity carry the
// app's identity, not the user's), so the person is shown by role.
export const OWNER_NAME = 'Owner'

export function mergeState(prev, next) {
  if (!next || typeof next !== 'object') return prev
  if (!prev) return { ...next, entries: { ...(next.entries || {}) } }
  const entries = { ...(prev.entries || {}) }
  for (const [cid, rows] of Object.entries(next.entries || {})) {
    const bySeq = new Map((entries[cid] || []).map((r) => [r.seq, r]))
    for (const r of rows || []) bySeq.set(r.seq, r)
    entries[cid] = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }
  return { ...prev, ...next, entries }
}

/** `lead:L-1` -> `L-1`; `owner`, `app`, `bar_raiser:C-1`, `secretary:B-1` stay as they are. */
export function actorId(by) {
  return typeof by === 'string' && by.startsWith('lead:') ? by.slice(5) : by || ''
}

export function leadIndex(state) {
  const map = new Map()
  ;(state?.leads || []).forEach((l, i) => map.set(l.lead_id, { ...l, hue: i }))
  return map
}

/** How many of *ids* (default: every lead) are still in the team. A removed lead stays
 *  in /state and in its groups' member lists, but is no longer a lead anyone counts. */
export function activeLeadCount(leads, ids) {
  const list = ids ? ids.map((id) => leads.get(id)) : [...leads.values()]
  return list.filter((l) => l && l.active !== false).length
}

/** Short name for a handle: `tm-demo-api-lead` -> `api-lead`. */
export function shortHandle(handle) {
  return String(handle || '').replace(/^tm-demo-/, '')
}

export function channelName(ch, leads) {
  if (!ch) return ''
  if (ch.kind === 'group') return ch.title || ch.id
  const names = (ch.members || []).map((id) => shortHandle(leads.get(id)?.handle || id))
  if ((ch.people || []).includes(OWNER)) names.push(OWNER_NAME)
  return names.join(' · ')
}

/**
 * Fold one channel's raw rows into what the conversation view needs.
 * Returns messages keyed by seq with their thread, hold, assignment and stub facts.
 */
export function foldChannel(rows) {
  const messages = []
  const bySeq = new Map()
  const byMsgId = new Map()
  const threads = new Map()
  const assignments = new Map()
  const relays = []
  for (const row of rows || []) {
    const d = row.data || {}
    switch (row.type) {
      case 'message/posted': {
        const m = { seq: row.seq, ts: row.ts, by: actorId(row.by), rawBy: row.by, ...d, held: false, assignments: [], redirected: [] }
        messages.push(m)
        bySeq.set(row.seq, m)
        byMsgId.set(d.msg_id, m)
        const th = d.thread_id && threads.get(d.thread_id)
        if (th) { th.count += 1; th.last_ts = row.ts; th.replies.push(m) }
        break
      }
      case 'thread/opened':
        threads.set(d.thread_id, { thread_id: d.thread_id, root_seq: d.root_seq, opener: d.opener, participants: [], count: 0, last_ts: row.ts, replies: [], mode: d.mode || 'chat', meeting_id: d.meeting_id || null })
        break
      case 'thread/member_added': {
        const th = threads.get(d.thread_id)
        if (th && !th.participants.includes(d.who)) th.participants.push(d.who)
        break
      }
      case 'message/held': {
        const m = byMsgId.get(d.msg_id)
        if (m) { m.held = true; m.held_reason = d.reason }
        break
      }
      case 'message/released': {
        const m = byMsgId.get(d.msg_id)
        if (m) { m.held = false; m.released = true }
        break
      }
      case 'assignment/opened': {
        const a = { ...d, state: 'open', opened_ts: row.ts }
        assignments.set(d.assignment_id, a)
        bySeq.get(d.msg_seq)?.assignments.push(a)
        break
      }
      case 'assignment/taken':
      case 'assignment/declined':
      case 'assignment/asked':
      case 'assignment/closed':
      case 'assignment/unanswered': {
        const a = assignments.get(d.assignment_id)
        if (a) { a.state = row.type.split('/')[1]; a.reason = d.reason || ''; a.empty = !!d.empty }
        break
      }
      case 'relay/noted':
        relays.push({ seq: row.seq, ts: row.ts, by: actorId(row.by), ...d })
        break
      case 'reply/redirected': { // round4 A-F2: a lead held back by the 2-answers-in-main cap
        const m = bySeq.get(d.reply_to)
        if (m && !m.redirected.some((x) => x.who === d.who)) m.redirected.push({ who: d.who, answers: d.answers_in_main })
        break
      }
      default:
        break
    }
  }
  const main = messages.filter((m) => !m.thread_id || m.also_main)
  return { messages, main, bySeq, threads, assignments, relays }
}

export const MEETING_STATE = {
  convening: ['Convening', 'is-info'],
  open: ['In session', 'is-assign'],
  adjourning: ['Adjourning', 'is-warn'],
  closed: ['Adjourned', 'is-ok'],
  cancelled: ['Cancelled', ''],
}

export const OUTCOME = {
  consensus: ['Consensus', 'is-ok'],
  vote: ['Vote', 'is-ok'],
  bar_raiser_ruling: ['Bar raiser ruling', 'is-assign'],
  deferred: ['Deferred', 'is-warn'],
  no_outcome: ['No outcome', 'is-err'],
}

/**
 * Ids in text people read, the same rules as teamapp/meeting.py readable_ids:
 * `I1-P2` -> "Proposal 2" inside item I1, else "Proposal 2 of item 1" (F-MS2);
 * `ballot I2-B1` -> "vote 1"; `seqs 116, 119` -> "Ada's speech and Uma's speech" from
 * `refs` (the meeting summary's seq -> words; an unknown seq reads "an earlier entry").
 * Without `refs`, seqs stay as written (round4 F4).
 */
export function readableIds(text, itemId, refs) {
  if (typeof text !== 'string') return text
  const where = (i) => (itemId === `I${i}` ? '' : ` of item ${i}`)
  let out = text
    .replace(/\bI(\d+)-P(\d+)\b/g, (_, i, p) => `Proposal ${p}${where(i)}`)
    .replace(/\b(?:([Bb])allot\s+)?I(\d+)-B(\d+)\b/g, (_, b, i, n) => `${b === 'B' ? 'Vote' : 'vote'} ${n}${where(i)}`)
  if (refs) {
    out = out.replace(/\b(?:record\s+|owner(?:'s)?\s+(?:message\s+)?|message\s+)?seqs?\s+(\d+(?:(?:\s*,\s*|\s+and\s+|\s*&\s*)\d+)*)/gi, (_, list) => {
      const words = [...new Set(list.match(/\d+/g).map((n) => refs[n] || 'an earlier entry'))]
      return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
    })
  }
  return out
}

/** Rows of one channel that belong to one meeting (planner rows, speeches, votes, actions). */
export function meetingRows(rows, meetingId) {
  return (rows || []).filter((r) => {
    const d = r.data || {}
    return d.meeting_id === meetingId || d.meeting?.meeting_id === meetingId || d.minutes_of === meetingId
  })
}

/** Open grants of an agenda item, newest round last. */
export function openGrants(item) {
  const out = []
  for (const rd of Object.values(item?.rounds || {})) for (const g of Object.values(rd.grants || {})) if (g.state === 'open') out.push(g)
  return out
}

/** `meeting_turn:TU-1` -> `meeting_turn`, for labels of wake reasons that carry an id. */
export function reasonKind(reason) {
  return String(reason || '').split(':')[0]
}

// Wake reasons as people read them. The ledger keeps `assign:A-…`, `meeting_turn:TU-…`;
// the label never carries the id (video round 2, S13/S15 showed "assign:A-cf8d581f").
const REASON_LABEL = {
  owner: 'message from Owner', mention: '@-mentioned', everyone: '@everyone', cc: 'cc', dm: 'direct message',
  assign: 'new assignment', answer: 'reply to its assignment', rewake: 'assignment still open',
  pulled_in: 'added to a thread', batch: 'group batch ready', thread: 'new thread reply',
  assignment_unanswered: 'assignment unanswered', meeting_invite: 'meeting invitation',
  meeting_turn: 'meeting turn', meeting_chair: 'chair check due', meeting_vote: 'meeting vote',
}

/** `assign:A-cf8d581f` -> `new assignment`; an unknown reason shows its kind only, never the id. */
export function reasonLabel(reason) {
  const kind = reasonKind(reason)
  return REASON_LABEL[kind] || kind.replace(/_/g, ' ')
}

/** A thread as people read its place: `thread: "first words…"` from the channel's
 * `thread_titles` (server-built, round5 S42), else `thread`. Never the T- id or root seq. */
export function threadLabel(threadId, titles) {
  const t = titles && titles[String(threadId || '')]
  return t ? `thread: “${t}”` : 'thread'
}

export function threadForRoot(folded, seq) {
  for (const th of folded.threads.values()) if (th.root_seq === seq) return th
  return null
}

/** Every relay/noted row across all channels, newest first. */
export function allRelays(state) {
  const out = []
  for (const [cid, rows] of Object.entries(state?.entries || {})) {
    for (const r of rows) if (r.type === 'relay/noted') out.push({ channel_id: cid, seq: r.seq, ts: r.ts, by: actorId(r.by), ...r.data })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

/** Raw rows for the ledger debug tab: the backend's own tail when it sends one, else channel rows. */
export function ledgerRows(state) {
  if (Array.isArray(state?.ledger)) return state.ledger
  const out = []
  for (const [cid, rows] of Object.entries(state?.entries || {})) {
    for (const r of rows) out.push({ file: `channels/${cid}.jsonl`, ...r })
  }
  return out.sort((a, b) => b.ts - a.ts || b.seq - a.seq)
}

/** Split text into plain and @mention parts so mentions can be drawn as chips. */
export function splitMentions(text, handles) {
  const parts = []
  const re = /@([\w.-]+)/g
  let last = 0
  let m
  while ((m = re.exec(text || ''))) {
    const name = m[1]
    if (name !== 'everyone' && !handles.has(name)) continue
    if (m.index > last) parts.push({ text: text.slice(last, m.index) })
    parts.push({ text: m[0], mention: name })
    last = m.index + m[0].length
  }
  if (last < (text || '').length) parts.push({ text: text.slice(last) })
  return parts
}

/** Lead ids mentioned in owner text, by handle. `@everyone` is reported separately. */
export function parseOwnerMentions(text, leads) {
  const byHandle = new Map([...leads.values()].map((l) => [l.handle, l.lead_id]))
  const mentions = []
  let everyone = false
  for (const m of (text || '').matchAll(/@([\w.-]+)/g)) {
    if (m[1] === 'everyone') everyone = true
    else if (byHandle.has(m[1]) && !mentions.includes(byHandle.get(m[1]))) mentions.push(byHandle.get(m[1]))
  }
  return { mentions, everyone }
}

export function fmtClock(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtTokens(n) {
  if (!n && n !== 0) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

// ───────────────────────────────────────────────────────────── limits, models, impact (W-LC)

// Labels for the keys of teamapp/limits.py LIMIT_KEYS; `unit: 'min'` shows seconds as minutes.
export const LIMIT_FIELDS = [
  { key: 'total_wakes', label: 'Deliveries in total' },
  { key: 'total_tokens_est', label: 'Tokens in total (estimate)' },
  { key: 'hourly_wake', label: 'Wakes per hour' },
  { key: 'wakes_per_lead_hour', label: 'Wakes per lead per hour' },
  { key: 'hourly_message', label: 'Messages per hour' },
  { key: 'hourly_secretary', label: 'Secretary runs per hour' },
  { key: 'hourly_bar_raiser', label: 'Bar raiser cases per hour' },
  { key: 'owner_away_secs', label: 'Pause batch wakes after you are away', unit: 'min' },
]

const toShown = (f, v) => (f.unit === 'min' ? Math.round(v / 60) : v)
const fromShown = (f, v) => (f.unit === 'min' ? v * 60 : v)

/** One row per limit: what applies, the hard cap, what the owner asked, and whether it was clamped. */
export function limitRows(budget) {
  const l = budget?.limits || {}
  const caps = l.caps || {}
  const hard = l.hard || {}
  const asked = l.asked || {}
  const clamped = new Set(l.clamped || [])
  return LIMIT_FIELDS.map((f) => ({
    ...f,
    applied: toShown(f, caps[f.key] ?? 0),
    hard: toShown(f, hard[f.key] ?? 0),
    asked: asked[f.key] === undefined ? null : toShown(f, asked[f.key]),
    clamped: clamped.has(f.key),
  }))
}

/**
 * The body for POST /limits from the dialog's text fields, or `{ error }`.
 * Blank fields are left out (the hard cap applies). A value above the hard cap is
 * still sent: the server keeps it as asked and applies the hard cap, and the page says so.
 */
export function limitsBody(fields) {
  const out = {}
  for (const f of LIMIT_FIELDS) {
    const raw = String(fields?.[f.key] ?? '').trim()
    if (!raw) continue
    if (!/^\d+$/.test(raw) || Number(raw) < 1) return { error: `${f.label}: enter a whole number of at least 1.` }
    out[f.key] = fromShown(f, Number(raw))
  }
  return { limits: out }
}

const LC_REFUSAL = {
  unknown_lead: 'This lead is already removed.',
  open_items: 'Clear the open items first.',
  group_closed: 'This group is already closed.',
  bad_model_id: 'A model id is lower-case letters, digits, dots and dashes, like claude-haiku-4.5.',
  bad_limit: 'Enter a whole number of at least 1 (at least 1 minute for the away pause).',
}

/** A short sentence for an error from this app's routes (the body's `reason`), else its message. */
export function errText(err) {
  let parsed = null
  try { parsed = JSON.parse(err?.body || '') } catch { /* not JSON */ }
  const reason = parsed?.reason
  if (reason && LC_REFUSAL[reason]) return LC_REFUSAL[reason]
  return err?.message || String(err)
}

export const ROLE_LABEL = { secretary: 'Secretary', bar_raiser: 'Bar raiser' }
export const INTENT_LABEL = { easy: 'Easy', default: 'Default', smartest: 'Smartest' }

/** `[{ role, label, intent, model }]` for the Models card. */
export function modelRows(models) {
  const routes = models?.routes || {}
  return Object.entries(models?.roles || {}).map(([role, intent]) => ({
    role, label: ROLE_LABEL[role] || role, intent, model: routes[intent] || '—',
  }))
}

/** Lines for the Remove confirmation, from GET /leads/{id}/impact. Plain words, no ids. */
export function impactLines(imp, { bot = false } = {}) {
  if (!imp) return []
  // Remove takes a lead out of the team; it never deletes the Bot.
  const out = [{ kind: 'keep', text: 'The Bot itself is kept: its chat, memory and history stay' }]
  // botSource.js:removeFromTeam turns these off; a legacy lead has neither.
  if (bot) out.push({ kind: 'info', text: 'Its “Answer from its own chat” switch and its wake job are turned off' })
  for (const g of imp.groups || []) {
    out.push({ kind: g.short ? 'warn' : 'info',
      text: g.short ? `#${g.title}: only ${g.left} active lead${g.left === 1 ? '' : 's'} left (a group needs 2)`
        : `#${g.title}: stops getting messages and wakes` })
  }
  if (imp.dms) out.push({ kind: 'info', text: `${imp.dms} direct message${imp.dms === 1 ? '' : 's'} stop${imp.dms === 1 ? 's' : ''} reaching it` })
  for (const r of imp.requests || []) out.push({ kind: 'warn', text: `${r.text} in #${r.group} is still ${r.state === 'taken' ? 'in progress' : 'open'}` })
  for (const a of imp.actions || []) out.push({ kind: 'warn', text: `Action item “${a.title}” in #${a.group} loses its owner (${a.state})` })
  for (const m of imp.meetings || []) out.push({ kind: 'warn', text: `Meeting “${m.title}” in #${m.group} loses its ${m.role}` })
  for (const c of imp.cases || []) out.push({ kind: 'warn', text: `A bar raiser case in ${c.group === 'a direct message' ? c.group : `#${c.group}`} is ${c.state}` })
  // The same line twice (e.g. one lead asked the same thing again) shows once, with a count.
  const seen = new Map()
  for (const l of out) {
    const s = seen.get(l.text)
    if (s) s.n += 1
    else seen.set(l.text, { ...l, n: 1 })
  }
  return [...seen.values()].map(({ n, ...l }) => (n > 1 ? { ...l, text: `${l.text} (${n} times)` } : l))
}

// ───────────────────────────────────────────── bar raiser cases and person cards

export const CASE_ACTION = {
  continue: 'Continue', narrow: 'Narrow the question', close_thread: 'Close this chain', veto: 'Block it',
  hold: 'Hold: cannot judge yet', suggest_meeting: 'Suggest a meeting', call_person: 'Hand to a person',
  rule: 'Rule', defer: 'Defer the item',
}
export const PERSON_CLASS = {
  spend: 'costs money', security: 'security', irreversible: 'cannot be undone', exhausted: 'bar raiser out of budget',
  requested: 'someone asked for a person',
}
const VOID = {
  new_attempt: 'Replaced by a newer card on this chain. Answer that one.',
  expired: 'This card expired.', changed: 'This card changed. Reload and read it again.',
  already_used: 'Already answered.', not_called: 'No card to answer.',
}

/** One status chip for a case: [label, tone]. Waiting on the owner comes first. */
export function caseStatus(c) {
  const cp = c.called_person
  if (c.defaulted) return ['Default action', 'is-warn']
  if (!c.acted) return ['Reviewing', 'is-info']
  if (cp?.standing) return ['Within your standing approval', 'is-ok']
  if (c.answer) return [{ approve: 'You approved', no: 'You said no', change: 'You answered' }[c.answer.decision] || 'You answered', 'is-ok']
  if (c.lapsed) return ['No answer · counted as No', 'is-warn']
  if (cp && cp.card && cp.void) return [cp.void === 'new_attempt' ? 'Replaced' : 'Closed', '']
  if (cp) return ['Needs your answer', 'is-err']
  if (c.acted.action === 'veto') return ['BLOCK', 'is-err']
  if (c.acted.action === 'hold') return ['HOLD', 'is-warn']
  return ['Done', 'is-ok']
}

/** The buttons a person card shows, in order (round4 C: Skip was only on the plain decision row). */
export const CARD_ACTIONS = ['approve', 'change', 'no', 'skip']

/**
 * The POST /decisions/answer body for one person-card button, bound to the card version
 * the owner saw (`card_hash`). `skip` is teamapp/decisions.py answer(skip=True): it counts
 * as No and runs the card's if_no once.
 */
export function cardAnswerBody(c, decision, { text = '', standing = false } = {}) {
  const card_hash = c?.called_person?.card_hash
  if (decision === 'skip') return { skip: true, card_hash }
  return {
    decision, card_hash, ...(text.trim() ? { text: text.trim() } : {}),
    ...(standing && decision !== 'change' ? { standing: { hours: 24 } } : {}),
  }
}

/** May the owner answer this person card now? */
export function cardOpen(c) {
  const cp = c.called_person
  return Boolean(cp && cp.card && !cp.standing && !c.answer && !c.lapsed && !cp.void)
}

export function cardVoidText(c) {
  return VOID[c.called_person?.void] || ''
}

function fmtLeft(secs) {
  if (secs <= 0) return 'expired'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h ? `in ${h}h ${m}m` : `in ${m}m`
}

/** The fixed-field rows of a person card, in a fixed order: [label, value]. */
export function cardRows(card, now) {
  if (!card) return []
  const undo = { yes: 'Yes', no: 'No', partly: 'Partly' }[card.reversible] || card.reversible
  const tried = (card.tried || []).map((a) => CASE_ACTION[a] || a).join(', ') || 'Nothing yet'
  return [
    ['What', card.what],
    ['Who', card.who],
    ['Cost', card.cost],
    ['Can undo', undo],
    ['Attempt', String(card.attempt)],
    ['Tried before', tried],
    ['Expires', `${fmtClock(card.expires)} (${fmtLeft(card.expires - now)})`],
    ['If you say no', CASE_ACTION[card.if_no] || card.if_no],
  ]
}

/** The evidence line: each cited seq with where it came from. Party claims are marked. */
export function evidenceParts(evidence) {
  const word = { record: 'record', owner: 'you', party_claim: 'claim' }
  return (evidence || []).map((e) => ({ seq: e.seq, source: e.source, label: `${word[e.source] || 'record'} #${e.seq}` }))
}

// ───────────────────────────────────────────────────────────── team tree

import { leadForBot, leadKind } from './botSource.js'

// Members tree: Owner -> each project's lead (an existing Bot) -> that Bot's own
// worker tree. Groups, assignments, cases and briefs come from GET /state; a lead's
// name, project and workers come only from the lead source (appLeadSource today,
// the Bot data source once it lands). Nothing a node shows is a lead, assignment or
// case id, or a session key: `key` and `slotKey` are for selection and the Open
// chat button only and are never rendered.

const ID_RE = /\b(?:[LACGDMTB]-[0-9a-z]+|TU-\d+|dashboard:\S+|chat-\d+|member-[\w-]+)/

/** True when *text* looks like an internal id or session key (used by tests and as a guard). */
export function hasInternalId(text) {
  return ID_RE.test(String(text || ''))
}

/** Assignments addressed to each lead, folded from every channel's rows. */
function assignmentsByLead(state) {
  const out = new Map()
  for (const rows of Object.values(state?.entries || {})) {
    for (const a of foldChannel(rows).assignments.values()) {
      if (!out.has(a.to)) out.set(a.to, [])
      out.get(a.to).push(a)
    }
  }
  return out
}

function nameOf(id, leads) {
  if (id === OWNER) return OWNER_NAME
  const h = leads.get(id)?.handle
  return h ? shortHandle(h) : 'a teammate'
}

/** One status per lead, first match wins. */
export const LEAD_STATUS = {
  stopped: ['Stopped', 'is-err'],
  waiting: ['Waiting on you', 'is-warn'],
  no_answer: ['No answer', 'is-err'],
  assigned: ['Assigned', 'is-assign'],
  quiet: ['Nothing pending', ''],
}

/** What a lead's kind reads as (botSource.js:leadKind): Bot, else the old `lead` agent chat. */
export const LEGACY_LABEL = 'Legacy lead'
export function leadKindLabel(kind) {
  return leadKind({ kind }).label
}

/**
 * Worker nodes as given by a source, nested: `[{ name | title, role?, status?, workers? }]`.
 * `null` / not a list means the source cannot see them.
 */
function cleanWorkers(list) {
  if (!Array.isArray(list)) return null
  return list.filter((w) => w && (w.name || w.title)).map((w) => ({
    name: String(w.name || w.title),
    role: typeof w.role === 'string' ? w.role : '',
    status: typeof w.status === 'string' ? w.status : '',
    workers: cleanWorkers(w.workers) || [],
  }))
}

/**
 * Data-source adapter: turns a lead list into tree nodes
 * `{ key, name, role, project, kind, legacy, slotKey, hue, workers }`. This is the
 * one place to swap; everything below reads only these fields.
 *
 * Optional fields draw an empty state: `role` / `project` as `''`, `workers` as
 * `null` (the source cannot see them, so no expand toggle) or `[]` (it sees none).
 */
export function appLeadSource(state) {
  return (state?.leads || []).map((l, i) => ({ l, i })).filter(({ l }) => l.active !== false).map(({ l, i }) => {
    const label = String(l.session_label || '')
    return {
      key: l.lead_id,
      hue: i,
      name: shortHandle(l.display_name || l.handle),
      role: typeof l.duty === 'string' ? l.duty : '',
      project: typeof l.project === 'string' ? l.project : '',
      kind: leadKindLabel(l.kind),
      legacy: l.kind !== 'bot',
      slotKey: label.startsWith('dashboard:') ? label.slice('dashboard:'.length) : null,
      workers: cleanWorkers(l.workers),
    }
  })
}

/**
 * Lead source over the Bot data source: rows from `botSource.js:botRows`
 * (`{ handle, name, bot, slot_key, session_label, project, description, workers | null }`),
 * matched to the app's leads the way `botSource.js:leadForBot` does (same crew key
 * or same chat). A matched Bot fills name, project, role (its description) and
 * workers; `workers` are crew-workers rows linked into a tree under the Bot's own
 * chat, or null when that call did not answer (then no expand toggle). A lead with
 * no Bot row keeps its own fields; a legacy lead is never matched and stays listed.
 * Kind always comes from the app's lead (`kind: bot` / anything else = legacy).
 */
export function rosterLeadSource(rows) {
  const bots = (rows || []).filter((r) => r && r.bot)
  return (state) => appLeadSource(state).map((n) => {
    const lead = (state?.leads || []).find((l) => l.lead_id === n.key)
    if (!lead || lead.kind !== 'bot') return n
    const r = bots.find((b) => leadForBot(b, [lead]))
    if (!r) return n
    return {
      ...n,
      name: shortHandle(r.name || r.handle) || n.name,
      project: typeof r.project === 'string' ? r.project : n.project,
      role: r.description || n.role,
      workers: Array.isArray(r.workers) ? crewWorkersToTree(r.workers, r.slot_key) : null,
    }
  })
}

/**
 * A Bot's own worker tree from `GET /api/chat/slots/<slot_key>/crew-workers` rows
 * (`{ key, title, status, dispatched_by }`): edges follow `dispatched_by`, starting
 * at the Bot's own slot. Keys are used to link rows and then dropped.
 */
// The host's side-panel group says what a worker is doing; its raw `status` only says
// whether a turn runs, so a worker that reported done reads "idle" there.
const WORKER_GROUP_LABEL = {
  approval: 'Needs approval', working: 'Working', with_conductor: 'Asking its Bot', waiting: 'Waiting', done: 'Done',
}
const WORKER_STATUS_LABEL = {
  needs_approval: 'Needs approval', working: 'Working', asking: 'Asking its Bot', idle: 'Waiting', closed: 'Done',
  waiting: 'Waiting', done: 'Done',
}

/** One crew-workers row's state in plain English: the host's `group` first, else `status`. */
export function workerStateLabel(row) {
  return WORKER_GROUP_LABEL[row?.group] || WORKER_STATUS_LABEL[row?.status] || ''
}

export function crewWorkersToTree(rows, rootKey) {
  const byParent = new Map()
  for (const r of rows || []) {
    if (!r || !r.key) continue
    const p = r.dispatched_by || rootKey
    if (!byParent.has(p)) byParent.set(p, [])
    byParent.get(p).push(r)
  }
  const seen = new Set([rootKey])
  const build = (parent) => (byParent.get(parent) || []).filter((r) => !seen.has(r.key)).map((r) => {
    seen.add(r.key)
    return { name: r.title || 'Untitled session', role: '', status: workerStateLabel(r), workers: build(r.key) }
  })
  return build(rootKey)
}

/**
 * Lead source straight from host rows: `GET /api/members` joined on the Bot's
 * fixed chat (`session_label` = `dashboard:<slot_key>`): name = `display_name`
 * (else `name`), role = `description`, project = `workspace`, workers =
 * `crewWorkersToTree(workersBySlot[slot_key])` (null when not fetched).
 */
export function botLeadSource(members, workersBySlot = {}) {
  const bySlot = new Map((members || []).filter((m) => m?.slot_key).map((m) => [m.slot_key, m]))
  return (state) => appLeadSource(state).map((n) => {
    const m = n.slotKey ? bySlot.get(n.slotKey) : null
    if (!m) return n
    const rows = workersBySlot[m.slot_key]
    return {
      ...n,
      name: m.display_name || m.name || n.name,
      role: typeof m.description === 'string' ? m.description : n.role,
      project: typeof m.workspace === 'string' ? m.workspace : n.project,
      kind: 'Bot',
      legacy: false,
      workers: Array.isArray(rows) ? crewWorkersToTree(rows, m.slot_key) : n.workers,
    }
  })
}

// ── expand / collapse each lead's own org chart (default: collapsed)

/** Workers under a lead, or null when the source cannot see them (then no toggle is drawn). */
export function hiddenWorkerCount(lead) {
  return Array.isArray(lead?.workers) && lead.workers.length ? countWorkers(lead.workers) : null
}

/** The leads as drawn: a collapsed lead keeps its own fields but shows no worker boxes. */
export function visibleTree(leads, expanded) {
  return (leads || []).map((l) => {
    const n = hiddenWorkerCount(l)
    const open = n !== null && expanded.has(l.key)
    return { ...l, open, hiddenCount: n !== null && !open ? n : 0, canToggle: n !== null, workers: open ? l.workers : null }
  })
}

/** Every lead that has a toggle, for Expand all. */
export function expandAllKeys(leads) {
  return new Set((leads || []).filter((l) => hiddenWorkerCount(l) !== null).map((l) => l.key))
}

export const EXPANDED_STORE_KEY = 'kirocrew.team-mode.tree-expanded'

/** Expanded lead keys from browser storage; anything unreadable means "all collapsed". */
export function loadExpanded(storage) {
  try {
    const v = JSON.parse(storage?.getItem(EXPANDED_STORE_KEY) || '[]')
    return new Set(Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveExpanded(storage, expanded) {
  try { storage?.setItem(EXPANDED_STORE_KEY, JSON.stringify([...expanded])) } catch { /* storage full or blocked: keep it in memory only */ }
}

/** Where the "no leads" empty state sends the owner: the host's Bots page. */
export const BOTS_PAGE = '/members'

/** Number of workers in a (nested) worker list. */
export function countWorkers(list) {
  return (list || []).reduce((n, w) => n + 1 + countWorkers(w.workers), 0)
}

/**
 * The Members tree: the owner, then every lead with what its node and role card
 * show, each carrying its own worker subtree from the source.
 */
export function teamTree(state, source = appLeadSource) {
  const leads = leadIndex(state)
  const active = source(state)
  const groups = (state?.channels || []).filter((c) => c.kind === 'group')
  const byLead = assignmentsByLead(state)
  const openCalls = (state?.cases || []).filter((c) => c.called_person && !c.answer)
  const briefs = state?.briefs || []
  return {
    owner: { name: OWNER_NAME, leadCount: active.length, groupCount: groups.length },
    leads: active.map((n) => {
      const mine = groups.filter((g) => (g.members || []).includes(n.key))
      const mineIds = new Set(mine.map((g) => g.id))
      const as = byLead.get(n.key) || []
      const waits = []
      for (const c of openCalls) {
        if (!mineIds.has(c.channel_id)) continue
        const g = mine.find((x) => x.id === c.channel_id)
        waits.push({ text: c.called_person.question ? fold1(c.called_person.question, leads) : 'The bar raiser called you.', where: `#${g.title || 'group'}`, who: OWNER_NAME })
      }
      for (const a of as.filter((x) => x.state === 'asked')) {
        waits.push({ text: `Asked ${nameOf(a.from, leads)} a question about an assignment.`, where: a.thread_id ? 'thread' : 'main', who: nameOf(a.from, leads) })
      }
      const count = (s) => as.filter((x) => x.state === s).length
      const status = state?.stopped ? 'stopped'
        : waits.some((w) => w.who === OWNER_NAME) ? 'waiting'
          : count('unanswered') ? 'no_answer'
            : count('open') ? 'assigned' : 'quiet'
      const myBriefs = briefs.filter((b) => b.lead_id === n.key)
      return {
        ...n,
        groups: mine.map((g) => g.title || 'Untitled group'),
        status,
        statusLabel: LEAD_STATUS[status][0],
        statusTone: LEAD_STATUS[status][1],
        waits,
        assignments: { open: count('open'), taken: count('taken'), asked: count('asked'), unanswered: count('unanswered') },
        routines: {
          // The app sees secretary briefs it wrote; it cannot list the lead's cron jobs.
          briefs: myBriefs.length,
          lastBriefTs: myBriefs.length ? myBriefs[myBriefs.length - 1].ts : null,
          cronJobs: null,
        },
      }
    }),
  }
}

function fold1(text, leads) {
  // Case text is scrubbed by the backend already; replace any id that slipped through.
  let t = String(text || '')
  for (const l of leads.values()) t = t.split(l.lead_id).join(shortHandle(l.handle))
  return t
}

/** The text a role card shows, field by field (no keys, no slot). */
export function roleCardFields(lead) {
  const r = lead.routines
  return {
    Name: lead.name,
    Project: lead.project || 'No project on record.',
    Owns: lead.role || 'No role written yet.',
    Workers: lead.workers === null || lead.workers === undefined ? ['Team Mode cannot see this lead’s workers yet.']
      : lead.workers.length ? flatWorkers(lead.workers).map(({ w, depth }) => `${'· '.repeat(depth)}${w.name}${w.role ? ` — ${w.role}` : ''}`)
        : ['No workers.'],
    Status: lead.statusLabel,
    'Waiting on a person': lead.waits.length ? lead.waits.map((w) => `${w.who}: ${w.text} (${w.where})`) : ['Nothing is waiting on a person.'],
    Assignments: `${lead.assignments.open} new · ${lead.assignments.taken} taken · ${lead.assignments.asked} asked back · ${lead.assignments.unanswered} unanswered`,
    Routines: [
      r.briefs ? `Secretary brief · ${r.briefs} so far · last ${fmtClock(r.lastBriefTs)}` : 'Secretary brief · none yet',
      'Scheduled jobs · Team Mode cannot see them',
    ],
    Groups: lead.groups.length ? lead.groups.map((g) => `#${g}`) : ['Not in a group yet.'],
  }
}

function flatWorkers(list, depth = 0, out = []) {
  for (const w of list || []) { out.push({ w, depth }); flatWorkers(w.workers, depth + 1, out) }
  return out
}

// Canvas geometry, in canvas pixels before zoom.
export const TREE = { ownerW: 168, ownerH: 72, leadW: 260, leadH: 124, workerW: 200, workerH: 56, gapX: 120, workerGapX: 64, gapY: 22, pad: 32 }

/**
 * Left-to-right tidy layout: owner, then the leads column, then each lead's own
 * worker tree to its right. A parent is centred on the span of its children.
 *
 * `leads` is the lead list (each with `workers` null / [] / nested list) or, for a
 * tree with no workers, just a count. Returns `{ width, height, owner, leads:
 * [{x,y,w,h}], workers: [{x,y,w,h,lead,name,role,status}], edges: [{d,lead}] }`.
 */
export function layoutTree(leads, g = TREE) {
  const list = typeof leads === 'number' ? Array.from({ length: leads }, () => ({ workers: null })) : leads || []
  const kids = (n) => n.workers || []
  // Height a subtree needs: its own box or its children stacked, whichever is taller.
  const stackH = (c) => c.reduce((s, w) => s + span(w, g.workerH), 0) + Math.max(0, c.length - 1) * g.gapY
  const span = (n, h) => Math.max(h, stackH(kids(n)))
  const spans = list.map((l) => span(l, g.leadH))
  const colH = spans.reduce((s, x) => s + x, 0) + Math.max(0, list.length - 1) * g.gapY
  const height = Math.max(colH, g.ownerH) + 2 * g.pad
  const owner = { x: g.pad, y: (height - g.ownerH) / 2, w: g.ownerW, h: g.ownerH }
  const lx = g.pad + g.ownerW + g.gapX
  const boxes = []
  const workers = []
  const edges = []
  let right = list.length ? lx + g.leadW : lx
  const curve = (a, b, lead) => {
    const sx = a.x + a.w; const sy = a.y + a.h / 2; const ty = b.y + b.h / 2; const mx = (sx + b.x) / 2
    edges.push({ d: `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${b.x},${ty}`, lead })
  }
  const place = (parent, children, x, top, lead) => {
    let y = top
    for (const w of children) {
      const s = span(w, g.workerH)
      const box = { x, y: y + (s - g.workerH) / 2, w: g.workerW, h: g.workerH, lead, name: w.name, role: w.role || '', status: w.status || '' }
      workers.push(box)
      curve(parent, box, lead)
      right = Math.max(right, x + g.workerW)
      place(box, kids(w), x + g.workerW + g.workerGapX, y + (s - stackH(kids(w))) / 2, lead)
      y += s + g.gapY
    }
  }
  let y = (height - colH) / 2
  list.forEach((l, i) => {
    const s = spans[i]
    const box = { x: lx, y: y + (s - g.leadH) / 2, w: g.leadW, h: g.leadH }
    boxes.push(box)
    curve(owner, box, i)
    place(box, kids(l), lx + g.leadW + g.workerGapX, y + (s - stackH(kids(l))) / 2, i)
    y += s + g.gapY
  })
  return { width: right + g.pad, height, owner, leads: boxes, workers, edges }
}

export const ZOOM_MIN = 0.4
export const ZOOM_MAX = 2

export function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
}

/** The zoom that shows the whole tree inside the viewport, never above 100%. */
export function fitZoom(view, content) {
  if (!view?.width || !view?.height || !content?.width || !content?.height) return 1
  // Floor before clamping: rounding up would let the tree spill past the viewport.
  return clampZoom(Math.floor(Math.min(1, view.width / content.width, view.height / content.height) * 100) / 100)
}
