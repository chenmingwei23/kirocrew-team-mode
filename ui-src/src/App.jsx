import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppApi, useChatLauncher, useNavigate, useNotify } from '@kirocrew/app-sdk'
import { Btn, Badge, Input, Modal } from '@kirocrew/app-sdk/ui'
import {
  Archive, ArrowRight, ArrowUp, AtSign, Bot, Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleStop,
  ClipboardList, Cpu, FolderKanban, Gauge, Gavel, Hash, Hourglass, Inbox, Link2, ListChecks, Lock, Maximize2, Megaphone,
  MessageSquare, MessagesSquare, Minus, Moon, Network, NotebookText, Play, Plus, ScrollText, ShieldCheck,
  SlidersHorizontal, Sparkles, Table2, TriangleAlert, UserPlus, Users, Vote, X,
} from 'lucide-react'
import css from './styles.css?inline'
import LeadsNowCard from './LeadsNowCard.jsx'
import CrossOwnerView from './CrossOwnerView.jsx'
import { addBody, addBotError, addCheck, leadForBot, leadKind, removeFromTeam, teamLeadIds } from './botSource.js'
import { useBots } from './useBots.js'
import {
  MEETING_STATE, OUTCOME, OWNER, OWNER_NAME, allRelays, channelName, fmtClock, fmtTokens, foldChannel, leadIndex,
  ledgerRows, meetingRows, mergeState, openGrants, parseOwnerMentions, reasonLabel, shortHandle, splitMentions,
  threadForRoot, threadLabel, CASE_ACTION, PERSON_CLASS, caseStatus, cardAnswerBody, cardOpen, cardRows, cardVoidText, evidenceParts,
  BOTS_PAGE, ZOOM_MAX, ZOOM_MIN, clampZoom, countWorkers, expandAllKeys, fitZoom, layoutTree, loadExpanded,
  roleCardFields, saveExpanded, teamTree, visibleTree, rosterLeadSource,
} from './model.js'
import { IMPACT_LABEL, sinceYouSpoke, waitingOnYou } from './needsYou.js'
import { itemStages, meetingNeedsYou } from './meetingStage.js'
import { clickFlips, flipOnKey, messageBack } from './msgBack.js'
import { INTENT_LABEL, activeLeadCount, errText, impactLines, limitRows, limitsBody, modelRows, readableIds } from './model.js'

const BASE = '/api/apps/team-mode'
const POLL_MS = 2000

// Every place the app can only approximate what the RFC asks for gets one of these.
const APPROX = {
  wake: { label: 'wake ≤ 60 s', tip: 'Approximate: a Bot lead is woken through Kiro Crew and reads its inbox when its current turn ends; an older lead chat is woken by the 60-second script cron it set up itself.' },
  identity: { label: 'identity = session label', tip: 'Approximate: identity is the session label, not a credential. A session with a shell could get around it.' },
  relay: { label: 'self-reported', tip: 'Approximate: the app cannot read the work ledger dispatch chain; the lead reported this path itself with team_relay_note.' },
  tokens: { label: 'estimate', tip: 'Approximate: the app cannot read real token usage. Estimated at ≈ 45k per warm wake and ≈ 96k per cold wake.' },
  round: { label: 'round = between two wakes', tip: 'Approximate: the app cannot see turn boundaries, so "no answer" is counted between two wakes.' },
}

function Approx({ kind }) {
  const a = APPROX[kind]
  return <span className="tm-approx" title={a.tip} aria-label={`${a.label} (${a.tip})`}>≈ {a.label}</span>
}

