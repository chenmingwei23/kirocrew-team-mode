// "Leads now": one status per lead, computed by fixed rules from the ledger rows the
// page already has (GET /state). No model and no secretary decide anything here.
//
// Input: the /state body (`channels`, `entries` = raw channel ledger rows,
// `cases` = folded cases.jsonl, `budget` = folded control.jsonl, `stopped`,
// `stop_reason`), a roster from leadSource.js, `now` in seconds, and the
// "waiting on you" items from waitingSource.js (needsYou.js owns that rule; this
// file never computes it).
// Output: `{ waiting, cards }`, cards sorted most-needs-a-person first.
//
// People read every string here: lead names and channel titles only, never
// L-/A-/C-/T- ids or session keys.

export const STATUS = {
  waiting_you: { rank: 0, label: 'Waiting on you', tone: 'is-err' },
  unanswered: { rank: 1, label: '@ unanswered', tone: 'is-warn' },
  limited: { rank: 2, label: 'Held back', tone: 'is-assign' },
  working: { rank: 3, label: 'Working', tone: 'is-info' },
  no_signal: { rank: 4, label: 'No indicator fired', tone: '' },
}

// "@ not answered" is never timed here: /state `assignments` carries the backend's
// one rule, wake.py `assignment_due` ({step, owed_by, due_ts, late}; an @ is closed
// by a result or no_result).
// shortcut: "working" beyond a taken @ has no ledger row of its own (wake/delivered
// and inbox/acked live in member files /state does not send); a recent post stands
// in for it. Upgrade when /state carries per-lead wake/ack rows.
export const WORKING_POSTED_SECS = 600

const HOLD = { hop_limit: 'hop over 4', channel_cooling: 'channel cooling down' }
const OWNER = 'owner'

const actor = (by) => (typeof by === 'string' && by.startsWith('lead:') ? by.slice(5) : by || '')

function placeName(ch, threadId, names) {
  if (!ch) return 'a channel'
  const base = ch.kind === 'group'
    ? `#${ch.title || 'group'}`
    : `DM with ${[...(ch.members || []).map((id) => names.get(id) || 'a lead'), ...((ch.people || []).includes(OWNER) ? ['Owner'] : [])].join(', ')}`
  return threadId ? `${base} › thread` : base
}

/** Fold one channel's rows into the facts the rules read. */
function foldRows(rows) {
  const msgs = new Map()
  const held = new Map()
  for (const r of rows || []) {
    const d = r.data || {}
    switch (r.type) {
      case 'message/posted':
        msgs.set(d.msg_id, { by: actor(r.by), ts: r.ts, thread_id: d.thread_id || null, kind: d.kind })
        break
      case 'message/held': held.set(d.msg_id, { ts: r.ts, reason: d.reason }); break
      case 'message/released': held.delete(d.msg_id); break
      default: break
    }
  }
  return { msgs, held }
}

/** One assignment from /state `assignments` (wake.py assignment_due applied) to a card hit, or null. */
function assignmentHit(a, ch, state, now, names, nameOf) {
  const place = placeName(ch, a.thread_id || null, names)
  const target = { channel_id: a.channel_id, thread_id: a.thread_id || null }
  const from = nameOf(a.from)
  const left = (ts) => (ts == null ? '' : ts > now ? ` due in ${fmtAge(ts - now)}` : ' overdue')
  if (a.step === 'ack') {
    const when = !a.late && a.due_ts != null && a.due_ts > now ? `bar raiser takes it in ${fmtAge(a.due_ts - now)}` : 'bar raiser due now'
    return { status: 'unanswered', since: a.opened_ts, target, reason: `@ from ${from} not answered · ${when}` }
  }
  if (a.step === 'result') {
    return a.late
      ? { status: 'unanswered', since: a.updated_ts ?? a.opened_ts, target, reason: `No result for @ from ${from} · overdue` }
      : { status: 'working', since: a.updated_ts ?? a.opened_ts, target, reason: `Took @ from ${from} · result${left(a.due_ts)} · ${place}` }
  }
  if (a.step === 'marked') {
    // Stays on the card until the bar raiser's case for it has acted.
    const c = (state?.cases || []).find((x) => (x.triggers || []).some((t) => t.key === `unanswered:${a.assignment_id}`))
    if (c && (c.acted || c.defaulted)) return null
    return { status: 'unanswered', since: a.opened_ts, target,
      reason: `${a.step_missed === 'result' ? `No result for @ from ${from}` : `@ from ${from} not answered`} · bar raiser has it` }
  }
  return null // asker (the assigner owes the reply) and done
}

/**
 * Status of every lead in *roster*, highest-need first.
 * Each card: `{ id, name, project, legacy, status, label, tone, reason, since, target, more, posts, lastTs }`;
 * `since` is the ts the status started (null when the ledger has none), `target` is
 * `{ channel_id, thread_id }` or null, `more` counts lower-or-equal hits not shown.
 * `waiting` counts distinct things waiting on the owner (not leads).
 */
