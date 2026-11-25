// Screenshot-only preview shell. NOT shipped: the real host provides all of this.
//
// It fills window.__kirocrew_modules the way the dashboard's shared-modules.ts does,
// so the host's own /vendor/*.mjs stubs (copied from website/public/vendor) resolve
// the page's bare imports. React, ReactDOM and lucide-react are the real packages.
// @kirocrew/app-sdk is a stand-in whose useAppApi answers from the fixture and
// applies writes to an in-memory copy. @kirocrew/ui stand-ins copy the host
// components' class strings (website/src/components/ui.tsx), so the host's compiled
// CSS draws them the same way.
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import * as lucide from 'lucide-react'
import quotaFixture from '../fixtures/state-13-quota.json'
// state-meeting.json comes from the real backend (teamapp.meeting) running two scripted meetings.
import meetingFixture from '../fixtures/state-meeting.json'

const q = new URLSearchParams(location.search)
const fixture = q.get('fixture') === 'meeting' ? meetingFixture : quotaFixture
const state = structuredClone(fixture)
if (q.get('stopped') === '1') { state.stopped = true; state.stop_reason = 'owner' }
// ?projects=1 gives each lead a fictional project, the way a Bot profile would.
if (q.get('projects') === '1') ['Payments API', 'Checkout web', 'Release infra'].forEach((p, i) => { if (state.leads[i]) state.leads[i].project = p })
// ?bots=1: sample project + worker tree on each lead, the shape a Bot-backed lead source would give.
if (q.get('bots') === '1') {
  const sample = [
    ['Payments API', 'Owns the public API and its clients', [{ name: 'schema-worker', role: 'API schema', workers: [{ name: 'lint-helper', status: 'running' }] }, { name: 'docs-worker', role: 'Reference docs' }]],
    ['Web app', 'Owns the dashboard UI', [{ name: 'a11y-worker', role: 'Accessibility pass' }]],
    ['Build infra', 'Owns CI and release builds', []],
  ]
  state.leads.forEach((l, i) => { const s = sample[i % sample.length]; l.project = s[0]; l.duty = s[1]; l.workers = s[2] })
}
if (q.get('empty') === '1') state.leads = []
// ?hostbots=1: the first two leads are host Bots (fake /api/members, /api/workspaces,
// crew-workers answers); the third stays a legacy lead chat.
const hostBots = q.get('hostbots') === '1' ? {
  members: { members: [
    { name: 'ada', display_name: 'Ada', slot_key: 'member-ada', workspace: 'payments-api', description: 'Owns the payments API' },
    { name: 'uma', display_name: 'Uma', slot_key: 'member-uma', workspace: 'checkout-web', description: 'Owns the checkout pages' },
  ] },
  workspaces: { workspaces: [{ name: 'payments-api', path: '/w/payments' }, { name: 'checkout-web', path: '/w/checkout' }], default: 'checkout-web' },
  workers: {
    'member-ada': { workers: [
      { key: 's1', title: 'Schema pass', status: 'working', dispatched_by: 'member-ada' },
      { key: 's2', title: 'Lint helper', status: 'done', dispatched_by: 's1' },
      { key: 's3', title: 'Reference docs', status: 'waiting', dispatched_by: 'member-ada' },
    ] },
  },
} : null
if (hostBots) {
  Object.assign(state.leads[0], { kind: 'bot', bot: 'ada', session_label: 'dashboard:member-ada' })
  Object.assign(state.leads[1], { kind: 'bot', bot: 'uma', session_label: 'dashboard:member-uma' })
}

