// The one source of "waiting on you" for Leads now: needsYou.js `waitingOnYou(state)`
// (open decisions from decisions.jsonl; answered, skipped or withdrawn ones are gone).
// Leads now never decides whether something waits; this file only turns each open
// decision into the shape leadsNow.js reads:
//   { key, lead_id, case, channel_id, thread_id, ts, label }
// `lead_id` is set for a lead's ask; a bar raiser case has none, so `case` carries the
// case row and leadsNow.js places it on a lead from the case's own triggers.

import { IMPACT_LABEL, waitingOnYou } from './needsYou.js'

const LABEL = { ...IMPACT_LABEL, ask: 'Asked you' }

export function waitingItems(state) {
  const cases = new Map((state?.cases || []).map((c) => [`case:${c.case_id}`, c]))
  return waitingOnYou(state).map((d) => ({
    key: d.key,
    lead_id: d.lead || null,
    case: d.kind === 'case' ? cases.get(d.key) || null : null,
    channel_id: d.channel_id || null,
    thread_id: d.thread_id || null,
    ts: d.opened_ts ?? null,
    label: d.kind === 'case' ? `Bar raiser asks you${LABEL[d.impact] ? ` · ${LABEL[d.impact].toLowerCase()}` : ''}`
      : d.kind === 'ask' ? LABEL.ask : d.kind === 'meeting_item' ? 'Meeting needs you' : 'Needs your decision',
  }))
}