export function leadsNow(state, roster, now, waiting = []) {
  const names = new Map((roster || []).map((l) => [l.id, l.name]))
  const nameOf = (id) => (id === OWNER ? 'Owner' : names.get(id) || 'a member')
  const channels = new Map((state?.channels || []).map((c) => [c.id, c]))
  const hits = new Map((roster || []).map((l) => [l.id, []]))
  const add = (id, h) => hits.get(id)?.push(h)
  const waitingKeys = new Set()
  const posts = new Map()
  const lastPost = new Map()

  const folds = new Map()

  for (const [cid, rows] of Object.entries(state?.entries || {})) {
    const f = foldRows(rows)
    folds.set(cid, f)
    const ch = channels.get(cid)
    for (const [mid, m] of f.msgs) {
      if (!hits.has(m.by) || m.kind === 'system') continue
      posts.set(m.by, (posts.get(m.by) || 0) + 1)
      if (!lastPost.has(m.by) || m.ts > lastPost.get(m.by).ts) lastPost.set(m.by, { ts: m.ts, cid, thread_id: m.thread_id })
      const h = f.held.get(mid)
      if (h) {
        add(m.by, { status: 'limited', since: h.ts, reason: `Message held · ${HOLD[h.reason] || h.reason} · ${placeName(ch, m.thread_id, names)}`, target: { channel_id: cid, thread_id: m.thread_id } })
      }
    }
  }

  // "@ not answered" and a taken @'s result come from /state `assignments` only
  // (wake.py assignment_due). An @ the lead answered with "ask" owes nothing here;
  // whether it waits on the owner is waitingOnYou's call (see `waiting` below).
  const asg = new Map()
  for (const a of state?.assignments || []) {
    asg.set(`${a.channel_id}:${a.assignment_id}`, a)
    const h = hits.has(a.owed_by) && assignmentHit(a, channels.get(a.channel_id), state, now, names, nameOf)
    if (h) add(a.owed_by, h)
  }

  // "Waiting on you" has one source: needsYou.js waitingOnYou(state), mapped by
  // waitingSource.js into `waiting`. Leads now only places each item on its lead.
  for (const w of waiting || []) {
    waitingKeys.add(w.key)
    const lead = w.lead_id || caseLead(w, folds.get(w.channel_id), asg, hits)
    if (!hits.has(lead)) continue
    const tid = w.thread_id || null
    add(lead, { status: 'waiting_you', since: w.ts ?? null,
      reason: w.channel_id ? `${w.label} · ${placeName(channels.get(w.channel_id), tid, names)}` : w.label,
      target: w.channel_id ? { channel_id: w.channel_id, thread_id: tid } : null })
  }

  const capped = state?.budget?.lead_wakes_hour
  for (const id of hits.keys()) {
    if (state?.stopped && state?.stop_reason === 'budget') {
      add(id, { status: 'limited', since: null, reason: 'Team budget used up · nobody is woken', target: null })
    }
    if (capped?.cap && (capped[id] || 0) >= capped.cap) {
      add(id, { status: 'limited', since: null, reason: `Wake cap hit · ${capped[id]}/${capped.cap} this hour`, target: null })
    }
    const lp = lastPost.get(id)
    if (lp && now - lp.ts < WORKING_POSTED_SECS) {
      add(id, { status: 'working', since: lp.ts, reason: `Posted in ${placeName(channels.get(lp.cid), lp.thread_id, names)}`, target: { channel_id: lp.cid, thread_id: lp.thread_id } })
    }
  }

  const cards = (roster || []).map((l) => {
    const list = hits.get(l.id).sort(byNeed)
    const lp = lastPost.get(l.id)
    const top = list[0] || {
      status: 'no_signal', since: null,
      reason: posts.get(l.id) ? `${plural(posts.get(l.id), 'post')}` : 'No posts yet',
      target: lp ? { channel_id: lp.cid, thread_id: lp.thread_id } : null,
    }
    const s = STATUS[top.status]
    return { id: l.id, name: l.name, project: l.project || null, legacy: !!l.legacy, remote: !!l.remote, status: top.status, label: s.label, tone: s.tone, reason: top.reason, since: top.since,
      target: top.target, more: Math.max(0, list.length - 1), posts: posts.get(l.id) || 0, lastTs: lp?.ts ?? null }
  })
  cards.sort((a, b) => byNeed(a, b) || a.name.localeCompare(b.name))
  return { waiting: waitingKeys.size, cards }
}

// Which lead's card a bar raiser case that waits on the owner goes on. This only
// places it; whether it waits is waitingOnYou's call. The case's triggers name the
// lead (the author of a held message, the lead an unanswered @ went to); else the
// last lead that posted in the case's timeline before it opened.
function caseLead(w, f, asg, hits) {
  if (!w.case || !f) return null
  for (const t of w.case.triggers || []) {
    const [kind, ref] = String(t.key || '').split(':')
    const who = kind === 'held' ? f.msgs.get(ref)?.by : kind === 'unanswered' ? asg.get(`${w.channel_id}:${ref}`)?.to : null
    if (hits.has(who)) return who
  }
  const tid = w.thread_id || null
  let last = null
  for (const m of f.msgs.values()) {
    if (m.thread_id === tid && hits.has(m.by) && m.kind !== 'system' && m.ts <= (w.ts ?? Infinity) && (!last || m.ts >= last.ts)) last = m
  }
  return last?.by || null
}

// Higher need first; within one status the older one (waiting longer) first; no ts last.
function byNeed(a, b) {
  return STATUS[a.status].rank - STATUS[b.status].rank || (a.since ?? Infinity) - (b.since ?? Infinity)
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`

/** `42` -> `<1 min`, `600` -> `10 min`, `7200` -> `2 h`, `200000` -> `2 d`. */
export function fmtAge(secs) {
  const s = Math.max(0, Math.floor(secs))
  if (s < 60) return '<1 min'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}
