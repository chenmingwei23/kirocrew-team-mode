// Where the "Leads now" card gets its list of leads and how a card opens a lead's
// own chat. Kept apart from the status rules (leadsNow.js) so the lead list can
// come from the host's Bots without touching them.
//
// Leads already exist: a lead is a Bot the owner added (D2/D6), or, for now, an
// old `lead` agent chat kept as "Legacy lead". This layer only reads; it never
// creates anyone.

import { leadForBot } from './botSource.js'
import { shortHandle } from './model.js'

/**
 * `[{ id, name, project, legacy, workers }]` for every active lead.
 *
 * - `id`: the app directory's lead id (`L-…`), the ledger key. Never shown.
 * - `name`: the Bot's live name (botSource.js `name`), else the lead's handle.
 * - `project`: the Bot's live project (its workspace), else the project recorded
 *   when the Bot was added; null shows no project.
 * - `legacy`: true for a lead that is not a Bot (registered with kind `chat`).
 * - `workers`: the Bot's worker list, or null when unknown.
 *
 * `bots` is botSource.js `botRows(...)` (useBots.js), joined to a lead the way
 * botSource.js `leadForBot` does it (crew key `bot`, else the Bot chat's session
 * label). Leave it out (or null) while it is not loaded.
 */
export function leadRoster(state, bots = null) {
  const leads = (state?.leads || []).filter((l) => l.active !== false)
  const botOf = new Map()
  for (const b of bots || []) {
    const l = leadForBot(b, leads)
    if (l && l.kind === 'bot') botOf.set(l.lead_id, b)
  }
  return leads.map((l) => {
    const b = botOf.get(l.lead_id)
    return {
      id: l.lead_id,
      name: b?.name || shortHandle(l.handle) || 'lead',
      project: b?.project || l.project || null,
      legacy: l.kind !== 'bot',
      workers: b?.workers ?? null,
    }
  })
}

/**
 * Where to send the owner when a card has no group or thread to open (for example
 * "No indicator fired"). `null` means the card does not open anything.
 *
 * shortcut: returns null; opening a Bot's own chat from an app page has no host
 * route yet (needs D1 or a host open-chat hook).
 */
export function leadChatTarget(/* lead */) {
  return null
}
