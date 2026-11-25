// The "Team Mode" tab on a Bot's page (app.json contributes.panelTabs). The host
// mounts it with the Bot's own chat as the request's X-Session-Key, so the tab knows
// which Bot it is on without asking. It shows which Team Mode groups this Bot is in,
// adds it to a group, and takes it out of the team. It never deletes the Bot.

import { useCallback, useEffect, useState } from 'react'
import { useAppApi, useAppInfo, useNavigate, useNotify } from '@kirocrew/app-sdk'
import { Btn, Modal, Toggle } from '@kirocrew/app-sdk/ui'
import { Check, Hash, Plus, TriangleAlert, Users } from 'lucide-react'
import css from './styles.css?inline'
import { addBody, addBotError, botGroups, CHAT_TOOLS, chatToolsBody, chatToolsError, chatToolsSwitch, groupError, removeFromTeam } from './botSource.js'
import { useBots } from './useBots.js'
import { errText, impactLines } from './model.js'

const BASE = '/api/apps/team-mode'

export default function TeamModePanel() {
  const api = useAppApi()
  const info = useAppInfo()
  const notify = useNotify()
  const navigate = useNavigate()
  const [me, setMe] = useState(null) // { bot, slot_key, lead_id }
  const [state, setState] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState('')
  const [removing, setRemoving] = useState(false)
  const { bots } = useBots(api)
  const active = info?.active !== false

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.get(`${BASE}/panel`), api.get(`${BASE}/state`)])
      setMe(p)
      setState(s)
      setErr('')
    } catch (e) {
      setErr(e?.message || String(e))
    }
  }, [api])
  useEffect(() => {
    if (!active) return undefined
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 5000)
    return () => clearInterval(id)
  }, [load, active])

  const act = async (fn, ok, toText) => {
    setBusy(true)
    try {
      await fn()
      if (ok) notify?.(ok, { type: 'success' })
      await load()
      return true
    } catch (e) {
      const msg = toText(e)
      setErr(msg)
      notify?.(msg, { type: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const bot = me?.slot_key ? (bots || []).find((b) => b.slot_key === me.slot_key) : null
  const name = bot?.name || 'This Bot'
  const groups = botGroups(state, me?.lead_id)

  return (
    <div className="tm" data-testid="tm-panel">
      <style>{css}</style>
      <div className="tm-panel">
        <div className="tm-card-title"><Users size={15} />Team Mode</div>
        {err && <div className="tm-field-err" role="alert">{err}</div>}
        {!me && !err && <div className="tm-muted">Loading…</div>}
        {me && !me.bot && <div className="tm-muted">Open this tab on a Bot's page to see its Team Mode groups.</div>}
        {me?.bot && !me.lead_id && (
          <>
            <div className="tm-muted">{name} is not in the team. A Bot in the team can be added to group chats with Bots from other projects.</div>
            <div><Btn primary disabled={busy || !bot} data-testid="tm-panel-join"
              onClick={() => act(() => api.post(`${BASE}/leads`, addBody(bot)), `${name} joined the team`, addBotError)}>Add to team</Btn></div>
          </>
        )}
        {me?.bot && me.lead_id && (
          <>
            <div className="tm-muted">{bot?.project ? `Project: ${bot.project}. ` : ''}{name} is in {groups.in.length} group{groups.in.length === 1 ? '' : 's'}.</div>
            <div data-testid="tm-panel-groups">
              {groups.in.length === 0 && <div className="tm-muted">No groups yet.</div>}
              {groups.in.map((g) => (
                <div key={g.id} className="tm-panel-row"><Hash size={13} /><span className="tm-break" style={{ flex: 1 }}>{g.title}</span><span className="tm-muted">{(g.members || []).length} leads</span></div>
              ))}
            </div>
            {groups.in.length > 1 && <div className="tm-note is-info"><TriangleAlert size={14} /><span>One memory for all {groups.in.length} groups: what it reads in one group can come up in another.</span></div>}
            <div>
              <label className="tm-label" htmlFor="tm-panel-pick">Add to group</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select id="tm-panel-pick" className="tm-select" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || groups.open.length === 0} style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                  <option value="">{groups.open.length === 0 ? 'No other groups' : 'Choose a group…'}</option>
                  {groups.open.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                </select>
                <Btn primary disabled={busy || !pick} data-testid="tm-panel-add"
                  onClick={() => act(() => api.post(`${BASE}/groups/${encodeURIComponent(pick)}/members`, { add: [me.lead_id] }),
                    `${name} was added to #${groups.open.find((g) => g.id === pick)?.title || 'the group'}`, groupError).then((ok) => { if (ok) setPick('') })}><Plus size={13} />Add</Btn>
              </div>
            </div>
            {bot?.bot && <ChatToolsSwitch api={api} crew={bot.bot} name={name} leadId={me.lead_id} notify={notify} />}
            <div><Btn danger disabled={busy} data-testid="tm-panel-remove" onClick={() => setRemoving(true)}>Remove from team</Btn></div>
            <div className="tm-muted">Remove takes {name} out of the team only. The Bot is kept.</div>
            {removing && <RemoveDialog api={api} leadId={me.lead_id} name={name} busy={busy} onClose={() => setRemoving(false)}
              onConfirm={() => act(() => removeFromTeam(api, me.lead_id, bot?.bot || ''), `${name} left the team; the Bot is kept`, addBotError).then(() => setRemoving(false))} />}
          </>
        )}
        <div className="tm-muted"><a href="/apps/team-mode" className="tm-link" onClick={(e) => { e.preventDefault(); navigate('/apps/team-mode') }}>Open Team Mode</a></div>
      </div>
    </div>
  )
}

// The owner's switch for Team Mode tools in this Bot's OWN chat. It ticks or unticks
// this Bot in the host's owner-only list (`PUT /api/apps/team-mode/bot-grants`), the
// same list as "Bots this app can reach" on the app's page: the host decides what a
// Bot's chat mounts. Disabled until the owner approves the `tools` scope. Each flip
// asks first, since on lets Team Mode wake the Bot and off starts its chat afresh.
function ChatToolsSwitch({ api, crew, name, leadId, notify }) {
  const url = CHAT_TOOLS
  const [view, setView] = useState(null)
  const [ask, setAsk] = useState(null) // the value the owner is being asked to confirm
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    api.get(url).then((v) => { if (live) setView(v) }, () => { if (live) setView(null) })
    return () => { live = false }
  }, [api, url])
  const { show, approved, on } = chatToolsSwitch(view, crew)
  if (!show) return null
  const confirm = async () => {
    const next = ask
    setBusy(true)
    setErr('')
    try {
      setView(await api.put(url, chatToolsBody(view, crew, next)))
      // Turned on: hang the inbox probe on the Bot's chat now (the host refused it until now).
      if (next && leadId) await api.post(`${BASE}/leads/${encodeURIComponent(leadId)}/wake`, {}).catch(() => null)
      notify?.(next ? `${name} can now answer the team from its own chat` : `Team Mode tools are off for ${name}`, { type: 'success' })
      setAsk(null)
    } catch (e) {
      setErr(chatToolsError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="tm-panel-switch" data-testid="tm-panel-chat-tools">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>
          <span className="tm-label" style={{ display: 'block', margin: 0 }}>Answer from its own chat</span>
          <span className="tm-muted">{!approved
            ? "Approve Team Mode's Bot tools access on its app page first."
            : on ? `On: ${name} is woken in its own chat when the team needs it.` : 'Off: Team Mode cannot wake this Bot.'}</span>
        </span>
        <span data-testid="tm-panel-chat-tools-toggle" data-on={on ? 'true' : 'false'}>
          <Toggle checked={on} disabled={busy || (!approved && !on)} label="Answer from its own chat" onChange={(v) => setAsk(v)} />
        </span>
      </div>
      {ask !== null && (
        <Modal open onClose={busy ? () => {} : () => { setAsk(null); setErr('') }}
          title={ask ? `Let ${name} answer the team from its own chat?` : `Turn off Team Mode tools for ${name}?`} maxWidth={480}>
          <div className="tm-form" data-testid="tm-panel-chat-tools-dialog">
            <ul className="tm-impact">
              {(ask ? [
                `${name}'s own chat gets the Team Mode tools.`,
                `When someone @-mentions ${name} in a group, Team Mode wakes that chat. Each wake is a full turn and uses credits.`,
                'You can turn this off at any time.',
              ] : [
                `${name}'s chat loses the Team Mode tools, and its wake job is removed.`,
                'Its next turn starts a fresh conversation. The messages stay visible.',
                `${name} stays in the team and in its groups.`,
              ]).map((t, i) => <li key={i}><Check size={14} /><span>{t}</span></li>)}
            </ul>
            {err && <div className="tm-field-err" role="alert">{err}</div>}
            <div className="tm-dialog-actions">
              <Btn type="button" disabled={busy} onClick={() => { setAsk(null); setErr('') }}>Cancel</Btn>
              <Btn primary={ask} danger={!ask} type="button" disabled={busy} data-testid="tm-panel-chat-tools-confirm" onClick={confirm}>{ask ? 'Turn on' : 'Turn off'}</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function RemoveDialog({ api, leadId, name, busy, onClose, onConfirm }) {
  const [imp, setImp] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    api.get(`${BASE}/leads/${encodeURIComponent(leadId)}/impact`).then((r) => { if (live) setImp(r) }, (e) => { if (live) setErr(errText(e)) })
    return () => { live = false }
  }, [api, leadId])
  const lines = impactLines(imp, { bot: true })
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Remove ${name} from the team?`} maxWidth={480}>
      <div className="tm-form" data-testid="tm-panel-remove-dialog">
        {err ? <div className="tm-field-err" role="alert">{err}</div> : !imp ? <div className="tm-muted">Checking what this touches…</div> : (
          <ul className="tm-impact">{lines.map((x, i) => <li key={i} className={x.kind === 'warn' ? 'is-warn' : ''}>{x.kind === 'warn' ? <TriangleAlert size={14} /> : x.kind === 'keep' ? <Check size={14} /> : <Hash size={14} />}<span>{x.text}</span></li>)}</ul>
        )}
        <div className="tm-dialog-actions">
          <Btn type="button" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn danger type="button" disabled={busy || !imp} data-testid="tm-panel-remove-confirm" onClick={onConfirm}>Remove from team</Btn>
        </div>
      </div>
    </Modal>
  )
}