function nextSeq(rows) { return (rows.at(-1)?.seq || 0) + 1 }
function post(path, body) {
  const now = state.now + 60
  if (path.endsWith('/stop')) { state.stopped = true; state.stop_reason = body?.reason || 'owner'; return {} }
  if (path.endsWith('/resume')) { state.stopped = false; state.stop_reason = null; return {} }
  if (path.endsWith('/messages')) {
    const rows = state.entries[body.channel_id]
    rows.push({ v: 1, seq: nextSeq(rows), ts: now, type: 'message/posted', by: 'owner', data: { msg_id: `M-p${rows.length}`, thread_id: body.thread === 'main' ? null : body.thread, text: body.text, kind: 'message', mentions: body.mentions, cc: [], everyone: body.everyone, also_main: false, reply_to: null, answers: null, chain: { hops: 0 } } })
    return { status: 'accepted' }
  }
  const m = /\/cases\/([^/]+)\/answer$/.exec(path)
  if (m) { const c = state.cases.find((x) => x.case_id === decodeURIComponent(m[1])); c.answer = { text: body.text, ts: now }; return {} }
  if (path.endsWith('/leads')) {
    const bot = body.bot ? { handle: body.display_name || body.bot, session_label: `dashboard:${body.slot_key}`, kind: 'bot', bot: body.bot, project: body.project || '' }
      : { handle: body.handle, session_label: body.session_label, kind: body.kind }
    state.leads.push({ lead_id: `L-${Math.random().toString(16).slice(2, 10)}`, ...bot, active: true, registered_ts: now }); return {}
  }
  return {}
}
const api = {
  get: async (path) => {
    if (path.includes('/state')) return structuredClone(state)
    if (hostBots && path === '/api/members') return hostBots.members
    if (hostBots && path === '/api/workspaces') return hostBots.workspaces
    const cw = /^\/api\/chat\/slots\/([^/]+)\/crew-workers$/.exec(path)
    if (hostBots && cw && hostBots.workers[decodeURIComponent(cw[1])]) return hostBots.workers[decodeURIComponent(cw[1])]
    throw Object.assign(new Error(`API 404: ${path}`), { status: 404 }) },
  post: async (path, body) => post(path, body),
  del: async (path) => { const id = decodeURIComponent(path.split('/').pop()); state.leads = state.leads.filter((l) => l.lead_id !== id); return {} },
}

const sdk = {
  useAppApi: () => api,
  useNotify: () => (msg) => console.log('[notify]', msg),
  useChatLauncher: () => ({ openChat: () => console.log('[openChat]') }),
  useNavigate: () => (path) => console.log('[navigate]', path),
  useTheme: () => ({ mode: document.documentElement.dataset.theme?.endsWith('light') ? 'light' : 'dark' }),
}

const h = React.createElement
const cx = (...a) => a.filter(Boolean).join(' ')
const ui = {
  Btn: React.forwardRef(({ children, danger, primary, className, ...rest }, ref) => h('button', {
    ref, ...rest,
    className: cx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[13px] cursor-pointer font-body transition-all active:scale-[0.97] active:duration-75 disabled:cursor-not-allowed',
      primary ? 'bg-accent text-accent-fg border-accent hover:bg-accent-hover hover:shadow-[0_0_12px_var(--accent-glow)] disabled:bg-bg-hover disabled:text-muted disabled:border-transparent disabled:shadow-none disabled:opacity-60'
        : danger ? 'border-border bg-transparent text-danger hover:text-danger-text hover:border-danger hover:bg-danger-subtle disabled:opacity-30'
          : 'border-border bg-transparent text-text hover:border-border-strong hover:bg-bg-hover disabled:opacity-30', className),
  }, children)),
  Badge: ({ variant, children, className, ...rest }) => h('span', {
    ...rest,
    className: cx('inline-flex items-center gap-1 px-2 py-[2px] rounded-full text-[13px] font-medium font-mono whitespace-nowrap',
      variant === 'ok' ? 'bg-ok-subtle text-ok-text' : variant === 'err' ? 'bg-danger-subtle text-danger-text' : variant === 'aim' ? 'bg-aim-subtle text-aim' : variant === 'muted' ? 'bg-[var(--bg-hover)] text-[var(--muted)]' : 'bg-warn-subtle text-warn-text', className),
  }, children),
  Input: React.forwardRef(({ className = '', ...props }, ref) => h('input', { ref, ...props, className: cx('bg-bg-elevated border border-border rounded-md px-3 py-2 text-text text-sm font-body outline-hidden flex-1 min-w-0 transition-colors focus-ring', className) })),
}

window.__kirocrew_modules = {
  react: React,
  'react-dom': ReactDOM,
  'react/jsx-runtime': jsxRuntime,
  'lucide-react': lucide,
  '@kirocrew/app-sdk': sdk,
  '@kirocrew/ui': ui,
}

const entry = '/ui/index.mjs'
import(/* @vite-ignore */ entry).then(({ default: Page }) => {
  ReactDOMClient.createRoot(document.getElementById('root')).render(h(Page))
}).catch((e) => { document.getElementById('root').textContent = `load failed: ${e}`; console.error(e) })
