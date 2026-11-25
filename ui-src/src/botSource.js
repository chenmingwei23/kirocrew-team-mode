// The one place Team Mode reads the host's Bots. Leads are Bots that already exist;
// this file only reads them and never creates one.
//
// The app backend cannot read these routes (an app token gets 404 from
// `_deny_app_caller`), so the page reads them with the owner's own session through
// the app API (`permissions.api` declares the three paths):
//   GET /api/members                          -> { members: MemberRosterRow[] }
//   GET /api/workspaces                       -> { workspaces: [{name, path, is_default}], default }
//   GET /api/chat/slots/<slot_key>/crew-workers -> { root, workers: [...], root_kind }
// `botRows` turns those three answers into one row per Bot. It is pure, so the tree
// canvas and Leads now read the same rows.

/** A roster row is a Bot when it is not the always-present `default` row and not a
 *  builtin (round3-bot-reuse §11.1). */
export function isBot(row) {
  return !!row && typeof row.name === 'string' && row.name !== 'default' && row.source !== 'builtin'
}

/** Mirrors `teamapp/identity.py:bot_handle`: display name, else crew key, made
 *  mention-safe. */
export function botHandle(row) {
  const raw = String(row?.display_name || '').trim() || String(row?.name || '').trim()
  return raw.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)
}

/** One crew-workers row in the shape the tree reads. */
function workerRow(w) {
  return {
    key: String(w?.key || ''),
    title: String(w?.title || ''),
    status: String(w?.status || ''),
    // The host's side-panel group (done, working, with_conductor, ...): the tree's label.
    group: String(w?.group || ''),
    dispatched_by: String(w?.dispatched_by || ''),
  }
}

/**
 * `[{ handle, name, bot, slot_key, session_label, project, project_path, description,
 *     running, last_active_ts, workers }]`, sorted by name.
 *
 * - `name` is what people read (display name, else crew key); `bot` is the crew key.
 * - `project` is the Bot's workspace name; an empty workspace means the default one
 *   (`workspaces.default`). `project_path` is that workspace's path, or null.
 * - `slot_key` is '' for a Bot whose chat was never opened (it cannot be added yet).
 * - `workers` is the Bot's own worker list from crew-workers when that call answered
 *   200, else null: no data is shown as no data, never as "no workers".
 *
 * `workersBySlot` maps slot_key -> the crew-workers JSON body (or null/undefined when
 * the call failed or was not made).
 */
