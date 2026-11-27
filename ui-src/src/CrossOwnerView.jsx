// Across owners: share a group with another owner's Team Mode (cross-owner phase 1).
// Everything here is owner-only on the backend (/api/apps/team-mode/cross*). The Slack
// token is sent once and never read back; the page only learns whether one is saved.
import { useCallback, useEffect, useState } from 'react'
import { useAppApi, useNotify } from '@kirocrew/app-sdk'
import { Btn, Badge, Input } from '@kirocrew/app-sdk/ui'
import { Check, Copy, KeyRound, Link2, LogOut, ShieldAlert, ShieldCheck, UserMinus, UserPlus, Users } from 'lucide-react'

const BASE = '/api/apps/team-mode'

const REASON = {
  screened: 'Withheld: failed content screening',
  bad_signature: 'Bad signature',
  not_admitted: 'Not admitted to this group',
  not_its_bot: 'Spoke for a Bot it did not bring',
  peer_rate: 'Over the hourly limit for this owner',
  bad_invite: 'Invite code not valid or already used',
  bad_proof: 'Invite proof did not match',
  bad_join: 'Join request malformed',
}

function reasonOf(e) {
  try { return JSON.parse(e?.body || '').reason || e?.message } catch { return e?.message || String(e) }
}

export function useCross(api) {
  const [cross, setCross] = useState(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setCross(await api.get(`${BASE}/cross`)); setError('') } catch (e) { setError(reasonOf(e)) }
  }, [api])
  useEffect(() => {
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 3000)
    return () => clearInterval(id)
  }, [load])
  return { cross, error, load }
}

export default function CrossOwnerView({ state, leads }) {
  const api = useAppApi()
  const notify = useNotify()
  const { cross, error, load } = useCross(api)
  const [busy, setBusy] = useState(false)
  const act = async (fn, ok) => {
    setBusy(true)
    try { const r = await fn(); if (ok) notify?.(ok, { type: 'success' }); await load(); return r } catch (e) {
      notify?.(`Failed: ${reasonOf(e)}`, { type: 'error' }); return null
    } finally { setBusy(false) }
  }
  if (!cross) return <div className="tm-empty">{error ? `Cannot read cross-owner state: ${error}` : 'Loading…'}</div>
  const groups = (state.channels || []).filter((c) => c.kind === 'group' && !c.closed && !c.mirror)
  const myBots = [...leads.values()].filter((l) => l.active !== false && l.kind === 'bot')
  return (
    <div className="tm-page" data-testid="tm-cross">
      <div className="tm-note is-info" role="status"><Users size={14} />
        <span>Share a group with another owner. The group stays on the gateway of the owner who made it. Each owner wakes only their own Bots, and another owner's Bot can never call a tool on this machine: its words reach your Bots as data.</span>
      </div>
      <div className="tm-page-grid">
        <div style={{ minWidth: 0 }}>
          <SetupCard cross={cross} busy={busy} act={act} api={api} />
          <JoinCard cross={cross} bots={myBots} busy={busy} act={act} api={api} />
          <JoinedCard cross={cross} busy={busy} act={act} api={api} />
        </div>
        <div style={{ minWidth: 0 }}>
          <HostCard cross={cross} groups={groups} busy={busy} act={act} api={api} />
          <PendingCard cross={cross} busy={busy} act={act} api={api} />
          <DroppedCard cross={cross} />
        </div>
      </div>
    </div>
  )
}

