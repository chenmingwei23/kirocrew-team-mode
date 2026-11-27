import { useMemo } from 'react'
import { ChevronRight, Radar } from 'lucide-react'
import { fmtClock } from './model.js'
import { fmtAge, leadsNow } from './leadsNow.js'
import { leadChatTarget, leadRoster } from './leadSource.js'
import { waitingItems } from './waitingSource.js'

/**
 * Right-rail "Leads now": one card per lead, one status each, most-needs-you first.
 * Statuses come from leadsNow.js (fixed rules over ledger rows); this only draws them.
 * `avatar(id)` draws a lead's avatar; `onOpen(channelId, threadId)` opens a place.
 */
export default function LeadsNowCard({ state, avatar, onOpen, bots = null }) {
  const now = state?.now || Date.now() / 1000
  const { waiting, cards } = useMemo(() => leadsNow(state, leadRoster(state, bots), now, waitingItems(state)), [state, bots, now])
  return (
    <div className="tm-card tm-now" data-testid="leads-now">
      <div className="tm-card-title">
        <Radar size={15} style={{ color: 'var(--accent)' }} />Leads now
        <span className="tm-spacer" />
        <span className={`tm-now-count ${waiting ? 'is-on' : ''}`} aria-live="polite">{waiting} waiting on you</span>
      </div>
      {cards.length === 0 && <div className="tm-muted">No leads yet.</div>}
      <ul className="tm-now-list">
        {cards.map((c) => {
          const target = c.target || leadChatTarget(c)
          const age = c.since != null ? fmtAge(now - c.since) : ''
          const reason = c.status === 'no_signal' && c.lastTs ? `${c.reason} · last ${fmtClock(c.lastTs)}` : c.reason
          const body = (
            <>
              {avatar(c.id)}
              <span className="tm-now-main">
                <span className="tm-now-row">
                  <b className="tm-now-name">{c.name}</b>
                  <span className={`tm-now-status ${c.tone}`}>{c.label}{age && <span className="tm-now-age"> · {age}</span>}</span>
                </span>
                {(c.project || c.legacy || c.remote) && (
                  <span className="tm-now-tags">
                    {c.project && <span className="tm-now-project" title={`Project: ${c.project}`}>{c.project}</span>}
                    {c.legacy && <span className="tm-now-project is-legacy" title="An old lead chat, not a Bot">Legacy lead</span>}
                    {c.remote && <span className="tm-now-project" title="Another owner's Bot: its own gateway wakes it">Other owner's Bot</span>}
                  </span>
                )}
                <span className="tm-now-why">{reason}{c.more > 0 && <span className="tm-muted"> · +{c.more} more</span>}</span>
              </span>
              {target && <ChevronRight size={14} className="tm-now-go" />}
            </>
          )
          return (
            <li key={c.id} className={`tm-now-item ${c.tone}`} data-status={c.status}>
              {target ? (
                <button className="tm-now-btn" onClick={() => onOpen(target.channel_id, target.thread_id)}
                  aria-label={`${c.name}${c.project ? ` (${c.project})` : ''}: ${c.label}. ${reason}. Open`}>{body}</button>
              ) : <div className="tm-now-btn is-static">{body}</div>}
            </li>
          )
        })}
      </ul>
      <div className="tm-muted tm-now-foot">Order: waiting on you › @ unanswered › held back › working › no signal. Counted from the ledger by fixed rules.</div>
    </div>
  )
}
