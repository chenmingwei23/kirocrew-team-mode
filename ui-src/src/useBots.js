// React hook over botSource.js: reads the host's Bots with the owner's session and
// keeps them fresh. `withWorkers` also reads each opened Bot's crew-workers (the tree
// canvas wants it; the Members page does not).

import { useCallback, useEffect, useState } from 'react'
import { botRows } from './botSource.js'

const REFRESH_MS = 10000

export async function loadBots(api, { withWorkers = false } = {}) {
  const [members, workspaces, teams] = await Promise.all([
    api.get('/api/members'),
    api.get('/api/workspaces').catch(() => null),
    api.get('/api/teams').catch(() => null),
  ])
  let workers = {}
  if (withWorkers) {
    const slots = (members?.members || []).map((m) => m.slot_key).filter(Boolean)
    const bodies = await Promise.all(slots.map((s) =>
      api.get(`/api/chat/slots/${encodeURIComponent(s)}/crew-workers`).catch(() => null)))
    workers = Object.fromEntries(slots.map((s, i) => [s, bodies[i]]))
  }
  return { bots: botRows(members, workspaces, workers), teams: teams?.teams || [] }
}

/** `{ bots, teams, error, loading, reload }`. `bots` is null until the first read. */
export function useBots(api, opts = {}) {
  const [data, setData] = useState({ bots: null, teams: [] })
  const [error, setError] = useState(null)
  const withWorkers = !!opts.withWorkers
  const reload = useCallback(async () => {
    try {
      setData(await loadBots(api, { withWorkers }))
      setError(null)
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [api, withWorkers])
  useEffect(() => {
    reload()
    const id = setInterval(() => { if (!document.hidden) reload() }, REFRESH_MS)
    return () => clearInterval(id)
  }, [reload])
  return { ...data, error, loading: data.bots === null && !error, reload }
}
