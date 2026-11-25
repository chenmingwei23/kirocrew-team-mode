// "Needs you": what waits on the owner, one card at a time, and what happened since
// the owner last spoke. Pure functions over the GET /state body; no model decides here.
//
// `waitingOnYou` is the one count of "things waiting on you". The top bar's
// "N waiting on you" and the "Leads now" card must both use it, so the two never
// disagree. People read every string here: lead names and channel titles, never ids.

import { OWNER, actorId, shortHandle } from './model.js'

// Higher impact first; the bar raiser's call_person classes, then a lead's question.
// Must match teamapp/decisions.py IMPACT.
export const IMPACT = { irreversible: 0, spend: 1, security: 2, exhausted: 3, requested: 4, ask: 5 }
export const IMPACT_LABEL = { irreversible: 'Irreversible', spend: 'Costs money', security: 'Security', exhausted: 'Out of tries', requested: 'Asked for you', ask: 'Question' }

/**
 * Open decisions, highest impact first, then the one waiting longest.
 * Each: `{ key, kind: 'case'|'ask', impact, question, channel_id, thread_id, opened_ts, lead? }`.
 * A skipped (= No), answered or withdrawn decision is not waiting.
 */
export function waitingOnYou(state) {
  return (state?.decisions || [])
    .filter((d) => d.state === 'open')
    .sort((a, b) => (IMPACT[a.impact] ?? 9) - (IMPACT[b.impact] ?? 9) || a.opened_ts - b.opened_ts)
}

/** The ts of the owner's last real post (bot, cron and system rows are not the owner). */
export function ownerLastSpoke(state) {
  let last = null
  for (const rows of Object.values(state?.entries || {})) {
    for (const r of rows || []) {
      if (r.type === 'message/posted' && r.by === OWNER && r.data?.kind !== 'system' && (last === null || r.ts > last)) last = r.ts
    }
  }
  return last
}

/**
 * What happened after the owner last spoke, from the ledger rows the page holds
 * (nothing live is looked up). `names` maps lead id -> handle.
 * Returns `{ since, lines: [{ channel_id, place, text }] }`; one line per channel
 * (its kinds of event joined by " · "), in channel order. `since` is null when the owner has not spoken yet.
 */
export function sinceYouSpoke(state, names) {
  const since = ownerLastSpoke(state)
  const after = (ts) => since === null || ts > since
  const nm = (id) => (id === OWNER ? 'you' : shortHandle(names?.get(id)) || 'a lead')
  const lines = []
  for (const ch of state?.channels || []) {
    const place = ch.kind === 'group' ? `#${ch.title || 'group'}` : `DM: ${(ch.members || []).map(nm).join(', ')}`
    const posts = new Map()
    const asg = { taken: [], declined: [], asked: [], unanswered: [] }
    let held = 0
    let closed = 0
    let botPosts = 0
    const opened = new Map()
    for (const r of state.entries?.[ch.id] || []) {
      const d = r.data || {}
      if (r.type === 'assignment/opened') opened.set(d.assignment_id, d)
      if (!after(r.ts)) continue
      if (r.type === 'message/posted') {
        const by = actorId(r.by)
        if (by === OWNER) continue
        if (String(r.by).startsWith('bar_raiser') || d.kind === 'system') botPosts += 1
        else posts.set(by, (posts.get(by) || 0) + 1)
      } else if (r.type === 'message/held') held += 1
      else if (r.type === 'chain/closed') closed += 1
      else if (r.type.startsWith('assignment/') && r.type !== 'assignment/opened') {
        const a = opened.get(d.assignment_id)
        const k = r.type.split('/')[1]
        if (a && asg[k]) asg[k].push(nm(a.to))
      }
    }
    const parts = []
    const add = (text) => parts.push(text)
    if (posts.size) add([...posts].map(([id, n]) => `${nm(id)} posted ${n}`).join(', '))
    if (asg.taken.length) add(`@ taken by ${uniq(asg.taken).join(', ')}`)
    if (asg.declined.length) add(`@ declined by ${uniq(asg.declined).join(', ')}`)
    if (asg.asked.length) add(`${uniq(asg.asked).join(', ')} asked about an @`)
    if (asg.unanswered.length) add(`@ unanswered by ${uniq(asg.unanswered).join(', ')}`)
    if (held) add(`${held} message${held === 1 ? '' : 's'} held`)
    if (closed) add(`bar raiser closed ${closed === 1 ? 'a chain' : `${closed} chains`}`)
    if (botPosts) add(`${botPosts} bar raiser note${botPosts === 1 ? '' : 's'}`)
    if (parts.length) lines.push({ channel_id: ch.id, place, text: parts.join(' · ') })
  }
  const cases = (state?.cases || []).filter((c) => after(c.ts)).length
  if (cases) lines.push({ channel_id: null, place: 'Bar raiser', text: `opened ${cases} case${cases === 1 ? '' : 's'}` })
  return { since, lines }
}

const uniq = (xs) => [...new Set(xs)]