function SetupCard({ cross, busy, act, api }) {
  const [name, setName] = useState(cross.name || '')
  const [channel, setChannel] = useState(cross.channel || '')
  const [token, setToken] = useState('')
  return (
    <div className="tm-card" data-testid="tm-cross-setup">
      <div className="tm-card-title"><KeyRound size={15} />This gateway<span className="tm-spacer" />
        {cross.self && <span className="tm-mono tm-muted" title="This gateway's id in shared groups">{cross.self}</span>}</div>
      <label className="tm-field"><span>Your short name (others see your Bots as Name.yourname)</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="bob" data-testid="tm-cross-name" /></label>
      <label className="tm-field"><span>Slack private channel id both owners share</span>
        <Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0123456789" data-testid="tm-cross-channel" /></label>
      <label className="tm-field"><span>Bot token of your own Slack app (chat:write, groups:history) {cross.token_set && <Badge variant="ok">saved</Badge>}</span>
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cross.token_set ? 'saved; paste to replace' : 'xoxb-…'} data-testid="tm-cross-token" /></label>
      <Btn primary disabled={busy || !name || !channel} data-testid="tm-cross-save"
        onClick={() => act(() => api.post(`${BASE}/cross/setup`, { name, channel, ...(token ? { token } : {}) }), 'Saved').then(() => setToken(''))}>Save</Btn>
      <div className="tm-muted" style={{ marginTop: 6 }}>The token is stored in this app's data folder (0600) and never shown again.</div>
    </div>
  )
}