function Avatar({ who, leads, size }) {
  const cls = size === 'sm' ? 'tm-av sm' : 'tm-av'
  if (who === OWNER) return <span className={`${cls} owner`} aria-hidden="true">{OWNER_NAME.slice(0, 1)}</span>
  if (String(who).startsWith('bar_raiser')) return <span className={`${cls} br`} aria-hidden="true"><ShieldCheck size={size === 'sm' ? 12 : 15} /></span>
  const lead = leads.get(who)
  const name = shortHandle(lead?.handle || who)
  return <span className={`${cls} h${(lead?.hue ?? 4) % 5}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
}

function whoName(who, leads) {
  if (who === OWNER) return OWNER_NAME
  if (String(who).startsWith('bar_raiser')) return 'Bar raiser'
  if (who === 'app') return 'Team Mode'
  if (String(who).startsWith('peer:')) return 'Other owner'
  return leads.get(who)?.handle || who
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`

// ───────────────────────────────────────────────────────────── data

function useTeamState() {
  const api = useAppApi()
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const cursorRef = useRef(null)
  const busyRef = useRef(false)

  const poll = useCallback(async (full = false) => {
    if (busyRef.current && !full) return
    busyRef.current = true
    try {
      const since = !full && cursorRef.current ? `?since=${encodeURIComponent(cursorRef.current)}` : ''
      const next = await api.get(`${BASE}/state${since}`)
      cursorRef.current = next?.cursor ?? null
      setState((prev) => (full ? mergeState(null, next) : mergeState(prev, next)))
      setError(null)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      busyRef.current = false
    }
  }, [api])

  useEffect(() => {
    poll(true)
    const id = setInterval(() => { if (!document.hidden) poll() }, POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  return { state, error, poll, api }
}

// ───────────────────────────────────────────────────────────── page

const TABS = [
  { key: 'chat', label: 'Chat', icon: MessagesSquare },
  { key: 'needs', label: 'Needs you', icon: Inbox },
  { key: 'members', label: 'Members', icon: Users },
  { key: 'cross', label: 'Across owners', icon: Link2 },
  { key: 'relay', label: 'Tree relay', icon: Network },
  { key: 'ledger', label: 'Ledger', icon: ScrollText },
]

export default function TeamModePage() {
  const { state, error, poll, api } = useTeamState()
  const notify = useNotify()
  const [tab, setTab] = useState('chat')
  const [busy, setBusy] = useState(false)

  const write = useCallback(async (fn, okText) => {
    setBusy(true)
    try {
      await fn()
      if (okText) notify?.(okText, { type: 'success' })
      await poll(true)
      return true
    } catch (e) {
      notify?.(`Failed: ${e?.message || e}`, { type: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }, [notify, poll])

  const leads = useMemo(() => leadIndex(state), [state])
  const waiting = useMemo(() => waitingOnYou(state), [state])
  const [focus, setFocus] = useState(null) // { channel_id, thread_id } for Chat to open
  const openInChat = (channel_id, thread_id) => { setFocus({ channel_id, thread_id, n: Date.now() }); setTab('chat') }
  const stopped = !!state?.stopped
  const stopWhy = state?.stop_reason && state.stop_reason !== 'owner'
    ? ` (${state.stop_reason === 'budget' ? 'budget used up' : state.stop_reason})` : ''

  return (
    <div className="tm" data-testid="team-mode-page">
      <style>{css}</style>
      <header className="tm-top">
        <div className="tm-title">
          Team Mode <Badge variant="aim">demo</Badge>
          <span className="tm-title-sub">{plural(activeLeadCount(leads), 'lead')} · data stays in this app's folder</span>
        </div>
        <div className="tm-tabs" role="tablist" aria-label="Team Mode views">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button key={key} role="tab" className="tm-tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              <Icon size={14} />{label}
              {key === 'needs' && waiting.length > 0 && <span className="tm-unread is-warn">{waiting.length}</span>}
            </button>
          ))}
        </div>
        <div className="tm-top-right">
          {waiting.length > 0 && (
            <button className="tm-waiting" onClick={() => setTab('needs')} title="Decisions only you can make. Open Needs you.">
              <Hourglass size={14} />{waiting.length} waiting on you
            </button>
          )}
          <span className="tm-live" title={error ? `Cannot read /state: ${error}` : 'Reads /state every 2 seconds'}>
            <span className={`tm-dot ${stopped ? 'is-stopped' : error ? 'is-off' : ''}`} />
            <span className="tm-live-text">{stopped ? 'Stopped' : error ? 'Backend unreachable' : 'Running'}</span>
          </span>
          {stopped ? (
            <button className="tm-resume" disabled={busy} onClick={() => write(() => api.post(`${BASE}/resume`, {}), 'Resumed')}>
              <Play size={14} />Resume
            </button>
          ) : (
            <button className="tm-stop" disabled={busy || !state} onClick={() => write(() => api.post(`${BASE}/stop`, { reason: 'owner' }), 'Emergency stop is on')}>
              <CircleStop size={15} />Emergency stop
            </button>
          )}
        </div>
      </header>

      {stopped && (
        <div className="tm-banner is-stopped" role="status">
          <CircleStop size={16} />
          <span>Emergency stop is on{stopWhy}: leads cannot post, nobody is woken, and no secretary or bar raiser starts. Press Resume to continue.</span>
        </div>
      )}
      {error && state && (
        <div className="tm-banner is-error" role="status"><TriangleAlert size={16} /><span>Cannot read the latest state; showing the last data. <span className="tm-mono tm-break">{error}</span></span></div>
      )}

      {!state ? (
        <div className="tm-empty">{error ? <>The backend did not answer: <span className="tm-mono tm-break">{error}</span><div style={{ marginTop: 10 }}><Btn onClick={() => poll(true)}>Retry</Btn></div></> : 'Loading…'}</div>
      ) : tab === 'chat' ? (
        <ChatView state={state} leads={leads} api={api} write={write} busy={busy} focus={focus} onNeeds={() => setTab('needs')} />
      ) : tab === 'needs' ? (
        <div className="tm-body is-single"><NeedsYouView state={state} leads={leads} waiting={waiting} api={api} write={write} busy={busy} onOpen={openInChat} /></div>
      ) : tab === 'members' ? (
        <div className="tm-body is-single"><MembersView state={state} leads={leads} api={api} write={write} busy={busy} /></div>
      ) : tab === 'cross' ? (
        <div className="tm-body is-single"><CrossOwnerView state={state} leads={leads} /></div>
      ) : tab === 'relay' ? (
        <div className="tm-body is-single"><RelayView state={state} leads={leads} /></div>
      ) : (
        <div className="tm-body is-single"><LedgerView state={state} /></div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────── chat

function ChatView({ state, leads, api, write, busy, focus, onNeeds }) {
  const channels = state.channels || []
  // Live Bot names and projects for Leads now; null (handles, no live project) until read.
  const { bots } = useBots(api)
  const [current, setCurrent] = useState(() => focus?.channel_id || channels.find((c) => c.kind === 'group')?.id || channels[0]?.id || null)
  const [threadId, setThreadId] = useState(null)
  // Needs you › Open in chat: land on that channel and thread.
  useEffect(() => { if (focus?.channel_id) { setCurrent(focus.channel_id); if (focus.thread_id) setTimeout(() => setThreadId(focus.thread_id), 0) } }, [focus])
  const [meetingId, setMeetingId] = useState(null)
  const [pane, setPane] = useState('chat')
  const [closing, setClosing] = useState(null)
  const channel = channels.find((c) => c.id === current) || null
  const folded = useMemo(() => foldChannel(state.entries?.[current] || []), [state.entries, current])
  const meetings = state.meetings || []
  const waiting = waitingOnYou(state)
  const meeting = meetings.find((m) => m.meeting_id === meetingId) || null
  // A meeting thread opens the meeting panel, not the plain thread drawer.
  const openThread = useCallback((tid) => {
    const th = folded.threads.get(tid)
    if (th?.mode === 'meeting' && th.meeting_id) { setThreadId(null); setMeetingId(th.meeting_id) } else { setMeetingId(null); setThreadId(tid) }
  }, [folded])
  const openMeeting = (m) => { setCurrent(m.channel_id); setTimeout(() => { setThreadId(null); setMeetingId(m.meeting_id) }, 0); setPane('chat') }

  useEffect(() => { setThreadId(null); setMeetingId((id) => (meetings.find((m) => m.meeting_id === id)?.channel_id === current ? id : null)) }, [current]) // eslint-disable-line react-hooks/exhaustive-deps
  // A channel created after the first load (or the first one) gets picked up.
  useEffect(() => { if (!current && channels.length) setCurrent(channels.find((c) => c.kind === 'group')?.id || channels[0].id) }, [current, channels])

  const groups = channels.filter((c) => c.kind === 'group')
  const dms = channels.filter((c) => c.kind === 'dm')
  const sideCount = waiting.filter((d) => d.kind === 'case').length

  return (
    <>
      <div className="tm-narrow-switch">
        <div className="tm-tabs" role="tablist" aria-label="Switch panel" style={{ width: '100%' }}>
          <button role="tab" className="tm-tab" aria-selected={pane === 'chat'} onClick={() => setPane('chat')}><MessageSquare size={14} />Chat</button>
          <button role="tab" className="tm-tab" aria-selected={pane === 'side'} onClick={() => setPane('side')}>
            <Sparkles size={14} />Briefs · Cases · Budget{sideCount > 0 && <span className="tm-unread" style={{ marginLeft: 4 }}>{sideCount}</span>}
          </button>
        </div>
      </div>
      <div className="tm-body" data-pane={pane}>
        <nav className="tm-rail" aria-label="Groups and direct messages">
          <div className="tm-sec">Groups</div>
          {groups.map((c) => <ChannelRow key={c.id} ch={c} leads={leads} active={c.id === current} onClick={() => { setCurrent(c.id); setPane('chat') }} />)}
          {meetings.length > 0 && <div className="tm-sec">Meetings</div>}
          {[...meetings].sort((a, b) => (b.state === 'open') - (a.state === 'open') || b.root_seq - a.root_seq).map((m) => (
            <MeetingRow key={m.meeting_id} m={m} waiting={waiting} leads={leads} channels={channels} active={m.meeting_id === meetingId} onClick={() => openMeeting(m)} />
          ))}
          <div className="tm-sec">Direct messages</div>
          {dms.map((c) => <ChannelRow key={c.id} ch={c} leads={leads} active={c.id === current} onClick={() => { setCurrent(c.id); setPane('chat') }} />)}
          {channels.length === 0 && <div className="tm-empty">No groups yet. Create one under Members.</div>}
        </nav>

        <section className="tm-center" aria-label="Conversation">
          {channel ? (
            <>
              <ChannelHeader ch={channel} leads={leads} onCloseGroup={() => setClosing(channel.id)} />
              <Conversation folded={folded} channel={channel} leads={leads} meetings={meetings} briefs={state.briefs} decisions={state.decisions} onOpenThread={openThread} />
              <Composer channel={channel} leads={leads} threadId={null} disabled={busy || state.stopped || channel.closed}
                stopped={state.stopped}
                onSend={(body) => write(() => api.post(`${BASE}/messages`, body))} />
              {closing === channel.id && (
                <CloseGroupDialog ch={channel} busy={busy} onClose={() => setClosing(null)}
                  onConfirm={() => write(() => api.post(`${BASE}/groups/${encodeURIComponent(channel.id)}/close`, {}), `#${channel.title} closed`).then((ok) => { if (ok) setClosing(null) })} />
              )}
            </>
          ) : <div className="tm-empty">Pick a group or a direct message.</div>}
        </section>
        {channel && meeting && meeting.channel_id === channel.id && (
          <MeetingDrawer m={meeting} state={state} channel={channel} leads={leads} busy={busy}
            onClose={() => setMeetingId(null)} disabled={busy || state.stopped} stopped={state.stopped}
            onSend={(body) => write(() => api.post(`${BASE}/messages`, body))}
            onAdjourn={() => write(() => api.post(`${BASE}/meetings/${encodeURIComponent(meeting.meeting_id)}/adjourn`, { reason: 'owner' }), 'Meeting adjourned')} />
        )}
        {channel && threadId && (
          <ThreadDrawer folded={folded} threadId={threadId} channel={channel} leads={leads} briefs={state.briefs}
            onClose={() => setThreadId(null)} disabled={busy || state.stopped} stopped={state.stopped}
            onSend={(body) => write(() => api.post(`${BASE}/messages`, body))} />
        )}

        <aside className="tm-side" aria-label="Leads now, room memory, secretary briefs, bar raiser and budget">
          <LeadsNowCard state={state} bots={bots} avatar={(id) => <Avatar who={id} leads={leads} size="sm" />}
            onOpen={(cid, tid) => {
              const mt = tid && meetings.find((m) => m.channel_id === cid && m.thread_id === tid)
              setCurrent(cid); setPane('chat')
              setTimeout(() => { setMeetingId(mt ? mt.meeting_id : null); setThreadId(mt ? null : tid || null) }, 0)
            }} />
          {channel?.kind === 'group' && <RoomMemoryCard memory={state.memory?.[channel.id]} />}
          <BriefCard state={state} leads={leads} />
          <CasesCard state={state} leads={leads} onNeeds={onNeeds}
            onOpen={(cid, tid) => { setCurrent(cid); if (tid) setTimeout(() => setThreadId(tid), 0); setPane('chat') }} />
          <BudgetCard state={state} leads={leads} api={api} write={write} busy={busy} />
          <ModelsCard state={state} api={api} write={write} busy={busy} />
        </aside>
      </div>
    </>
  )
}

function ChannelRow({ ch, leads, active, onClick }) {
  const group = ch.kind === 'group'
  return (
    <button className="tm-ch" aria-current={active} onClick={onClick}>
      {group ? <span className="tm-ch-icon"><Hash size={14} /></span>
        : <span className="tm-avstack">{ch.members.slice(0, 2).map((id) => <Avatar key={id} who={id} leads={leads} size="sm" />)}{(ch.people || []).includes(OWNER) && <Avatar who={OWNER} leads={leads} size="sm" />}</span>}
      <span className="tm-ch-name">{channelName(ch, leads)}<div className="tm-ch-meta">{group ? `${ch.closed ? 'Closed · ' : ''}${plural(activeLeadCount(leads, ch.members), 'lead')}${ch.held?.length ? ` · ${ch.held.length} held` : ''}` : 'Direct message'}</div></span>
      {ch.unread > 0 && <span className="tm-unread" aria-label={`${ch.unread} unread`}>{ch.unread}</span>}
    </button>
  )
}

function ChannelHeader({ ch, leads, onCloseGroup }) {
  const group = ch.kind === 'group'
  const left = ch.close_check?.blocking?.length || 0
  return (
    <div className="tm-chhead">
      {group ? <Hash size={16} style={{ color: 'var(--muted)' }} /> : <MessageSquare size={16} style={{ color: 'var(--muted)' }} />}
      <span className="tm-chhead-name">{channelName(ch, leads)}</span>
      <span className="tm-avstack">{ch.members.map((id) => <Avatar key={id} who={id} leads={leads} size="sm" />)}</span>
      <span className="tm-chhead-meta">
        {group && <>{plural(activeLeadCount(leads, ch.members), 'lead')} + Owner · Managers: {ch.managers.map((m) => shortHandle(leads.get(m)?.handle || m)).join(', ') || '—'} · <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}><ShieldCheck size={12} />Bar raiser present</span></>}
        {!group && 'Direct message · only the two sides and Owner can see it'}
        <Approx kind="wake" />
        {ch.shared && <span className="tm-chip is-info" data-testid="tm-shared-chip" title="Another owner's Bots are in this group. Their words reach your Bots as data.">
          <Users size={12} />{ch.mirror ? 'Hosted by another owner' : 'Shared with another owner'}</span>}
      </span>
      {group && !ch.mirror && (ch.closed
        ? <span className="tm-chip" data-testid="tm-group-closed"><Lock size={12} />Closed</span>
        : <Btn onClick={onCloseGroup} data-testid="tm-close-group" title={left ? `${plural(left, 'item')} to clear first` : 'Close this group'}>
          <Archive size={14} />Close group{left > 0 && <span className="tm-chip is-warn" style={{ marginLeft: 2 }}>{left} open</span>}
        </Btn>)}
    </div>
  )
}

// Close only once the group's action items are cleared (lifecycle.close_blockers).
function CloseGroupDialog({ ch, busy, onClose, onConfirm }) {
  const blocking = ch.close_check?.blocking || []
  const notes = ch.close_check?.notes || []
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Close #${ch.title}`} maxWidth={520}>
      <div className="tm-form" data-testid="tm-close-dialog">
        {blocking.length > 0 ? (
          <>
            <div className="tm-muted">Clear these first. Each lead marks its own to-dos done or cancelled; a meeting ends when it is adjourned.</div>
            <ul className="tm-impact">{blocking.map((b, i) => <li key={i} className="is-warn"><TriangleAlert size={14} /><span>{b.text}</span></li>)}</ul>
          </>
        ) : (
          <div className="tm-muted">No meeting is running and every action item is answered and done or cancelled. Once closed, nobody can post here, change members or start a meeting. The history stays.</div>
        )}
        {notes.length > 0 && (
          <>
            <div className="tm-label" style={{ marginTop: 4 }}>Will be left as they are</div>
            <ul className="tm-impact">{notes.map((n, i) => <li key={i}><span>{n.text}</span></li>)}</ul>
          </>
        )}
        <div className="tm-dialog-actions">
          <Btn type="button" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn danger type="button" disabled={busy || blocking.length > 0} onClick={onConfirm} data-testid="tm-close-confirm">Close group</Btn>
        </div>
      </div>
    </Modal>
  )
}

function MessageText({ text, leads }) {
  const handles = useMemo(() => new Set([...leads.values()].map((l) => l.handle)), [leads])
  return <>{splitMentions(text, handles).map((p, i) => p.mention ? <span key={i} className="tm-mention">{p.text}</span> : <span key={i}>{p.text}</span>)}</>
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const FLIP_HALF_MS = 160

// A message card: the front shows name, time and body; a click, Enter or Space turns
// it over to the back (msgBack.js:messageBack). The face swaps at the half turn, so
// each face keeps its own height; with reduced motion it swaps at once.
function FlipCard({ who, front, back }) {
  const [flipped, setFlipped] = useState(false)
  const [turning, setTurning] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const flip = () => {
    if (turning) return
    if (reducedMotion()) { setFlipped((f) => !f); return }
    setTurning(true)
    timer.current = setTimeout(() => { setFlipped((f) => !f); timer.current = setTimeout(() => setTurning(false), FLIP_HALF_MS) }, FLIP_HALF_MS)
  }
  return (
    <div className={`tm-flip ${turning ? 'is-turning' : ''} ${flipped ? 'is-back' : ''}`} role="button" tabIndex={0}
      aria-pressed={flipped} aria-label={flipped ? `Details of the message from ${who}. Press to show the message.` : `Message from ${who}. Press for details.`}
      data-testid="tm-msg-card" data-side={flipped ? 'back' : 'front'}
      onClick={(e) => { if (clickFlips(e.target, window.getSelection?.()?.toString() || '')) flip() }}
      onKeyDown={(e) => { if (e.target === e.currentTarget && flipOnKey(e.key)) { e.preventDefault(); flip() } }}>
      {flipped ? back : front}
    </div>
  )
}

function Message({ m, folded, leads, onOpenThread, inThread, meetings, briefs, channelId, dm, decisions }) {
  if (m.kind === 'system') {
    return (
      <div className="tm-sys" role="note">
        <ShieldCheck size={15} className="tm-sys-icon" />
        <div style={{ minWidth: 0 }}><b style={{ color: 'var(--aim)' }}>{String(m.rawBy || '').startsWith('bar_raiser') || m.case_id ? 'Bar raiser' : 'Team Mode'}</b> · {fmtClock(m.ts)}<div className="tm-break"><MessageText text={m.text} leads={leads} /></div></div>
      </div>
    )
  }
  if (m.kind === 'minutes') {
    const mt = (meetings || []).find((x) => x.meeting_id === m.minutes_of)
    return (
      <div className="tm-minutes-post" role="note">
        <div className="tm-minutes-head"><NotebookText size={15} /><b>Minutes{mt ? ` · ${mt.title}` : ''}</b><span className="tm-muted">{fmtClock(m.ts)}</span><span className="tm-spacer" />
          {mt && <button className="tm-stub" style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => onOpenThread(mt.thread_id)}>Open meeting<ChevronRight size={12} /></button>}</div>
        <div className="tm-minutes-text tm-break">{m.text}</div>
      </div>
    )
  }
  const owner = m.by === OWNER
  const thread = !inThread && !m.thread_id ? threadForRoot(folded, m.seq) : null
  const replyTo = m.reply_to ? folded.bySeq.get(m.reply_to) : null
  const who = whoName(m.by, leads)
  const head = <div className="tm-msg-head"><span className="tm-msg-who">{who}</span><span>{fmtClock(m.ts)}</span></div>
  const rows = messageBack(m, { leads, channelId, briefs, replyTo, everyoneCount: m.everyoneCount, dm, decisions })
  return (
    <div className={`tm-msg ${owner ? 'is-owner' : ''} ${m.held ? 'is-held' : ''}`}>
      <Avatar who={m.by} leads={leads} />
      <div className="tm-msg-body">
        <FlipCard who={who}
          front={<>{head}<div className="tm-bubble"><MessageText text={m.text} leads={leads} /></div></>}
          back={<>{head}<dl className="tm-msg-back" data-testid="tm-msg-back">{rows.map((r, i) => <Fragment key={i}><dt>{r.label}</dt><dd className="tm-break">{r.value}</dd></Fragment>)}</dl></>} />
        {thread && <div className="tm-chips">
          {thread && thread.mode === 'meeting' && (() => {
            const mt = (meetings || []).find((x) => x.meeting_id === thread.meeting_id)
            const [label, cls] = MEETING_STATE[mt?.state] || MEETING_STATE.convening
            return (
              <button className="tm-stub is-meeting" onClick={() => onOpenThread(thread.thread_id)}>
                <Gavel size={13} /><b>Meeting</b><span className={`tm-chip ${cls}`} style={{ padding: '0 6px' }}>{label}</span>
                {mt && <span className="tm-muted">{plural(mt.agenda.length, 'item')} · turns {mt.turns_used}/{mt.budgets.turns}</span>}
                <span className="tm-muted">Open meeting</span><ChevronRight size={14} />
              </button>
            )
          })()}
          {thread && thread.mode !== 'meeting' && (
            <button className="tm-stub" onClick={() => onOpenThread(thread.thread_id)}>
              <span className="tm-avstack">{thread.participants.slice(0, 3).map((id) => <Avatar key={id} who={id} leads={leads} size="sm" />)}</span>
              <b>{plural(thread.count, 'reply', 'replies')}</b>
              {thread.replies.some((r) => r.held) && <span className="tm-chip is-warn" style={{ padding: '0 6px' }}><Lock size={11} />{thread.replies.filter((r) => r.held).length} held</span>}
              <span className="tm-muted">Open thread</span><ChevronRight size={14} />
            </button>
          )}
        </div>}
      </div>
    </div>
  )
}

function Conversation({ folded, channel, leads, meetings, briefs, decisions, onOpenThread }) {
  const ref = useRef(null)
  const count = folded.main.length
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }, [count, channel.id])
  const n = activeLeadCount(leads, channel.members)
  return (
    <div className="tm-scroll" ref={ref}>
      <div className="tm-daysep">{channel.kind === 'group' ? `#${channelName(channel, leads)} · ${plural(n, 'lead')} + Owner · @ = assign, must answer · @everyone = wake everyone` : 'Start of direct message'}</div>
      {folded.main.length === 0 && <div className="tm-empty">No messages yet.</div>}
      {folded.main.map((m) => <Message key={m.seq} m={{ ...m, everyoneCount: m.everyone ? plural(n, 'lead') : '' }} folded={folded} leads={leads} meetings={meetings} briefs={briefs} decisions={decisions} dm={channel.kind === 'dm'} channelId={channel.id} onOpenThread={onOpenThread} />)}
    </div>
  )
}

function ThreadDrawer({ folded, threadId, channel, leads, briefs, onClose, onSend, disabled, stopped }) {
  const th = folded.threads.get(threadId)
  const root = th && folded.bySeq.get(th.root_seq)
  if (!th) return null
  return (
    <div className="tm-drawer" role="dialog" aria-label="Thread" data-testid="tm-thread-drawer">
      <div className="tm-drawer-head">
        <MessagesSquare size={16} style={{ color: 'var(--muted)' }} />
        <b style={{ color: 'var(--text-strong)' }}>Thread</b>
        <span className="tm-avstack" style={{ marginLeft: 6 }}>{th.participants.map((id) => <Avatar key={id} who={id} leads={leads} size="sm" />)}</span>
        <button className="tm-icobtn" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close thread"><X size={16} /></button>
      </div>
      {root && <div className="tm-drawer-root"><Message m={root} folded={folded} leads={leads} briefs={briefs} channelId={channel.id} inThread onOpenThread={() => {}} /></div>}
      <div className="tm-scroll">
        <div className="tm-daysep">{plural(th.count, 'reply', 'replies')} · only participants and Owner can see this · an @ here pulls that lead in</div>
        {th.replies.map((m) => <Message key={m.seq} m={m} folded={folded} leads={leads} briefs={briefs} channelId={channel.id} inThread onOpenThread={() => {}} />)}
      </div>
      <Composer channel={channel} leads={leads} threadId={threadId} onSend={onSend} disabled={disabled} stopped={stopped} />
    </div>
  )
}

function Composer({ channel, leads, threadId, onSend, disabled, stopped, meeting }) {
  const [text, setText] = useState('')
  const [pop, setPop] = useState(null) // { query, start }
  const [hi, setHi] = useState(0)
  const taRef = useRef(null)
  const options = useMemo(() => {
    if (!pop) return []
    const members = channel.members.map((id) => leads.get(id)).filter(Boolean)
    const all = [...members.map((l) => ({ handle: l.handle, id: l.lead_id, note: 'assign · must answer' }))]
    if (channel.kind === 'group' && !threadId) all.push({ handle: 'everyone', id: 'everyone', note: 'broadcast · wakes all' })
    const q = pop.query.toLowerCase()
    return all.filter((o) => o.handle.toLowerCase().includes(q))
  }, [pop, channel, leads, threadId])

  const onChange = (e) => {
    const v = e.target.value
    setText(v)
    const caret = e.target.selectionStart ?? v.length
    const m = /@([\w.-]*)$/.exec(v.slice(0, caret))
    setPop(m ? { query: m[1], start: caret - m[0].length } : null)
    setHi(0)
  }
  const pick = (o) => {
    const caret = taRef.current?.selectionStart ?? text.length
    const next = `${text.slice(0, pop.start)}@${o.handle} ${text.slice(caret)}`
    setText(next)
    setPop(null)
    taRef.current?.focus()
  }
  const send = async () => {
    const body = text.trim()
    if (!body || disabled) return
    const { mentions, everyone } = parseOwnerMentions(body, leads)
    const payload = { thread: threadId || 'main', text: body, mentions, cc: [], everyone }
    if (channel.kind === 'dm' && !(channel.people || []).includes(OWNER)) payload.to = channel.members[0]
    payload.channel_id = channel.id
    const ok = await onSend(payload)
    if (ok) setText('')
  }
  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return
    if (pop && options.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi((hi + 1) % options.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi((hi - 1 + options.length) % options.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[hi]); return }
      if (e.key === 'Escape') { setPop(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }
  const { mentions, everyone } = parseOwnerMentions(text, leads)
  return (
    <div className="tm-composer">
      <div className="tm-composer-target">
        <span>Posting as Owner to <b style={{ color: 'var(--text)' }}>{meeting ? 'the meeting' : threadId ? 'the thread' : channel.kind === 'group' ? 'main' : 'direct message'}</b></span>
        <span>{meeting ? '· gives the current item one extra round; an @ names the next speakers' : '· your post resets the hop count'}</span>
        {mentions.length > 0 && <span className="tm-chip is-assign"><AtSign size={12} />{meeting ? 'Speaks next' : 'Assigns'} {mentions.map((id) => shortHandle(leads.get(id)?.handle)).join(', ')}</span>}
        {everyone && <span className="tm-chip is-info"><Megaphone size={12} />Broadcast</span>}
      </div>
      {pop && options.length > 0 && (
        <div className="tm-pop" role="listbox" aria-label="Mention a lead">
          {options.map((o, i) => (
            <button key={o.id} role="option" aria-selected={i === hi} className="tm-pop-item" onMouseDown={(e) => { e.preventDefault(); pick(o) }}>
              {o.id === 'everyone' ? <span className="tm-av sm owner"><Megaphone size={11} /></span> : <Avatar who={o.id} leads={leads} size="sm" />}
              <span className="tm-pop-handle">@{o.handle}</span><small>{o.note}</small>
            </button>
          ))}
        </div>
      )}
      <div className="tm-composer-box">
        <button className="tm-icobtn" aria-label="Insert @" onClick={() => { setText((t) => `${t}@`); setPop({ query: '', start: text.length }); taRef.current?.focus() }}><AtSign size={16} /></button>
        <textarea ref={taRef} className="tm-textarea" rows={1} value={text} onChange={onChange} onKeyDown={onKeyDown}
          placeholder={channel.closed ? 'This group is closed.' : stopped ? 'Emergency stop is on. Resume to post.' : meeting ? 'Speak in the meeting as Owner…' : threadId ? 'Reply in the thread; an @ pulls a lead in…' : channel.kind === 'group' ? 'Post to main; @ someone to assign…' : 'Direct message…'}
          disabled={disabled} aria-label="Message" />
        <button className="tm-send" onClick={send} disabled={disabled || !text.trim()} aria-label="Send"><ArrowUp size={16} /></button>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────── meetings

const STANCE = { propose: ['Proposes', 'is-assign'], agree: ['Agrees', 'is-ok'], object: ['Objects', 'is-err'], info: ['Info', 'is-info'], pass: ['Pass', ''] }
const ACTION_ITEM = { proposed: ['Waiting for the owner to accept', 'is-info'], accepted: ['Accepted · in the owner\'s to-dos', 'is-ok'], declined: ['Declined', 'is-err'], unowned: ['Unowned', 'is-warn'] }
const ADJOURN = { agenda_done: 'agenda done', turn_budget: 'turn budget used up', time_budget: 'time budget used up', owner: 'Owner adjourned' }

function mName(m, who, leads) {
  if (who === OWNER) return OWNER_NAME
  if (who === 'none') return 'none'
  return shortHandle(leads.get(who)?.handle || m.names?.[who] || who)
}

function MeetingRow({ m, waiting, leads, channels, active, onClick }) {
  const [label, cls] = MEETING_STATE[m.state] || MEETING_STATE.convening
  const ch = channels.find((c) => c.id === m.channel_id)
  const cur = m.agenda.findIndex((a) => a.item_id === m.current)
  const needs = meetingNeedsYou(m, waiting).length
  return (
    <button className="tm-ch" aria-current={active} onClick={onClick}>
      <span className="tm-avstack">{m.speakers.slice(0, 3).map((id) => <Avatar key={id} who={id} leads={leads} size="sm" />)}</span>
      <span className="tm-ch-name">{m.title}
        <div className="tm-ch-meta"><span className={`tm-chip ${cls}`} style={{ padding: '0 6px', fontSize: 11 }}>{label}</span>{needs > 0 && <span className="tm-chip is-err" style={{ padding: '0 6px', fontSize: 11, marginLeft: 4 }}>Needs you</span>} #{channelName(ch, leads)}{cur >= 0 ? ` · item ${cur + 1}/${m.agenda.length}` : ''}</div>
      </span>
      {m.state === 'open' && <span className="tm-live-dot" aria-label="in session" />}
    </button>
  )
}

function MeetingDrawer({ m, state, channel, leads, onClose, onSend, onAdjourn, disabled, stopped, busy }) {
  const [tab, setTab] = useState('agenda')
  const [label, cls] = MEETING_STATE[m.state] || MEETING_STATE.convening
  const live = ['convening', 'open', 'adjourning'].includes(m.state)
  const cur = m.agenda.find((a) => a.item_id === m.current)
  const closed = m.agenda.filter((a) => a.state === 'closed').length
  const br = m.bar_raiser || {}
  const brCase = (state.cases || []).filter((c) => c.channel_id === m.channel_id && c.thread_id === m.thread_id)
  const brKeys = new Set(brCase.map((c) => `case:${c.case_id}`))
  const waitingYou = waitingOnYou(state).some((d) => brKeys.has(d.key))
  const brText = waitingYou ? ['Waiting for your answer', 'is-err'] : br.pending ? ['Reviewing an item', 'is-info'] : br.waiting_person ? ['Waiting for a person', 'is-warn'] : ['Standing by', '']
  const TABS_M = [['agenda', 'Agenda', ListChecks], ['minutes', 'Minutes', NotebookText], ['actions', 'Action items', ClipboardList], ['ledger', 'Ledger', ScrollText]]
  return (
    <div className="tm-drawer tm-mdrawer" role="dialog" aria-label={`meeting ${m.title}`} data-testid="meeting-panel">
      <div className="tm-drawer-head">
        <Gavel size={16} style={{ color: 'var(--accent)' }} />
        <b className="tm-ellipsis" style={{ color: 'var(--text-strong)' }}>{m.title}</b>
        <span className={`tm-chip ${cls}`}>{label}</span>
        <span className="tm-spacer" style={{ flex: 1 }} />
        {live && m.state !== 'adjourning' && <Btn danger disabled={busy} onClick={onAdjourn}>Adjourn</Btn>}
        <button className="tm-icobtn" onClick={onClose} aria-label="Close meeting"><X size={16} /></button>
      </div>
      <div className="tm-mhead">
        {m.purpose && <div className="tm-muted tm-break" style={{ marginBottom: 6 }}>{m.purpose}</div>}
        <div className="tm-mpeople">
          {m.speakers.map((id) => (
            <span key={id} className="tm-mperson"><Avatar who={id} leads={leads} size="sm" />{mName(m, id, leads)}
              {id === m.convener && <span className="tm-role">convener</span>}{id === m.chair && <span className="tm-role">chair</span>}</span>
          ))}
          {Object.entries(m.invitees || {}).filter(([, i]) => i.state !== 'accepted').map(([id, i]) => (
            <span key={id} className="tm-mperson is-dim" title={i.note || ''}><Avatar who={id} leads={leads} size="sm" />{mName(m, id, leads)}<span className="tm-role">{i.state === 'invited' ? 'invited' : 'declined'}</span></span>
          ))}
          <span className="tm-mperson"><span className="tm-av sm br" aria-hidden="true"><ShieldCheck size={12} /></span>Bar raiser<span className={`tm-chip ${brText[1]}`} style={{ padding: '0 6px' }}>{brText[0]}</span><span className="tm-mono tm-muted">{br.cases ?? 0}/{br.cap ?? 6}</span></span>
        </div>
        <div className="tm-mbudget">
          <Meter label="Turns" used={m.turns_used} cap={m.budgets.turns} />
          <Meter label="Minutes open" used={Math.floor((m.elapsed_secs || 0) / 60)} cap={m.budgets.minutes} />
          <Meter label="Items closed" used={closed} cap={m.agenda.length} fullOk />
          <Meter label={cur ? `Round · ${cur.title}` : 'Round'} used={cur?.round || 0} cap={cur ? m.budgets.rounds + (cur.extra_rounds || 0) : m.budgets.rounds} />
        </div>
      </div>
      <div className="tm-tabs tm-mtabs" role="tablist" aria-label="Meeting views">
        {TABS_M.map(([k, l, Icon]) => <button key={k} role="tab" className="tm-tab" aria-selected={tab === k} onClick={() => setTab(k)}><Icon size={14} />{l}{k === 'actions' && m.actions.length > 0 && <span className="tm-muted">{m.actions.length}</span>}</button>)}
      </div>
      <div className="tm-scroll tm-mbody">
        {tab === 'agenda' && <AgendaTab m={m} leads={leads} waiting={waitingOnYou(state)} />}
        {tab === 'minutes' && <MinutesTab m={m} leads={leads} />}
        {tab === 'actions' && <ActionsTab m={m} leads={leads} />}
        {tab === 'ledger' && <MeetingLedger rows={meetingRows(state.entries?.[m.channel_id], m.meeting_id)} />}
      </div>
      {live && <Composer channel={channel} leads={leads} threadId={m.thread_id} onSend={onSend} disabled={disabled} stopped={stopped} meeting />}
    </div>
  )
}

function AgendaTab({ m, leads, waiting }) {
  if (m.state === 'convening') {
    const wait = Object.entries(m.invitees || {}).filter(([, i]) => i.state === 'invited').map(([id]) => mName(m, id, leads))
    return <div className="tm-muted tm-mnote"><Hourglass size={14} />Waiting for answers{wait.length ? ` from ${wait.join(', ')}` : ''} · opens with 2 or more speakers · answer by {fmtClock(m.respond_by)}</div>
  }
  return (
    <>
      {m.state === 'cancelled' && <div className="tm-muted tm-mnote">Cancelled: {m.cancel_reason === 'quorum' ? 'fewer than 2 speakers accepted' : m.cancel_reason}</div>}
      {m.adjourn_reason && <div className="tm-muted tm-mnote">Adjourned · {ADJOURN[m.adjourn_reason] || m.adjourn_reason}</div>}
      <ol className="tm-agenda">
        {m.agenda.map((a, i) => <AgendaItem key={a.item_id} a={a} n={i + 1} m={m} leads={leads} waiting={waiting} />)}
      </ol>
    </>
  )
}

function AgendaItem({ a, n, m, leads, waiting }) {
  const current = a.item_id === m.current
  const [open, setOpen] = useState(current)
  useEffect(() => { if (current) setOpen(true) }, [current])
  const out = a.outcome && (OUTCOME[a.outcome.kind] || [a.outcome.kind, ''])
  const badge = a.state === 'closed' ? 'done' : current ? (a.waiting || a.br_needed?.length ? 'wait' : 'cur') : ''
  const grants = openGrants(a)
  const rd = a.rounds?.[String(a.round)]
  const sealed = rd?.sealed && !rd?.revealed
  const ballots = Object.values(a.ballots || {})
  const proposals = Object.values(a.proposals || {})
  const stages = itemStages(a, m, (w) => mName(m, w, leads), waiting)
  return (
    <li className={`tm-agenda-item ${current ? 'is-current' : ''} ${stages.needsYou ? 'is-needs' : ''}`} data-testid="agenda-item">
      <button className="tm-agenda-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`tm-agenda-n ${badge}`}>{a.state === 'closed' ? <Check size={13} /> : n}</span>
        <span style={{ minWidth: 0, flex: 1 }}><b className="tm-break">{a.title}</b>{a.question && <small className="tm-break">{a.question}</small>}</span>
        {stages.needsYou ? <span className="tm-chip is-err">Needs you</span> : out ? <span className={`tm-chip ${out[1]}`}>{out[0]}</span> : current ? <span className="tm-chip is-assign">Round {a.round}/{m.budgets.rounds + (a.extra_rounds || 0)}</span> : <span className="tm-muted">pending</span>}
      </button>
      <StageBar stages={stages} />
      {open && (
        <div className="tm-agenda-body">
          {a.outcome && (
            <div className="tm-outcome">
              <b>{out[0]}:</b> <span className="tm-break">{readableIds(a.outcome.text, a.item_id, m.refs)}</span>
              {a.outcome.rationale && <div className="tm-muted tm-break">Rationale: {readableIds(a.outcome.rationale, a.item_id, m.refs)}</div>}
              <div className="tm-muted">recorded by {a.outcome.by === 'planner' ? 'the server' : a.outcome.by === 'bar_raiser' ? 'the bar raiser' : a.outcome.by}</div>
            </div>
          )}
          {current && grants.length > 0 && (
            <div className="tm-case-row"><Hourglass size={13} className="tm-muted" /><span className="tm-muted">Floor:</span>
              {grants.map((g) => <span key={g.turn_id} className="tm-chip is-info">{mName(m, g.speaker, leads)} · {g.sealed ? 'sealed · ' : ''}until {fmtClock(g.expires_at)}</span>)}</div>
          )}
          {current && sealed && <div className="tm-muted tm-mnote"><Lock size={13} />Round 1 is sealed: speakers see the presentation, not each other, until everyone has spoken.</div>}
          {current && a.waiting && <div className="tm-chip is-warn is-wrap" style={{ marginTop: 6 }}>Waiting for a person{a.waiting.question ? `: ${a.waiting.question}` : ''} · speak below to answer</div>}
          {current && a.br_needed?.length > 0 && <div className="tm-chip is-info is-wrap" style={{ marginTop: 6 }}><ShieldCheck size={12} />Bar raiser called: {TRIGGER[`meeting_${a.br_needed[0].trigger}`] || a.br_needed[0].trigger}</div>}
          {proposals.length > 0 && (
            <div className="tm-proposals">
              {proposals.map((p) => {
                const st = stanceOf(a, m.speakers, p.proposal_id)
                return (
                  <div key={p.proposal_id} className={`tm-proposal ${a.outcome?.proposal_id === p.proposal_id ? 'is-win' : ''}`}>
                    <div className="tm-case-row"><span className="tm-muted">Proposal {pNum(a, p.proposal_id)}</span><b>{mName(m, p.by, leads)}</b>
                      <span className="tm-chip is-ok">{st.agree.length} agree</span><span className={`tm-chip ${st.object.length ? 'is-err' : ''}`}>{st.object.length} object</span></div>
                    <div className="tm-break">{p.text}</div>
                  </div>
                )
              })}
            </div>
          )}
          {ballots.map((b) => (
            <div key={b.ballot_id} className="tm-ballot">
              <div className="tm-case-row"><Vote size={13} /><b>Ballot</b><span className="tm-muted">{b.state === 'open' ? `sealed to voters until it closes · ${Object.keys(b.votes).length}/${m.speakers.length} voted` : b.tie?.length ? `tie: ${b.tie.join(', ')}` : b.winner ? `winner: ${b.winner}` : 'closed'}</span></div>
              <div className="tm-chips">{b.options.map((o) => <span key={o} className={`tm-chip ${b.winner === o ? 'is-ok' : ''}`}>{o}{b.tally ? ` · ${b.tally[o] ?? 0}` : ''}</span>)}</div>
              {Object.entries(b.votes || {}).map(([w, v]) => <div key={w} className="tm-muted tm-break">{mName(m, w, leads)} → <b>{v.choice}</b>: {readableIds(v.reason, a.item_id, m.refs)}</div>)}
            </div>
          ))}
          {(a.speeches || []).length > 0 && (
            <div className="tm-speeches">
              {a.speeches.map((s) => {
                const [sl, sc] = STANCE[s.stance] || [s.stance, '']
                return (
                  <div key={s.seq} className="tm-speech">
                    <Avatar who={s.by} leads={leads} size="sm" />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="tm-msg-head"><span className="tm-msg-who">{mName(m, s.by, leads)}</span><span className={`tm-chip ${sc}`} style={{ padding: '0 6px' }}>{sl}{s.proposal_id && pNum(a, s.proposal_id) ? ` proposal ${pNum(a, s.proposal_id)}` : ''}</span><span className="tm-muted">round {s.round}{s.sealed_key ? ' · sealed' : ''} · {fmtClock(s.ts)}</span></div>
                      <div className="tm-break">{readableIds(s.text, a.item_id, m.refs)}</div>
                      {s.evidence?.length > 0 && <div className="tm-muted tm-break">Evidence: {s.evidence.join(' · ')}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {(a.person || []).map((p) => <div key={p.seq} className="tm-speech is-owner"><Avatar who={OWNER} leads={leads} size="sm" /><div className="tm-break"><b>{OWNER_NAME}</b> · {p.text}</div></div>)}
        </div>
      )}
    </li>
  )
}

// Stages come from meetingStage.js (fixed rules over the meeting fold), never from a model.
function StageBar({ stages }) {
  return (
    <ol className="tm-stages" aria-label="Item stage">
      {stages.steps.map((s) => {
        const needs = s.state === 'current' && s.note === 'Needs you'
        return (
          <li key={s.key} className={`tm-stage is-${s.state} ${needs ? 'is-needs' : ''}`} aria-current={s.state === 'current' ? 'step' : undefined}
            title={s.state === 'skipped' ? `${s.label}: none` : s.label}>
            <span className="tm-stage-label">{needs ? 'Needs you' : s.label}</span>
            {s.note && !needs && <span className="tm-stage-note">{s.note}</span>}
          </li>
        )
      })}
    </ol>
  )
}

// People see "Proposal 2" / "item 1", never the server's proposal or item ids.
const pNum = (a, pid) => Object.keys(a.proposals || {}).indexOf(pid) + 1 || null
const itemNum = (m, iid) => m.agenda.findIndex((x) => x.item_id === iid) + 1 || null

function stanceOf(a, speakers, pid) {
  const agree = []; const object = []
  for (const s of speakers) {
    const l = a.latest?.[s]
    if (l && l[1] === pid) (l[0] === 'object' ? object : agree).push(s)
  }
  return { agree, object }
}

function MinutesTab({ m, leads }) {
  const mn = m.minutes
  if (!mn) return <div className="tm-muted tm-mnote"><NotebookText size={14} />The server writes the minutes from the ledger when the meeting adjourns. No bot writes them.</div>
  const names = (ws) => (ws || []).map((w) => mName(m, w, leads)).join(', ') || 'none'
  return (
    <div className="tm-minutes">
      <h4><NotebookText size={14} />Minutes · {mn.title}</h4>
      <div className="tm-muted">Convener {mName(m, mn.convener, leads)} · chair {mName(m, mn.chair, leads)} · open {mn.budget.minutes[0]}/{mn.budget.minutes[1]} min · turns {mn.budget.turns[0]}/{mn.budget.turns[1]} · {ADJOURN[mn.adjourn_reason] || mn.adjourn_reason}</div>
      <div className="tm-muted">Attended {names(mn.attendees.accepted)}{mn.attendees.declined.length ? ` · declined ${names(mn.attendees.declined.map((d) => d.who))}` : ''}{mn.attendees.no_answer.length ? ` · no answer ${names(mn.attendees.no_answer)}` : ''}</div>
      <ol>
        {mn.items.map((it) => {
          const o = it.outcome && (OUTCOME[it.outcome.kind] || [it.outcome.kind, ''])
          return (
            <li key={it.item_id}>
              <b>{it.title}</b> {o && <span className={`tm-chip ${o[1]}`} style={{ padding: '0 6px' }}>{o[0]}</span>} <span className="tm-break">{readableIds(it.outcome?.text, it.item_id, m.refs)}</span>
              {it.stances && <div className="tm-muted">Agree {names(it.stances.agree)} · object {names(it.stances.object)} · abstain {names(it.stances.abstain)}</div>}
              {it.ballots.filter((b) => b.tally).map((b) => <div key={b.ballot_id} className="tm-muted">Vote {Object.entries(b.tally).map(([k, v]) => `${k} ${v}`).join(', ')}{b.tie.length ? ` · tie ${b.tie.join(', ')}` : ''}</div>)}
              {it.dissent.map((d, i) => <div key={i} className="tm-muted tm-break">Dissent, {mName(m, d.who, leads)}: “{d.text}”</div>)}
              {(it.rejected || []).length > 0 && (
                <div className="tm-minutes-rejected">
                  <div className="tm-muted"><b>Turned down</b></div>
                  {it.rejected.map((r, i) => (
                    <div key={i} className="tm-break">
                      <span className="tm-chip is-warn" style={{ padding: '0 6px' }}>{r.label}</span>{r.by ? ` ${mName(m, r.by, leads)}: ` : ' '}“{r.text}”
                      <div className="tm-muted">{r.reason} · chosen instead: {r.lost_to}</div>
                      {r.objections.map((o, j) => <div key={j} className="tm-muted tm-break">Objection, {mName(m, o.who, leads)}: “{o.text}”</div>)}
                    </div>
                  ))}
                </div>
              )}
              {it.outcome?.rationale && <div className="tm-muted tm-break">Bar raiser rationale: {readableIds(it.outcome.rationale, it.item_id, m.refs)}</div>}
            </li>
          )
        })}
      </ol>
      {mn.actions.length > 0 && <><b>Action items</b><ul>{mn.actions.map((a) => <li key={a.action_id}>{mName(m, a.owner, leads)}: {a.title}{a.due ? ` (due ${a.due})` : ''} · {a.state}{a.reason ? `: ${a.reason}` : ''}</li>)}</ul></>}
      <div className="tm-muted" style={{ marginTop: 8 }}>{mn.source} Posted to main; each attendee gets an inbox pointer. Not written into any bot's memory.</div>
    </div>
  )
}

function ActionsTab({ m, leads }) {
  if (!m.actions.length) return <div className="tm-muted tm-mnote"><ClipboardList size={14} />No action items yet. A speaker proposes one to an attendee; it reaches that attendee's to-dos only when they accept.</div>
  return (
    <div>
      {m.actions.map((a) => {
        const st = a.state === 'proposed' && m.state === 'closed' ? 'unowned' : a.state
        const [l, c] = ACTION_ITEM[st] || [st, '']
        return (
          <div key={a.action_id} className="tm-action">
            <Avatar who={a.owner} leads={leads} size="sm" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <b className="tm-break">{a.title}</b>
              <div className="tm-muted">{mName(m, a.owner, leads)}{a.due ? ` · due ${a.due}` : ''} · proposed by {mName(m, a.by, leads)}{a.item_id && itemNum(m, a.item_id) ? ` · item ${itemNum(m, a.item_id)}` : ''}</div>
              {a.detail && <div className="tm-muted tm-break">{a.detail}</div>}
              <span className={`tm-chip is-wrap ${c}`}>{l}{a.reason ? `: ${a.reason}` : ''}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MeetingLedger({ rows }) {
  return (
    <div className="tm-xscroll">
      <table className="tm-table tm-ledger">
        <thead><tr><th>seq</th><th>Time</th><th>type</th><th>by</th></tr></thead>
        <tbody>
          {[...rows].reverse().map((r) => <tr key={r.seq} title={JSON.stringify(r.data)}><td>{r.seq}</td><td className="tm-muted">{fmtClock(r.ts)}</td><td className="tm-type">{r.type}{r.data?.meeting ? ` · ${r.data.meeting.stance}` : ''}</td><td>{r.by}</td></tr>)}
        </tbody>
      </table>
    </div>
  )
}

// ───────────────────────────────────────────────────────────── side cards

function BriefCard({ state, leads }) {
  const briefs = state.briefs || []
  const ids = [...leads.keys()]
  const [who, setWho] = useState(ids[0] || '')
  useEffect(() => { if (!who && ids.length) setWho(ids[0]) }, [who, ids])
  const latest = briefs.filter((b) => b.lead_id === who).sort((a, b) => b.ts - a.ts)[0]
  const channels = new Map((state.channels || []).map((c) => [c.id, c]))
  return (
    <div className="tm-card">
      <div className="tm-card-title">
        <Sparkles size={15} style={{ color: 'var(--accent)' }} />Secretary brief
        <span className="tm-spacer" />
        <select className="tm-select" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Whose brief">
          {ids.map((id) => <option key={id} value={id}>{shortHandle(leads.get(id).handle)}</option>)}
        </select>
      </div>
      {!latest ? <div className="tm-muted">This lead has not been woken yet.</div> : (
        <>
          <div className="tm-case-row">
            <span className={`tm-lane ${latest.lane}`}>lane {latest.lane}</span>
            <span className="tm-muted">Woken {fmtClock(latest.ts)} · reason: {[...new Set((latest.reasons || []).map(reasonLabel))].join(', ')}</span>
          </div>
          {latest.lane === 'rules' && <div className="tm-muted tm-break" style={{ marginTop: 4 }}>The secretary did not submit ({latest.fallback_reason || 'invalid'}), so code grouped the items and used each first line as the summary. The wake went out as usual.</div>}
          {(latest.brief?.groups || []).map((g, i) => {
            const ch = channels.get(g.channel_id)
            return (
              <div key={i} className="tm-brief-group">
                <div className="tm-brief-place">{ch?.kind === 'dm' ? <MessageSquare size={12} /> : <Hash size={12} />}{channelName(ch, leads) || g.channel_id}{g.thread_id ? ` › ${threadLabel(g.thread_id, ch?.thread_titles)}` : ' › main'}</div>
                {g.items.map((it, j) => (
                  <div key={j} className="tm-brief-item">
                    <span className="tm-seq">#{it.seqs.join(',')}</span>
                    <span className="tm-break">{it.summary}<BriefPointers p={it.pointers} here={g.channel_id} channels={channels} leads={leads} /></span>
                  </div>
                ))}
              </div>
            )
          })}
          <div className="tm-muted" style={{ marginTop: 6 }}>Organizes only, never judges. The wake itself carries a pointer, not the message text.</div>
        </>
      )}
    </div>
  )
}

// History pointers code attached to a brief item: where the same question came up
// before, the lead's own answer, and how often. Ledger seqs only, no judgement.
function BriefPointers({ p, here, channels, leads }) {
  if (!p) return null
  const at = (r) => `${r.channel_id === here ? '' : `${channelName(channels.get(r.channel_id), leads) || r.channel_id} `}#${r.seq}`
  const parts = []
  if (p.seen_before?.length) parts.push(`Seen before: ${p.seen_before.map(at).join(', ')}`)
  if (p.answered_before) parts.push(`You answered: ${at(p.answered_before)}`)
  if (p.repeat_count > 1) parts.push(`Came up ${p.repeat_count}× in 7 days`)
  const room = (r) => (r.channel_id === here ? 'this group' : channelName(channels.get(r.channel_id), leads) || 'another group')
  if (p.decided_before) parts.push(`Decided in ${room(p.decided_before)}: “${p.decided_before.topic}” (${DECISION_STATUS[p.decided_before.status]?.[0] || p.decided_before.status})`)
  if (p.rejected_before) parts.push(`Turned down before in ${room(p.rejected_before)}: “${p.rejected_before.topic}”`)
  if (!parts.length) return null
  return <span className="tm-brief-pointers">{parts.join(' · ')}</span>
}

// ───────────────────────────────────────────────────────────── room memory

const DECISION_STATUS = { current: ['Current', 'is-ok'], conflict: ['Conflict', 'is-err'], superseded: ['Replaced', ''] }
const SOURCE = { meeting: 'meeting', lead: 'recorded by a lead' }
const SECTION_ICON = { decisions: Gavel, waiting: Hourglass, stuck: TriangleAlert, in_progress: ListChecks }

// Decisions, what the group turned down, and the rolling summary. All of it is
// folded by the server from explicit ledger rows (meeting outcomes, rulings,
// team_decide); nobody, the secretary included, judges a status here.
function RoomMemoryCard({ memory }) {
  const [open, setOpen] = useState(false)
  if (!memory) return null
  const decisions = memory.decisions || []
  const bySeq = new Map(decisions.map((d) => [d.seq, d]))
  const replaced = decisions.filter((d) => d.status === 'superseded').reverse()
  const rejected = [...(memory.rejected || [])].reverse()
  const sections = memory.summary?.sections || []
  const conflicts = decisions.filter((d) => d.status === 'conflict').length
  return (
    <div className="tm-card" data-testid="room-memory">
      <div className="tm-card-title">
        <NotebookText size={15} style={{ color: 'var(--accent)' }} />Room memory
        {conflicts > 0 && <span className="tm-chip is-err">{plural(conflicts, 'conflict')}</span>}
        <span className="tm-spacer" />
        <span className="tm-muted" style={{ fontWeight: 400 }}>built from the ledger</span>
      </div>
      {sections.map((s) => {
        const Icon = SECTION_ICON[s.key] || ListChecks
        return (
          <div key={s.key} className="tm-mem-sec" data-section={s.key}>
            <div className="tm-mem-head">
              <Icon size={12} />{s.title}
              <span className="tm-spacer" />
              <span className="tm-muted tm-mem-cap" title={`This section keeps at most ${s.cap.items} lines and ${s.cap.chars} characters. When it is full, only this section is shortened.`}>
                {s.items.length}/{s.cap.items}
              </span>
            </div>
            {s.items.length === 0 && <div className="tm-muted tm-mem-none">Nothing here.</div>}
            {s.items.map((it, i) => (
              <div key={i} className="tm-mem-line">
                {s.key === 'decisions' && <span className={`tm-chip ${DECISION_STATUS[it.tag]?.[1] || ''}`}>{DECISION_STATUS[it.tag]?.[0] || it.tag}</span>}
                <span className="tm-break">{it.text}</span>
              </div>
            ))}
            {s.more > 0 && <div className="tm-muted tm-mem-more">+{s.more} older, shortened to fit</div>}
          </div>
        )
      })}
      {(replaced.length > 0 || rejected.length > 0) && (
        <button className="tm-stub tm-mem-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <ChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
          History · {plural(replaced.length, 'replaced decision')} · {plural(rejected.length, 'turned-down proposal')}
        </button>
      )}
      {open && (
        <div className="tm-mem-history">
          {replaced.map((d) => (
            <div key={`d${d.seq}`} className="tm-mem-old">
              <div className="tm-mem-line"><span className="tm-chip">Replaced</span><span className="tm-break"><b>{d.topic}</b>: {d.text}</span></div>
              <div className="tm-muted tm-break">Replaced by: {bySeq.get(d.superseded_by)?.text || 'a later decision'} · {SOURCE[d.source]}</div>
            </div>
          ))}
          {rejected.map((r) => (
            <div key={`r${r.seq}`} className="tm-mem-old">
              <div className="tm-mem-line"><span className="tm-chip is-warn">Turned down</span><span className="tm-break"><b>{r.topic}</b>: {r.text}</span></div>
              <div className="tm-muted tm-break">Why: {r.reason}{r.lost_to ? ` (chosen instead: ${r.lost_to})` : ''}{r.by_name ? ` · proposed by ${r.by_name}` : ''}{r.objections?.length ? ` · ${plural(r.objections.length, 'objection')}` : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const TRIGGER = {
  hop_limit: 'hop over 4', round_budget: 'too many posts this round', cooldown: 'channel cooling down', unanswered_assignment: 'assignment unanswered', requested: 'someone asked for it',
  meeting_tie: 'meeting vote tied', meeting_stalled: 'meeting stalled 3 rounds', meeting_rounds_spent: 'meeting rounds spent', meeting_budget_warning: 'meeting budget at 80%', meeting_requested: 'a speaker asked for it',
}
function CasesCard({ state, leads, onNeeds, onOpen }) {
  // "waiting on you" only through waitingOnYou; a case is answered in Needs you
  const waitingKeys = new Set(waitingOnYou(state).map((d) => d.key))
  const isWaiting = (c) => waitingKeys.has(`case:${c.case_id}`)
  const cases = [...(state.cases || [])].sort((a, b) => isWaiting(b) - isWaiting(a) || b.ts - a.ts)
  const used = state.budget?.cases_hour
  return (
    <div className="tm-card">
      <div className="tm-card-title">
        <ShieldCheck size={15} style={{ color: 'var(--aim)' }} />Bar raiser
        <span className="tm-muted" style={{ fontWeight: 400 }}>independent · takes no work · no vote</span>
        <span className="tm-spacer" />
        {used && <span className="tm-mono tm-muted">{used.used}/{used.cap} cases/h</span>}
      </div>
      {cases.length === 0 && <div className="tm-muted">No cases yet. It is called when a hop goes over 4, an assignment goes unanswered, and similar.</div>}
      {cases.map((c) => <CaseItem key={c.case_id} c={c} n={state.cases.indexOf(c) + 1} state={state} leads={leads} waiting={isWaiting(c)} onNeeds={onNeeds} onOpen={onOpen} />)}
    </div>
  )
}

// People see "Case 2" (the order it opened in), never the C-… id; hover shows the id.
function CaseItem({ c, n, state, leads, waiting, onNeeds, onOpen }) {
  const ch = (state.channels || []).find((x) => x.id === c.channel_id)
  const status = caseStatus(c)
  const a = c.acted
  return (
    <div className={`tm-case ${waiting ? 'is-call' : ''}`}>
      <div className="tm-case-row">
        <span className="tm-mono tm-muted" title={c.case_id}>Case {n}</span>
        <span className={`tm-chip ${status[1]}`}>{status[0]}</span>
        <button className="tm-stub" style={{ padding: '1px 8px', fontSize: 12, marginLeft: 'auto' }} onClick={() => onOpen(c.channel_id, c.thread_id)}>
          {ch ? `#${channelName(ch, leads)}` : 'a channel'}{c.thread_id ? ` › ${threadLabel(c.thread_id, ch?.thread_titles)}` : ''}<ChevronRight size={12} />
        </button>
      </div>
      <div className="tm-case-row" style={{ marginTop: 6 }}>
        <span className="tm-muted">Trigger:</span>
        {(c.triggers || []).map((t) => <span key={t.key} className="tm-chip">{TRIGGER[t.trigger] || t.trigger}</span>)}
        {(c.triggers || []).some((t) => t.trigger === 'unanswered_assignment') && <Approx kind="round" />}
      </div>
      {a && (
        <>
          <div className="tm-case-row" style={{ marginTop: 6 }}>
            <span className="tm-muted">Action:</span><b style={{ color: 'var(--text-strong)' }}>{CASE_ACTION[a.action] || a.action}</b>
            {c.called_person?.class && <span className="tm-chip is-err">{PERSON_CLASS[c.called_person.class] || c.called_person.class}</span>}
          </div>
          {a.args?.question && <div className="tm-case-q tm-break">{a.args.question}</div>}
          <Verdict a={a} />
          <div className="tm-case-why tm-break">{a.rationale} <Evidence parts={evidenceParts(a.evidence)} /></div>
        </>
      )}
      {/* read-only here; the card is answered in Needs you (one place, one count) */}
      {c.called_person?.card && <PersonCard c={c} n={n} now={state.now || Date.now() / 1000} />}
      {c.defaulted && <div className="tm-case-why tm-break">The bar raiser gave no valid action in time ({c.defaulted.reason}), so the default action ran.</div>}
      {waiting && onNeeds && <div style={{ marginTop: 8 }}><Btn primary onClick={onNeeds}>Answer in Needs you</Btn></div>}
      {c.answer && !c.called_person?.card && <div className="tm-case-why tm-break" style={{ marginTop: 6 }}>Your answer ({fmtClock(c.answer.ts)}): <span style={{ color: 'var(--text)' }}>{c.answer.text}</span></div>}
    </div>
  )
}

// veto = BLOCK (it fails), hold = HOLD (cannot judge yet), rule = one side's choice with each side's claim
function Verdict({ a }) {
  const g = a.args || {}
  if (a.action === 'veto') {
    return (
      <div className="tm-verdict is-block">
        <div className="tm-verdict-head"><span className="tm-chip is-err">BLOCK</span>It fails a rule</div>
        <dl className="tm-fields"><dt>Rule</dt><dd>{g.rule}</dd><dt>Number</dt><dd>{g.number}</dd><dt>To go on</dt><dd>{g.change}</dd></dl>
      </div>
    )
  }
  if (a.action === 'hold') {
    return (
      <div className="tm-verdict is-hold">
        <div className="tm-verdict-head"><span className="tm-chip is-warn">HOLD</span>Cannot judge yet · not a failure</div>
        <dl className="tm-fields"><dt>Missing</dt><dd>{g.missing}</dd></dl>
      </div>
    )
  }
  if (a.action === 'rule' && Array.isArray(g.positions)) {
    return (
      <div className="tm-verdict">
        <div className="tm-verdict-head"><span className="tm-chip is-info">Ruling</span>Picked: <b>{g.choice}</b> · no middle value</div>
        <dl className="tm-fields">
          {g.positions.map((p, i) => <Fragment key={i}><dt>{p.by}</dt><dd>{p.claim}{p.evidence_seqs?.length ? <span className="tm-seq"> #{p.evidence_seqs.join(', #')}</span> : null}</dd></Fragment>)}
          <dt>Decided by</dt><dd>{g.decides}</dd>
        </dl>
      </div>
    )
  }
  return null
}

function Evidence({ parts }) {
  if (!parts.length) return null
  return (
    <span className="tm-evidence">
      {parts.map((p) => <span key={p.seq} className={`tm-ev ${p.source === 'party_claim' ? 'is-claim' : ''}`} title={p.source === 'party_claim' ? 'What a lead said about itself. Not enough alone.' : p.source === 'owner' ? 'Your message' : 'Written by the app'}>{p.label}</span>)}
    </span>
  )
}

// One card, fixed fields. The answer is bound to this exact version (card_hash) and is used once.
function PersonCard({ c, n, now, onAnswer, busy }) {
  const [mode, setMode] = useState(null)
  const [text, setText] = useState('')
  const [standing, setStanding] = useState(false)
  const cp = c.called_person
  const card = cp.card
  const open = cardOpen(c)
  const send = (decision) => onAnswer(c.case_id, cardAnswerBody(c, decision, { text, standing }))
  const ifNo = CASE_ACTION[card.if_no] || card.if_no
  return (
    <div className={`tm-pcard ${open ? '' : 'is-closed'}`} aria-label={`Card for case ${n}`}>
      <dl className="tm-fields">
        {cardRows(card, now).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
      </dl>
      {open && onAnswer && (
        <>
          {mode === 'change' && (
            <form className="tm-answer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send('change') }}>
              <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What to do instead, e.g. run it after 18:00" aria-label={`Change for case ${n}`} />
              <Btn primary type="submit" disabled={busy || !text.trim()}>Send change</Btn>
            </form>
          )}
          {mode !== 'change' && (
            <div className="tm-pcard-actions">
              <Btn primary disabled={busy} onClick={() => send('approve')}><Check size={14} />Approve this version</Btn>
              <Btn disabled={busy} onClick={() => setMode('change')}>Change…</Btn>
              <Btn disabled={busy} onClick={() => send('no')}><X size={14} />No</Btn>
              <Btn disabled={busy} onClick={() => send('skip')} title={`Skipping counts as No: “${ifNo}” runs once.`}>Skip</Btn>
            </div>
          )}
          <label className="tm-standing">
            <input type="checkbox" checked={standing} onChange={(e) => setStanding(e.target.checked)} />
            <span>Within this range, don&apos;t ask me again for 24h: in this room, for <b>{PERSON_CLASS[card.class] || card.class}</b>, just <b>{ifNo}</b>.</span>
          </label>
          <div className="tm-muted tm-pcard-note">Skipping counts as No: at {fmtClock(card.expires)} “{ifNo}” runs once. A standing approval only covers actions that stop or hold work.</div>
        </>
      )}
      {!open && cardVoidText(c) && <div className="tm-muted tm-pcard-note">{cardVoidText(c)}</div>}
      {cp.standing && <div className="tm-pcard-note">Your standing approval answered it: “{ifNo}” ran. No card was sent.</div>}
      {c.lapsed && <div className="tm-pcard-note">No answer by {fmtClock(card.expires)}, so it counted as No: “{ifNo}” ran once.</div>}
      {c.answer && (
        <div className="tm-pcard-note">
          {{ approve: 'You approved this version', no: `You said no · “${ifNo}” ran`, change: 'You asked for a change' }[c.answer.decision] || 'You answered'} ({fmtClock(c.answer.ts)}){c.answer.text ? <>: <span style={{ color: 'var(--text)' }}>{c.answer.text}</span></> : null}
          {c.answer.standing && <div className="tm-muted">Standing for 24h in this room: {ifNo}.</div>}
        </div>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────── needs you

function NeedsYouView({ state, leads, waiting, api, write, busy, onOpen }) {
  const names = useMemo(() => new Map([...leads].map(([id, l]) => [id, l.handle])), [leads])
  const recap = useMemo(() => sinceYouSpoke(state, names), [state, names])
  const d = waiting[0] || null
  const done = (state.decisions || []).filter((x) => x.state !== 'open').slice(-3).reverse()
  return (
    <div className="tm-needs">
      <div className="tm-card">
        <div className="tm-card-title">
          <ClipboardList size={15} style={{ color: 'var(--aim)' }} />Since you last spoke
          <span className="tm-muted" style={{ fontWeight: 400 }}>{recap.since ? `after ${fmtClock(recap.since)}` : 'you have not posted yet'}</span>
        </div>
        {recap.lines.length === 0 && <div className="tm-muted">Nothing new in the groups.</div>}
        <ul className="tm-recap">
          {recap.lines.map((l, i) => (
            <li key={i}>
              {l.channel_id ? <button className="tm-stub" onClick={() => onOpen(l.channel_id, null)}>{l.place}<ChevronRight size={12} /></button> : <b>{l.place}</b>}
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {d ? <DecisionCard key={d.key} d={d} state={state} leads={leads} left={waiting.length - 1} busy={busy || state.stopped}
        stopped={state.stopped} onOpen={onOpen}
        onAnswer={(text) => write(() => api.post(`${BASE}/decisions/answer`, { key: d.key, text }), 'Answer sent')}
        onSkip={() => write(() => api.post(`${BASE}/decisions/answer`, { key: d.key, skip: true }), 'Skipped · counted as No')}
        onCard={(body) => write(() => api.post(`${BASE}/decisions/answer`, { key: d.key, ...body }),
          body.skip ? 'Skipped · counted as No' : { approve: 'Approved this version', no: 'Said no', change: 'Change sent' }[body.decision] || 'Answer sent')} />
        : <div className="tm-card tm-needs-empty"><Check size={18} style={{ color: 'var(--ok)' }} /><div><b>Nothing is waiting on you.</b><div className="tm-muted">A card shows up here when the bar raiser hands you a decision or a lead asks about your @.</div></div></div>}

      {done.length > 0 && (
        <div className="tm-card">
          <div className="tm-card-title"><ListChecks size={15} />Recently decided</div>
          {done.map((x) => (
            <div key={x.key} className="tm-case-row" style={{ marginBottom: 6 }}>
              <span className={`tm-chip ${x.state === 'skipped' ? 'is-err' : x.state === 'answered' ? 'is-ok' : ''}`}>{x.state === 'skipped' ? 'Skipped = No' : x.state === 'answered' ? 'Answered' : 'Withdrawn'}</span>
              <span className="tm-break">{x.question}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DecisionCard({ d, state, leads, left, busy, stopped, onOpen, onAnswer, onSkip, onCard }) {
  const [text, setText] = useState('')
  // a bar raiser case with a fixed-field card is answered on the card itself, bound to its version
  const kase = d.kind === 'case' ? (state.cases || []).find((c) => `case:${c.case_id}` === d.key) : null
  const withCard = Boolean(kase?.called_person?.card)
  const ch = (state.channels || []).find((x) => x.id === d.channel_id)
  const where = ch ? `${ch.kind === 'group' ? '#' : ''}${channelName(ch, leads)}${d.thread_id ? ' › thread' : ''}` : 'a channel'
  const who = d.kind === 'ask' ? `${shortHandle(leads.get(d.lead)?.handle) || 'A lead'} ${d.via === 'dm' ? 'asked you' : 'asked about your @'}`
    : d.kind === 'case' ? 'Bar raiser hands this to you'
      : d.kind === 'meeting_item' ? 'A meeting needs you' : 'Needs your decision'
  // Other kinds (a meeting item, ...) are answered where they were asked.
  const here = d.kind === 'case' || d.kind === 'ask'
  return (
    <div className="tm-card tm-decision" role="region" aria-label="Decision waiting on you">
      <div className="tm-card-title">
        <Gavel size={15} style={{ color: 'var(--danger)' }} />{who}
        <span className={`tm-chip ${d.impact === 'ask' ? 'is-info' : 'is-err'}`}>{IMPACT_LABEL[d.impact] || d.impact}</span>
        <span className="tm-spacer" />
        <span className="tm-muted" style={{ fontWeight: 400 }}>{left > 0 ? `${left} more after this` : 'last one'}</span>
      </div>
      <div className="tm-decision-q tm-break">{d.question}</div>
      <div className="tm-case-row tm-muted">
        <span>Waiting since {fmtClock(d.opened_ts)}</span>·
        <button className="tm-stub" onClick={() => onOpen(d.channel_id, d.thread_id)}>{where}<ChevronRight size={12} /></button>
      </div>
      {!here && <div className="tm-answer"><Btn primary onClick={() => onOpen(d.channel_id, d.thread_id)}>Answer where it was asked</Btn></div>}
      {withCard && <PersonCard c={kase} n={(state.cases || []).indexOf(kase) + 1} now={state.now || Date.now() / 1000}
        busy={busy} onAnswer={(_, body) => onCard(body)} />}
      {here && !withCard && <form className="tm-answer" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswer(text.trim()) }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer, posted where it was asked" aria-label="Your answer" disabled={busy} />
        <Btn primary type="submit" disabled={busy || !text.trim()}>Send answer</Btn>
        <Btn type="button" disabled={busy} onClick={onSkip} title="Skipping says No. It is posted as your answer and not asked again.">Skip = No</Btn>
      </form>}
      {stopped && <div className="tm-muted" style={{ marginTop: 6 }}>Emergency stop is on. Resume to answer.</div>}
    </div>
  )
}

function Meter({ label, used, cap, suffix, fullOk }) {
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0
  return (
    <div className="tm-meter">
      <div className="tm-meter-row"><span>{label}</span><span><b>{used}</b> <span className="tm-muted">/ {cap}{suffix || ''}</span></span></div>
      <div className="tm-bar" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={cap} aria-label={label}>
        <i className={fullOk ? '' : pct >= 100 ? 'is-full' : pct >= 80 ? 'is-hot' : ''} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function BudgetCard({ state, leads, api, write, busy }) {
  const b = state.budget || {}
  const t = b.tokens_est || {}
  const per = b.lead_wakes_hour || {}
  const rows = limitRows(b)
  const clamped = rows.filter((r) => r.clamped)
  const tightened = rows.filter((r) => r.asked !== null && !r.clamped && r.applied < r.hard)
  const away = b.owner_away || {}
  const [editing, setEditing] = useState(false)
  return (
    <div className="tm-card" data-testid="tm-budget-card">
      <div className="tm-card-title"><Gauge size={15} style={{ color: 'var(--muted)' }} />Budget<span className="tm-spacer" /><span className="tm-muted" style={{ fontWeight: 400 }}>stops itself at the cap</span></div>
      {clamped.map((r) => (
        <div key={r.key} className="tm-note is-warn" role="status" data-testid="tm-limit-clamped">
          <TriangleAlert size={14} /><span>{r.label}: you set {r.asked}{r.unit === 'min' ? ' min' : ''}, above the hard cap. The hard cap of {r.hard}{r.unit === 'min' ? ' min' : ''} applies.</span>
        </div>
      ))}
      {away.paused_since && (
        <div className="tm-note is-info" role="status"><Moon size={14} /><span>You were away: group batch wakes are paused. They resume now that you are back.</span></div>
      )}
      {!away.paused_since && away.last_pause && (
        <div className="tm-note is-info" role="status" data-testid="tm-away-note"><Moon size={14} /><span>While you were away ({fmtClock(away.last_pause.from)}–{fmtClock(away.last_pause.to)}), group batch wakes were paused. Direct words still woke leads.</span></div>
      )}
      {b.deliveries && <Meter label="Deliveries" used={b.deliveries.used} cap={b.deliveries.cap} />}
      {b.wakes_hour && <Meter label="Wakes (this hour)" used={b.wakes_hour.used} cap={b.wakes_hour.cap} />}
      <div className="tm-stat-grid">
        <div className="tm-stat"><div className="tm-stat-l">Tokens <Approx kind="tokens" /></div><div className="tm-stat-v">{fmtTokens(t.total)}{t.cap ? <span className="tm-muted"> / {fmtTokens(t.cap)}</span> : null}</div>
          {t.hot !== undefined && <div className="tm-muted">{t.hot} warm × {fmtTokens(t.hot_each)} + {t.cold} cold × {fmtTokens(t.cold_each)}</div>}</div>
        <div className="tm-stat"><div className="tm-stat-l">Messages (this hour)</div><div className="tm-stat-v">{b.messages_hour?.used ?? '—'}<span className="tm-muted"> / {b.messages_hour?.cap ?? '—'}</span></div>
          <div className="tm-muted">Secretary {b.secretary_hour?.used ?? '—'}/{b.secretary_hour?.cap ?? '—'}</div></div>
      </div>
      {per.cap && (
        <div style={{ marginTop: 10 }}>
          <div className="tm-muted" style={{ marginBottom: 4 }}>Wakes per lead this hour (cap {per.cap})</div>
          {[...leads.values()].map((l) => (
            <div key={l.lead_id} className="tm-meter-row" style={{ alignItems: 'center' }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}><Avatar who={l.lead_id} leads={leads} size="sm" /><span className="tm-ellipsis">{shortHandle(l.handle)}</span></span>
              <span className="tm-mono">{per[l.lead_id] ?? 0}/{per.cap}</span>
            </div>
          ))}
        </div>
      )}
      <div className="tm-limits-row">
        <span className="tm-muted">{tightened.length ? `${plural(tightened.length, 'limit')} set lower than the hard cap` : 'Hard caps apply'} · batch wakes pause after {Math.round((away.after_secs || 0) / 60)} min away</span>
        <span className="tm-spacer" />
        <Btn disabled={busy} onClick={() => setEditing(true)} data-testid="tm-limits-edit"><SlidersHorizontal size={14} />Tighten limits</Btn>
      </div>
      {editing && <LimitsDialog rows={rows} busy={busy} onClose={() => setEditing(false)}
        onSave={(body) => write(() => api.post(`${BASE}/limits`, body), 'Limits saved').then((ok) => { if (ok) setEditing(false) })} />}
    </div>
  )
}

// Hard caps only tighten (limits.effective_caps): a looser value is kept as asked and the cap applies.
function LimitsDialog({ rows, busy, onClose, onSave }) {
  const [fields, setFields] = useState(() => Object.fromEntries(rows.map((r) => [r.key, r.asked === null ? '' : String(r.asked)])))
  const [err, setErr] = useState('')
  const over = rows.filter((r) => /^\d+$/.test(fields[r.key] || '') && Number(fields[r.key]) > r.hard)
  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Tighten limits" maxWidth={520}>
      <form className="tm-form" data-testid="tm-limits-dialog" onSubmit={(e) => { e.preventDefault(); const b = limitsBody(fields); if (b.error) setErr(b.error); else onSave(b) }}>
        <div className="tm-muted">You can set any limit lower than its hard cap. Nobody can raise a hard cap, and leads cannot change limits. Leave a field blank to use the hard cap.</div>
        <div className="tm-limit-grid">
          {rows.map((r) => (
            <label key={r.key} className="tm-limit-field">
              <span>{r.label}</span>
              <Input value={fields[r.key]} inputMode="numeric" placeholder={String(r.hard)} aria-label={r.label}
                onChange={(e) => { setErr(''); setFields({ ...fields, [r.key]: e.target.value }) }} />
              <span className="tm-muted">hard cap {r.hard}{r.unit === 'min' ? ' min' : ''}</span>
            </label>
          ))}
        </div>
        {over.length > 0 && <div className="tm-note is-warn" role="status"><TriangleAlert size={14} /><span>{over.map((r) => r.label).join(', ')}: above the hard cap. The hard cap will apply.</span></div>}
        {err && <div className="tm-field-err" role="alert">{err}</div>}
        <div className="tm-dialog-actions">
          <Btn type="button" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn primary type="submit" disabled={busy} data-testid="tm-limits-save">Save limits</Btn>
        </div>
      </form>
    </Modal>
  )
}

// Roles name an intent (easy / default / smartest); one table maps intents to model ids (teamapp/models.py).
function ModelsCard({ state, api, write, busy }) {
  const cfg = state.models || {}
  const rows = modelRows(cfg)
  const [editing, setEditing] = useState(false)
  if (!rows.length) return null
  return (
    <div className="tm-card" data-testid="tm-models-card">
      <div className="tm-card-title"><Cpu size={15} style={{ color: 'var(--muted)' }} />Models<span className="tm-spacer" /><span className="tm-muted" style={{ fontWeight: 400 }}>picked by intent</span></div>
      {rows.map((r) => (
        <div key={r.role} className="tm-meter-row" style={{ alignItems: 'center' }}>
          <span>{r.label}</span>
          <span><span className="tm-chip is-info">{INTENT_LABEL[r.intent] || r.intent}</span> <span className="tm-mono">{r.model}</span></span>
        </div>
      ))}
      <div className="tm-limits-row"><span className="tm-spacer" /><Btn disabled={busy} onClick={() => setEditing(true)} data-testid="tm-models-edit">Edit</Btn></div>
      {editing && <ModelsDialog cfg={cfg} busy={busy} onClose={() => setEditing(false)}
        onSave={(body) => write(() => api.post(`${BASE}/models`, body), 'Models saved').then((ok) => { if (ok) setEditing(false) })} />}
    </div>
  )
}

function ModelsDialog({ cfg, busy, onClose, onSave }) {
  const intents = cfg.intents || ['easy', 'default', 'smartest']
  const [routes, setRoutes] = useState({ ...(cfg.routes || {}) })
  const [roles, setRoles] = useState({ ...(cfg.roles || {}) })
  const changed = (a, b) => Object.fromEntries(Object.entries(a).filter(([k, v]) => b?.[k] !== v))
  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Models" maxWidth={520}>
      <form className="tm-form" data-testid="tm-models-dialog" onSubmit={(e) => { e.preventDefault(); onSave({ routes: changed(routes, cfg.routes), roles: changed(roles, cfg.roles) }) }}>
        <div className="tm-muted">Each role uses an intent. Each intent points at one model. Change the model behind an intent once, and every role on it follows.</div>
        <div className="tm-limit-grid">
          {intents.map((i) => (
            <label key={i} className="tm-limit-field">
              <span>{INTENT_LABEL[i] || i}</span>
              <Input value={routes[i] || ''} aria-label={`${INTENT_LABEL[i] || i} model`} onChange={(e) => setRoutes({ ...routes, [i]: e.target.value.trim() })} />
            </label>
          ))}
        </div>
        <div className="tm-limit-grid">
          {modelRows({ routes, roles }).map((r) => (
            <label key={r.role} className="tm-limit-field">
              <span>{r.label} uses</span>
              <select className="tm-select" value={r.intent} aria-label={`${r.label} intent`} onChange={(e) => setRoles({ ...roles, [r.role]: e.target.value })}>
                {intents.map((i) => <option key={i} value={i}>{INTENT_LABEL[i] || i}</option>)}
              </select>
              <span className="tm-muted tm-mono">{r.model}</span>
            </label>
          ))}
        </div>
        <div className="tm-dialog-actions">
          <Btn type="button" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn primary type="submit" disabled={busy} data-testid="tm-models-save">Save</Btn>
        </div>
      </form>
    </Modal>
  )
}

// ───────────────────────────────────────────────────────────── members

function BotsLink({ children }) {
  const navigate = useNavigate()
  return <a href="/members" className="tm-link" data-testid="tm-bots-link" onClick={(e) => { e.preventDefault(); navigate('/members') }}>{children}</a>
}

// Add Bot: leads are Bots that already exist, from any project. Nothing is created here.
function AddBotsCard({ bots, botsError, leads, api, write, busy, reload }) {
  const [err, setErr] = useState('')
  const add = (b) => {
    setErr('')
    return write(async () => {
      try {
        await api.post(`${BASE}/leads`, addBody(b))
      } catch (e) {
        const msg = addBotError(e)
        setErr(`${b.name}: ${msg}`)
        throw new Error(msg)
      }
    }, `${b.name} joined the team`).then(reload)
  }
  return (
    <div className="tm-card" data-testid="tm-add-bots">
      <div className="tm-card-title"><UserPlus size={15} />Add Bots<span className="tm-spacer" /><span className="tm-muted" style={{ fontWeight: 400 }}>from any project</span></div>
      {botsError && <div className="tm-field-err" role="alert">Could not read your Bots: {botsError}</div>}
      {err && <div className="tm-field-err" role="alert" data-testid="tm-add-error">{err}</div>}
      {bots === null && !botsError && <div className="tm-muted">Reading your Bots…</div>}
      {bots && bots.length === 0 && (
        <div className="tm-note is-info" role="status" data-testid="tm-no-bots"><Users size={14} />
          <span>No Bots yet. <BotsLink>Create one on the Bots page first</BotsLink>.</span></div>
      )}
      {(bots || []).map((b) => {
        const check = addCheck(b, leads)
        const inTeam = !!leadForBot(b, leads)
        return (
          <div key={b.bot} className="tm-bot-row" data-testid="tm-bot-row">
            <div className="tm-bot-main">
              <div className="tm-break" style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{b.name}</div>
              <div className="tm-muted tm-break"><span title={b.project_path || undefined}>Project: {b.project || 'default'}</span>{b.description ? ` · ${b.description}` : ''}</div>
            </div>
            {inTeam ? <span className="tm-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}><Check size={13} />In the team</span>
              : <Btn primary disabled={busy || !check.ok} title={check.ok ? undefined : check.why} onClick={() => add(b)} data-testid="tm-add-bot">Add</Btn>}
            {!check.ok && !inTeam && <div className="tm-muted tm-bot-why">{check.why}{!b.slot_key && <> <BotsLink>Open Bots</BotsLink></>}</div>}
          </div>
        )
      })}
    </div>
  )
}

// ───────────────────────────────────────────────────────────── team tree
// Owner -> leads, left to right, with a role card on the right. Pure SVG + CSS.
// Nothing here renders an id or session key, not even in a title (owner rule).

function TreeAvatar({ hue, name, owner }) {
  return <span className={`tm-av ${owner ? 'owner' : `h${(hue ?? 4) % 5}`}`} aria-hidden="true">{String(name || '?').slice(0, 1).toUpperCase()}</span>
}

function TeamTreeView({ state, api }) {
  // Bot leads read their name, project and own worker tree from the host's Bots
  // (botSource.js via useBots). Until that read answers, or if it fails, every lead
  // keeps the app's own fields and no lead shows an expand toggle.
  const { bots } = useBots(api, { withWorkers: true })
  const tree = useMemo(() => teamTree(state, bots ? rosterLeadSource(bots) : undefined), [state, bots])
  // Each lead's own org chart starts collapsed; what is open is remembered in this browser.
  const [expanded, setExpandedRaw] = useState(() => loadExpanded(window.localStorage))
  const setExpanded = (next) => { setExpandedRaw(next); saveExpanded(window.localStorage, next) }
  const toggle = (key) => { const n = new Set(expanded); if (n.has(key)) n.delete(key); else n.add(key); setExpanded(n) }
  const shown = useMemo(() => visibleTree(tree.leads, expanded), [tree, expanded])
  const allKeys = useMemo(() => expandAllKeys(tree.leads), [tree])
  // Re-layout (and so re-fit) only when what is drawn changes, not on every 2-second poll.
  const shape = JSON.stringify(shown.map((l) => l.workers))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geo = useMemo(() => layoutTree(shown), [shape])
  const [sel, setSel] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const viewRef = useRef(null)
  const dragRef = useRef(null)
  const { openChat } = useChatLauncher()
  const navigate = useNavigate()
  const picked = tree.leads.find((l) => l.key === sel) || null

  const fit = useCallback(() => {
    const el = viewRef.current
    if (!el) return
    // Keep a band free at top and bottom for the Expand/Collapse bar and the zoom control.
    const band = 44
    const view = { width: el.clientWidth, height: Math.max(1, el.clientHeight - 2 * band) }
    const z = fitZoom(view, geo)
    setZoom(z)
    setPan({ x: (view.width - geo.width * z) / 2, y: band + (view.height - geo.height * z) / 2 })
  }, [geo])
  useEffect(() => { fit() }, [fit])

  const zoomBy = (f) => {
    const el = viewRef.current
    const cx = el ? el.clientWidth / 2 : 0
    const cy = el ? el.clientHeight / 2 : 0
    const nz = clampZoom(zoom * f)
    if (nz === zoom) return
    setPan((p) => ({ x: cx - (cx - p.x) * (nz / zoom), y: cy - (cy - p.y) * (nz / zoom) }))
    setZoom(nz)
  }
  // ctrl/cmd + wheel zooms; a native listener because React's wheel handler is passive.
  const zoomByRef = useRef(zoomBy)
  zoomByRef.current = zoomBy
  useEffect(() => {
    const el = viewRef.current
    if (!el) return undefined
    const onWheel = (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomByRef.current(e.deltaY < 0 ? 1.1 : 1 / 1.1) } }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const onDown = (e) => { if (e.target.closest('button')) return; dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; e.currentTarget.setPointerCapture?.(e.pointerId) }
  const onMove = (e) => { if (dragRef.current) setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y }) }
  const onUp = () => { dragRef.current = null }

  return (
    <div className="tm-tree-wrap">
      <div className="tm-tree-view" ref={viewRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} data-testid="tm-tree-canvas" aria-label="Team tree">
        <div className="tm-tree-inner" style={{ width: geo.width, height: geo.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <svg className="tm-tree-edges" width={geo.width} height={geo.height} aria-hidden="true">
            {geo.edges.map((e, i) => <path key={i} d={e.d} className={tree.leads[e.lead]?.key === sel ? 'is-sel' : ''} />)}
          </svg>
          {tree.leads.length > 0 && <button type="button" className={`tm-tnode is-owner ${sel === null ? 'is-sel' : ''}`} style={{ left: geo.owner.x, top: geo.owner.y, width: geo.owner.w, height: geo.owner.h }} onClick={() => setSel(null)} data-testid="tm-tree-owner">
            <TreeAvatar owner name={tree.owner.name} />
            <span className="tm-tnode-main"><b>{tree.owner.name}</b><small>{plural(tree.owner.leadCount, 'lead')} · {plural(tree.owner.groupCount, 'group')}</small></span>
          </button>}
          {tree.leads.map((l, i) => {
            const b = geo.leads[i]
            return (
              <button type="button" key={l.key} className={`tm-tnode ${sel === l.key ? 'is-sel' : ''} ${l.legacy ? 'is-legacy' : ''}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} onClick={() => setSel(l.key)} aria-pressed={sel === l.key} data-testid="tm-tree-lead">
                <span className="tm-tnode-row">
                  <TreeAvatar hue={l.hue} name={l.name} />
                  <span className="tm-tnode-main"><b className="tm-ellipsis">{l.name}</b><small>{l.legacy ? 'Chat' : l.kind}</small></span>
                  <span className={`tm-chip ${l.statusTone}`}>{l.statusLabel}</span>
                </span>
                <span className={`tm-tnode-project ${l.project ? '' : 'is-empty'}`}>{l.legacy && <span className="tm-legacy-tag" data-testid="tm-tree-legacy">{l.kind}</span>}<FolderKanban size={12} />{l.project || 'No project'}</span>
                <span className={`tm-tnode-duty ${l.role ? '' : 'is-empty'}`}>{l.role || 'No role written yet'}</span>
                <span className="tm-tnode-groups">
                  {l.groups.length === 0 ? <span className="tm-muted">No group</span> : l.groups.slice(0, 2).map((g) => <span key={g} className="tm-tgroup"><Hash size={11} />{g}</span>)}
                  {l.groups.length > 2 && <span className="tm-muted">+{l.groups.length - 2}</span>}
                </span>
              </button>
            )
          })}
          {shown.map((l, i) => {
            // No toggle when the source cannot see this lead's workers (or it has none).
            if (!l.canToggle) return null
            const b = geo.leads[i]
            return (
              <button type="button" key={`t-${l.key}`} className={`tm-ttoggle ${l.open ? 'is-open' : ''}`} style={{ left: b.x + b.w - 14, top: b.y + b.h / 2 - 14 }}
                onClick={() => toggle(l.key)} aria-expanded={l.open} aria-label={l.open ? `Hide ${l.name}'s workers` : `Show ${l.name}'s ${plural(l.hiddenCount, 'worker')}`} data-testid="tm-tree-toggle">
                {l.open ? <Minus size={13} /> : <span className="tm-mono">+{l.hiddenCount}</span>}
              </button>
            )
          })}
          {geo.workers.map((w, i) => (
            <div key={i} className={`tm-tworker ${tree.leads[w.lead]?.key === sel ? 'is-sel' : ''}`} style={{ left: w.x, top: w.y, width: w.w, height: w.h }} data-testid="tm-tree-worker">
              <b className="tm-ellipsis">{w.name}</b>
              <small className="tm-ellipsis">{[w.role, w.status].filter(Boolean).join(' · ') || 'Worker'}</small>
            </div>
          ))}
        </div>
        {tree.leads.length === 0 && (
          <div className="tm-tree-empty" data-testid="tm-tree-empty">
            <div className="tm-tree-empty-box">
              <b>No leads yet</b>
              <span>A lead is a Bot that already exists. Create the Bot on the Bots page first, then add it here.</span>
              <span className="tm-tree-empty-act"><Btn primary onClick={() => navigate(BOTS_PAGE)} data-testid="tm-tree-bots-link"><Bot size={14} />Go to Bots page</Btn></span>
            </div>
          </div>
        )}
        {tree.leads.length > 0 && (
          <div className="tm-tree-bar" role="group" aria-label="Org charts">
            <button type="button" onClick={() => setExpanded(new Set(allKeys))} disabled={allKeys.size === 0 || [...allKeys].every((k) => expanded.has(k))} data-testid="tm-tree-expand-all"><ChevronsUpDown size={13} />Expand all</button>
            <button type="button" onClick={() => setExpanded(new Set())} disabled={![...allKeys].some((k) => expanded.has(k))} data-testid="tm-tree-collapse-all"><ChevronsDownUp size={13} />Collapse all</button>
          </div>
        )}
        <div className="tm-tree-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out" disabled={zoom <= ZOOM_MIN}><Minus size={14} /></button>
          <span className="tm-mono" data-testid="tm-tree-zoom">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in" disabled={zoom >= ZOOM_MAX}><Plus size={14} /></button>
          <button type="button" className="tm-tree-fit" onClick={fit} data-testid="tm-tree-fit"><Maximize2 size={13} />Fit all</button>
        </div>
      </div>
      <aside className="tm-rolecard" data-testid="tm-rolecard" aria-live="polite">
        {!picked ? (
          <>
            <div className="tm-rolecard-head"><TreeAvatar owner name={tree.owner.name} /><div><div className="tm-rolecard-name">{tree.owner.name}</div><div className="tm-muted">You. Every lead reports to you.</div></div></div>
            <div className="tm-muted" style={{ marginTop: 12 }}>Pick a lead in the tree to see its role card.</div>
            <div className="tm-muted" style={{ marginTop: 8 }}>Each lead is an existing Bot that runs one project. Its own workers show to its right when Team Mode can see them.</div>
          </>
        ) : <RoleCard lead={picked} onOpen={() => openChat({ slotKey: picked.slotKey })} />}
      </aside>
    </div>
  )
}

function RoleCard({ lead, onOpen }) {
  const f = roleCardFields(lead)
  const list = (items) => <ul className="tm-rolecard-list">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
  return (
    <>
      <div className="tm-rolecard-head">
        <TreeAvatar hue={lead.hue} name={lead.name} />
        <div style={{ minWidth: 0 }}><div className="tm-rolecard-name tm-break">{f.Name}</div><div className="tm-muted">{lead.kind} · reports to Owner</div></div>
        <span className="tm-spacer" />
        <span className={`tm-chip ${lead.statusTone}`}>{f.Status}</span>
      </div>
      <div className="tm-rolecard-sec"><div className="tm-rolecard-k">Project</div><div className={lead.project ? 'tm-break' : 'tm-muted'}>{f.Project}</div></div>
      <div className="tm-rolecard-sec"><div className="tm-rolecard-k">Owns</div><div className={lead.role ? 'tm-break' : 'tm-muted'}>{f.Owns}</div></div>
      <div className="tm-rolecard-sec"><div className="tm-rolecard-k">Workers{lead.workers?.length ? ` · ${countWorkers(lead.workers)}` : ''}</div>{lead.workers?.length ? list(f.Workers) : <div className="tm-muted">{f.Workers[0]}</div>}</div>
      <div className="tm-rolecard-sec"><div className="tm-rolecard-k">Waiting on a person</div>{lead.waits.length ? list(f['Waiting on a person']) : <div className="tm-muted">{f['Waiting on a person'][0]}</div>}</div>
      <div className="tm-rolecard-sec"><div className="tm-rolecard-k">Assignments</div><div>{f.Assignments}</div></div>
      <div className="tm-rolecard-sec"><div className="tm-rolecard-k">Routines</div>
        <div className="tm-chips" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          {f.Routines.map((r, i) => <span key={i} className={`tm-chip is-wrap ${i === 0 && lead.routines.briefs ? 'is-info' : ''}`}><Hourglass size={11} />{r}</span>)}
        </div>
      </div>
      <div className="tm-rolecard-sec"><div className="tm-rolecard-k">Groups</div>
        {lead.groups.length ? <div className="tm-chips">{f.Groups.map((g) => <span key={g} className="tm-chip">{g}</span>)}</div> : <div className="tm-muted">{f.Groups[0]}</div>}
      </div>
      <div className="tm-rolecard-sec">
        {lead.slotKey ? <Btn primary onClick={onOpen} data-testid="tm-rolecard-open"><MessageSquare size={14} />Open chat</Btn> : <span className="tm-muted">No chat to open for this lead.</span>}
      </div>
    </>
  )
}

function MembersView({ state, leads, api, write, busy }) {
  const registered = [...leads.values()].filter((l) => l.active !== false)
  const { bots, teams, error: botsError, reload } = useBots(api)
  const projectOf = (l) => l.project || bots?.find((b) => b.bot === l.bot)?.project || ''
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState([])
  const [mgr, setMgr] = useState('')
  const groupCount = (id) => (state.channels || []).filter((c) => c.kind === 'group' && c.members.includes(id)).length
  const [removing, setRemoving] = useState(null)
  const [view, setView] = useState('tree')
  const notify = useNotify()
  const openGroup = (t) => write(async () => {
    const r = await api.post(`${BASE}/groups`, { title: t, members: picked, managers: mgr ? [mgr] : [] })
    notify?.(r?.reused?.length ? `#${t} already exists with these members. Reused it.`
      : `Created #${t}. Nobody is woken until the first message.`, { type: 'success' })
  })
  return (
    <div className="tm-page">
      {removing && <RemoveLeadDialog lead={removing} api={api} write={write} busy={busy} onClose={() => setRemoving(null)} />}
      <div className="tm-tabs tm-members-tabs" role="tablist" aria-label="Lead views">
        <button role="tab" className="tm-tab" aria-selected={view === 'tree'} onClick={() => setView('tree')} data-testid="tm-members-tree-tab"><Network size={14} />Tree</button>
        <button role="tab" className="tm-tab" aria-selected={view === 'table'} onClick={() => setView('table')} data-testid="tm-members-table-tab"><Table2 size={14} />Table</button>
      </div>
      {view === 'tree' && (
        <div className="tm-card">
          <div className="tm-card-title"><Network size={15} />Team tree<span className="tm-spacer" /><span className="tm-muted" style={{ fontWeight: 400 }}>drag to move · ctrl + scroll to zoom</span></div>
          <TeamTreeView state={state} api={api} />
        </div>
      )}
      <div className="tm-page-grid">
        <div style={{ minWidth: 0 }}>
          {view === 'table' && <div className="tm-card">
            <div className="tm-card-title"><Users size={15} />Leads<span className="tm-spacer" /><Approx kind="identity" /></div>
            {registered.length === 0 ? <div className="tm-muted">None yet. Add a Bot below.</div> : (
              <div className="tm-xscroll">
                <table className="tm-table" data-testid="tm-leads-table">
                  <thead><tr><th>Lead</th><th>Project</th><th>Groups</th><th /></tr></thead>
                  <tbody>
                    {registered.map((l) => {
                      const k = leadKind(l)
                      return (
                        <tr key={l.lead_id}>
                          {/* Lead id and session label stay off screen (owner rule). */}
                          <td><div className="tm-lead-cell"><Avatar who={l.lead_id} leads={leads} /><div style={{ minWidth: 0 }}><div className="tm-break" style={{ fontWeight: 600, color: 'var(--text-strong)' }}>{l.handle}</div>
                            <div className="tm-muted">{k.kind === 'legacy'
                              ? <span className="tm-legacy" title="An older lead chat from before leads were Bots. It keeps working; add a Bot instead for new leads.">Legacy lead</span>
                              : k.label}</div></div></div></td>
                          <td className="tm-break">{projectOf(l) || <span className="tm-muted">—</span>}</td>
                          <td className="tm-mono">{groupCount(l.lead_id)}</td>
                          <td style={{ textAlign: 'right' }}><Btn danger disabled={busy} onClick={() => setRemoving(l)} data-testid="tm-remove-lead">Remove</Btn></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>}
          <AddBotsCard bots={bots} botsError={botsError} leads={leads} api={api} write={write} busy={busy} reload={reload} />
        </div>
        <div className="tm-card" style={{ minWidth: 0 }}>
          <div className="tm-card-title"><Plus size={15} />New group</div>
          <form className="tm-form" onSubmit={(e) => { e.preventDefault(); openGroup(title.trim()).then((ok) => { if (ok) { setTitle(''); setPicked([]); setMgr('') } }) }}>
            <div><label className="tm-label" htmlFor="tm-gtitle">Group name</label><Input id="tm-gtitle" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. release-train" style={{ width: '100%' }} /></div>
            <div>
              <span className="tm-label">Members (2–6 leads, from any project; you do not count)</span>
              {registered.length < 2 && (
                <div className="tm-note is-info" role="status" data-testid="tm-need-bots">
                  <Users size={14} /><span>A group is made from Bots in the team; nobody is created here. {registered.length === 0 ? 'There are none yet.' : 'There is only one.'}{' '}
                    Add them on the left, or <BotsLink>create Bots on the Bots page</BotsLink>.</span>
                </div>
              )}
              {teams.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <label className="tm-label" htmlFor="tm-gteam">Start from a Bot team (optional)</label>
                  <select id="tm-gteam" className="tm-select" value="" data-testid="tm-from-team" style={{ fontSize: 13, padding: '6px 28px 6px 10px', maxWidth: '100%' }}
                    onChange={(e) => {
                      const t = teams.find((x) => x.id === e.target.value)
                      if (!t) return
                      const ids = teamLeadIds(t, leads)
                      setPicked(ids)
                      if (!title.trim()) setTitle(String(t.name || '').toLowerCase().replace(/\s+/g, '-'))
                      notify?.(ids.length < (t.members || []).length
                        ? `Picked ${ids.length} of ${(t.members || []).length} Bots from ${t.name}. Add the others to the team first.`
                        : `Picked the ${ids.length} Bots of ${t.name}.`, { type: 'info' })
                    }}>
                    <option value="">Choose a team…</option>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name} ({(t.members || []).length})</option>)}
                  </select>
                </div>
              )}
              <div className="tm-pick">
                {registered.map((l) => (
                  <label key={l.lead_id}><input type="checkbox" checked={picked.includes(l.lead_id)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.lead_id] : picked.filter((x) => x !== l.lead_id))} /><Avatar who={l.lead_id} leads={leads} size="sm" />{shortHandle(l.handle)}{projectOf(l) && <span className="tm-muted">· {projectOf(l)}</span>}</label>
                ))}
              </div>
            </div>
            <div>
              <label className="tm-label" htmlFor="tm-gmgr">Manager (may use @everyone)</label>
              <select id="tm-gmgr" className="tm-select" value={mgr} onChange={(e) => setMgr(e.target.value)} style={{ fontSize: 13, padding: '6px 28px 6px 10px', maxWidth: '100%' }}>
                <option value="">Only me</option>
                {picked.map((id) => <option key={id} value={id}>{shortHandle(leads.get(id)?.handle)}</option>)}
              </select>
            </div>
            <div className="tm-muted">Every group gets its own bar raiser. Creating it wakes nobody; the first message does.</div>
            <div><Btn primary type="submit" disabled={busy || !title.trim() || picked.length < 2 || picked.length > 6}>Create group</Btn></div>
          </form>
        </div>
      </div>
    </div>
  )
}

// Remove shows what it touches first (lifecycle.removal_impact), then retires the lead.
function RemoveLeadDialog({ lead, api, write, busy, onClose }) {
  const [imp, setImp] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    api.get(`${BASE}/leads/${encodeURIComponent(lead.lead_id)}/impact`).then((r) => { if (live) setImp(r) }, (e) => { if (live) setErr(errText(e)) })
    return () => { live = false }
  }, [api, lead.lead_id])
  const lines = impactLines(imp, { bot: lead.kind === 'bot' })
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Remove ${lead.handle} from the team?`} maxWidth={520}>
      <div className="tm-form" data-testid="tm-remove-dialog">
        {err ? <div className="tm-field-err" role="alert">{err}</div> : !imp ? <div className="tm-muted">Checking what this touches…</div> : (
          <>
            <div className="tm-muted">Removing it from the team affects:</div>
            {lines.length > 0 && <ul className="tm-impact">{lines.map((x, i) => <li key={i} className={x.kind === 'warn' ? 'is-warn' : ''}>{x.kind === 'warn' ? <TriangleAlert size={14} /> : x.kind === 'keep' ? <Check size={14} /> : <Hash size={14} />}<span>{x.text}</span></li>)}</ul>}
            <div className="tm-muted">This takes it out of the team only. It stops getting team wakes and cannot post in team groups.</div>
          </>
        )}
        <div className="tm-dialog-actions">
          <Btn type="button" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn danger type="button" disabled={busy || !imp} data-testid="tm-remove-confirm"
            onClick={() => write(() => removeFromTeam(api, lead.lead_id, lead.kind === 'bot' ? lead.bot : ''), `${lead.handle} left the team; the Bot is kept`).then((ok) => { if (ok) onClose() })}>Remove from team</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ───────────────────────────────────────────────────────────── relay

function RelayView({ state, leads }) {
  const relays = allRelays(state)
  const byHandle = new Map([...leads.values()].map((l) => [l.handle, l]))
  return (
    <div className="tm-page">
      <div className="tm-card">
        <div className="tm-card-title"><Network size={15} />Tree relay<span className="tm-spacer" /><Approx kind="relay" /></div>
        <div className="tm-muted">Workers inside one tree do not join the group. To pass word, they go through their nearest common parent: W1 → C1 → W2. Each row below is a note a lead wrote with team_relay_note after passing word.</div>
      </div>
      {relays.length === 0 && <div className="tm-empty">No relay notes yet.</div>}
      {relays.map((r) => {
        const parent = byHandle.get(r.via_session)
        return (
          <div key={`${r.channel_id}:${r.seq}`} className="tm-card">
            <div className="tm-case-row"><Avatar who={r.by} leads={leads} size="sm" /><b style={{ color: 'var(--text-strong)' }}>{whoName(r.by, leads)}</b><span className="tm-muted">noted {fmtClock(r.ts)}</span></div>
            <div className="tm-relay">
              <div className="tm-node"><div className="tm-node-k">W1 · sender</div><div className="tm-node-v" title={r.from_session}>{r.from_session}</div></div>
              <span className="tm-arrow"><ArrowRight size={16} /></span>
              <div className="tm-node is-parent"><div className="tm-node-k">C1 · common parent</div><div className="tm-node-v" title={r.via_session}>{parent ? parent.handle : r.via_session}</div></div>
              <span className="tm-arrow"><ArrowRight size={16} /></span>
              <div className="tm-node"><div className="tm-node-k">W2 · receiver</div><div className="tm-node-v" title={r.to_session}>{r.to_session}</div></div>
            </div>
            <div className="tm-relay-sum tm-break">“{r.summary}”</div>
          </div>
        )
      })}
    </div>
  )
}

// ───────────────────────────────────────────────────────────── ledger

function LedgerView({ state }) {
  const rows = ledgerRows(state)
  const files = [...new Set(rows.map((r) => r.file))]
  const [file, setFile] = useState('')
  const [open, setOpen] = useState(null)
  const shown = rows.filter((r) => !file || r.file === file).slice(0, 300)
  return (
    <div className="tm-page" style={{ maxWidth: 1300 }}>
      <div className="tm-card">
        <div className="tm-card-title"><ScrollText size={15} />Raw ledger rows<span className="tm-muted" style={{ fontWeight: 400 }}>append-only, newest first, click a row for the full JSON</span><span className="tm-spacer" />
          <select className="tm-select" value={file} onChange={(e) => setFile(e.target.value)} aria-label="Filter by file">
            <option value="">All files</option>
            {files.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="tm-xscroll">
          <table className="tm-table tm-ledger">
            <thead><tr><th>File</th><th>seq</th><th>Time</th><th>type</th><th>by</th><th>data</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const k = `${r.file}:${r.seq}`
                return (
                  <tr key={k}>
                    <td className="tm-muted">{r.file}</td>
                    <td>{r.seq}</td>
                    <td className="tm-muted">{fmtClock(r.ts)}</td>
                    <td className="tm-type">{r.type}</td>
                    <td>{r.by}</td>
                    <td className={`tm-json ${open === k ? 'is-open' : ''}`} onClick={() => setOpen(open === k ? null : k)}>{JSON.stringify(r.data, null, open === k ? 2 : 0)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && <div className="tm-empty">No rows.</div>}
      </div>
    </div>
  )
}
