// Stage bar for one agenda item: Proposed -> Evidence -> Discussion -> Decided -> Actions.
//
// Computed by fixed rules from the meeting fold the page already has (GET /state
// `meetings[]`, built by teamapp/meeting.py fold_meeting from the channel rows):
// the item's speeches, sealed round 1, proposals, ballots, outcome and the meeting's
// action items. No model reports a stage; no text is read.
//
// "Needs you" has one source for the whole app: the open decisions of
// needsYou.js waitingOnYou(state) (decisions.jsonl). An item needs you when one of
// them points at it (`meeting_id` + `item_id`). An action item waits for the attendee
// it was given to, not for you, so it is shown as "Waiting on <name>" and never as
// Needs you.

export const STAGES = [
  ['proposed', 'Proposed'],
  ['evidence', 'Evidence'],
  ['discussion', 'Discussion'],
  ['decided', 'Decided'],
  ['actions', 'Actions'],
]

/** True when an open decision in *waiting* (= waitingOnYou(state)) points at this item. */
export function itemNeedsYou(item, meeting, waiting) {
  return (waiting || []).some((d) => d.state === 'open' && d.meeting_id === meeting?.meeting_id
    && d.item_id === item?.item_id)
}

/** Agenda items of *meeting* that wait on you. */
export function meetingNeedsYou(meeting, waiting) {
  return (meeting?.agenda || []).filter((a) => itemNeedsYou(a, meeting, waiting))
}

/**
 * Steps for *item* of *meeting*.
 * `waiting` is waitingOnYou(state).
 * Returns `{ steps: [{ key, label, state, note }], current, needsYou }` where state is
 * 'done' | 'current' | 'todo' | 'skipped', `current` is the key of the current step
 * (null before the item opens and once every step is done or skipped), and `note`
 * is a short plain-English hint for the current step (or '').
 * `nameOf(who)` turns an attendee id into a display name.
 */
export function itemStages(item, meeting, nameOf = (w) => w, waiting = []) {
  const ballots = Object.values(item?.ballots || {})
  const r1 = item?.rounds?.['1']
  const opened = !!item && item.state !== 'pending'
  const decided = !!item?.outcome
  const presented = decided || (item?.round || 0) >= 2 || ballots.length > 0
    || (item?.speeches || []).some((s) => s.round === 1)
  const evidenced = decided || (item?.round || 0) >= 2 || ballots.some((b) => b.state === 'closed')
    || !!(r1 && (r1.revealed || r1.ended))
  const actions = (meeting?.actions || []).filter((a) => a.item_id && a.item_id === item?.item_id)
  const open = actions.filter((a) => a.state === 'proposed')
  const live = ['open', 'adjourning'].includes(meeting?.state)

  const done = { proposed: presented, evidence: evidenced, discussion: decided, decided, actions: false }
  let actionsState = 'todo'
  if (decided) {
    if (!actions.length || (!live && open.length === actions.length)) actionsState = 'skipped'
    else actionsState = open.length && live ? 'current' : 'done'
  }

  const needsYou = itemNeedsYou(item, meeting, waiting)
  let current = null
  const steps = STAGES.map(([key, label]) => {
    let state
    if (key === 'actions') state = actionsState
    else if (done[key]) state = 'done'
    else if (opened && current === null && item.state === 'open') state = 'current'
    else state = 'todo'
    if (state === 'current') current = key
    return { key, label, state, note: '' }
  })

  const cur = steps.find((s) => s.state === 'current')
  if (cur) {
    if (needsYou) cur.note = 'Needs you'
    else if (cur.key === 'actions') cur.note = `Waiting on ${[...new Set(open.map((a) => nameOf(a.owner)))].join(', ')}`
    else if (item.br_needed?.length) cur.note = 'Bar raiser'
    else if (item.ballot_open) cur.note = 'Voting'
    else if (cur.key === 'evidence' && r1?.sealed && !r1?.revealed) cur.note = 'Sealed'
  }
  return { steps, current: cur ? cur.key : null, needsYou }
}
