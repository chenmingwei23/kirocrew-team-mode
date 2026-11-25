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

/** The host's owner-only list of the Bots ticked for this app (`permissions.bots`).
 *  A ticked Bot's own chat carries this app's `contributes.botChatServers` once the
 *  owner approved the `tools` scope and the `bot_chat_app_tools` preview is on. */
export const CHAT_TOOLS = '/api/apps/team-mode/bot-grants'

/** `{show, approved, on}` for one Bot's switch from the host's `GET` answer
 *  (`{bots, declaredScopes, scopes}`). Hidden unless the manifest declares `tools`;
 *  `approved` is false until the owner approves that scope on the app's page. */
export function chatToolsSwitch(view, crew) {
  const declared = Array.isArray(view?.declaredScopes) ? view.declaredScopes : []
  const scopes = Array.isArray(view?.scopes) ? view.scopes : []
  const bots = Array.isArray(view?.bots) ? view.bots : []
  return { show: declared.includes('tools'), approved: scopes.includes('tools'), on: !!crew && bots.includes(crew) }
}

/** The `PUT` body that ticks or unticks one Bot and keeps every other ticked Bot. */
export function chatToolsBody(view, crew, on) {
  const others = (Array.isArray(view?.bots) ? view.bots : []).filter((b) => b !== crew)
  return { bots: on ? [...others, crew] : others }
}

/**
 * Remove takes a Bot out of the team, and nothing it was given for the team stays
 * behind: retire the lead (the backend also drops its wake job), then untick the Bot
 * for this app so its own chat loses the team tools. The list is the host's owner-only
 * route, which the app backend cannot write, so the page does it with the owner's
 * session. Other ticked Bots are kept. A legacy lead (`crew` empty) has no switch.
 */
export async function removeFromTeam(api, leadId, crew) {
  await api.del(`/api/apps/team-mode/leads/${encodeURIComponent(leadId)}`)
  if (!crew) return
  const view = await api.get(CHAT_TOOLS)
  if (chatToolsSwitch(view, crew).on) await api.put(CHAT_TOOLS, chatToolsBody(view, crew, false))
}

const CHAT_TOOLS_ERRORS = {
  app_not_installed: 'Team Mode is not installed.',
  owner_only: 'Only the owner can change this.',
  invalid_bot_grants: 'Too many Bots are ticked for Team Mode.',
  bot_grants_not_saved: 'Bot access was not saved. Try again.',
}

/** Plain English for a refusal from `PUT /api/apps/team-mode/bot-grants`. */
export function chatToolsError(err) {
  const text = String(err?.body || err?.message || err || '')
  const m = text.match(/"code"\s*:\s*"([a-z_]+)"/)
  return (m && CHAT_TOOLS_ERRORS[m[1]]) || 'Could not change the switch. Try again.'
}