export function botRows(members, workspaces, workersBySlot) {
  const rows = Array.isArray(members?.members) ? members.members : Array.isArray(members) ? members : []
  const wsList = Array.isArray(workspaces?.workspaces) ? workspaces.workspaces : []
  const wsDefault = typeof workspaces?.default === 'string' ? workspaces.default : ''
  const paths = new Map(wsList.map((w) => [w.name, w.path || null]))
  const byslot = workersBySlot || {}
  return rows.filter(isBot).map((m) => {
    const slot = typeof m.slot_key === 'string' ? m.slot_key : ''
    const project = String(m.workspace || '') || wsDefault
    const body = slot ? byslot[slot] : null
    return {
      handle: botHandle(m),
      name: String(m.display_name || '').trim() || m.name,
      bot: m.name,
      slot_key: slot,
      session_label: slot ? `dashboard:${slot}` : '',
      project,
      project_path: paths.get(project) ?? null,
      description: String(m.description || ''),
      running: !!m.running,
      last_active_ts: typeof m.last_active_ts === 'number' ? m.last_active_ts : null,
      workers: body && Array.isArray(body.workers) ? body.workers.map(workerRow) : null,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** The team's lead for a Bot row (an active `kind: bot` lead with the same crew key
 *  or the same chat), or undefined. */
export function leadForBot(bot, leads) {
  return [...(leads?.values?.() || leads || [])].find((l) => l.active !== false
    && (l.bot === bot.bot || (bot.session_label && l.session_label === bot.session_label)))
}

/** `{ kind, label }` a page shows for a lead: Bot, or the old lead chat. */
export function leadKind(lead) {
  return lead?.kind === 'bot' ? { kind: 'bot', label: 'Bot' } : { kind: 'legacy', label: 'Legacy lead' }
}

/** What Add does for one Bot row: `{ ok: true }` or `{ ok: false, why }` in plain words. */
export function addCheck(bot, leads) {
  if (!bot.slot_key) return { ok: false, why: 'Open this Bot once on the Bots page first.' }
  if (leadForBot(bot, leads)) return { ok: false, why: 'Already in the team.' }
  if (!bot.handle) return { ok: false, why: 'This Bot has no usable name.' }
  const clash = [...(leads?.values?.() || leads || [])].find((l) => l.active !== false && l.handle === bot.handle)
  if (clash) return { ok: false, why: `A lead named ${bot.handle} is already in the team.` }
  return { ok: true }
}

const ADD_ERRORS = {
  already_in_team: 'This Bot is already in the team.',
  handle_taken: 'Another lead in the team already has this name. Rename one of the Bots first.',
  not_a_bot: 'That is not a Bot chat. Open the Bot once on the Bots page, then try again.',
  bad_bot: 'That Bot name cannot be used here.',
  bad_handle: 'This Bot has no usable name. Give it a display name on the Bots page.',
  bad_project: 'This Bot\'s project name cannot be used here.',
  unknown_lead: 'That lead is not in the team any more.',
}

/** Plain English for a refusal from POST /leads or DELETE /leads/{id}. */
export function addBotError(err) {
  const text = String(err?.body || err?.message || err || '')
  const m = text.match(/"reason"\s*:\s*"([a-z_]+)"/)
  const code = m ? m[1] : ''
  return ADD_ERRORS[code] || `Could not add the Bot${code ? ` (${code.replace(/_/g, ' ')})` : ''}. Try again.`
}

/** POST /leads body for a Bot row. */
export function addBody(bot) {
  return { bot: bot.bot, slot_key: bot.slot_key, display_name: bot.name === bot.bot ? '' : bot.name, project: bot.project }
}

/** Bot rows of one core Bot team (`GET /api/teams` row: `{members: [crew key]}`) that
 *  are already leads, as lead ids, in team order. */
export function teamLeadIds(team, leads) {
  const list = [...(leads?.values?.() || leads || [])].filter((l) => l.active !== false && l.kind === 'bot')
  return (team?.members || []).map((key) => list.find((l) => l.bot === key)?.lead_id).filter(Boolean)
}

/** For the Bot page tab: `{ in: [group], open: [group] }`. `in` = open groups this
 *  lead is a member of; `open` = open groups it could be added to. A Team Mode group
 *  lives in this app's ledger only, apart from the host's Bot teams, so one Bot can
 *  be in any number of groups (D5a). Closed groups and DMs are left out. */
export function botGroups(state, leadId) {
  const groups = (state?.channels || []).filter((c) => c.kind === 'group' && !c.closed)
  const has = (c) => !!leadId && (c.members || []).includes(leadId)
  return { in: groups.filter(has), open: groups.filter((c) => !has(c)) }
}

const GROUP_ERRORS = {
  group_size: 'A group has 2 to 6 leads. This one is full.',
  group_closed: 'That group is closed.',
  no_such_channel: 'That group is gone.',
  not_a_lead: 'This Bot is not in the team any more.',
  not_allowed: 'Only the owner can change this group.',
}

/** Plain English for a refusal from POST /groups/{id}/members. */
export function groupError(err) {
  const text = String(err?.body || err?.message || err || '')
  const m = text.match(/"reason"\s*:\s*"([a-z_]+)"/)
  return (m && GROUP_ERRORS[m[1]]) || 'Could not change the group. Try again.'
}

/** The host's per-Bot app-tool switch (`/api/bot-chat-app-tools/{bot}`) and the ref of
 *  this app's offer (app.json `contributes.botChatServers`). */
export const CHAT_TOOLS = '/api/bot-chat-app-tools'
export const CHAT_TOOLS_REF = 'team-mode:team'

/** `{show, on}` for the switch from the host's `GET` answer. Hidden unless the host's
 *  preview is on AND it lists this app's offer: preview off shows no switch at all. */
export function chatToolsSwitch(view) {
  const offered = Array.isArray(view?.offered) ? view.offered : []
  const enabled = Array.isArray(view?.enabled) ? view.enabled : []
  return { show: view?.preview === true && offered.includes(CHAT_TOOLS_REF), on: enabled.includes(CHAT_TOOLS_REF) }
}

/** The `PUT` body that turns this app's server on or off and keeps any other app's. */
export function chatToolsBody(view, on) {
  const others = (Array.isArray(view?.enabled) ? view.enabled : []).filter((r) => r !== CHAT_TOOLS_REF)
  return { servers: on ? [...others, CHAT_TOOLS_REF] : others }
}

/**
 * Remove takes a Bot out of the team, and nothing it was given for the team stays
 * behind: retire the lead (the backend also drops its wake job), then turn Team Mode's
 * tools off in the Bot's own chat. The switch is the host's owner-only route, which the
 * app backend cannot write, so the page does it with the owner's session. Another app's
 * tools on the same Bot are kept. A legacy lead (`crew` empty) has no switch.
 */
export async function removeFromTeam(api, leadId, crew) {
  await api.del(`/api/apps/team-mode/leads/${encodeURIComponent(leadId)}`)
  if (!crew) return
  const url = `${CHAT_TOOLS}/${encodeURIComponent(crew)}`
  const view = await api.get(url)
  if (chatToolsSwitch(view).on) await api.put(url, chatToolsBody(view, false))
}

const CHAT_TOOLS_ERRORS = {
  preview_off: 'The Bot chat app tools preview is off.',
  not_offered: 'Team Mode is not enabled, so it has no tools to offer.',
  owner_only: 'Only the owner can change this.',
  no_such_bot: 'This Bot is gone.',
}

/** Plain English for a refusal from `PUT /api/bot-chat-app-tools/{bot}`. */
export function chatToolsError(err) {
  const text = String(err?.body || err?.message || err || '')
  const m = text.match(/"code"\s*:\s*"([a-z_]+)"/)
  return (m && CHAT_TOOLS_ERRORS[m[1]]) || 'Could not change the switch. Try again.'
}