function HostCard({ cross, groups, busy, act, api }) {
  const [room, setRoom] = useState('')
  const [code, setCode] = useState('')
  const hosted = new Map(cross.hosted.map((h) => [h.room, h]))
  return (
    <div className="tm-card" data-testid="tm-cross-host">
      <div className="tm-card-title"><Link2 size={15} />Groups I host</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select className="tm-select" value={room} onChange={(e) => setRoom(e.target.value)} data-testid="tm-cross-room">
          <option value="">Pick a group…</option>
          {groups.map((g) => <option key={g.id} value={g.id}>#{g.title}</option>)}
        </select>
        <Btn disabled={busy || !room || !cross.name} data-testid="tm-cross-invite"
          onClick={() => act(() => api.post(`${BASE}/cross/invite`, { channel_id: room })).then((r) => r && setCode(r.code))}>Make invite code</Btn>
      </div>
      {code && (
        <div className="tm-note is-info" style={{ marginTop: 8 }} data-testid="tm-cross-code">
          <span>Send this one-time code to the other owner yourself (not through a Bot). It works once, for 24 hours.</span>
          <code className="tm-mono tm-break" style={{ display: 'block', marginTop: 6 }}>{code}</code>
          <Btn onClick={() => navigator.clipboard?.writeText(code)}><Copy size={13} />Copy</Btn>
        </div>
      )}
      {[...hosted.values()].map((h) => (
        <div key={h.room} className="tm-bot-row" data-testid="tm-cross-hosted">
          <div className="tm-bot-main">
            <div style={{ fontWeight: 600 }}>#{h.title} <Badge variant="info">shared</Badge></div>
            {h.peers.length === 0 && h.requests.length === 0 && <div className="tm-muted">Nobody joined yet.</div>}
            {h.requests.map((q) => (
              <div key={q.peer} className="tm-cross-line" data-testid="tm-cross-request">
                <UserPlus size={13} /><b>{q.name}</b> asks to join with {q.bots.join(', ')}
                <Btn primary disabled={busy} data-testid="tm-cross-admit"
                  onClick={() => act(() => api.post(`${BASE}/cross/admit`, { peer: q.peer, room: h.room }), `${q.name}'s Bots joined`)}>Admit</Btn>
                <Btn disabled={busy} onClick={() => act(() => api.post(`${BASE}/cross/admit`, { peer: q.peer, room: h.room, approve: false }), 'Declined')}>Decline</Btn>
              </div>
            ))}
            {h.peers.map((p) => (
              <div key={p.peer} className="tm-cross-line" data-testid="tm-cross-peer">
                <Check size={13} /><b>{p.name}</b>: {p.bots.join(', ') || 'no Bots'}{p.trusted && <Badge variant="ok">may @ my Bots</Badge>}
                <Btn disabled={busy} data-testid="tm-cross-remove"
                  onClick={() => act(() => api.post(`${BASE}/cross/remove`, { peer: p.peer, room: h.room }), `${p.name} removed`)}><UserMinus size={13} />Remove</Btn>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function JoinCard({ cross, bots, busy, act, api }) {
  const [code, setCode] = useState('')
  const [picked, setPicked] = useState([])
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(0, 3)))
  return (
    <div className="tm-card" data-testid="tm-cross-join">
      <div className="tm-card-title"><UserPlus size={15} />Join another owner's group</div>
      <label className="tm-field"><span>Invite code they sent you</span>
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="tmi1.…" data-testid="tm-cross-join-code" /></label>
      <div className="tm-muted" style={{ margin: '6px 0' }}>Which of your Bots go in (up to 3):</div>
      {bots.length === 0 && <div className="tm-muted">Add a Bot on Members first.</div>}
      {bots.map((b) => (
        <label key={b.lead_id} className="tm-check" data-testid="tm-cross-join-bot">
          <input type="checkbox" checked={picked.includes(b.lead_id)} onChange={() => toggle(b.lead_id)} /> {b.handle}
        </label>
      ))}
      <Btn primary disabled={busy || !code || !picked.length || !cross.name} data-testid="tm-cross-join-send"
        onClick={() => act(() => api.post(`${BASE}/cross/join`, { code: code.trim(), bots: picked }), 'Asked to join. The host owner must admit you.').then((r) => { if (r) { setCode(''); setPicked([]) } })}>Ask to join</Btn>
    </div>
  )
}

function JoinedCard({ cross, busy, act, api }) {
  if (!cross.joined.length) return null
  const label = { joined: 'joined', left: 'left', removed: 'removed by host' }
  return (
    <div className="tm-card" data-testid="tm-cross-joined">
      <div className="tm-card-title"><Users size={15} />Groups I joined</div>
      {cross.joined.map((j) => (
        <div key={j.room} className="tm-cross-line" data-testid="tm-cross-joined-row">
          <b>#{j.title}</b> · host {j.hub_name} · {j.bots.join(', ')} · <Badge variant={j.state === 'joined' ? (j.synced ? 'ok' : 'warn') : 'err'}>
            {j.state === 'joined' && !j.synced ? 'waiting for the host to admit' : label[j.state]}</Badge>
          {j.state === 'joined' && <Btn disabled={busy} onClick={() => act(() => api.post(`${BASE}/cross/rooms/${j.room}/leave`, {}), 'Left the group')}><LogOut size={13} />Leave</Btn>}
        </div>
      ))}
    </div>
  )
}

function PendingCard({ cross, busy, act, api }) {
  if (!cross.pending.length) return null
  const answer = (p, approve, trust) => act(() => api.post(`${BASE}/cross/pending/${p.pending_id}/answer`, { approve, trust }),
    approve ? 'Let through' : 'Declined')
  return (
    <div className="tm-card is-warn" data-testid="tm-cross-pending">
      <div className="tm-card-title"><ShieldCheck size={15} />Another owner's Bot wants to give your Bots work</div>
      {cross.pending.map((p) => (
        <div key={p.pending_id} className="tm-cross-line" data-testid="tm-cross-pending-row">
          <div><b>{p.name}</b> in #{p.title} @ {p.mentions.join(', ')}: <span className="tm-break">{p.text}</span></div>
          <Btn primary disabled={busy} onClick={() => answer(p, true, true)} data-testid="tm-cross-trust">Allow, and trust {p.name}</Btn>
          <Btn disabled={busy} onClick={() => answer(p, true, false)}>Allow once</Btn>
          <Btn disabled={busy} onClick={() => answer(p, false, false)}>Decline</Btn>
        </div>
      ))}
    </div>
  )
}

function DroppedCard({ cross }) {
  if (!cross.dropped.length) return null
  return (
    <div className="tm-card" data-testid="tm-cross-dropped">
      <div className="tm-card-title"><ShieldAlert size={15} />Held back from your Bots</div>
      {cross.dropped.map((d, i) => (
        <div key={i} className="tm-cross-line" data-testid="tm-cross-dropped-row">
          <Badge variant="err">{REASON[d.reason] || d.reason}</Badge>
          <span className="tm-muted">{new Date(d.ts * 1000).toLocaleTimeString()}</span>
          {d.sample && <span className="tm-mono tm-break">{d.sample}</span>}
        </div>
      ))}
    </div>
  )
}
