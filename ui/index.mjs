import { jsxs, jsx, Fragment } from "react/jsx-runtime";
import { useMemo, useState, useCallback, useRef, useEffect, Fragment as Fragment$1 } from "react";
import { useNotify, useAppApi, useChatLauncher, useNavigate } from "@kirocrew/app-sdk";
import { Badge, Btn, Input, Modal } from "@kirocrew/app-sdk/ui";
import { Radar, ChevronRight, MessagesSquare, Inbox, Users, Network, ScrollText, Hourglass, Play, CircleStop, TriangleAlert, MessageSquare, Sparkles, ClipboardList, Check, ListChecks, Table2, Plus, ArrowRight, Hash, ShieldCheck, Lock, Archive, AtSign, Megaphone, ArrowUp, Gavel, X, NotebookText, Gauge, Moon, SlidersHorizontal, Cpu, FolderKanban, Minus, Bot, ChevronsUpDown, ChevronsDownUp, Maximize2, UserPlus, Vote } from "lucide-react";
import { l as leadForBot, s as shortHandle, a as actorId, O as OWNER$1, f as fmtClock, b as leadKind, c as leadIndex, d as css, e as activeLeadCount, m as mergeState, u as useBots, g as foldChannel, t as teamLeadIds, h as allRelays, i as ledgerRows, j as channelName, M as MEETING_STATE, p as parseOwnerMentions, k as meetingRows, n as OWNER_NAME, r as reasonLabel, o as threadLabel, q as limitRows, v as fmtTokens, w as modelRows, I as INTENT_LABEL, x as errText, y as impactLines, z as removeFromTeam, A as teamTree, B as rosterLeadSource, C as loadExpanded, D as visibleTree, E as expandAllKeys, F as layoutTree, G as fitZoom, H as BOTS_PAGE, Z as ZOOM_MIN, J as ZOOM_MAX, K as addCheck, L as threadForRoot, N as OUTCOME, P as readableIds, Q as caseStatus, R as CASE_ACTION, S as PERSON_CLASS, T as evidenceParts, U as limitsBody, V as cardOpen, W as cardRows, X as cardVoidText, Y as saveExpanded, _ as roleCardFields, $ as countWorkers, a0 as addBody, a1 as addBotError, a2 as splitMentions, a3 as openGrants, a4 as cardAnswerBody, a5 as clampZoom } from "./useBots.mjs";
const STATUS = {
  waiting_you: { rank: 0, label: "Waiting on you", tone: "is-err" },
  unanswered: { rank: 1, label: "@ unanswered", tone: "is-warn" },
  limited: { rank: 2, label: "Held back", tone: "is-assign" },
  working: { rank: 3, label: "Working", tone: "is-info" },
  no_signal: { rank: 4, label: "No indicator fired", tone: "" }
};
const WORKING_POSTED_SECS = 600;
const HOLD = { hop_limit: "hop over 4", channel_cooling: "channel cooling down" };
const OWNER = "owner";
const actor = (by) => typeof by === "string" && by.startsWith("lead:") ? by.slice(5) : by || "";
function placeName(ch, threadId, names) {
  if (!ch) return "a channel";
  const base = ch.kind === "group" ? `#${ch.title || "group"}` : `DM with ${[...(ch.members || []).map((id) => names.get(id) || "a lead"), ...(ch.people || []).includes(OWNER) ? ["Owner"] : []].join(", ")}`;
  return threadId ? `${base} › thread` : base;
}
function foldRows(rows) {
  const msgs = /* @__PURE__ */ new Map();
  const held = /* @__PURE__ */ new Map();
  for (const r of rows || []) {
    const d = r.data || {};
    switch (r.type) {
      case "message/posted":
        msgs.set(d.msg_id, { by: actor(r.by), ts: r.ts, thread_id: d.thread_id || null, kind: d.kind });
        break;
      case "message/held":
        held.set(d.msg_id, { ts: r.ts, reason: d.reason });
        break;
      case "message/released":
        held.delete(d.msg_id);
        break;
    }
  }
  return { msgs, held };
}
function assignmentHit(a, ch, state, now, names, nameOf) {
  const place = placeName(ch, a.thread_id || null, names);
  const target = { channel_id: a.channel_id, thread_id: a.thread_id || null };
  const from = nameOf(a.from);
  const left = (ts) => ts == null ? "" : ts > now ? ` due in ${fmtAge(ts - now)}` : " overdue";
  if (a.step === "ack") {
    const when = !a.late && a.due_ts != null && a.due_ts > now ? `bar raiser takes it in ${fmtAge(a.due_ts - now)}` : "bar raiser due now";
    return { status: "unanswered", since: a.opened_ts, target, reason: `@ from ${from} not answered · ${when}` };
  }
  if (a.step === "result") {
    return a.late ? { status: "unanswered", since: a.updated_ts ?? a.opened_ts, target, reason: `No result for @ from ${from} · overdue` } : { status: "working", since: a.updated_ts ?? a.opened_ts, target, reason: `Took @ from ${from} · result${left(a.due_ts)} · ${place}` };
  }
  if (a.step === "marked") {
    const c = (state?.cases || []).find((x) => (x.triggers || []).some((t) => t.key === `unanswered:${a.assignment_id}`));
    if (c && (c.acted || c.defaulted)) return null;
    return {
      status: "unanswered",
      since: a.opened_ts,
      target,
      reason: `${a.step_missed === "result" ? `No result for @ from ${from}` : `@ from ${from} not answered`} · bar raiser has it`
    };
  }
  return null;
}
function leadsNow(state, roster, now, waiting = []) {
  const names = new Map((roster || []).map((l) => [l.id, l.name]));
  const nameOf = (id) => id === OWNER ? "Owner" : names.get(id) || "a member";
  const channels = new Map((state?.channels || []).map((c) => [c.id, c]));
  const hits = new Map((roster || []).map((l) => [l.id, []]));
  const add = (id, h) => hits.get(id)?.push(h);
  const waitingKeys = /* @__PURE__ */ new Set();
  const posts = /* @__PURE__ */ new Map();
  const lastPost = /* @__PURE__ */ new Map();
  const folds = /* @__PURE__ */ new Map();
  for (const [cid, rows] of Object.entries(state?.entries || {})) {
    const f = foldRows(rows);
    folds.set(cid, f);
    const ch = channels.get(cid);
    for (const [mid, m] of f.msgs) {
      if (!hits.has(m.by) || m.kind === "system") continue;
      posts.set(m.by, (posts.get(m.by) || 0) + 1);
      if (!lastPost.has(m.by) || m.ts > lastPost.get(m.by).ts) lastPost.set(m.by, { ts: m.ts, cid, thread_id: m.thread_id });
      const h = f.held.get(mid);
      if (h) {
        add(m.by, { status: "limited", since: h.ts, reason: `Message held · ${HOLD[h.reason] || h.reason} · ${placeName(ch, m.thread_id, names)}`, target: { channel_id: cid, thread_id: m.thread_id } });
      }
    }
  }
  const asg = /* @__PURE__ */ new Map();
  for (const a of state?.assignments || []) {
    asg.set(`${a.channel_id}:${a.assignment_id}`, a);
    const h = hits.has(a.owed_by) && assignmentHit(a, channels.get(a.channel_id), state, now, names, nameOf);
    if (h) add(a.owed_by, h);
  }
  for (const w of waiting || []) {
    waitingKeys.add(w.key);
    const lead = w.lead_id || caseLead(w, folds.get(w.channel_id), asg, hits);
    if (!hits.has(lead)) continue;
    const tid = w.thread_id || null;
    add(lead, {
      status: "waiting_you",
      since: w.ts ?? null,
      reason: w.channel_id ? `${w.label} · ${placeName(channels.get(w.channel_id), tid, names)}` : w.label,
      target: w.channel_id ? { channel_id: w.channel_id, thread_id: tid } : null
    });
  }
  const capped = state?.budget?.lead_wakes_hour;
  for (const id of hits.keys()) {
    if (state?.stopped && state?.stop_reason === "budget") {
      add(id, { status: "limited", since: null, reason: "Team budget used up · nobody is woken", target: null });
    }
    if (capped?.cap && (capped[id] || 0) >= capped.cap) {
      add(id, { status: "limited", since: null, reason: `Wake cap hit · ${capped[id]}/${capped.cap} this hour`, target: null });
    }
    const lp = lastPost.get(id);
    if (lp && now - lp.ts < WORKING_POSTED_SECS) {
      add(id, { status: "working", since: lp.ts, reason: `Posted in ${placeName(channels.get(lp.cid), lp.thread_id, names)}`, target: { channel_id: lp.cid, thread_id: lp.thread_id } });
    }
  }
  const cards = (roster || []).map((l) => {
    const list = hits.get(l.id).sort(byNeed);
    const lp = lastPost.get(l.id);
    const top = list[0] || {
      status: "no_signal",
      since: null,
      reason: posts.get(l.id) ? `${plural$1(posts.get(l.id), "post")}` : "No posts yet",
      target: lp ? { channel_id: lp.cid, thread_id: lp.thread_id } : null
    };
    const s = STATUS[top.status];
    return {
      id: l.id,
      name: l.name,
      project: l.project || null,
      legacy: !!l.legacy,
      status: top.status,
      label: s.label,
      tone: s.tone,
      reason: top.reason,
      since: top.since,
      target: top.target,
      more: Math.max(0, list.length - 1),
      posts: posts.get(l.id) || 0,
      lastTs: lp?.ts ?? null
    };
  });
  cards.sort((a, b) => byNeed(a, b) || a.name.localeCompare(b.name));
  return { waiting: waitingKeys.size, cards };
}
function caseLead(w, f, asg, hits) {
  if (!w.case || !f) return null;
  for (const t of w.case.triggers || []) {
    const [kind, ref] = String(t.key || "").split(":");
    const who = kind === "held" ? f.msgs.get(ref)?.by : kind === "unanswered" ? asg.get(`${w.channel_id}:${ref}`)?.to : null;
    if (hits.has(who)) return who;
  }
  const tid = w.thread_id || null;
  let last = null;
  for (const m of f.msgs.values()) {
    if (m.thread_id === tid && hits.has(m.by) && m.kind !== "system" && m.ts <= (w.ts ?? Infinity) && (!last || m.ts >= last.ts)) last = m;
  }
  return last?.by || null;
}
function byNeed(a, b) {
  return STATUS[a.status].rank - STATUS[b.status].rank || (a.since ?? Infinity) - (b.since ?? Infinity);
}
const plural$1 = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
function fmtAge(secs) {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return "<1 min";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}
function leadRoster(state, bots = null) {
  const leads = (state?.leads || []).filter((l) => l.active !== false);
  const botOf = /* @__PURE__ */ new Map();
  for (const b of bots || []) {
    const l = leadForBot(b, leads);
    if (l && l.kind === "bot") botOf.set(l.lead_id, b);
  }
  return leads.map((l) => {
    const b = botOf.get(l.lead_id);
    return {
      id: l.lead_id,
      name: b?.name || shortHandle(l.handle) || "lead",
      project: b?.project || l.project || null,
      legacy: l.kind !== "bot",
      workers: b?.workers ?? null
    };
  });
}
function leadChatTarget() {
  return null;
}
const IMPACT = { irreversible: 0, spend: 1, security: 2, exhausted: 3, requested: 4, ask: 5 };
const IMPACT_LABEL = { irreversible: "Irreversible", spend: "Costs money", security: "Security", exhausted: "Out of tries", requested: "Asked for you", ask: "Question" };
function waitingOnYou(state) {
  return (state?.decisions || []).filter((d) => d.state === "open").sort((a, b) => (IMPACT[a.impact] ?? 9) - (IMPACT[b.impact] ?? 9) || a.opened_ts - b.opened_ts);
}
function ownerLastSpoke(state) {
  let last = null;
  for (const rows of Object.values(state?.entries || {})) {
    for (const r of rows || []) {
      if (r.type === "message/posted" && r.by === OWNER$1 && r.data?.kind !== "system" && (last === null || r.ts > last)) last = r.ts;
    }
  }
  return last;
}
function sinceYouSpoke(state, names) {
  const since = ownerLastSpoke(state);
  const after = (ts) => since === null || ts > since;
  const nm = (id) => id === OWNER$1 ? "you" : shortHandle(names?.get(id)) || "a lead";
  const lines = [];
  for (const ch of state?.channels || []) {
    const place = ch.kind === "group" ? `#${ch.title || "group"}` : `DM: ${(ch.members || []).map(nm).join(", ")}`;
    const posts = /* @__PURE__ */ new Map();
    const asg = { taken: [], declined: [], asked: [], unanswered: [] };
    let held = 0;
    let closed = 0;
    let botPosts = 0;
    const opened = /* @__PURE__ */ new Map();
    for (const r of state.entries?.[ch.id] || []) {
      const d = r.data || {};
      if (r.type === "assignment/opened") opened.set(d.assignment_id, d);
      if (!after(r.ts)) continue;
      if (r.type === "message/posted") {
        const by = actorId(r.by);
        if (by === OWNER$1) continue;
        if (String(r.by).startsWith("bar_raiser") || d.kind === "system") botPosts += 1;
        else posts.set(by, (posts.get(by) || 0) + 1);
      } else if (r.type === "message/held") held += 1;
      else if (r.type === "chain/closed") closed += 1;
      else if (r.type.startsWith("assignment/") && r.type !== "assignment/opened") {
        const a = opened.get(d.assignment_id);
        const k = r.type.split("/")[1];
        if (a && asg[k]) asg[k].push(nm(a.to));
      }
    }
    const parts = [];
    const add = (text) => parts.push(text);
    if (posts.size) add([...posts].map(([id, n]) => `${nm(id)} posted ${n}`).join(", "));
    if (asg.taken.length) add(`@ taken by ${uniq(asg.taken).join(", ")}`);
    if (asg.declined.length) add(`@ declined by ${uniq(asg.declined).join(", ")}`);
    if (asg.asked.length) add(`${uniq(asg.asked).join(", ")} asked about an @`);
    if (asg.unanswered.length) add(`@ unanswered by ${uniq(asg.unanswered).join(", ")}`);
    if (held) add(`${held} message${held === 1 ? "" : "s"} held`);
    if (closed) add(`bar raiser closed ${closed === 1 ? "a chain" : `${closed} chains`}`);
    if (botPosts) add(`${botPosts} bar raiser note${botPosts === 1 ? "" : "s"}`);
    if (parts.length) lines.push({ channel_id: ch.id, place, text: parts.join(" · ") });
  }
  const cases = (state?.cases || []).filter((c) => after(c.ts)).length;
  if (cases) lines.push({ channel_id: null, place: "Bar raiser", text: `opened ${cases} case${cases === 1 ? "" : "s"}` });
  return { since, lines };
}
const uniq = (xs) => [...new Set(xs)];
const LABEL = { ...IMPACT_LABEL, ask: "Asked you" };
function waitingItems(state) {
  const cases = new Map((state?.cases || []).map((c) => [`case:${c.case_id}`, c]));
  return waitingOnYou(state).map((d) => ({
    key: d.key,
    lead_id: d.lead || null,
    case: d.kind === "case" ? cases.get(d.key) || null : null,
    channel_id: d.channel_id || null,
    thread_id: d.thread_id || null,
    ts: d.opened_ts ?? null,
    label: d.kind === "case" ? `Bar raiser asks you${LABEL[d.impact] ? ` · ${LABEL[d.impact].toLowerCase()}` : ""}` : d.kind === "ask" ? LABEL.ask : d.kind === "meeting_item" ? "Meeting needs you" : "Needs your decision"
  }));
}
function LeadsNowCard({ state, avatar, onOpen, bots = null }) {
  const now = state?.now || Date.now() / 1e3;
  const { waiting, cards } = useMemo(() => leadsNow(state, leadRoster(state, bots), now, waitingItems(state)), [state, bots, now]);
  return /* @__PURE__ */ jsxs("div", { className: "tm-card tm-now", "data-testid": "leads-now", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(Radar, { size: 15, style: { color: "var(--accent)" } }),
      "Leads now",
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsxs("span", { className: `tm-now-count ${waiting ? "is-on" : ""}`, "aria-live": "polite", children: [
        waiting,
        " waiting on you"
      ] })
    ] }),
    cards.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "No leads yet." }),
    /* @__PURE__ */ jsx("ul", { className: "tm-now-list", children: cards.map((c) => {
      const target = c.target || leadChatTarget();
      const age = c.since != null ? fmtAge(now - c.since) : "";
      const reason = c.status === "no_signal" && c.lastTs ? `${c.reason} · last ${fmtClock(c.lastTs)}` : c.reason;
      const body = /* @__PURE__ */ jsxs(Fragment, { children: [
        avatar(c.id),
        /* @__PURE__ */ jsxs("span", { className: "tm-now-main", children: [
          /* @__PURE__ */ jsxs("span", { className: "tm-now-row", children: [
            /* @__PURE__ */ jsx("b", { className: "tm-now-name", children: c.name }),
            /* @__PURE__ */ jsxs("span", { className: `tm-now-status ${c.tone}`, children: [
              c.label,
              age && /* @__PURE__ */ jsxs("span", { className: "tm-now-age", children: [
                " · ",
                age
              ] })
            ] })
          ] }),
          (c.project || c.legacy) && /* @__PURE__ */ jsxs("span", { className: "tm-now-tags", children: [
            c.project && /* @__PURE__ */ jsx("span", { className: "tm-now-project", title: `Project: ${c.project}`, children: c.project }),
            c.legacy && /* @__PURE__ */ jsx("span", { className: "tm-now-project is-legacy", title: "An old lead chat, not a Bot", children: "Legacy lead" })
          ] }),
          /* @__PURE__ */ jsxs("span", { className: "tm-now-why", children: [
            reason,
            c.more > 0 && /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
              " · +",
              c.more,
              " more"
            ] })
          ] })
        ] }),
        target && /* @__PURE__ */ jsx(ChevronRight, { size: 14, className: "tm-now-go" })
      ] });
      return /* @__PURE__ */ jsx("li", { className: `tm-now-item ${c.tone}`, "data-status": c.status, children: target ? /* @__PURE__ */ jsx(
        "button",
        {
          className: "tm-now-btn",
          onClick: () => onOpen(target.channel_id, target.thread_id),
          "aria-label": `${c.name}${c.project ? ` (${c.project})` : ""}: ${c.label}. ${reason}. Open`,
          children: body
        }
      ) : /* @__PURE__ */ jsx("div", { className: "tm-now-btn is-static", children: body }) }, c.id);
    }) }),
    /* @__PURE__ */ jsx("div", { className: "tm-muted tm-now-foot", children: "Order: waiting on you › @ unanswered › held back › working › no signal. Counted from the ledger by fixed rules." })
  ] });
}
const STAGES = [
  ["proposed", "Proposed"],
  ["evidence", "Evidence"],
  ["discussion", "Discussion"],
  ["decided", "Decided"],
  ["actions", "Actions"]
];
function itemNeedsYou(item, meeting, waiting) {
  return (waiting || []).some((d) => d.state === "open" && d.meeting_id === meeting?.meeting_id && d.item_id === item?.item_id);
}
function meetingNeedsYou(meeting, waiting) {
  return (meeting?.agenda || []).filter((a) => itemNeedsYou(a, meeting, waiting));
}
function itemStages(item, meeting, nameOf = (w) => w, waiting = []) {
  const ballots = Object.values(item?.ballots || {});
  const r1 = item?.rounds?.["1"];
  const opened = !!item && item.state !== "pending";
  const decided = !!item?.outcome;
  const presented = decided || (item?.round || 0) >= 2 || ballots.length > 0 || (item?.speeches || []).some((s) => s.round === 1);
  const evidenced = decided || (item?.round || 0) >= 2 || ballots.some((b) => b.state === "closed") || !!(r1 && (r1.revealed || r1.ended));
  const actions = (meeting?.actions || []).filter((a) => a.item_id && a.item_id === item?.item_id);
  const open = actions.filter((a) => a.state === "proposed");
  const live = ["open", "adjourning"].includes(meeting?.state);
  const done = { proposed: presented, evidence: evidenced, discussion: decided, decided, actions: false };
  let actionsState = "todo";
  if (decided) {
    if (!actions.length || !live && open.length === actions.length) actionsState = "skipped";
    else actionsState = open.length && live ? "current" : "done";
  }
  const needsYou = itemNeedsYou(item, meeting, waiting);
  let current = null;
  const steps = STAGES.map(([key, label]) => {
    let state;
    if (key === "actions") state = actionsState;
    else if (done[key]) state = "done";
    else if (opened && current === null && item.state === "open") state = "current";
    else state = "todo";
    if (state === "current") current = key;
    return { key, label, state, note: "" };
  });
  const cur = steps.find((s) => s.state === "current");
  if (cur) {
    if (needsYou) cur.note = "Needs you";
    else if (cur.key === "actions") cur.note = `Waiting on ${[...new Set(open.map((a) => nameOf(a.owner)))].join(", ")}`;
    else if (item.br_needed?.length) cur.note = "Bar raiser";
    else if (item.ballot_open) cur.note = "Voting";
    else if (cur.key === "evidence" && r1?.sealed && !r1?.revealed) cur.note = "Sealed";
  }
  return { steps, current: cur ? cur.key : null, needsYou };
}
const ASSIGN_STATE = {
  open: "Waiting for an answer",
  taken: "Taken · result due",
  declined: "Declined",
  asked: "Asked back",
  closed: "Result sent",
  unanswered: "No answer · bar raiser called"
};
function assignStep(a) {
  if (a.state === "closed" && a.empty) return "Closed · no result";
  if (a.state === "unanswered" && a.reason === "no_result") return "No result · bar raiser called";
  return ASSIGN_STATE[a.state] || ASSIGN_STATE.open;
}
const ANSWER = {
  take: "Took the assignment",
  ask: "Asked a question",
  result: "Sent the result",
  no_result: "No result · still a reply"
};
function addresses(m, lead, dm) {
  const named = [...m.mentions || [], ...m.cc || []];
  if ((m.assignments || []).some((a) => a.to === lead) || named.includes(lead)) return true;
  if (m.everyone || dm) return true;
  return m.by === OWNER$1 && named.length === 0;
}
function wokeSplit(briefs, channelId, m, dm = false) {
  const now = [];
  const later = [];
  for (const b of briefs || []) {
    const hit = (b.brief?.groups || []).some((g) => g.channel_id === channelId && (g.items || []).some((it) => (it.seqs || []).includes(m.seq)));
    if (!hit || now.includes(b.lead_id)) continue;
    const atOnce = (b.reasons || []).some((r) => r !== "batch");
    if (atOnce && addresses(m, b.lead_id, dm)) {
      now.push(b.lead_id);
      const i = later.indexOf(b.lead_id);
      if (i >= 0) later.splice(i, 1);
    } else if (!later.includes(b.lead_id)) later.push(b.lead_id);
  }
  return { now, later };
}
const DM_STEP = { open: "Waiting on you", answered: "You answered", skipped: "You said no", withdrawn: "Withdrawn" };
function dmAsk(decisions, channelId, m) {
  let best = null;
  for (const d of decisions || []) {
    if (d.via !== "dm" || d.channel_id !== channelId || d.ask_seq > m.seq) continue;
    if (!best || d.ask_seq > best.ask_seq) best = d;
  }
  if (!best) return null;
  return best.state === "open" || best.ask_seq === m.seq || (best.answer?.ts ?? 0) >= m.ts ? best : null;
}
function fmtStamp(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtClock(ts)}:${p(d.getSeconds())}`;
}
function name(id, leads) {
  if (id === OWNER$1) return "Owner";
  return shortHandle(leads.get(id)?.handle) || "a lead";
}
function messageBack(m, { leads = /* @__PURE__ */ new Map(), channelId = null, briefs = [], replyTo = null, everyoneCount = "", dm = false, decisions = [] } = {}) {
  const rows = [];
  const owner = m.by === OWNER$1;
  const lead = leads.get(m.by);
  rows.push({ label: "Source", value: owner ? "Owner" : lead ? lead.kind === "bot" ? "Bot lead" : leadKind(lead).label : "Team Mode" });
  for (const a of m.assignments || []) {
    rows.push({ label: "Assigned to", value: `${name(a.to, leads)} · must answer` });
    rows.push({ label: "Current step", value: assignStep(a) });
  }
  if (m.answers) {
    const r = m.answers.response;
    const said = r === "decline" ? `Declined${m.answers.reason ? `: ${m.answers.reason}` : ""}` : ANSWER[r] || ANSWER.ask;
    const again = r === "take" && m.answers.binding?.attempt > 1 ? ` · ask ${m.answers.binding.attempt}` : "";
    rows.push({ label: "Answer", value: `${said}${again}` });
  }
  if (m.kind === "notice") rows.push({ label: "Kind", value: "Notice · goes to briefs · wakes nobody · not a hop" });
  if (m.everyone) rows.push({ label: "Addressed", value: `@everyone · wakes all${everyoneCount ? ` ${everyoneCount}` : ""}` });
  const ask = dm && !owner ? dmAsk(decisions, channelId, m) : null;
  if (ask) {
    rows.push({ label: "Asked", value: "Owner · shows in Needs you" });
    rows.push({ label: "Current step", value: DM_STEP[ask.state] || "Waiting on you" });
  }
  const unaddressed = !dm && !owner && !m.everyone && !m.mentions?.length && !m.answers && !m.thread_id;
  if (unaddressed && m.kind !== "notice") rows.push({ label: "Addressed", value: "No @ · each lead decides whether to answer" });
  const hops = m.chain?.hops || 0;
  rows.push({ label: "Hop", value: hops > 0 ? `${hops} · past 4 the bar raiser takes over` : owner ? "0 · your post resets the count" : "0" });
  if (m.held) rows.push({ label: "Held", value: `Hop ${m.chain?.hops ?? "?"} is over 4 · waiting for bar raiser` });
  else if (m.released) rows.push({ label: "Held", value: "Released by bar raiser" });
  const woke = wokeSplit(briefs, channelId, m, dm);
  if (woke.now.length) rows.push({ label: "Woke now", value: woke.now.map((id) => name(id, leads)).join(", ") });
  if (woke.later.length) rows.push({ label: "Read later", value: woke.later.map((id) => name(id, leads)).join(", ") });
  if (m.redirected?.length) {
    const n = Math.max(...m.redirected.map((x) => x.answers || 2));
    rows.push({ label: "Redirected", value: `${m.redirected.map((x) => name(x.who, leads)).join(", ")} · ${n} answers in main already` });
  }
  if (replyTo) {
    const t = String(replyTo.text || "");
    rows.push({ label: "Reply to", value: `${name(replyTo.by, leads)}: ${t.slice(0, 36)}${t.length > 36 ? "…" : ""}` });
  }
  rows.push({ label: "Recorded", value: fmtStamp(m.ts) });
  return rows;
}
function flipOnKey(key) {
  return key === "Enter" || key === " " || key === "Spacebar";
}
function clickFlips(target, selectedText = "") {
  if (selectedText) return false;
  return !target?.closest?.("a, button, input, textarea, select");
}
const BASE = "/api/apps/team-mode";
const POLL_MS = 2e3;
const APPROX = {
  wake: { label: "wake ≤ 60 s", tip: "Approximate: the app can only wake a lead through the 60-second script cron that lead set up itself, not instantly." },
  identity: { label: "identity = session label", tip: "Approximate: identity is the session label, not a credential. A session with a shell could get around it." },
  relay: { label: "self-reported", tip: "Approximate: the app cannot read the work ledger dispatch chain; the lead reported this path itself with team_relay_note." },
  tokens: { label: "estimate", tip: "Approximate: the app cannot read real token usage. Estimated at ≈ 45k per warm wake and ≈ 96k per cold wake." },
  round: { label: "round = between two wakes", tip: 'Approximate: the app cannot see turn boundaries, so "no answer" is counted between two wakes.' }
};
function Approx({ kind }) {
  const a = APPROX[kind];
  return /* @__PURE__ */ jsxs("span", { className: "tm-approx", title: a.tip, "aria-label": `${a.label} (${a.tip})`, children: [
    "≈ ",
    a.label
  ] });
}
function Avatar({ who, leads, size }) {
  const cls = size === "sm" ? "tm-av sm" : "tm-av";
  if (who === OWNER$1) return /* @__PURE__ */ jsx("span", { className: `${cls} owner`, "aria-hidden": "true", children: OWNER_NAME.slice(0, 1) });
  if (String(who).startsWith("bar_raiser")) return /* @__PURE__ */ jsx("span", { className: `${cls} br`, "aria-hidden": "true", children: /* @__PURE__ */ jsx(ShieldCheck, { size: size === "sm" ? 12 : 15 }) });
  const lead = leads.get(who);
  const name2 = shortHandle(lead?.handle || who);
  return /* @__PURE__ */ jsx("span", { className: `${cls} h${(lead?.hue ?? 4) % 5}`, "aria-hidden": "true", children: name2.slice(0, 1).toUpperCase() });
}
function whoName(who, leads) {
  if (who === OWNER$1) return OWNER_NAME;
  if (String(who).startsWith("bar_raiser")) return "Bar raiser";
  if (who === "app") return "Team Mode";
  return leads.get(who)?.handle || who;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
function useTeamState() {
  const api = useAppApi();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const cursorRef = useRef(null);
  const busyRef = useRef(false);
  const poll = useCallback(async (full = false) => {
    if (busyRef.current && !full) return;
    busyRef.current = true;
    try {
      const since = !full && cursorRef.current ? `?since=${encodeURIComponent(cursorRef.current)}` : "";
      const next = await api.get(`${BASE}/state${since}`);
      cursorRef.current = next?.cursor ?? null;
      setState((prev) => full ? mergeState(null, next) : mergeState(prev, next));
      setError(null);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      busyRef.current = false;
    }
  }, [api]);
  useEffect(() => {
    poll(true);
    const id = setInterval(() => {
      if (!document.hidden) poll();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);
  return { state, error, poll, api };
}
const TABS = [
  { key: "chat", label: "Chat", icon: MessagesSquare },
  { key: "needs", label: "Needs you", icon: Inbox },
  { key: "members", label: "Members", icon: Users },
  { key: "relay", label: "Tree relay", icon: Network },
  { key: "ledger", label: "Ledger", icon: ScrollText }
];
function TeamModePage() {
  const { state, error, poll, api } = useTeamState();
  const notify = useNotify();
  const [tab, setTab] = useState("chat");
  const [busy, setBusy] = useState(false);
  const write = useCallback(async (fn, okText) => {
    setBusy(true);
    try {
      await fn();
      if (okText) notify?.(okText, { type: "success" });
      await poll(true);
      return true;
    } catch (e) {
      notify?.(`Failed: ${e?.message || e}`, { type: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  }, [notify, poll]);
  const leads = useMemo(() => leadIndex(state), [state]);
  const waiting = useMemo(() => waitingOnYou(state), [state]);
  const [focus, setFocus] = useState(null);
  const openInChat = (channel_id, thread_id) => {
    setFocus({ channel_id, thread_id, n: Date.now() });
    setTab("chat");
  };
  const stopped = !!state?.stopped;
  const stopWhy = state?.stop_reason && state.stop_reason !== "owner" ? ` (${state.stop_reason === "budget" ? "budget used up" : state.stop_reason})` : "";
  return /* @__PURE__ */ jsxs("div", { className: "tm", "data-testid": "team-mode-page", children: [
    /* @__PURE__ */ jsx("style", { children: css }),
    /* @__PURE__ */ jsxs("header", { className: "tm-top", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-title", children: [
        "Team Mode ",
        /* @__PURE__ */ jsx(Badge, { variant: "aim", children: "demo" }),
        /* @__PURE__ */ jsxs("span", { className: "tm-title-sub", children: [
          plural(activeLeadCount(leads), "lead"),
          " · data stays in this app's folder"
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "tm-tabs", role: "tablist", "aria-label": "Team Mode views", children: TABS.map(({ key, label, icon: Icon }) => /* @__PURE__ */ jsxs("button", { role: "tab", className: "tm-tab", "aria-selected": tab === key, onClick: () => setTab(key), children: [
        /* @__PURE__ */ jsx(Icon, { size: 14 }),
        label,
        key === "needs" && waiting.length > 0 && /* @__PURE__ */ jsx("span", { className: "tm-unread is-warn", children: waiting.length })
      ] }, key)) }),
      /* @__PURE__ */ jsxs("div", { className: "tm-top-right", children: [
        waiting.length > 0 && /* @__PURE__ */ jsxs("button", { className: "tm-waiting", onClick: () => setTab("needs"), title: "Decisions only you can make. Open Needs you.", children: [
          /* @__PURE__ */ jsx(Hourglass, { size: 14 }),
          waiting.length,
          " waiting on you"
        ] }),
        /* @__PURE__ */ jsxs("span", { className: "tm-live", title: error ? `Cannot read /state: ${error}` : "Reads /state every 2 seconds", children: [
          /* @__PURE__ */ jsx("span", { className: `tm-dot ${stopped ? "is-stopped" : error ? "is-off" : ""}` }),
          /* @__PURE__ */ jsx("span", { className: "tm-live-text", children: stopped ? "Stopped" : error ? "Backend unreachable" : "Running" })
        ] }),
        stopped ? /* @__PURE__ */ jsxs("button", { className: "tm-resume", disabled: busy, onClick: () => write(() => api.post(`${BASE}/resume`, {}), "Resumed"), children: [
          /* @__PURE__ */ jsx(Play, { size: 14 }),
          "Resume"
        ] }) : /* @__PURE__ */ jsxs("button", { className: "tm-stop", disabled: busy || !state, onClick: () => write(() => api.post(`${BASE}/stop`, { reason: "owner" }), "Emergency stop is on"), children: [
          /* @__PURE__ */ jsx(CircleStop, { size: 15 }),
          "Emergency stop"
        ] })
      ] })
    ] }),
    stopped && /* @__PURE__ */ jsxs("div", { className: "tm-banner is-stopped", role: "status", children: [
      /* @__PURE__ */ jsx(CircleStop, { size: 16 }),
      /* @__PURE__ */ jsxs("span", { children: [
        "Emergency stop is on",
        stopWhy,
        ": leads cannot post, nobody is woken, and no secretary or bar raiser starts. Press Resume to continue."
      ] })
    ] }),
    error && state && /* @__PURE__ */ jsxs("div", { className: "tm-banner is-error", role: "status", children: [
      /* @__PURE__ */ jsx(TriangleAlert, { size: 16 }),
      /* @__PURE__ */ jsxs("span", { children: [
        "Cannot read the latest state; showing the last data. ",
        /* @__PURE__ */ jsx("span", { className: "tm-mono tm-break", children: error })
      ] })
    ] }),
    !state ? /* @__PURE__ */ jsx("div", { className: "tm-empty", children: error ? /* @__PURE__ */ jsxs(Fragment, { children: [
      "The backend did not answer: ",
      /* @__PURE__ */ jsx("span", { className: "tm-mono tm-break", children: error }),
      /* @__PURE__ */ jsx("div", { style: { marginTop: 10 }, children: /* @__PURE__ */ jsx(Btn, { onClick: () => poll(true), children: "Retry" }) })
    ] }) : "Loading…" }) : tab === "chat" ? /* @__PURE__ */ jsx(ChatView, { state, leads, api, write, busy, focus, onNeeds: () => setTab("needs") }) : tab === "needs" ? /* @__PURE__ */ jsx("div", { className: "tm-body is-single", children: /* @__PURE__ */ jsx(NeedsYouView, { state, leads, waiting, api, write, busy, onOpen: openInChat }) }) : tab === "members" ? /* @__PURE__ */ jsx("div", { className: "tm-body is-single", children: /* @__PURE__ */ jsx(MembersView, { state, leads, api, write, busy }) }) : tab === "relay" ? /* @__PURE__ */ jsx("div", { className: "tm-body is-single", children: /* @__PURE__ */ jsx(RelayView, { state, leads }) }) : /* @__PURE__ */ jsx("div", { className: "tm-body is-single", children: /* @__PURE__ */ jsx(LedgerView, { state }) })
  ] });
}
function ChatView({ state, leads, api, write, busy, focus, onNeeds }) {
  const channels = state.channels || [];
  const { bots } = useBots(api);
  const [current, setCurrent] = useState(() => focus?.channel_id || channels.find((c) => c.kind === "group")?.id || channels[0]?.id || null);
  const [threadId, setThreadId] = useState(null);
  useEffect(() => {
    if (focus?.channel_id) {
      setCurrent(focus.channel_id);
      if (focus.thread_id) setTimeout(() => setThreadId(focus.thread_id), 0);
    }
  }, [focus]);
  const [meetingId, setMeetingId] = useState(null);
  const [pane, setPane] = useState("chat");
  const [closing, setClosing] = useState(null);
  const channel = channels.find((c) => c.id === current) || null;
  const folded = useMemo(() => foldChannel(state.entries?.[current] || []), [state.entries, current]);
  const meetings = state.meetings || [];
  const waiting = waitingOnYou(state);
  const meeting = meetings.find((m) => m.meeting_id === meetingId) || null;
  const openThread = useCallback((tid) => {
    const th = folded.threads.get(tid);
    if (th?.mode === "meeting" && th.meeting_id) {
      setThreadId(null);
      setMeetingId(th.meeting_id);
    } else {
      setMeetingId(null);
      setThreadId(tid);
    }
  }, [folded]);
  const openMeeting = (m) => {
    setCurrent(m.channel_id);
    setTimeout(() => {
      setThreadId(null);
      setMeetingId(m.meeting_id);
    }, 0);
    setPane("chat");
  };
  useEffect(() => {
    setThreadId(null);
    setMeetingId((id) => meetings.find((m) => m.meeting_id === id)?.channel_id === current ? id : null);
  }, [current]);
  useEffect(() => {
    if (!current && channels.length) setCurrent(channels.find((c) => c.kind === "group")?.id || channels[0].id);
  }, [current, channels]);
  const groups = channels.filter((c) => c.kind === "group");
  const dms = channels.filter((c) => c.kind === "dm");
  const sideCount = waiting.filter((d) => d.kind === "case").length;
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("div", { className: "tm-narrow-switch", children: /* @__PURE__ */ jsxs("div", { className: "tm-tabs", role: "tablist", "aria-label": "Switch panel", style: { width: "100%" }, children: [
      /* @__PURE__ */ jsxs("button", { role: "tab", className: "tm-tab", "aria-selected": pane === "chat", onClick: () => setPane("chat"), children: [
        /* @__PURE__ */ jsx(MessageSquare, { size: 14 }),
        "Chat"
      ] }),
      /* @__PURE__ */ jsxs("button", { role: "tab", className: "tm-tab", "aria-selected": pane === "side", onClick: () => setPane("side"), children: [
        /* @__PURE__ */ jsx(Sparkles, { size: 14 }),
        "Briefs · Cases · Budget",
        sideCount > 0 && /* @__PURE__ */ jsx("span", { className: "tm-unread", style: { marginLeft: 4 }, children: sideCount })
      ] })
    ] }) }),
    /* @__PURE__ */ jsxs("div", { className: "tm-body", "data-pane": pane, children: [
      /* @__PURE__ */ jsxs("nav", { className: "tm-rail", "aria-label": "Groups and direct messages", children: [
        /* @__PURE__ */ jsx("div", { className: "tm-sec", children: "Groups" }),
        groups.map((c) => /* @__PURE__ */ jsx(ChannelRow, { ch: c, leads, active: c.id === current, onClick: () => {
          setCurrent(c.id);
          setPane("chat");
        } }, c.id)),
        meetings.length > 0 && /* @__PURE__ */ jsx("div", { className: "tm-sec", children: "Meetings" }),
        [...meetings].sort((a, b) => (b.state === "open") - (a.state === "open") || b.root_seq - a.root_seq).map((m) => /* @__PURE__ */ jsx(MeetingRow, { m, waiting, leads, channels, active: m.meeting_id === meetingId, onClick: () => openMeeting(m) }, m.meeting_id)),
        /* @__PURE__ */ jsx("div", { className: "tm-sec", children: "Direct messages" }),
        dms.map((c) => /* @__PURE__ */ jsx(ChannelRow, { ch: c, leads, active: c.id === current, onClick: () => {
          setCurrent(c.id);
          setPane("chat");
        } }, c.id)),
        channels.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-empty", children: "No groups yet. Create one under Members." })
      ] }),
      /* @__PURE__ */ jsx("section", { className: "tm-center", "aria-label": "Conversation", children: channel ? /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx(ChannelHeader, { ch: channel, leads, onCloseGroup: () => setClosing(channel.id) }),
        /* @__PURE__ */ jsx(Conversation, { folded, channel, leads, meetings, briefs: state.briefs, decisions: state.decisions, onOpenThread: openThread }),
        /* @__PURE__ */ jsx(
          Composer,
          {
            channel,
            leads,
            threadId: null,
            disabled: busy || state.stopped || channel.closed,
            stopped: state.stopped,
            onSend: (body) => write(() => api.post(`${BASE}/messages`, body))
          }
        ),
        closing === channel.id && /* @__PURE__ */ jsx(
          CloseGroupDialog,
          {
            ch: channel,
            busy,
            onClose: () => setClosing(null),
            onConfirm: () => write(() => api.post(`${BASE}/groups/${encodeURIComponent(channel.id)}/close`, {}), `#${channel.title} closed`).then((ok) => {
              if (ok) setClosing(null);
            })
          }
        )
      ] }) : /* @__PURE__ */ jsx("div", { className: "tm-empty", children: "Pick a group or a direct message." }) }),
      channel && meeting && meeting.channel_id === channel.id && /* @__PURE__ */ jsx(
        MeetingDrawer,
        {
          m: meeting,
          state,
          channel,
          leads,
          busy,
          onClose: () => setMeetingId(null),
          disabled: busy || state.stopped,
          stopped: state.stopped,
          onSend: (body) => write(() => api.post(`${BASE}/messages`, body)),
          onAdjourn: () => write(() => api.post(`${BASE}/meetings/${encodeURIComponent(meeting.meeting_id)}/adjourn`, { reason: "owner" }), "Meeting adjourned")
        }
      ),
      channel && threadId && /* @__PURE__ */ jsx(
        ThreadDrawer,
        {
          folded,
          threadId,
          channel,
          leads,
          briefs: state.briefs,
          onClose: () => setThreadId(null),
          disabled: busy || state.stopped,
          stopped: state.stopped,
          onSend: (body) => write(() => api.post(`${BASE}/messages`, body))
        }
      ),
      /* @__PURE__ */ jsxs("aside", { className: "tm-side", "aria-label": "Leads now, room memory, secretary briefs, bar raiser and budget", children: [
        /* @__PURE__ */ jsx(
          LeadsNowCard,
          {
            state,
            bots,
            avatar: (id) => /* @__PURE__ */ jsx(Avatar, { who: id, leads, size: "sm" }),
            onOpen: (cid, tid) => {
              const mt = tid && meetings.find((m) => m.channel_id === cid && m.thread_id === tid);
              setCurrent(cid);
              setPane("chat");
              setTimeout(() => {
                setMeetingId(mt ? mt.meeting_id : null);
                setThreadId(mt ? null : tid || null);
              }, 0);
            }
          }
        ),
        channel?.kind === "group" && /* @__PURE__ */ jsx(RoomMemoryCard, { memory: state.memory?.[channel.id] }),
        /* @__PURE__ */ jsx(BriefCard, { state, leads }),
        /* @__PURE__ */ jsx(
          CasesCard,
          {
            state,
            leads,
            onNeeds,
            onOpen: (cid, tid) => {
              setCurrent(cid);
              if (tid) setTimeout(() => setThreadId(tid), 0);
              setPane("chat");
            }
          }
        ),
        /* @__PURE__ */ jsx(BudgetCard, { state, leads, api, write, busy }),
        /* @__PURE__ */ jsx(ModelsCard, { state, api, write, busy })
      ] })
    ] })
  ] });
}
function ChannelRow({ ch, leads, active, onClick }) {
  const group = ch.kind === "group";
  return /* @__PURE__ */ jsxs("button", { className: "tm-ch", "aria-current": active, onClick, children: [
    group ? /* @__PURE__ */ jsx("span", { className: "tm-ch-icon", children: /* @__PURE__ */ jsx(Hash, { size: 14 }) }) : /* @__PURE__ */ jsxs("span", { className: "tm-avstack", children: [
      ch.members.slice(0, 2).map((id) => /* @__PURE__ */ jsx(Avatar, { who: id, leads, size: "sm" }, id)),
      (ch.people || []).includes(OWNER$1) && /* @__PURE__ */ jsx(Avatar, { who: OWNER$1, leads, size: "sm" })
    ] }),
    /* @__PURE__ */ jsxs("span", { className: "tm-ch-name", children: [
      channelName(ch, leads),
      /* @__PURE__ */ jsx("div", { className: "tm-ch-meta", children: group ? `${ch.closed ? "Closed · " : ""}${plural(activeLeadCount(leads, ch.members), "lead")}${ch.held?.length ? ` · ${ch.held.length} held` : ""}` : "Direct message" })
    ] }),
    ch.unread > 0 && /* @__PURE__ */ jsx("span", { className: "tm-unread", "aria-label": `${ch.unread} unread`, children: ch.unread })
  ] });
}
function ChannelHeader({ ch, leads, onCloseGroup }) {
  const group = ch.kind === "group";
  const left = ch.close_check?.blocking?.length || 0;
  return /* @__PURE__ */ jsxs("div", { className: "tm-chhead", children: [
    group ? /* @__PURE__ */ jsx(Hash, { size: 16, style: { color: "var(--muted)" } }) : /* @__PURE__ */ jsx(MessageSquare, { size: 16, style: { color: "var(--muted)" } }),
    /* @__PURE__ */ jsx("span", { className: "tm-chhead-name", children: channelName(ch, leads) }),
    /* @__PURE__ */ jsx("span", { className: "tm-avstack", children: ch.members.map((id) => /* @__PURE__ */ jsx(Avatar, { who: id, leads, size: "sm" }, id)) }),
    /* @__PURE__ */ jsxs("span", { className: "tm-chhead-meta", children: [
      group && /* @__PURE__ */ jsxs(Fragment, { children: [
        plural(activeLeadCount(leads, ch.members), "lead"),
        " + Owner · Managers: ",
        ch.managers.map((m) => shortHandle(leads.get(m)?.handle || m)).join(", ") || "—",
        " · ",
        /* @__PURE__ */ jsxs("span", { style: { whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }, children: [
          /* @__PURE__ */ jsx(ShieldCheck, { size: 12 }),
          "Bar raiser present"
        ] })
      ] }),
      !group && "Direct message · only the two sides and Owner can see it",
      /* @__PURE__ */ jsx(Approx, { kind: "wake" })
    ] }),
    group && (ch.closed ? /* @__PURE__ */ jsxs("span", { className: "tm-chip", "data-testid": "tm-group-closed", children: [
      /* @__PURE__ */ jsx(Lock, { size: 12 }),
      "Closed"
    ] }) : /* @__PURE__ */ jsxs(Btn, { onClick: onCloseGroup, "data-testid": "tm-close-group", title: left ? `${plural(left, "item")} to clear first` : "Close this group", children: [
      /* @__PURE__ */ jsx(Archive, { size: 14 }),
      "Close group",
      left > 0 && /* @__PURE__ */ jsxs("span", { className: "tm-chip is-warn", style: { marginLeft: 2 }, children: [
        left,
        " open"
      ] })
    ] }))
  ] });
}
function CloseGroupDialog({ ch, busy, onClose, onConfirm }) {
  const blocking = ch.close_check?.blocking || [];
  const notes = ch.close_check?.notes || [];
  return /* @__PURE__ */ jsx(Modal, { open: true, onClose: busy ? () => {
  } : onClose, title: `Close #${ch.title}`, maxWidth: 520, children: /* @__PURE__ */ jsxs("div", { className: "tm-form", "data-testid": "tm-close-dialog", children: [
    blocking.length > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Clear these first. Each lead marks its own to-dos done or cancelled; a meeting ends when it is adjourned." }),
      /* @__PURE__ */ jsx("ul", { className: "tm-impact", children: blocking.map((b, i) => /* @__PURE__ */ jsxs("li", { className: "is-warn", children: [
        /* @__PURE__ */ jsx(TriangleAlert, { size: 14 }),
        /* @__PURE__ */ jsx("span", { children: b.text })
      ] }, i)) })
    ] }) : /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "No meeting is running and every action item is answered and done or cancelled. Once closed, nobody can post here, change members or start a meeting. The history stays." }),
    notes.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("div", { className: "tm-label", style: { marginTop: 4 }, children: "Will be left as they are" }),
      /* @__PURE__ */ jsx("ul", { className: "tm-impact", children: notes.map((n, i) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx("span", { children: n.text }) }, i)) })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-dialog-actions", children: [
      /* @__PURE__ */ jsx(Btn, { type: "button", disabled: busy, onClick: onClose, children: "Cancel" }),
      /* @__PURE__ */ jsx(Btn, { danger: true, type: "button", disabled: busy || blocking.length > 0, onClick: onConfirm, "data-testid": "tm-close-confirm", children: "Close group" })
    ] })
  ] }) });
}
function MessageText({ text, leads }) {
  const handles = useMemo(() => new Set([...leads.values()].map((l) => l.handle)), [leads]);
  return /* @__PURE__ */ jsx(Fragment, { children: splitMentions(text, handles).map((p, i) => p.mention ? /* @__PURE__ */ jsx("span", { className: "tm-mention", children: p.text }, i) : /* @__PURE__ */ jsx("span", { children: p.text }, i)) });
}
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const FLIP_HALF_MS = 160;
function FlipCard({ who, front, back }) {
  const [flipped, setFlipped] = useState(false);
  const [turning, setTurning] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flip = () => {
    if (turning) return;
    if (reducedMotion()) {
      setFlipped((f) => !f);
      return;
    }
    setTurning(true);
    timer.current = setTimeout(() => {
      setFlipped((f) => !f);
      timer.current = setTimeout(() => setTurning(false), FLIP_HALF_MS);
    }, FLIP_HALF_MS);
  };
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: `tm-flip ${turning ? "is-turning" : ""} ${flipped ? "is-back" : ""}`,
      role: "button",
      tabIndex: 0,
      "aria-pressed": flipped,
      "aria-label": flipped ? `Details of the message from ${who}. Press to show the message.` : `Message from ${who}. Press for details.`,
      "data-testid": "tm-msg-card",
      "data-side": flipped ? "back" : "front",
      onClick: (e) => {
        if (clickFlips(e.target, window.getSelection?.()?.toString() || "")) flip();
      },
      onKeyDown: (e) => {
        if (e.target === e.currentTarget && flipOnKey(e.key)) {
          e.preventDefault();
          flip();
        }
      },
      children: flipped ? back : front
    }
  );
}
function Message({ m, folded, leads, onOpenThread, inThread, meetings, briefs, channelId, dm, decisions }) {
  if (m.kind === "system") {
    return /* @__PURE__ */ jsxs("div", { className: "tm-sys", role: "note", children: [
      /* @__PURE__ */ jsx(ShieldCheck, { size: 15, className: "tm-sys-icon" }),
      /* @__PURE__ */ jsxs("div", { style: { minWidth: 0 }, children: [
        /* @__PURE__ */ jsx("b", { style: { color: "var(--aim)" }, children: String(m.rawBy || "").startsWith("bar_raiser") || m.case_id ? "Bar raiser" : "Team Mode" }),
        " · ",
        fmtClock(m.ts),
        /* @__PURE__ */ jsx("div", { className: "tm-break", children: /* @__PURE__ */ jsx(MessageText, { text: m.text, leads }) })
      ] })
    ] });
  }
  if (m.kind === "minutes") {
    const mt = (meetings || []).find((x) => x.meeting_id === m.minutes_of);
    return /* @__PURE__ */ jsxs("div", { className: "tm-minutes-post", role: "note", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-minutes-head", children: [
        /* @__PURE__ */ jsx(NotebookText, { size: 15 }),
        /* @__PURE__ */ jsxs("b", { children: [
          "Minutes",
          mt ? ` · ${mt.title}` : ""
        ] }),
        /* @__PURE__ */ jsx("span", { className: "tm-muted", children: fmtClock(m.ts) }),
        /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
        mt && /* @__PURE__ */ jsxs("button", { className: "tm-stub", style: { padding: "1px 8px", fontSize: 12 }, onClick: () => onOpenThread(mt.thread_id), children: [
          "Open meeting",
          /* @__PURE__ */ jsx(ChevronRight, { size: 12 })
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "tm-minutes-text tm-break", children: m.text })
    ] });
  }
  const owner = m.by === OWNER$1;
  const thread = !inThread && !m.thread_id ? threadForRoot(folded, m.seq) : null;
  const replyTo = m.reply_to ? folded.bySeq.get(m.reply_to) : null;
  const who = whoName(m.by, leads);
  const head = /* @__PURE__ */ jsxs("div", { className: "tm-msg-head", children: [
    /* @__PURE__ */ jsx("span", { className: "tm-msg-who", children: who }),
    /* @__PURE__ */ jsx("span", { children: fmtClock(m.ts) })
  ] });
  const rows = messageBack(m, { leads, channelId, briefs, replyTo, everyoneCount: m.everyoneCount, dm, decisions });
  return /* @__PURE__ */ jsxs("div", { className: `tm-msg ${owner ? "is-owner" : ""} ${m.held ? "is-held" : ""}`, children: [
    /* @__PURE__ */ jsx(Avatar, { who: m.by, leads }),
    /* @__PURE__ */ jsxs("div", { className: "tm-msg-body", children: [
      /* @__PURE__ */ jsx(
        FlipCard,
        {
          who,
          front: /* @__PURE__ */ jsxs(Fragment, { children: [
            head,
            /* @__PURE__ */ jsx("div", { className: "tm-bubble", children: /* @__PURE__ */ jsx(MessageText, { text: m.text, leads }) })
          ] }),
          back: /* @__PURE__ */ jsxs(Fragment, { children: [
            head,
            /* @__PURE__ */ jsx("dl", { className: "tm-msg-back", "data-testid": "tm-msg-back", children: rows.map((r, i) => /* @__PURE__ */ jsxs(Fragment$1, { children: [
              /* @__PURE__ */ jsx("dt", { children: r.label }),
              /* @__PURE__ */ jsx("dd", { className: "tm-break", children: r.value })
            ] }, i)) })
          ] })
        }
      ),
      thread && /* @__PURE__ */ jsxs("div", { className: "tm-chips", children: [
        thread && thread.mode === "meeting" && (() => {
          const mt = (meetings || []).find((x) => x.meeting_id === thread.meeting_id);
          const [label, cls] = MEETING_STATE[mt?.state] || MEETING_STATE.convening;
          return /* @__PURE__ */ jsxs("button", { className: "tm-stub is-meeting", onClick: () => onOpenThread(thread.thread_id), children: [
            /* @__PURE__ */ jsx(Gavel, { size: 13 }),
            /* @__PURE__ */ jsx("b", { children: "Meeting" }),
            /* @__PURE__ */ jsx("span", { className: `tm-chip ${cls}`, style: { padding: "0 6px" }, children: label }),
            mt && /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
              plural(mt.agenda.length, "item"),
              " · turns ",
              mt.turns_used,
              "/",
              mt.budgets.turns
            ] }),
            /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "Open meeting" }),
            /* @__PURE__ */ jsx(ChevronRight, { size: 14 })
          ] });
        })(),
        thread && thread.mode !== "meeting" && /* @__PURE__ */ jsxs("button", { className: "tm-stub", onClick: () => onOpenThread(thread.thread_id), children: [
          /* @__PURE__ */ jsx("span", { className: "tm-avstack", children: thread.participants.slice(0, 3).map((id) => /* @__PURE__ */ jsx(Avatar, { who: id, leads, size: "sm" }, id)) }),
          /* @__PURE__ */ jsx("b", { children: plural(thread.count, "reply", "replies") }),
          thread.replies.some((r) => r.held) && /* @__PURE__ */ jsxs("span", { className: "tm-chip is-warn", style: { padding: "0 6px" }, children: [
            /* @__PURE__ */ jsx(Lock, { size: 11 }),
            thread.replies.filter((r) => r.held).length,
            " held"
          ] }),
          /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "Open thread" }),
          /* @__PURE__ */ jsx(ChevronRight, { size: 14 })
        ] })
      ] })
    ] })
  ] });
}
function Conversation({ folded, channel, leads, meetings, briefs, decisions, onOpenThread }) {
  const ref = useRef(null);
  const count = folded.main.length;
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, channel.id]);
  const n = activeLeadCount(leads, channel.members);
  return /* @__PURE__ */ jsxs("div", { className: "tm-scroll", ref, children: [
    /* @__PURE__ */ jsx("div", { className: "tm-daysep", children: channel.kind === "group" ? `#${channelName(channel, leads)} · ${plural(n, "lead")} + Owner · @ = assign, must answer · @everyone = wake everyone` : "Start of direct message" }),
    folded.main.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-empty", children: "No messages yet." }),
    folded.main.map((m) => /* @__PURE__ */ jsx(Message, { m: { ...m, everyoneCount: m.everyone ? plural(n, "lead") : "" }, folded, leads, meetings, briefs, decisions, dm: channel.kind === "dm", channelId: channel.id, onOpenThread }, m.seq))
  ] });
}
function ThreadDrawer({ folded, threadId, channel, leads, briefs, onClose, onSend, disabled, stopped }) {
  const th = folded.threads.get(threadId);
  const root = th && folded.bySeq.get(th.root_seq);
  if (!th) return null;
  return /* @__PURE__ */ jsxs("div", { className: "tm-drawer", role: "dialog", "aria-label": "Thread", "data-testid": "tm-thread-drawer", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-drawer-head", children: [
      /* @__PURE__ */ jsx(MessagesSquare, { size: 16, style: { color: "var(--muted)" } }),
      /* @__PURE__ */ jsx("b", { style: { color: "var(--text-strong)" }, children: "Thread" }),
      /* @__PURE__ */ jsx("span", { className: "tm-avstack", style: { marginLeft: 6 }, children: th.participants.map((id) => /* @__PURE__ */ jsx(Avatar, { who: id, leads, size: "sm" }, id)) }),
      /* @__PURE__ */ jsx("button", { className: "tm-icobtn", style: { marginLeft: "auto" }, onClick: onClose, "aria-label": "Close thread", children: /* @__PURE__ */ jsx(X, { size: 16 }) })
    ] }),
    root && /* @__PURE__ */ jsx("div", { className: "tm-drawer-root", children: /* @__PURE__ */ jsx(Message, { m: root, folded, leads, briefs, channelId: channel.id, inThread: true, onOpenThread: () => {
    } }) }),
    /* @__PURE__ */ jsxs("div", { className: "tm-scroll", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-daysep", children: [
        plural(th.count, "reply", "replies"),
        " · only participants and Owner can see this · an @ here pulls that lead in"
      ] }),
      th.replies.map((m) => /* @__PURE__ */ jsx(Message, { m, folded, leads, briefs, channelId: channel.id, inThread: true, onOpenThread: () => {
      } }, m.seq))
    ] }),
    /* @__PURE__ */ jsx(Composer, { channel, leads, threadId, onSend, disabled, stopped })
  ] });
}
function Composer({ channel, leads, threadId, onSend, disabled, stopped, meeting }) {
  const [text, setText] = useState("");
  const [pop, setPop] = useState(null);
  const [hi, setHi] = useState(0);
  const taRef = useRef(null);
  const options = useMemo(() => {
    if (!pop) return [];
    const members = channel.members.map((id) => leads.get(id)).filter(Boolean);
    const all = [...members.map((l) => ({ handle: l.handle, id: l.lead_id, note: "assign · must answer" }))];
    if (channel.kind === "group" && !threadId) all.push({ handle: "everyone", id: "everyone", note: "broadcast · wakes all" });
    const q = pop.query.toLowerCase();
    return all.filter((o) => o.handle.toLowerCase().includes(q));
  }, [pop, channel, leads, threadId]);
  const onChange = (e) => {
    const v = e.target.value;
    setText(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = /@([\w.-]*)$/.exec(v.slice(0, caret));
    setPop(m ? { query: m[1], start: caret - m[0].length } : null);
    setHi(0);
  };
  const pick = (o) => {
    const caret = taRef.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, pop.start)}@${o.handle} ${text.slice(caret)}`;
    setText(next);
    setPop(null);
    taRef.current?.focus();
  };
  const send = async () => {
    const body = text.trim();
    if (!body || disabled) return;
    const { mentions: mentions2, everyone: everyone2 } = parseOwnerMentions(body, leads);
    const payload = { thread: threadId || "main", text: body, mentions: mentions2, cc: [], everyone: everyone2 };
    if (channel.kind === "dm" && !(channel.people || []).includes(OWNER$1)) payload.to = channel.members[0];
    payload.channel_id = channel.id;
    const ok = await onSend(payload);
    if (ok) setText("");
  };
  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (pop && options.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((hi + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((hi - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[hi]);
        return;
      }
      if (e.key === "Escape") {
        setPop(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const { mentions, everyone } = parseOwnerMentions(text, leads);
  return /* @__PURE__ */ jsxs("div", { className: "tm-composer", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-composer-target", children: [
      /* @__PURE__ */ jsxs("span", { children: [
        "Posting as Owner to ",
        /* @__PURE__ */ jsx("b", { style: { color: "var(--text)" }, children: meeting ? "the meeting" : threadId ? "the thread" : channel.kind === "group" ? "main" : "direct message" })
      ] }),
      /* @__PURE__ */ jsx("span", { children: meeting ? "· gives the current item one extra round; an @ names the next speakers" : "· your post resets the hop count" }),
      mentions.length > 0 && /* @__PURE__ */ jsxs("span", { className: "tm-chip is-assign", children: [
        /* @__PURE__ */ jsx(AtSign, { size: 12 }),
        meeting ? "Speaks next" : "Assigns",
        " ",
        mentions.map((id) => shortHandle(leads.get(id)?.handle)).join(", ")
      ] }),
      everyone && /* @__PURE__ */ jsxs("span", { className: "tm-chip is-info", children: [
        /* @__PURE__ */ jsx(Megaphone, { size: 12 }),
        "Broadcast"
      ] })
    ] }),
    pop && options.length > 0 && /* @__PURE__ */ jsx("div", { className: "tm-pop", role: "listbox", "aria-label": "Mention a lead", children: options.map((o, i) => /* @__PURE__ */ jsxs("button", { role: "option", "aria-selected": i === hi, className: "tm-pop-item", onMouseDown: (e) => {
      e.preventDefault();
      pick(o);
    }, children: [
      o.id === "everyone" ? /* @__PURE__ */ jsx("span", { className: "tm-av sm owner", children: /* @__PURE__ */ jsx(Megaphone, { size: 11 }) }) : /* @__PURE__ */ jsx(Avatar, { who: o.id, leads, size: "sm" }),
      /* @__PURE__ */ jsxs("span", { className: "tm-pop-handle", children: [
        "@",
        o.handle
      ] }),
      /* @__PURE__ */ jsx("small", { children: o.note })
    ] }, o.id)) }),
    /* @__PURE__ */ jsxs("div", { className: "tm-composer-box", children: [
      /* @__PURE__ */ jsx("button", { className: "tm-icobtn", "aria-label": "Insert @", onClick: () => {
        setText((t) => `${t}@`);
        setPop({ query: "", start: text.length });
        taRef.current?.focus();
      }, children: /* @__PURE__ */ jsx(AtSign, { size: 16 }) }),
      /* @__PURE__ */ jsx(
        "textarea",
        {
          ref: taRef,
          className: "tm-textarea",
          rows: 1,
          value: text,
          onChange,
          onKeyDown,
          placeholder: channel.closed ? "This group is closed." : stopped ? "Emergency stop is on. Resume to post." : meeting ? "Speak in the meeting as Owner…" : threadId ? "Reply in the thread; an @ pulls a lead in…" : channel.kind === "group" ? "Post to main; @ someone to assign…" : "Direct message…",
          disabled,
          "aria-label": "Message"
        }
      ),
      /* @__PURE__ */ jsx("button", { className: "tm-send", onClick: send, disabled: disabled || !text.trim(), "aria-label": "Send", children: /* @__PURE__ */ jsx(ArrowUp, { size: 16 }) })
    ] })
  ] });
}
const STANCE = { propose: ["Proposes", "is-assign"], agree: ["Agrees", "is-ok"], object: ["Objects", "is-err"], info: ["Info", "is-info"], pass: ["Pass", ""] };
const ACTION_ITEM = { proposed: ["Waiting for the owner to accept", "is-info"], accepted: ["Accepted · in the owner's to-dos", "is-ok"], declined: ["Declined", "is-err"], unowned: ["Unowned", "is-warn"] };
const ADJOURN = { agenda_done: "agenda done", turn_budget: "turn budget used up", time_budget: "time budget used up", owner: "Owner adjourned" };
function mName(m, who, leads) {
  if (who === OWNER$1) return OWNER_NAME;
  if (who === "none") return "none";
  return shortHandle(leads.get(who)?.handle || m.names?.[who] || who);
}
function MeetingRow({ m, waiting, leads, channels, active, onClick }) {
  const [label, cls] = MEETING_STATE[m.state] || MEETING_STATE.convening;
  const ch = channels.find((c) => c.id === m.channel_id);
  const cur = m.agenda.findIndex((a) => a.item_id === m.current);
  const needs = meetingNeedsYou(m, waiting).length;
  return /* @__PURE__ */ jsxs("button", { className: "tm-ch", "aria-current": active, onClick, children: [
    /* @__PURE__ */ jsx("span", { className: "tm-avstack", children: m.speakers.slice(0, 3).map((id) => /* @__PURE__ */ jsx(Avatar, { who: id, leads, size: "sm" }, id)) }),
    /* @__PURE__ */ jsxs("span", { className: "tm-ch-name", children: [
      m.title,
      /* @__PURE__ */ jsxs("div", { className: "tm-ch-meta", children: [
        /* @__PURE__ */ jsx("span", { className: `tm-chip ${cls}`, style: { padding: "0 6px", fontSize: 11 }, children: label }),
        needs > 0 && /* @__PURE__ */ jsx("span", { className: "tm-chip is-err", style: { padding: "0 6px", fontSize: 11, marginLeft: 4 }, children: "Needs you" }),
        " #",
        channelName(ch, leads),
        cur >= 0 ? ` · item ${cur + 1}/${m.agenda.length}` : ""
      ] })
    ] }),
    m.state === "open" && /* @__PURE__ */ jsx("span", { className: "tm-live-dot", "aria-label": "in session" })
  ] });
}
function MeetingDrawer({ m, state, channel, leads, onClose, onSend, onAdjourn, disabled, stopped, busy }) {
  const [tab, setTab] = useState("agenda");
  const [label, cls] = MEETING_STATE[m.state] || MEETING_STATE.convening;
  const live = ["convening", "open", "adjourning"].includes(m.state);
  const cur = m.agenda.find((a) => a.item_id === m.current);
  const closed = m.agenda.filter((a) => a.state === "closed").length;
  const br = m.bar_raiser || {};
  const brCase = (state.cases || []).filter((c) => c.channel_id === m.channel_id && c.thread_id === m.thread_id);
  const brKeys = new Set(brCase.map((c) => `case:${c.case_id}`));
  const waitingYou = waitingOnYou(state).some((d) => brKeys.has(d.key));
  const brText = waitingYou ? ["Waiting for your answer", "is-err"] : br.pending ? ["Reviewing an item", "is-info"] : br.waiting_person ? ["Waiting for a person", "is-warn"] : ["Standing by", ""];
  const TABS_M = [["agenda", "Agenda", ListChecks], ["minutes", "Minutes", NotebookText], ["actions", "Action items", ClipboardList], ["ledger", "Ledger", ScrollText]];
  return /* @__PURE__ */ jsxs("div", { className: "tm-drawer tm-mdrawer", role: "dialog", "aria-label": `meeting ${m.title}`, "data-testid": "meeting-panel", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-drawer-head", children: [
      /* @__PURE__ */ jsx(Gavel, { size: 16, style: { color: "var(--accent)" } }),
      /* @__PURE__ */ jsx("b", { className: "tm-ellipsis", style: { color: "var(--text-strong)" }, children: m.title }),
      /* @__PURE__ */ jsx("span", { className: `tm-chip ${cls}`, children: label }),
      /* @__PURE__ */ jsx("span", { className: "tm-spacer", style: { flex: 1 } }),
      live && m.state !== "adjourning" && /* @__PURE__ */ jsx(Btn, { danger: true, disabled: busy, onClick: onAdjourn, children: "Adjourn" }),
      /* @__PURE__ */ jsx("button", { className: "tm-icobtn", onClick: onClose, "aria-label": "Close meeting", children: /* @__PURE__ */ jsx(X, { size: 16 }) })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-mhead", children: [
      m.purpose && /* @__PURE__ */ jsx("div", { className: "tm-muted tm-break", style: { marginBottom: 6 }, children: m.purpose }),
      /* @__PURE__ */ jsxs("div", { className: "tm-mpeople", children: [
        m.speakers.map((id) => /* @__PURE__ */ jsxs("span", { className: "tm-mperson", children: [
          /* @__PURE__ */ jsx(Avatar, { who: id, leads, size: "sm" }),
          mName(m, id, leads),
          id === m.convener && /* @__PURE__ */ jsx("span", { className: "tm-role", children: "convener" }),
          id === m.chair && /* @__PURE__ */ jsx("span", { className: "tm-role", children: "chair" })
        ] }, id)),
        Object.entries(m.invitees || {}).filter(([, i]) => i.state !== "accepted").map(([id, i]) => /* @__PURE__ */ jsxs("span", { className: "tm-mperson is-dim", title: i.note || "", children: [
          /* @__PURE__ */ jsx(Avatar, { who: id, leads, size: "sm" }),
          mName(m, id, leads),
          /* @__PURE__ */ jsx("span", { className: "tm-role", children: i.state === "invited" ? "invited" : "declined" })
        ] }, id)),
        /* @__PURE__ */ jsxs("span", { className: "tm-mperson", children: [
          /* @__PURE__ */ jsx("span", { className: "tm-av sm br", "aria-hidden": "true", children: /* @__PURE__ */ jsx(ShieldCheck, { size: 12 }) }),
          "Bar raiser",
          /* @__PURE__ */ jsx("span", { className: `tm-chip ${brText[1]}`, style: { padding: "0 6px" }, children: brText[0] }),
          /* @__PURE__ */ jsxs("span", { className: "tm-mono tm-muted", children: [
            br.cases ?? 0,
            "/",
            br.cap ?? 6
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "tm-mbudget", children: [
        /* @__PURE__ */ jsx(Meter, { label: "Turns", used: m.turns_used, cap: m.budgets.turns }),
        /* @__PURE__ */ jsx(Meter, { label: "Minutes open", used: Math.floor((m.elapsed_secs || 0) / 60), cap: m.budgets.minutes }),
        /* @__PURE__ */ jsx(Meter, { label: "Items closed", used: closed, cap: m.agenda.length, fullOk: true }),
        /* @__PURE__ */ jsx(Meter, { label: cur ? `Round · ${cur.title}` : "Round", used: cur?.round || 0, cap: cur ? m.budgets.rounds + (cur.extra_rounds || 0) : m.budgets.rounds })
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "tm-tabs tm-mtabs", role: "tablist", "aria-label": "Meeting views", children: TABS_M.map(([k, l, Icon]) => /* @__PURE__ */ jsxs("button", { role: "tab", className: "tm-tab", "aria-selected": tab === k, onClick: () => setTab(k), children: [
      /* @__PURE__ */ jsx(Icon, { size: 14 }),
      l,
      k === "actions" && m.actions.length > 0 && /* @__PURE__ */ jsx("span", { className: "tm-muted", children: m.actions.length })
    ] }, k)) }),
    /* @__PURE__ */ jsxs("div", { className: "tm-scroll tm-mbody", children: [
      tab === "agenda" && /* @__PURE__ */ jsx(AgendaTab, { m, leads, waiting: waitingOnYou(state) }),
      tab === "minutes" && /* @__PURE__ */ jsx(MinutesTab, { m, leads }),
      tab === "actions" && /* @__PURE__ */ jsx(ActionsTab, { m, leads }),
      tab === "ledger" && /* @__PURE__ */ jsx(MeetingLedger, { rows: meetingRows(state.entries?.[m.channel_id], m.meeting_id) })
    ] }),
    live && /* @__PURE__ */ jsx(Composer, { channel, leads, threadId: m.thread_id, onSend, disabled, stopped, meeting: true })
  ] });
}
function AgendaTab({ m, leads, waiting }) {
  if (m.state === "convening") {
    const wait = Object.entries(m.invitees || {}).filter(([, i]) => i.state === "invited").map(([id]) => mName(m, id, leads));
    return /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-mnote", children: [
      /* @__PURE__ */ jsx(Hourglass, { size: 14 }),
      "Waiting for answers",
      wait.length ? ` from ${wait.join(", ")}` : "",
      " · opens with 2 or more speakers · answer by ",
      fmtClock(m.respond_by)
    ] });
  }
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    m.state === "cancelled" && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-mnote", children: [
      "Cancelled: ",
      m.cancel_reason === "quorum" ? "fewer than 2 speakers accepted" : m.cancel_reason
    ] }),
    m.adjourn_reason && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-mnote", children: [
      "Adjourned · ",
      ADJOURN[m.adjourn_reason] || m.adjourn_reason
    ] }),
    /* @__PURE__ */ jsx("ol", { className: "tm-agenda", children: m.agenda.map((a, i) => /* @__PURE__ */ jsx(AgendaItem, { a, n: i + 1, m, leads, waiting }, a.item_id)) })
  ] });
}
function AgendaItem({ a, n, m, leads, waiting }) {
  const current = a.item_id === m.current;
  const [open, setOpen] = useState(current);
  useEffect(() => {
    if (current) setOpen(true);
  }, [current]);
  const out = a.outcome && (OUTCOME[a.outcome.kind] || [a.outcome.kind, ""]);
  const badge = a.state === "closed" ? "done" : current ? a.waiting || a.br_needed?.length ? "wait" : "cur" : "";
  const grants = openGrants(a);
  const rd = a.rounds?.[String(a.round)];
  const sealed = rd?.sealed && !rd?.revealed;
  const ballots = Object.values(a.ballots || {});
  const proposals = Object.values(a.proposals || {});
  const stages = itemStages(a, m, (w) => mName(m, w, leads), waiting);
  return /* @__PURE__ */ jsxs("li", { className: `tm-agenda-item ${current ? "is-current" : ""} ${stages.needsYou ? "is-needs" : ""}`, "data-testid": "agenda-item", children: [
    /* @__PURE__ */ jsxs("button", { className: "tm-agenda-row", onClick: () => setOpen(!open), "aria-expanded": open, children: [
      /* @__PURE__ */ jsx("span", { className: `tm-agenda-n ${badge}`, children: a.state === "closed" ? /* @__PURE__ */ jsx(Check, { size: 13 }) : n }),
      /* @__PURE__ */ jsxs("span", { style: { minWidth: 0, flex: 1 }, children: [
        /* @__PURE__ */ jsx("b", { className: "tm-break", children: a.title }),
        a.question && /* @__PURE__ */ jsx("small", { className: "tm-break", children: a.question })
      ] }),
      stages.needsYou ? /* @__PURE__ */ jsx("span", { className: "tm-chip is-err", children: "Needs you" }) : out ? /* @__PURE__ */ jsx("span", { className: `tm-chip ${out[1]}`, children: out[0] }) : current ? /* @__PURE__ */ jsxs("span", { className: "tm-chip is-assign", children: [
        "Round ",
        a.round,
        "/",
        m.budgets.rounds + (a.extra_rounds || 0)
      ] }) : /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "pending" })
    ] }),
    /* @__PURE__ */ jsx(StageBar, { stages }),
    open && /* @__PURE__ */ jsxs("div", { className: "tm-agenda-body", children: [
      a.outcome && /* @__PURE__ */ jsxs("div", { className: "tm-outcome", children: [
        /* @__PURE__ */ jsxs("b", { children: [
          out[0],
          ":"
        ] }),
        " ",
        /* @__PURE__ */ jsx("span", { className: "tm-break", children: readableIds(a.outcome.text, a.item_id, m.refs) }),
        a.outcome.rationale && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
          "Rationale: ",
          readableIds(a.outcome.rationale, a.item_id, m.refs)
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          "recorded by ",
          a.outcome.by === "planner" ? "the server" : a.outcome.by === "bar_raiser" ? "the bar raiser" : a.outcome.by
        ] })
      ] }),
      current && grants.length > 0 && /* @__PURE__ */ jsxs("div", { className: "tm-case-row", children: [
        /* @__PURE__ */ jsx(Hourglass, { size: 13, className: "tm-muted" }),
        /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "Floor:" }),
        grants.map((g) => /* @__PURE__ */ jsxs("span", { className: "tm-chip is-info", children: [
          mName(m, g.speaker, leads),
          " · ",
          g.sealed ? "sealed · " : "",
          "until ",
          fmtClock(g.expires_at)
        ] }, g.turn_id))
      ] }),
      current && sealed && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-mnote", children: [
        /* @__PURE__ */ jsx(Lock, { size: 13 }),
        "Round 1 is sealed: speakers see the presentation, not each other, until everyone has spoken."
      ] }),
      current && a.waiting && /* @__PURE__ */ jsxs("div", { className: "tm-chip is-warn is-wrap", style: { marginTop: 6 }, children: [
        "Waiting for a person",
        a.waiting.question ? `: ${a.waiting.question}` : "",
        " · speak below to answer"
      ] }),
      current && a.br_needed?.length > 0 && /* @__PURE__ */ jsxs("div", { className: "tm-chip is-info is-wrap", style: { marginTop: 6 }, children: [
        /* @__PURE__ */ jsx(ShieldCheck, { size: 12 }),
        "Bar raiser called: ",
        TRIGGER[`meeting_${a.br_needed[0].trigger}`] || a.br_needed[0].trigger
      ] }),
      proposals.length > 0 && /* @__PURE__ */ jsx("div", { className: "tm-proposals", children: proposals.map((p) => {
        const st = stanceOf(a, m.speakers, p.proposal_id);
        return /* @__PURE__ */ jsxs("div", { className: `tm-proposal ${a.outcome?.proposal_id === p.proposal_id ? "is-win" : ""}`, children: [
          /* @__PURE__ */ jsxs("div", { className: "tm-case-row", children: [
            /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
              "Proposal ",
              pNum(a, p.proposal_id)
            ] }),
            /* @__PURE__ */ jsx("b", { children: mName(m, p.by, leads) }),
            /* @__PURE__ */ jsxs("span", { className: "tm-chip is-ok", children: [
              st.agree.length,
              " agree"
            ] }),
            /* @__PURE__ */ jsxs("span", { className: `tm-chip ${st.object.length ? "is-err" : ""}`, children: [
              st.object.length,
              " object"
            ] })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "tm-break", children: p.text })
        ] }, p.proposal_id);
      }) }),
      ballots.map((b) => /* @__PURE__ */ jsxs("div", { className: "tm-ballot", children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-case-row", children: [
          /* @__PURE__ */ jsx(Vote, { size: 13 }),
          /* @__PURE__ */ jsx("b", { children: "Ballot" }),
          /* @__PURE__ */ jsx("span", { className: "tm-muted", children: b.state === "open" ? `sealed to voters until it closes · ${Object.keys(b.votes).length}/${m.speakers.length} voted` : b.tie?.length ? `tie: ${b.tie.join(", ")}` : b.winner ? `winner: ${b.winner}` : "closed" })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "tm-chips", children: b.options.map((o) => /* @__PURE__ */ jsxs("span", { className: `tm-chip ${b.winner === o ? "is-ok" : ""}`, children: [
          o,
          b.tally ? ` · ${b.tally[o] ?? 0}` : ""
        ] }, o)) }),
        Object.entries(b.votes || {}).map(([w, v]) => /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
          mName(m, w, leads),
          " → ",
          /* @__PURE__ */ jsx("b", { children: v.choice }),
          ": ",
          readableIds(v.reason, a.item_id, m.refs)
        ] }, w))
      ] }, b.ballot_id)),
      (a.speeches || []).length > 0 && /* @__PURE__ */ jsx("div", { className: "tm-speeches", children: a.speeches.map((s) => {
        const [sl, sc] = STANCE[s.stance] || [s.stance, ""];
        return /* @__PURE__ */ jsxs("div", { className: "tm-speech", children: [
          /* @__PURE__ */ jsx(Avatar, { who: s.by, leads, size: "sm" }),
          /* @__PURE__ */ jsxs("div", { style: { minWidth: 0, flex: 1 }, children: [
            /* @__PURE__ */ jsxs("div", { className: "tm-msg-head", children: [
              /* @__PURE__ */ jsx("span", { className: "tm-msg-who", children: mName(m, s.by, leads) }),
              /* @__PURE__ */ jsxs("span", { className: `tm-chip ${sc}`, style: { padding: "0 6px" }, children: [
                sl,
                s.proposal_id && pNum(a, s.proposal_id) ? ` proposal ${pNum(a, s.proposal_id)}` : ""
              ] }),
              /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
                "round ",
                s.round,
                s.sealed_key ? " · sealed" : "",
                " · ",
                fmtClock(s.ts)
              ] })
            ] }),
            /* @__PURE__ */ jsx("div", { className: "tm-break", children: readableIds(s.text, a.item_id, m.refs) }),
            s.evidence?.length > 0 && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
              "Evidence: ",
              s.evidence.join(" · ")
            ] })
          ] })
        ] }, s.seq);
      }) }),
      (a.person || []).map((p) => /* @__PURE__ */ jsxs("div", { className: "tm-speech is-owner", children: [
        /* @__PURE__ */ jsx(Avatar, { who: OWNER$1, leads, size: "sm" }),
        /* @__PURE__ */ jsxs("div", { className: "tm-break", children: [
          /* @__PURE__ */ jsx("b", { children: OWNER_NAME }),
          " · ",
          p.text
        ] })
      ] }, p.seq))
    ] })
  ] });
}
function StageBar({ stages }) {
  return /* @__PURE__ */ jsx("ol", { className: "tm-stages", "aria-label": "Item stage", children: stages.steps.map((s) => {
    const needs = s.state === "current" && s.note === "Needs you";
    return /* @__PURE__ */ jsxs(
      "li",
      {
        className: `tm-stage is-${s.state} ${needs ? "is-needs" : ""}`,
        "aria-current": s.state === "current" ? "step" : void 0,
        title: s.state === "skipped" ? `${s.label}: none` : s.label,
        children: [
          /* @__PURE__ */ jsx("span", { className: "tm-stage-label", children: needs ? "Needs you" : s.label }),
          s.note && !needs && /* @__PURE__ */ jsx("span", { className: "tm-stage-note", children: s.note })
        ]
      },
      s.key
    );
  }) });
}
const pNum = (a, pid) => Object.keys(a.proposals || {}).indexOf(pid) + 1 || null;
const itemNum = (m, iid) => m.agenda.findIndex((x) => x.item_id === iid) + 1 || null;
function stanceOf(a, speakers, pid) {
  const agree = [];
  const object = [];
  for (const s of speakers) {
    const l = a.latest?.[s];
    if (l && l[1] === pid) (l[0] === "object" ? object : agree).push(s);
  }
  return { agree, object };
}
function MinutesTab({ m, leads }) {
  const mn = m.minutes;
  if (!mn) return /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-mnote", children: [
    /* @__PURE__ */ jsx(NotebookText, { size: 14 }),
    "The server writes the minutes from the ledger when the meeting adjourns. No bot writes them."
  ] });
  const names = (ws) => (ws || []).map((w) => mName(m, w, leads)).join(", ") || "none";
  return /* @__PURE__ */ jsxs("div", { className: "tm-minutes", children: [
    /* @__PURE__ */ jsxs("h4", { children: [
      /* @__PURE__ */ jsx(NotebookText, { size: 14 }),
      "Minutes · ",
      mn.title
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
      "Convener ",
      mName(m, mn.convener, leads),
      " · chair ",
      mName(m, mn.chair, leads),
      " · open ",
      mn.budget.minutes[0],
      "/",
      mn.budget.minutes[1],
      " min · turns ",
      mn.budget.turns[0],
      "/",
      mn.budget.turns[1],
      " · ",
      ADJOURN[mn.adjourn_reason] || mn.adjourn_reason
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
      "Attended ",
      names(mn.attendees.accepted),
      mn.attendees.declined.length ? ` · declined ${names(mn.attendees.declined.map((d) => d.who))}` : "",
      mn.attendees.no_answer.length ? ` · no answer ${names(mn.attendees.no_answer)}` : ""
    ] }),
    /* @__PURE__ */ jsx("ol", { children: mn.items.map((it) => {
      const o = it.outcome && (OUTCOME[it.outcome.kind] || [it.outcome.kind, ""]);
      return /* @__PURE__ */ jsxs("li", { children: [
        /* @__PURE__ */ jsx("b", { children: it.title }),
        " ",
        o && /* @__PURE__ */ jsx("span", { className: `tm-chip ${o[1]}`, style: { padding: "0 6px" }, children: o[0] }),
        " ",
        /* @__PURE__ */ jsx("span", { className: "tm-break", children: readableIds(it.outcome?.text, it.item_id, m.refs) }),
        it.stances && /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          "Agree ",
          names(it.stances.agree),
          " · object ",
          names(it.stances.object),
          " · abstain ",
          names(it.stances.abstain)
        ] }),
        it.ballots.filter((b) => b.tally).map((b) => /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          "Vote ",
          Object.entries(b.tally).map(([k, v]) => `${k} ${v}`).join(", "),
          b.tie.length ? ` · tie ${b.tie.join(", ")}` : ""
        ] }, b.ballot_id)),
        it.dissent.map((d, i) => /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
          "Dissent, ",
          mName(m, d.who, leads),
          ": “",
          d.text,
          "”"
        ] }, i)),
        (it.rejected || []).length > 0 && /* @__PURE__ */ jsxs("div", { className: "tm-minutes-rejected", children: [
          /* @__PURE__ */ jsx("div", { className: "tm-muted", children: /* @__PURE__ */ jsx("b", { children: "Turned down" }) }),
          it.rejected.map((r, i) => /* @__PURE__ */ jsxs("div", { className: "tm-break", children: [
            /* @__PURE__ */ jsx("span", { className: "tm-chip is-warn", style: { padding: "0 6px" }, children: r.label }),
            r.by ? ` ${mName(m, r.by, leads)}: ` : " ",
            "“",
            r.text,
            "”",
            /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
              r.reason,
              " · chosen instead: ",
              r.lost_to
            ] }),
            r.objections.map((o2, j) => /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
              "Objection, ",
              mName(m, o2.who, leads),
              ": “",
              o2.text,
              "”"
            ] }, j))
          ] }, i))
        ] }),
        it.outcome?.rationale && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
          "Bar raiser rationale: ",
          readableIds(it.outcome.rationale, it.item_id, m.refs)
        ] })
      ] }, it.item_id);
    }) }),
    mn.actions.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("b", { children: "Action items" }),
      /* @__PURE__ */ jsx("ul", { children: mn.actions.map((a) => /* @__PURE__ */ jsxs("li", { children: [
        mName(m, a.owner, leads),
        ": ",
        a.title,
        a.due ? ` (due ${a.due})` : "",
        " · ",
        a.state,
        a.reason ? `: ${a.reason}` : ""
      ] }, a.action_id)) })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-muted", style: { marginTop: 8 }, children: [
      mn.source,
      " Posted to main; each attendee gets an inbox pointer. Not written into any bot's memory."
    ] })
  ] });
}
function ActionsTab({ m, leads }) {
  if (!m.actions.length) return /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-mnote", children: [
    /* @__PURE__ */ jsx(ClipboardList, { size: 14 }),
    "No action items yet. A speaker proposes one to an attendee; it reaches that attendee's to-dos only when they accept."
  ] });
  return /* @__PURE__ */ jsx("div", { children: m.actions.map((a) => {
    const st = a.state === "proposed" && m.state === "closed" ? "unowned" : a.state;
    const [l, c] = ACTION_ITEM[st] || [st, ""];
    return /* @__PURE__ */ jsxs("div", { className: "tm-action", children: [
      /* @__PURE__ */ jsx(Avatar, { who: a.owner, leads, size: "sm" }),
      /* @__PURE__ */ jsxs("div", { style: { minWidth: 0, flex: 1 }, children: [
        /* @__PURE__ */ jsx("b", { className: "tm-break", children: a.title }),
        /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          mName(m, a.owner, leads),
          a.due ? ` · due ${a.due}` : "",
          " · proposed by ",
          mName(m, a.by, leads),
          a.item_id && itemNum(m, a.item_id) ? ` · item ${itemNum(m, a.item_id)}` : ""
        ] }),
        a.detail && /* @__PURE__ */ jsx("div", { className: "tm-muted tm-break", children: a.detail }),
        /* @__PURE__ */ jsxs("span", { className: `tm-chip is-wrap ${c}`, children: [
          l,
          a.reason ? `: ${a.reason}` : ""
        ] })
      ] })
    ] }, a.action_id);
  }) });
}
function MeetingLedger({ rows }) {
  return /* @__PURE__ */ jsx("div", { className: "tm-xscroll", children: /* @__PURE__ */ jsxs("table", { className: "tm-table tm-ledger", children: [
    /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
      /* @__PURE__ */ jsx("th", { children: "seq" }),
      /* @__PURE__ */ jsx("th", { children: "Time" }),
      /* @__PURE__ */ jsx("th", { children: "type" }),
      /* @__PURE__ */ jsx("th", { children: "by" })
    ] }) }),
    /* @__PURE__ */ jsx("tbody", { children: [...rows].reverse().map((r) => /* @__PURE__ */ jsxs("tr", { title: JSON.stringify(r.data), children: [
      /* @__PURE__ */ jsx("td", { children: r.seq }),
      /* @__PURE__ */ jsx("td", { className: "tm-muted", children: fmtClock(r.ts) }),
      /* @__PURE__ */ jsxs("td", { className: "tm-type", children: [
        r.type,
        r.data?.meeting ? ` · ${r.data.meeting.stance}` : ""
      ] }),
      /* @__PURE__ */ jsx("td", { children: r.by })
    ] }, r.seq)) })
  ] }) });
}
function BriefCard({ state, leads }) {
  const briefs = state.briefs || [];
  const ids = [...leads.keys()];
  const [who, setWho] = useState(ids[0] || "");
  useEffect(() => {
    if (!who && ids.length) setWho(ids[0]);
  }, [who, ids]);
  const latest = briefs.filter((b) => b.lead_id === who).sort((a, b) => b.ts - a.ts)[0];
  const channels = new Map((state.channels || []).map((c) => [c.id, c]));
  return /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(Sparkles, { size: 15, style: { color: "var(--accent)" } }),
      "Secretary brief",
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsx("select", { className: "tm-select", value: who, onChange: (e) => setWho(e.target.value), "aria-label": "Whose brief", children: ids.map((id) => /* @__PURE__ */ jsx("option", { value: id, children: shortHandle(leads.get(id).handle) }, id)) })
    ] }),
    !latest ? /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "This lead has not been woken yet." }) : /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-case-row", children: [
        /* @__PURE__ */ jsxs("span", { className: `tm-lane ${latest.lane}`, children: [
          "lane ",
          latest.lane
        ] }),
        /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
          "Woken ",
          fmtClock(latest.ts),
          " · reason: ",
          [...new Set((latest.reasons || []).map(reasonLabel))].join(", ")
        ] })
      ] }),
      latest.lane === "rules" && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", style: { marginTop: 4 }, children: [
        "The secretary did not submit (",
        latest.fallback_reason || "invalid",
        "), so code grouped the items and used each first line as the summary. The wake went out as usual."
      ] }),
      (latest.brief?.groups || []).map((g, i) => {
        const ch = channels.get(g.channel_id);
        return /* @__PURE__ */ jsxs("div", { className: "tm-brief-group", children: [
          /* @__PURE__ */ jsxs("div", { className: "tm-brief-place", children: [
            ch?.kind === "dm" ? /* @__PURE__ */ jsx(MessageSquare, { size: 12 }) : /* @__PURE__ */ jsx(Hash, { size: 12 }),
            channelName(ch, leads) || g.channel_id,
            g.thread_id ? ` › ${threadLabel(g.thread_id, ch?.thread_titles)}` : " › main"
          ] }),
          g.items.map((it, j) => /* @__PURE__ */ jsxs("div", { className: "tm-brief-item", children: [
            /* @__PURE__ */ jsxs("span", { className: "tm-seq", children: [
              "#",
              it.seqs.join(",")
            ] }),
            /* @__PURE__ */ jsxs("span", { className: "tm-break", children: [
              it.summary,
              /* @__PURE__ */ jsx(BriefPointers, { p: it.pointers, here: g.channel_id, channels, leads })
            ] })
          ] }, j))
        ] }, i);
      }),
      /* @__PURE__ */ jsx("div", { className: "tm-muted", style: { marginTop: 6 }, children: "Organizes only, never judges. The wake itself carries a pointer, not the message text." })
    ] })
  ] });
}
function BriefPointers({ p, here, channels, leads }) {
  if (!p) return null;
  const at = (r) => `${r.channel_id === here ? "" : `${channelName(channels.get(r.channel_id), leads) || r.channel_id} `}#${r.seq}`;
  const parts = [];
  if (p.seen_before?.length) parts.push(`Seen before: ${p.seen_before.map(at).join(", ")}`);
  if (p.answered_before) parts.push(`You answered: ${at(p.answered_before)}`);
  if (p.repeat_count > 1) parts.push(`Came up ${p.repeat_count}× in 7 days`);
  const room = (r) => r.channel_id === here ? "this group" : channelName(channels.get(r.channel_id), leads) || "another group";
  if (p.decided_before) parts.push(`Decided in ${room(p.decided_before)}: “${p.decided_before.topic}” (${DECISION_STATUS[p.decided_before.status]?.[0] || p.decided_before.status})`);
  if (p.rejected_before) parts.push(`Turned down before in ${room(p.rejected_before)}: “${p.rejected_before.topic}”`);
  if (!parts.length) return null;
  return /* @__PURE__ */ jsx("span", { className: "tm-brief-pointers", children: parts.join(" · ") });
}
const DECISION_STATUS = { current: ["Current", "is-ok"], conflict: ["Conflict", "is-err"], superseded: ["Replaced", ""] };
const SOURCE = { meeting: "meeting", lead: "recorded by a lead" };
const SECTION_ICON = { decisions: Gavel, waiting: Hourglass, stuck: TriangleAlert, in_progress: ListChecks };
function RoomMemoryCard({ memory }) {
  const [open, setOpen] = useState(false);
  if (!memory) return null;
  const decisions = memory.decisions || [];
  const bySeq = new Map(decisions.map((d) => [d.seq, d]));
  const replaced = decisions.filter((d) => d.status === "superseded").reverse();
  const rejected = [...memory.rejected || []].reverse();
  const sections = memory.summary?.sections || [];
  const conflicts = decisions.filter((d) => d.status === "conflict").length;
  return /* @__PURE__ */ jsxs("div", { className: "tm-card", "data-testid": "room-memory", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(NotebookText, { size: 15, style: { color: "var(--accent)" } }),
      "Room memory",
      conflicts > 0 && /* @__PURE__ */ jsx("span", { className: "tm-chip is-err", children: plural(conflicts, "conflict") }),
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: "built from the ledger" })
    ] }),
    sections.map((s) => {
      const Icon = SECTION_ICON[s.key] || ListChecks;
      return /* @__PURE__ */ jsxs("div", { className: "tm-mem-sec", "data-section": s.key, children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-mem-head", children: [
          /* @__PURE__ */ jsx(Icon, { size: 12 }),
          s.title,
          /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
          /* @__PURE__ */ jsxs("span", { className: "tm-muted tm-mem-cap", title: `This section keeps at most ${s.cap.items} lines and ${s.cap.chars} characters. When it is full, only this section is shortened.`, children: [
            s.items.length,
            "/",
            s.cap.items
          ] })
        ] }),
        s.items.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-muted tm-mem-none", children: "Nothing here." }),
        s.items.map((it, i) => /* @__PURE__ */ jsxs("div", { className: "tm-mem-line", children: [
          s.key === "decisions" && /* @__PURE__ */ jsx("span", { className: `tm-chip ${DECISION_STATUS[it.tag]?.[1] || ""}`, children: DECISION_STATUS[it.tag]?.[0] || it.tag }),
          /* @__PURE__ */ jsx("span", { className: "tm-break", children: it.text })
        ] }, i)),
        s.more > 0 && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-mem-more", children: [
          "+",
          s.more,
          " older, shortened to fit"
        ] })
      ] }, s.key);
    }),
    (replaced.length > 0 || rejected.length > 0) && /* @__PURE__ */ jsxs("button", { className: "tm-stub tm-mem-toggle", "aria-expanded": open, onClick: () => setOpen((v) => !v), children: [
      /* @__PURE__ */ jsx(ChevronRight, { size: 12, style: { transform: open ? "rotate(90deg)" : "none" } }),
      "History · ",
      plural(replaced.length, "replaced decision"),
      " · ",
      plural(rejected.length, "turned-down proposal")
    ] }),
    open && /* @__PURE__ */ jsxs("div", { className: "tm-mem-history", children: [
      replaced.map((d) => /* @__PURE__ */ jsxs("div", { className: "tm-mem-old", children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-mem-line", children: [
          /* @__PURE__ */ jsx("span", { className: "tm-chip", children: "Replaced" }),
          /* @__PURE__ */ jsxs("span", { className: "tm-break", children: [
            /* @__PURE__ */ jsx("b", { children: d.topic }),
            ": ",
            d.text
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
          "Replaced by: ",
          bySeq.get(d.superseded_by)?.text || "a later decision",
          " · ",
          SOURCE[d.source]
        ] })
      ] }, `d${d.seq}`)),
      rejected.map((r) => /* @__PURE__ */ jsxs("div", { className: "tm-mem-old", children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-mem-line", children: [
          /* @__PURE__ */ jsx("span", { className: "tm-chip is-warn", children: "Turned down" }),
          /* @__PURE__ */ jsxs("span", { className: "tm-break", children: [
            /* @__PURE__ */ jsx("b", { children: r.topic }),
            ": ",
            r.text
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
          "Why: ",
          r.reason,
          r.lost_to ? ` (chosen instead: ${r.lost_to})` : "",
          r.by_name ? ` · proposed by ${r.by_name}` : "",
          r.objections?.length ? ` · ${plural(r.objections.length, "objection")}` : ""
        ] })
      ] }, `r${r.seq}`))
    ] })
  ] });
}
const TRIGGER = {
  hop_limit: "hop over 4",
  round_budget: "too many posts this round",
  cooldown: "channel cooling down",
  unanswered_assignment: "assignment unanswered",
  requested: "someone asked for it",
  meeting_tie: "meeting vote tied",
  meeting_stalled: "meeting stalled 3 rounds",
  meeting_rounds_spent: "meeting rounds spent",
  meeting_budget_warning: "meeting budget at 80%",
  meeting_requested: "a speaker asked for it"
};
function CasesCard({ state, leads, onNeeds, onOpen }) {
  const waitingKeys = new Set(waitingOnYou(state).map((d) => d.key));
  const isWaiting = (c) => waitingKeys.has(`case:${c.case_id}`);
  const cases = [...state.cases || []].sort((a, b) => isWaiting(b) - isWaiting(a) || b.ts - a.ts);
  const used = state.budget?.cases_hour;
  return /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(ShieldCheck, { size: 15, style: { color: "var(--aim)" } }),
      "Bar raiser",
      /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: "independent · takes no work · no vote" }),
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      used && /* @__PURE__ */ jsxs("span", { className: "tm-mono tm-muted", children: [
        used.used,
        "/",
        used.cap,
        " cases/h"
      ] })
    ] }),
    cases.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "No cases yet. It is called when a hop goes over 4, an assignment goes unanswered, and similar." }),
    cases.map((c) => /* @__PURE__ */ jsx(CaseItem, { c, n: state.cases.indexOf(c) + 1, state, leads, waiting: isWaiting(c), onNeeds, onOpen }, c.case_id))
  ] });
}
function CaseItem({ c, n, state, leads, waiting, onNeeds, onOpen }) {
  const ch = (state.channels || []).find((x) => x.id === c.channel_id);
  const status = caseStatus(c);
  const a = c.acted;
  return /* @__PURE__ */ jsxs("div", { className: `tm-case ${waiting ? "is-call" : ""}`, children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-case-row", children: [
      /* @__PURE__ */ jsxs("span", { className: "tm-mono tm-muted", title: c.case_id, children: [
        "Case ",
        n
      ] }),
      /* @__PURE__ */ jsx("span", { className: `tm-chip ${status[1]}`, children: status[0] }),
      /* @__PURE__ */ jsxs("button", { className: "tm-stub", style: { padding: "1px 8px", fontSize: 12, marginLeft: "auto" }, onClick: () => onOpen(c.channel_id, c.thread_id), children: [
        ch ? `#${channelName(ch, leads)}` : "a channel",
        c.thread_id ? ` › ${threadLabel(c.thread_id, ch?.thread_titles)}` : "",
        /* @__PURE__ */ jsx(ChevronRight, { size: 12 })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-case-row", style: { marginTop: 6 }, children: [
      /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "Trigger:" }),
      (c.triggers || []).map((t) => /* @__PURE__ */ jsx("span", { className: "tm-chip", children: TRIGGER[t.trigger] || t.trigger }, t.key)),
      (c.triggers || []).some((t) => t.trigger === "unanswered_assignment") && /* @__PURE__ */ jsx(Approx, { kind: "round" })
    ] }),
    a && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-case-row", style: { marginTop: 6 }, children: [
        /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "Action:" }),
        /* @__PURE__ */ jsx("b", { style: { color: "var(--text-strong)" }, children: CASE_ACTION[a.action] || a.action }),
        c.called_person?.class && /* @__PURE__ */ jsx("span", { className: "tm-chip is-err", children: PERSON_CLASS[c.called_person.class] || c.called_person.class })
      ] }),
      a.args?.question && /* @__PURE__ */ jsx("div", { className: "tm-case-q tm-break", children: a.args.question }),
      /* @__PURE__ */ jsx(Verdict, { a }),
      /* @__PURE__ */ jsxs("div", { className: "tm-case-why tm-break", children: [
        a.rationale,
        " ",
        /* @__PURE__ */ jsx(Evidence, { parts: evidenceParts(a.evidence) })
      ] })
    ] }),
    c.called_person?.card && /* @__PURE__ */ jsx(PersonCard, { c, n, now: state.now || Date.now() / 1e3 }),
    c.defaulted && /* @__PURE__ */ jsxs("div", { className: "tm-case-why tm-break", children: [
      "The bar raiser gave no valid action in time (",
      c.defaulted.reason,
      "), so the default action ran."
    ] }),
    waiting && onNeeds && /* @__PURE__ */ jsx("div", { style: { marginTop: 8 }, children: /* @__PURE__ */ jsx(Btn, { primary: true, onClick: onNeeds, children: "Answer in Needs you" }) }),
    c.answer && !c.called_person?.card && /* @__PURE__ */ jsxs("div", { className: "tm-case-why tm-break", style: { marginTop: 6 }, children: [
      "Your answer (",
      fmtClock(c.answer.ts),
      "): ",
      /* @__PURE__ */ jsx("span", { style: { color: "var(--text)" }, children: c.answer.text })
    ] })
  ] });
}
function Verdict({ a }) {
  const g = a.args || {};
  if (a.action === "veto") {
    return /* @__PURE__ */ jsxs("div", { className: "tm-verdict is-block", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-verdict-head", children: [
        /* @__PURE__ */ jsx("span", { className: "tm-chip is-err", children: "BLOCK" }),
        "It fails a rule"
      ] }),
      /* @__PURE__ */ jsxs("dl", { className: "tm-fields", children: [
        /* @__PURE__ */ jsx("dt", { children: "Rule" }),
        /* @__PURE__ */ jsx("dd", { children: g.rule }),
        /* @__PURE__ */ jsx("dt", { children: "Number" }),
        /* @__PURE__ */ jsx("dd", { children: g.number }),
        /* @__PURE__ */ jsx("dt", { children: "To go on" }),
        /* @__PURE__ */ jsx("dd", { children: g.change })
      ] })
    ] });
  }
  if (a.action === "hold") {
    return /* @__PURE__ */ jsxs("div", { className: "tm-verdict is-hold", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-verdict-head", children: [
        /* @__PURE__ */ jsx("span", { className: "tm-chip is-warn", children: "HOLD" }),
        "Cannot judge yet · not a failure"
      ] }),
      /* @__PURE__ */ jsxs("dl", { className: "tm-fields", children: [
        /* @__PURE__ */ jsx("dt", { children: "Missing" }),
        /* @__PURE__ */ jsx("dd", { children: g.missing })
      ] })
    ] });
  }
  if (a.action === "rule" && Array.isArray(g.positions)) {
    return /* @__PURE__ */ jsxs("div", { className: "tm-verdict", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-verdict-head", children: [
        /* @__PURE__ */ jsx("span", { className: "tm-chip is-info", children: "Ruling" }),
        "Picked: ",
        /* @__PURE__ */ jsx("b", { children: g.choice }),
        " · no middle value"
      ] }),
      /* @__PURE__ */ jsxs("dl", { className: "tm-fields", children: [
        g.positions.map((p, i) => /* @__PURE__ */ jsxs(Fragment$1, { children: [
          /* @__PURE__ */ jsx("dt", { children: p.by }),
          /* @__PURE__ */ jsxs("dd", { children: [
            p.claim,
            p.evidence_seqs?.length ? /* @__PURE__ */ jsxs("span", { className: "tm-seq", children: [
              " #",
              p.evidence_seqs.join(", #")
            ] }) : null
          ] })
        ] }, i)),
        /* @__PURE__ */ jsx("dt", { children: "Decided by" }),
        /* @__PURE__ */ jsx("dd", { children: g.decides })
      ] })
    ] });
  }
  return null;
}
function Evidence({ parts }) {
  if (!parts.length) return null;
  return /* @__PURE__ */ jsx("span", { className: "tm-evidence", children: parts.map((p) => /* @__PURE__ */ jsx("span", { className: `tm-ev ${p.source === "party_claim" ? "is-claim" : ""}`, title: p.source === "party_claim" ? "What a lead said about itself. Not enough alone." : p.source === "owner" ? "Your message" : "Written by the app", children: p.label }, p.seq)) });
}
function PersonCard({ c, n, now, onAnswer, busy }) {
  const [mode, setMode] = useState(null);
  const [text, setText] = useState("");
  const [standing, setStanding] = useState(false);
  const cp = c.called_person;
  const card = cp.card;
  const open = cardOpen(c);
  const send = (decision) => onAnswer(c.case_id, cardAnswerBody(c, decision, { text, standing }));
  const ifNo = CASE_ACTION[card.if_no] || card.if_no;
  return /* @__PURE__ */ jsxs("div", { className: `tm-pcard ${open ? "" : "is-closed"}`, "aria-label": `Card for case ${n}`, children: [
    /* @__PURE__ */ jsx("dl", { className: "tm-fields", children: cardRows(card, now).map(([k, v]) => /* @__PURE__ */ jsxs(Fragment$1, { children: [
      /* @__PURE__ */ jsx("dt", { children: k }),
      /* @__PURE__ */ jsx("dd", { children: v })
    ] }, k)) }),
    open && onAnswer && /* @__PURE__ */ jsxs(Fragment, { children: [
      mode === "change" && /* @__PURE__ */ jsxs("form", { className: "tm-answer", onSubmit: (e) => {
        e.preventDefault();
        if (text.trim()) send("change");
      }, children: [
        /* @__PURE__ */ jsx(Input, { autoFocus: true, value: text, onChange: (e) => setText(e.target.value), placeholder: "What to do instead, e.g. run it after 18:00", "aria-label": `Change for case ${n}` }),
        /* @__PURE__ */ jsx(Btn, { primary: true, type: "submit", disabled: busy || !text.trim(), children: "Send change" })
      ] }),
      mode !== "change" && /* @__PURE__ */ jsxs("div", { className: "tm-pcard-actions", children: [
        /* @__PURE__ */ jsxs(Btn, { primary: true, disabled: busy, onClick: () => send("approve"), children: [
          /* @__PURE__ */ jsx(Check, { size: 14 }),
          "Approve this version"
        ] }),
        /* @__PURE__ */ jsx(Btn, { disabled: busy, onClick: () => setMode("change"), children: "Change…" }),
        /* @__PURE__ */ jsxs(Btn, { disabled: busy, onClick: () => send("no"), children: [
          /* @__PURE__ */ jsx(X, { size: 14 }),
          "No"
        ] }),
        /* @__PURE__ */ jsx(Btn, { disabled: busy, onClick: () => send("skip"), title: `Skipping counts as No: “${ifNo}” runs once.`, children: "Skip" })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "tm-standing", children: [
        /* @__PURE__ */ jsx("input", { type: "checkbox", checked: standing, onChange: (e) => setStanding(e.target.checked) }),
        /* @__PURE__ */ jsxs("span", { children: [
          "Within this range, don't ask me again for 24h: in this room, for ",
          /* @__PURE__ */ jsx("b", { children: PERSON_CLASS[card.class] || card.class }),
          ", just ",
          /* @__PURE__ */ jsx("b", { children: ifNo }),
          "."
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-pcard-note", children: [
        "Skipping counts as No: at ",
        fmtClock(card.expires),
        " “",
        ifNo,
        "” runs once. A standing approval only covers actions that stop or hold work."
      ] })
    ] }),
    !open && cardVoidText(c) && /* @__PURE__ */ jsx("div", { className: "tm-muted tm-pcard-note", children: cardVoidText(c) }),
    cp.standing && /* @__PURE__ */ jsxs("div", { className: "tm-pcard-note", children: [
      "Your standing approval answered it: “",
      ifNo,
      "” ran. No card was sent."
    ] }),
    c.lapsed && /* @__PURE__ */ jsxs("div", { className: "tm-pcard-note", children: [
      "No answer by ",
      fmtClock(card.expires),
      ", so it counted as No: “",
      ifNo,
      "” ran once."
    ] }),
    c.answer && /* @__PURE__ */ jsxs("div", { className: "tm-pcard-note", children: [
      { approve: "You approved this version", no: `You said no · “${ifNo}” ran`, change: "You asked for a change" }[c.answer.decision] || "You answered",
      " (",
      fmtClock(c.answer.ts),
      ")",
      c.answer.text ? /* @__PURE__ */ jsxs(Fragment, { children: [
        ": ",
        /* @__PURE__ */ jsx("span", { style: { color: "var(--text)" }, children: c.answer.text })
      ] }) : null,
      c.answer.standing && /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
        "Standing for 24h in this room: ",
        ifNo,
        "."
      ] })
    ] })
  ] });
}
function NeedsYouView({ state, leads, waiting, api, write, busy, onOpen }) {
  const names = useMemo(() => new Map([...leads].map(([id, l]) => [id, l.handle])), [leads]);
  const recap = useMemo(() => sinceYouSpoke(state, names), [state, names]);
  const d = waiting[0] || null;
  const done = (state.decisions || []).filter((x) => x.state !== "open").slice(-3).reverse();
  return /* @__PURE__ */ jsxs("div", { className: "tm-needs", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
        /* @__PURE__ */ jsx(ClipboardList, { size: 15, style: { color: "var(--aim)" } }),
        "Since you last spoke",
        /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: recap.since ? `after ${fmtClock(recap.since)}` : "you have not posted yet" })
      ] }),
      recap.lines.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Nothing new in the groups." }),
      /* @__PURE__ */ jsx("ul", { className: "tm-recap", children: recap.lines.map((l, i) => /* @__PURE__ */ jsxs("li", { children: [
        l.channel_id ? /* @__PURE__ */ jsxs("button", { className: "tm-stub", onClick: () => onOpen(l.channel_id, null), children: [
          l.place,
          /* @__PURE__ */ jsx(ChevronRight, { size: 12 })
        ] }) : /* @__PURE__ */ jsx("b", { children: l.place }),
        /* @__PURE__ */ jsx("span", { children: l.text })
      ] }, i)) })
    ] }),
    d ? /* @__PURE__ */ jsx(
      DecisionCard,
      {
        d,
        state,
        leads,
        left: waiting.length - 1,
        busy: busy || state.stopped,
        stopped: state.stopped,
        onOpen,
        onAnswer: (text) => write(() => api.post(`${BASE}/decisions/answer`, { key: d.key, text }), "Answer sent"),
        onSkip: () => write(() => api.post(`${BASE}/decisions/answer`, { key: d.key, skip: true }), "Skipped · counted as No"),
        onCard: (body) => write(
          () => api.post(`${BASE}/decisions/answer`, { key: d.key, ...body }),
          body.skip ? "Skipped · counted as No" : { approve: "Approved this version", no: "Said no", change: "Change sent" }[body.decision] || "Answer sent"
        )
      },
      d.key
    ) : /* @__PURE__ */ jsxs("div", { className: "tm-card tm-needs-empty", children: [
      /* @__PURE__ */ jsx(Check, { size: 18, style: { color: "var(--ok)" } }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("b", { children: "Nothing is waiting on you." }),
        /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "A card shows up here when the bar raiser hands you a decision or a lead asks about your @." })
      ] })
    ] }),
    done.length > 0 && /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
        /* @__PURE__ */ jsx(ListChecks, { size: 15 }),
        "Recently decided"
      ] }),
      done.map((x) => /* @__PURE__ */ jsxs("div", { className: "tm-case-row", style: { marginBottom: 6 }, children: [
        /* @__PURE__ */ jsx("span", { className: `tm-chip ${x.state === "skipped" ? "is-err" : x.state === "answered" ? "is-ok" : ""}`, children: x.state === "skipped" ? "Skipped = No" : x.state === "answered" ? "Answered" : "Withdrawn" }),
        /* @__PURE__ */ jsx("span", { className: "tm-break", children: x.question })
      ] }, x.key))
    ] })
  ] });
}
function DecisionCard({ d, state, leads, left, busy, stopped, onOpen, onAnswer, onSkip, onCard }) {
  const [text, setText] = useState("");
  const kase = d.kind === "case" ? (state.cases || []).find((c) => `case:${c.case_id}` === d.key) : null;
  const withCard = Boolean(kase?.called_person?.card);
  const ch = (state.channels || []).find((x) => x.id === d.channel_id);
  const where = ch ? `${ch.kind === "group" ? "#" : ""}${channelName(ch, leads)}${d.thread_id ? " › thread" : ""}` : "a channel";
  const who = d.kind === "ask" ? `${shortHandle(leads.get(d.lead)?.handle) || "A lead"} ${d.via === "dm" ? "asked you" : "asked about your @"}` : d.kind === "case" ? "Bar raiser hands this to you" : d.kind === "meeting_item" ? "A meeting needs you" : "Needs your decision";
  const here = d.kind === "case" || d.kind === "ask";
  return /* @__PURE__ */ jsxs("div", { className: "tm-card tm-decision", role: "region", "aria-label": "Decision waiting on you", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(Gavel, { size: 15, style: { color: "var(--danger)" } }),
      who,
      /* @__PURE__ */ jsx("span", { className: `tm-chip ${d.impact === "ask" ? "is-info" : "is-err"}`, children: IMPACT_LABEL[d.impact] || d.impact }),
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: left > 0 ? `${left} more after this` : "last one" })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "tm-decision-q tm-break", children: d.question }),
    /* @__PURE__ */ jsxs("div", { className: "tm-case-row tm-muted", children: [
      /* @__PURE__ */ jsxs("span", { children: [
        "Waiting since ",
        fmtClock(d.opened_ts)
      ] }),
      "·",
      /* @__PURE__ */ jsxs("button", { className: "tm-stub", onClick: () => onOpen(d.channel_id, d.thread_id), children: [
        where,
        /* @__PURE__ */ jsx(ChevronRight, { size: 12 })
      ] })
    ] }),
    !here && /* @__PURE__ */ jsx("div", { className: "tm-answer", children: /* @__PURE__ */ jsx(Btn, { primary: true, onClick: () => onOpen(d.channel_id, d.thread_id), children: "Answer where it was asked" }) }),
    withCard && /* @__PURE__ */ jsx(
      PersonCard,
      {
        c: kase,
        n: (state.cases || []).indexOf(kase) + 1,
        now: state.now || Date.now() / 1e3,
        busy,
        onAnswer: (_, body) => onCard(body)
      }
    ),
    here && !withCard && /* @__PURE__ */ jsxs("form", { className: "tm-answer", onSubmit: (e) => {
      e.preventDefault();
      if (text.trim()) onAnswer(text.trim());
    }, children: [
      /* @__PURE__ */ jsx(Input, { value: text, onChange: (e) => setText(e.target.value), placeholder: "Your answer, posted where it was asked", "aria-label": "Your answer", disabled: busy }),
      /* @__PURE__ */ jsx(Btn, { primary: true, type: "submit", disabled: busy || !text.trim(), children: "Send answer" }),
      /* @__PURE__ */ jsx(Btn, { type: "button", disabled: busy, onClick: onSkip, title: "Skipping says No. It is posted as your answer and not asked again.", children: "Skip = No" })
    ] }),
    stopped && /* @__PURE__ */ jsx("div", { className: "tm-muted", style: { marginTop: 6 }, children: "Emergency stop is on. Resume to answer." })
  ] });
}
function Meter({ label, used, cap, suffix, fullOk }) {
  const pct = cap ? Math.min(100, Math.round(used / cap * 100)) : 0;
  return /* @__PURE__ */ jsxs("div", { className: "tm-meter", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-meter-row", children: [
      /* @__PURE__ */ jsx("span", { children: label }),
      /* @__PURE__ */ jsxs("span", { children: [
        /* @__PURE__ */ jsx("b", { children: used }),
        " ",
        /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
          "/ ",
          cap,
          suffix || ""
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "tm-bar", role: "progressbar", "aria-valuenow": used, "aria-valuemin": 0, "aria-valuemax": cap, "aria-label": label, children: /* @__PURE__ */ jsx("i", { className: fullOk ? "" : pct >= 100 ? "is-full" : pct >= 80 ? "is-hot" : "", style: { width: `${pct}%` } }) })
  ] });
}
function BudgetCard({ state, leads, api, write, busy }) {
  const b = state.budget || {};
  const t = b.tokens_est || {};
  const per = b.lead_wakes_hour || {};
  const rows = limitRows(b);
  const clamped = rows.filter((r) => r.clamped);
  const tightened = rows.filter((r) => r.asked !== null && !r.clamped && r.applied < r.hard);
  const away = b.owner_away || {};
  const [editing, setEditing] = useState(false);
  return /* @__PURE__ */ jsxs("div", { className: "tm-card", "data-testid": "tm-budget-card", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(Gauge, { size: 15, style: { color: "var(--muted)" } }),
      "Budget",
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: "stops itself at the cap" })
    ] }),
    clamped.map((r) => /* @__PURE__ */ jsxs("div", { className: "tm-note is-warn", role: "status", "data-testid": "tm-limit-clamped", children: [
      /* @__PURE__ */ jsx(TriangleAlert, { size: 14 }),
      /* @__PURE__ */ jsxs("span", { children: [
        r.label,
        ": you set ",
        r.asked,
        r.unit === "min" ? " min" : "",
        ", above the hard cap. The hard cap of ",
        r.hard,
        r.unit === "min" ? " min" : "",
        " applies."
      ] })
    ] }, r.key)),
    away.paused_since && /* @__PURE__ */ jsxs("div", { className: "tm-note is-info", role: "status", children: [
      /* @__PURE__ */ jsx(Moon, { size: 14 }),
      /* @__PURE__ */ jsx("span", { children: "You were away: group batch wakes are paused. They resume now that you are back." })
    ] }),
    !away.paused_since && away.last_pause && /* @__PURE__ */ jsxs("div", { className: "tm-note is-info", role: "status", "data-testid": "tm-away-note", children: [
      /* @__PURE__ */ jsx(Moon, { size: 14 }),
      /* @__PURE__ */ jsxs("span", { children: [
        "While you were away (",
        fmtClock(away.last_pause.from),
        "–",
        fmtClock(away.last_pause.to),
        "), group batch wakes were paused. Direct words still woke leads."
      ] })
    ] }),
    b.deliveries && /* @__PURE__ */ jsx(Meter, { label: "Deliveries", used: b.deliveries.used, cap: b.deliveries.cap }),
    b.wakes_hour && /* @__PURE__ */ jsx(Meter, { label: "Wakes (this hour)", used: b.wakes_hour.used, cap: b.wakes_hour.cap }),
    /* @__PURE__ */ jsxs("div", { className: "tm-stat-grid", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-stat", children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-stat-l", children: [
          "Tokens ",
          /* @__PURE__ */ jsx(Approx, { kind: "tokens" })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "tm-stat-v", children: [
          fmtTokens(t.total),
          t.cap ? /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
            " / ",
            fmtTokens(t.cap)
          ] }) : null
        ] }),
        t.hot !== void 0 && /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          t.hot,
          " warm × ",
          fmtTokens(t.hot_each),
          " + ",
          t.cold,
          " cold × ",
          fmtTokens(t.cold_each)
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "tm-stat", children: [
        /* @__PURE__ */ jsx("div", { className: "tm-stat-l", children: "Messages (this hour)" }),
        /* @__PURE__ */ jsxs("div", { className: "tm-stat-v", children: [
          b.messages_hour?.used ?? "—",
          /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
            " / ",
            b.messages_hour?.cap ?? "—"
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          "Secretary ",
          b.secretary_hour?.used ?? "—",
          "/",
          b.secretary_hour?.cap ?? "—"
        ] })
      ] })
    ] }),
    per.cap && /* @__PURE__ */ jsxs("div", { style: { marginTop: 10 }, children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-muted", style: { marginBottom: 4 }, children: [
        "Wakes per lead this hour (cap ",
        per.cap,
        ")"
      ] }),
      [...leads.values()].map((l) => /* @__PURE__ */ jsxs("div", { className: "tm-meter-row", style: { alignItems: "center" }, children: [
        /* @__PURE__ */ jsxs("span", { style: { display: "flex", gap: 6, alignItems: "center", minWidth: 0 }, children: [
          /* @__PURE__ */ jsx(Avatar, { who: l.lead_id, leads, size: "sm" }),
          /* @__PURE__ */ jsx("span", { className: "tm-ellipsis", children: shortHandle(l.handle) })
        ] }),
        /* @__PURE__ */ jsxs("span", { className: "tm-mono", children: [
          per[l.lead_id] ?? 0,
          "/",
          per.cap
        ] })
      ] }, l.lead_id))
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-limits-row", children: [
      /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
        tightened.length ? `${plural(tightened.length, "limit")} set lower than the hard cap` : "Hard caps apply",
        " · batch wakes pause after ",
        Math.round((away.after_secs || 0) / 60),
        " min away"
      ] }),
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsxs(Btn, { disabled: busy, onClick: () => setEditing(true), "data-testid": "tm-limits-edit", children: [
        /* @__PURE__ */ jsx(SlidersHorizontal, { size: 14 }),
        "Tighten limits"
      ] })
    ] }),
    editing && /* @__PURE__ */ jsx(
      LimitsDialog,
      {
        rows,
        busy,
        onClose: () => setEditing(false),
        onSave: (body) => write(() => api.post(`${BASE}/limits`, body), "Limits saved").then((ok) => {
          if (ok) setEditing(false);
        })
      }
    )
  ] });
}
function LimitsDialog({ rows, busy, onClose, onSave }) {
  const [fields, setFields] = useState(() => Object.fromEntries(rows.map((r) => [r.key, r.asked === null ? "" : String(r.asked)])));
  const [err, setErr] = useState("");
  const over = rows.filter((r) => /^\d+$/.test(fields[r.key] || "") && Number(fields[r.key]) > r.hard);
  return /* @__PURE__ */ jsx(Modal, { open: true, onClose: busy ? () => {
  } : onClose, title: "Tighten limits", maxWidth: 520, children: /* @__PURE__ */ jsxs("form", { className: "tm-form", "data-testid": "tm-limits-dialog", onSubmit: (e) => {
    e.preventDefault();
    const b = limitsBody(fields);
    if (b.error) setErr(b.error);
    else onSave(b);
  }, children: [
    /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "You can set any limit lower than its hard cap. Nobody can raise a hard cap, and leads cannot change limits. Leave a field blank to use the hard cap." }),
    /* @__PURE__ */ jsx("div", { className: "tm-limit-grid", children: rows.map((r) => /* @__PURE__ */ jsxs("label", { className: "tm-limit-field", children: [
      /* @__PURE__ */ jsx("span", { children: r.label }),
      /* @__PURE__ */ jsx(
        Input,
        {
          value: fields[r.key],
          inputMode: "numeric",
          placeholder: String(r.hard),
          "aria-label": r.label,
          onChange: (e) => {
            setErr("");
            setFields({ ...fields, [r.key]: e.target.value });
          }
        }
      ),
      /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
        "hard cap ",
        r.hard,
        r.unit === "min" ? " min" : ""
      ] })
    ] }, r.key)) }),
    over.length > 0 && /* @__PURE__ */ jsxs("div", { className: "tm-note is-warn", role: "status", children: [
      /* @__PURE__ */ jsx(TriangleAlert, { size: 14 }),
      /* @__PURE__ */ jsxs("span", { children: [
        over.map((r) => r.label).join(", "),
        ": above the hard cap. The hard cap will apply."
      ] })
    ] }),
    err && /* @__PURE__ */ jsx("div", { className: "tm-field-err", role: "alert", children: err }),
    /* @__PURE__ */ jsxs("div", { className: "tm-dialog-actions", children: [
      /* @__PURE__ */ jsx(Btn, { type: "button", disabled: busy, onClick: onClose, children: "Cancel" }),
      /* @__PURE__ */ jsx(Btn, { primary: true, type: "submit", disabled: busy, "data-testid": "tm-limits-save", children: "Save limits" })
    ] })
  ] }) });
}
function ModelsCard({ state, api, write, busy }) {
  const cfg = state.models || {};
  const rows = modelRows(cfg);
  const [editing, setEditing] = useState(false);
  if (!rows.length) return null;
  return /* @__PURE__ */ jsxs("div", { className: "tm-card", "data-testid": "tm-models-card", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(Cpu, { size: 15, style: { color: "var(--muted)" } }),
      "Models",
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: "picked by intent" })
    ] }),
    rows.map((r) => /* @__PURE__ */ jsxs("div", { className: "tm-meter-row", style: { alignItems: "center" }, children: [
      /* @__PURE__ */ jsx("span", { children: r.label }),
      /* @__PURE__ */ jsxs("span", { children: [
        /* @__PURE__ */ jsx("span", { className: "tm-chip is-info", children: INTENT_LABEL[r.intent] || r.intent }),
        " ",
        /* @__PURE__ */ jsx("span", { className: "tm-mono", children: r.model })
      ] })
    ] }, r.role)),
    /* @__PURE__ */ jsxs("div", { className: "tm-limits-row", children: [
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsx(Btn, { disabled: busy, onClick: () => setEditing(true), "data-testid": "tm-models-edit", children: "Edit" })
    ] }),
    editing && /* @__PURE__ */ jsx(
      ModelsDialog,
      {
        cfg,
        busy,
        onClose: () => setEditing(false),
        onSave: (body) => write(() => api.post(`${BASE}/models`, body), "Models saved").then((ok) => {
          if (ok) setEditing(false);
        })
      }
    )
  ] });
}
function ModelsDialog({ cfg, busy, onClose, onSave }) {
  const intents = cfg.intents || ["easy", "default", "smartest"];
  const [routes, setRoutes] = useState({ ...cfg.routes || {} });
  const [roles, setRoles] = useState({ ...cfg.roles || {} });
  const changed = (a, b) => Object.fromEntries(Object.entries(a).filter(([k, v]) => b?.[k] !== v));
  return /* @__PURE__ */ jsx(Modal, { open: true, onClose: busy ? () => {
  } : onClose, title: "Models", maxWidth: 520, children: /* @__PURE__ */ jsxs("form", { className: "tm-form", "data-testid": "tm-models-dialog", onSubmit: (e) => {
    e.preventDefault();
    onSave({ routes: changed(routes, cfg.routes), roles: changed(roles, cfg.roles) });
  }, children: [
    /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Each role uses an intent. Each intent points at one model. Change the model behind an intent once, and every role on it follows." }),
    /* @__PURE__ */ jsx("div", { className: "tm-limit-grid", children: intents.map((i) => /* @__PURE__ */ jsxs("label", { className: "tm-limit-field", children: [
      /* @__PURE__ */ jsx("span", { children: INTENT_LABEL[i] || i }),
      /* @__PURE__ */ jsx(Input, { value: routes[i] || "", "aria-label": `${INTENT_LABEL[i] || i} model`, onChange: (e) => setRoutes({ ...routes, [i]: e.target.value.trim() }) })
    ] }, i)) }),
    /* @__PURE__ */ jsx("div", { className: "tm-limit-grid", children: modelRows({ routes, roles }).map((r) => /* @__PURE__ */ jsxs("label", { className: "tm-limit-field", children: [
      /* @__PURE__ */ jsxs("span", { children: [
        r.label,
        " uses"
      ] }),
      /* @__PURE__ */ jsx("select", { className: "tm-select", value: r.intent, "aria-label": `${r.label} intent`, onChange: (e) => setRoles({ ...roles, [r.role]: e.target.value }), children: intents.map((i) => /* @__PURE__ */ jsx("option", { value: i, children: INTENT_LABEL[i] || i }, i)) }),
      /* @__PURE__ */ jsx("span", { className: "tm-muted tm-mono", children: r.model })
    ] }, r.role)) }),
    /* @__PURE__ */ jsxs("div", { className: "tm-dialog-actions", children: [
      /* @__PURE__ */ jsx(Btn, { type: "button", disabled: busy, onClick: onClose, children: "Cancel" }),
      /* @__PURE__ */ jsx(Btn, { primary: true, type: "submit", disabled: busy, "data-testid": "tm-models-save", children: "Save" })
    ] })
  ] }) });
}
function BotsLink({ children }) {
  const navigate = useNavigate();
  return /* @__PURE__ */ jsx("a", { href: "/members", className: "tm-link", "data-testid": "tm-bots-link", onClick: (e) => {
    e.preventDefault();
    navigate("/members");
  }, children });
}
function AddBotsCard({ bots, botsError, leads, api, write, busy, reload }) {
  const [err, setErr] = useState("");
  const add = (b) => {
    setErr("");
    return write(async () => {
      try {
        await api.post(`${BASE}/leads`, addBody(b));
      } catch (e) {
        const msg = addBotError(e);
        setErr(`${b.name}: ${msg}`);
        throw new Error(msg);
      }
    }, `${b.name} joined the team`).then(reload);
  };
  return /* @__PURE__ */ jsxs("div", { className: "tm-card", "data-testid": "tm-add-bots", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(UserPlus, { size: 15 }),
      "Add Bots",
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: "from any project" })
    ] }),
    botsError && /* @__PURE__ */ jsxs("div", { className: "tm-field-err", role: "alert", children: [
      "Could not read your Bots: ",
      botsError
    ] }),
    err && /* @__PURE__ */ jsx("div", { className: "tm-field-err", role: "alert", "data-testid": "tm-add-error", children: err }),
    bots === null && !botsError && /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Reading your Bots…" }),
    bots && bots.length === 0 && /* @__PURE__ */ jsxs("div", { className: "tm-note is-info", role: "status", "data-testid": "tm-no-bots", children: [
      /* @__PURE__ */ jsx(Users, { size: 14 }),
      /* @__PURE__ */ jsxs("span", { children: [
        "No Bots yet. ",
        /* @__PURE__ */ jsx(BotsLink, { children: "Create one on the Bots page first" }),
        "."
      ] })
    ] }),
    (bots || []).map((b) => {
      const check = addCheck(b, leads);
      const inTeam = !!leadForBot(b, leads);
      return /* @__PURE__ */ jsxs("div", { className: "tm-bot-row", "data-testid": "tm-bot-row", children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-bot-main", children: [
          /* @__PURE__ */ jsx("div", { className: "tm-break", style: { fontWeight: 600, color: "var(--text-strong)" }, children: b.name }),
          /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-break", children: [
            /* @__PURE__ */ jsxs("span", { title: b.project_path || void 0, children: [
              "Project: ",
              b.project || "default"
            ] }),
            b.description ? ` · ${b.description}` : ""
          ] })
        ] }),
        inTeam ? /* @__PURE__ */ jsxs("span", { className: "tm-muted", style: { display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }, children: [
          /* @__PURE__ */ jsx(Check, { size: 13 }),
          "In the team"
        ] }) : /* @__PURE__ */ jsx(Btn, { primary: true, disabled: busy || !check.ok, title: check.ok ? void 0 : check.why, onClick: () => add(b), "data-testid": "tm-add-bot", children: "Add" }),
        !check.ok && !inTeam && /* @__PURE__ */ jsxs("div", { className: "tm-muted tm-bot-why", children: [
          check.why,
          !b.slot_key && /* @__PURE__ */ jsxs(Fragment, { children: [
            " ",
            /* @__PURE__ */ jsx(BotsLink, { children: "Open Bots" })
          ] })
        ] })
      ] }, b.bot);
    })
  ] });
}
function TreeAvatar({ hue, name: name2, owner }) {
  return /* @__PURE__ */ jsx("span", { className: `tm-av ${owner ? "owner" : `h${(hue ?? 4) % 5}`}`, "aria-hidden": "true", children: String(name2 || "?").slice(0, 1).toUpperCase() });
}
function TeamTreeView({ state, api }) {
  const { bots } = useBots(api, { withWorkers: true });
  const tree = useMemo(() => teamTree(state, bots ? rosterLeadSource(bots) : void 0), [state, bots]);
  const [expanded, setExpandedRaw] = useState(() => loadExpanded(window.localStorage));
  const setExpanded = (next) => {
    setExpandedRaw(next);
    saveExpanded(window.localStorage, next);
  };
  const toggle = (key) => {
    const n = new Set(expanded);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    setExpanded(n);
  };
  const shown = useMemo(() => visibleTree(tree.leads, expanded), [tree, expanded]);
  const allKeys = useMemo(() => expandAllKeys(tree.leads), [tree]);
  const shape = JSON.stringify(shown.map((l) => l.workers));
  const geo = useMemo(() => layoutTree(shown), [shape]);
  const [sel, setSel] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewRef = useRef(null);
  const dragRef = useRef(null);
  const { openChat } = useChatLauncher();
  const navigate = useNavigate();
  const picked = tree.leads.find((l) => l.key === sel) || null;
  const fit = useCallback(() => {
    const el = viewRef.current;
    if (!el) return;
    const band = 44;
    const view = { width: el.clientWidth, height: Math.max(1, el.clientHeight - 2 * band) };
    const z = fitZoom(view, geo);
    setZoom(z);
    setPan({ x: (view.width - geo.width * z) / 2, y: band + (view.height - geo.height * z) / 2 });
  }, [geo]);
  useEffect(() => {
    fit();
  }, [fit]);
  const zoomBy = (f) => {
    const el = viewRef.current;
    const cx = el ? el.clientWidth / 2 : 0;
    const cy = el ? el.clientHeight / 2 : 0;
    const nz = clampZoom(zoom * f);
    if (nz === zoom) return;
    setPan((p) => ({ x: cx - (cx - p.x) * (nz / zoom), y: cy - (cy - p.y) * (nz / zoom) }));
    setZoom(nz);
  };
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return void 0;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomByRef.current(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const onDown = (e) => {
    if (e.target.closest("button")) return;
    dragRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (dragRef.current) setPan({ x: e.clientX - dragRef.current.x, y: e.clientY - dragRef.current.y });
  };
  const onUp = () => {
    dragRef.current = null;
  };
  return /* @__PURE__ */ jsxs("div", { className: "tm-tree-wrap", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-tree-view", ref: viewRef, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerLeave: onUp, "data-testid": "tm-tree-canvas", "aria-label": "Team tree", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-tree-inner", style: { width: geo.width, height: geo.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }, children: [
        /* @__PURE__ */ jsx("svg", { className: "tm-tree-edges", width: geo.width, height: geo.height, "aria-hidden": "true", children: geo.edges.map((e, i) => /* @__PURE__ */ jsx("path", { d: e.d, className: tree.leads[e.lead]?.key === sel ? "is-sel" : "" }, i)) }),
        tree.leads.length > 0 && /* @__PURE__ */ jsxs("button", { type: "button", className: `tm-tnode is-owner ${sel === null ? "is-sel" : ""}`, style: { left: geo.owner.x, top: geo.owner.y, width: geo.owner.w, height: geo.owner.h }, onClick: () => setSel(null), "data-testid": "tm-tree-owner", children: [
          /* @__PURE__ */ jsx(TreeAvatar, { owner: true, name: tree.owner.name }),
          /* @__PURE__ */ jsxs("span", { className: "tm-tnode-main", children: [
            /* @__PURE__ */ jsx("b", { children: tree.owner.name }),
            /* @__PURE__ */ jsxs("small", { children: [
              plural(tree.owner.leadCount, "lead"),
              " · ",
              plural(tree.owner.groupCount, "group")
            ] })
          ] })
        ] }),
        tree.leads.map((l, i) => {
          const b = geo.leads[i];
          return /* @__PURE__ */ jsxs("button", { type: "button", className: `tm-tnode ${sel === l.key ? "is-sel" : ""} ${l.legacy ? "is-legacy" : ""}`, style: { left: b.x, top: b.y, width: b.w, height: b.h }, onClick: () => setSel(l.key), "aria-pressed": sel === l.key, "data-testid": "tm-tree-lead", children: [
            /* @__PURE__ */ jsxs("span", { className: "tm-tnode-row", children: [
              /* @__PURE__ */ jsx(TreeAvatar, { hue: l.hue, name: l.name }),
              /* @__PURE__ */ jsxs("span", { className: "tm-tnode-main", children: [
                /* @__PURE__ */ jsx("b", { className: "tm-ellipsis", children: l.name }),
                /* @__PURE__ */ jsx("small", { children: l.legacy ? "Chat" : l.kind })
              ] }),
              /* @__PURE__ */ jsx("span", { className: `tm-chip ${l.statusTone}`, children: l.statusLabel })
            ] }),
            /* @__PURE__ */ jsxs("span", { className: `tm-tnode-project ${l.project ? "" : "is-empty"}`, children: [
              l.legacy && /* @__PURE__ */ jsx("span", { className: "tm-legacy-tag", "data-testid": "tm-tree-legacy", children: l.kind }),
              /* @__PURE__ */ jsx(FolderKanban, { size: 12 }),
              l.project || "No project"
            ] }),
            /* @__PURE__ */ jsx("span", { className: `tm-tnode-duty ${l.role ? "" : "is-empty"}`, children: l.role || "No role written yet" }),
            /* @__PURE__ */ jsxs("span", { className: "tm-tnode-groups", children: [
              l.groups.length === 0 ? /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "No group" }) : l.groups.slice(0, 2).map((g) => /* @__PURE__ */ jsxs("span", { className: "tm-tgroup", children: [
                /* @__PURE__ */ jsx(Hash, { size: 11 }),
                g
              ] }, g)),
              l.groups.length > 2 && /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
                "+",
                l.groups.length - 2
              ] })
            ] })
          ] }, l.key);
        }),
        shown.map((l, i) => {
          if (!l.canToggle) return null;
          const b = geo.leads[i];
          return /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              className: `tm-ttoggle ${l.open ? "is-open" : ""}`,
              style: { left: b.x + b.w - 14, top: b.y + b.h / 2 - 14 },
              onClick: () => toggle(l.key),
              "aria-expanded": l.open,
              "aria-label": l.open ? `Hide ${l.name}'s workers` : `Show ${l.name}'s ${plural(l.hiddenCount, "worker")}`,
              "data-testid": "tm-tree-toggle",
              children: l.open ? /* @__PURE__ */ jsx(Minus, { size: 13 }) : /* @__PURE__ */ jsxs("span", { className: "tm-mono", children: [
                "+",
                l.hiddenCount
              ] })
            },
            `t-${l.key}`
          );
        }),
        geo.workers.map((w, i) => /* @__PURE__ */ jsxs("div", { className: `tm-tworker ${tree.leads[w.lead]?.key === sel ? "is-sel" : ""}`, style: { left: w.x, top: w.y, width: w.w, height: w.h }, "data-testid": "tm-tree-worker", children: [
          /* @__PURE__ */ jsx("b", { className: "tm-ellipsis", children: w.name }),
          /* @__PURE__ */ jsx("small", { className: "tm-ellipsis", children: [w.role, w.status].filter(Boolean).join(" · ") || "Worker" })
        ] }, i))
      ] }),
      tree.leads.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-tree-empty", "data-testid": "tm-tree-empty", children: /* @__PURE__ */ jsxs("div", { className: "tm-tree-empty-box", children: [
        /* @__PURE__ */ jsx("b", { children: "No leads yet" }),
        /* @__PURE__ */ jsx("span", { children: "A lead is a Bot that already exists. Create the Bot on the Bots page first, then add it here." }),
        /* @__PURE__ */ jsx("span", { className: "tm-tree-empty-act", children: /* @__PURE__ */ jsxs(Btn, { primary: true, onClick: () => navigate(BOTS_PAGE), "data-testid": "tm-tree-bots-link", children: [
          /* @__PURE__ */ jsx(Bot, { size: 14 }),
          "Go to Bots page"
        ] }) })
      ] }) }),
      tree.leads.length > 0 && /* @__PURE__ */ jsxs("div", { className: "tm-tree-bar", role: "group", "aria-label": "Org charts", children: [
        /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => setExpanded(new Set(allKeys)), disabled: allKeys.size === 0 || [...allKeys].every((k) => expanded.has(k)), "data-testid": "tm-tree-expand-all", children: [
          /* @__PURE__ */ jsx(ChevronsUpDown, { size: 13 }),
          "Expand all"
        ] }),
        /* @__PURE__ */ jsxs("button", { type: "button", onClick: () => setExpanded(/* @__PURE__ */ new Set()), disabled: ![...allKeys].some((k) => expanded.has(k)), "data-testid": "tm-tree-collapse-all", children: [
          /* @__PURE__ */ jsx(ChevronsDownUp, { size: 13 }),
          "Collapse all"
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "tm-tree-zoom", role: "group", "aria-label": "Zoom", children: [
        /* @__PURE__ */ jsx("button", { type: "button", onClick: () => zoomBy(1 / 1.2), "aria-label": "Zoom out", disabled: zoom <= ZOOM_MIN, children: /* @__PURE__ */ jsx(Minus, { size: 14 }) }),
        /* @__PURE__ */ jsxs("span", { className: "tm-mono", "data-testid": "tm-tree-zoom", children: [
          Math.round(zoom * 100),
          "%"
        ] }),
        /* @__PURE__ */ jsx("button", { type: "button", onClick: () => zoomBy(1.2), "aria-label": "Zoom in", disabled: zoom >= ZOOM_MAX, children: /* @__PURE__ */ jsx(Plus, { size: 14 }) }),
        /* @__PURE__ */ jsxs("button", { type: "button", className: "tm-tree-fit", onClick: fit, "data-testid": "tm-tree-fit", children: [
          /* @__PURE__ */ jsx(Maximize2, { size: 13 }),
          "Fit all"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsx("aside", { className: "tm-rolecard", "data-testid": "tm-rolecard", "aria-live": "polite", children: !picked ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-head", children: [
        /* @__PURE__ */ jsx(TreeAvatar, { owner: true, name: tree.owner.name }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("div", { className: "tm-rolecard-name", children: tree.owner.name }),
          /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "You. Every lead reports to you." })
        ] })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "tm-muted", style: { marginTop: 12 }, children: "Pick a lead in the tree to see its role card." }),
      /* @__PURE__ */ jsx("div", { className: "tm-muted", style: { marginTop: 8 }, children: "Each lead is an existing Bot that runs one project. Its own workers show to its right when Team Mode can see them." })
    ] }) : /* @__PURE__ */ jsx(RoleCard, { lead: picked, onOpen: () => openChat({ slotKey: picked.slotKey }) }) })
  ] });
}
function RoleCard({ lead, onOpen }) {
  const f = roleCardFields(lead);
  const list = (items) => /* @__PURE__ */ jsx("ul", { className: "tm-rolecard-list", children: items.map((t, i) => /* @__PURE__ */ jsx("li", { children: t }, i)) });
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-head", children: [
      /* @__PURE__ */ jsx(TreeAvatar, { hue: lead.hue, name: lead.name }),
      /* @__PURE__ */ jsxs("div", { style: { minWidth: 0 }, children: [
        /* @__PURE__ */ jsx("div", { className: "tm-rolecard-name tm-break", children: f.Name }),
        /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          lead.kind,
          " · reports to Owner"
        ] })
      ] }),
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsx("span", { className: `tm-chip ${lead.statusTone}`, children: f.Status })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-sec", children: [
      /* @__PURE__ */ jsx("div", { className: "tm-rolecard-k", children: "Project" }),
      /* @__PURE__ */ jsx("div", { className: lead.project ? "tm-break" : "tm-muted", children: f.Project })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-sec", children: [
      /* @__PURE__ */ jsx("div", { className: "tm-rolecard-k", children: "Owns" }),
      /* @__PURE__ */ jsx("div", { className: lead.role ? "tm-break" : "tm-muted", children: f.Owns })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-sec", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-k", children: [
        "Workers",
        lead.workers?.length ? ` · ${countWorkers(lead.workers)}` : ""
      ] }),
      lead.workers?.length ? list(f.Workers) : /* @__PURE__ */ jsx("div", { className: "tm-muted", children: f.Workers[0] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-sec", children: [
      /* @__PURE__ */ jsx("div", { className: "tm-rolecard-k", children: "Waiting on a person" }),
      lead.waits.length ? list(f["Waiting on a person"]) : /* @__PURE__ */ jsx("div", { className: "tm-muted", children: f["Waiting on a person"][0] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-sec", children: [
      /* @__PURE__ */ jsx("div", { className: "tm-rolecard-k", children: "Assignments" }),
      /* @__PURE__ */ jsx("div", { children: f.Assignments })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-sec", children: [
      /* @__PURE__ */ jsx("div", { className: "tm-rolecard-k", children: "Routines" }),
      /* @__PURE__ */ jsx("div", { className: "tm-chips", style: { flexDirection: "column", alignItems: "flex-start" }, children: f.Routines.map((r, i) => /* @__PURE__ */ jsxs("span", { className: `tm-chip is-wrap ${i === 0 && lead.routines.briefs ? "is-info" : ""}`, children: [
        /* @__PURE__ */ jsx(Hourglass, { size: 11 }),
        r
      ] }, i)) })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-rolecard-sec", children: [
      /* @__PURE__ */ jsx("div", { className: "tm-rolecard-k", children: "Groups" }),
      lead.groups.length ? /* @__PURE__ */ jsx("div", { className: "tm-chips", children: f.Groups.map((g) => /* @__PURE__ */ jsx("span", { className: "tm-chip", children: g }, g)) }) : /* @__PURE__ */ jsx("div", { className: "tm-muted", children: f.Groups[0] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "tm-rolecard-sec", children: lead.slotKey ? /* @__PURE__ */ jsxs(Btn, { primary: true, onClick: onOpen, "data-testid": "tm-rolecard-open", children: [
      /* @__PURE__ */ jsx(MessageSquare, { size: 14 }),
      "Open chat"
    ] }) : /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "No chat to open for this lead." }) })
  ] });
}
function MembersView({ state, leads, api, write, busy }) {
  const registered = [...leads.values()].filter((l) => l.active !== false);
  const { bots, teams, error: botsError, reload } = useBots(api);
  const projectOf = (l) => l.project || bots?.find((b) => b.bot === l.bot)?.project || "";
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState([]);
  const [mgr, setMgr] = useState("");
  const groupCount = (id) => (state.channels || []).filter((c) => c.kind === "group" && c.members.includes(id)).length;
  const [removing, setRemoving] = useState(null);
  const [view, setView] = useState("tree");
  const notify = useNotify();
  const openGroup = (t) => write(async () => {
    const r = await api.post(`${BASE}/groups`, { title: t, members: picked, managers: mgr ? [mgr] : [] });
    notify?.(r?.reused?.length ? `#${t} already exists with these members. Reused it.` : `Created #${t}. Nobody is woken until the first message.`, { type: "success" });
  });
  return /* @__PURE__ */ jsxs("div", { className: "tm-page", children: [
    removing && /* @__PURE__ */ jsx(RemoveLeadDialog, { lead: removing, api, write, busy, onClose: () => setRemoving(null) }),
    /* @__PURE__ */ jsxs("div", { className: "tm-tabs tm-members-tabs", role: "tablist", "aria-label": "Lead views", children: [
      /* @__PURE__ */ jsxs("button", { role: "tab", className: "tm-tab", "aria-selected": view === "tree", onClick: () => setView("tree"), "data-testid": "tm-members-tree-tab", children: [
        /* @__PURE__ */ jsx(Network, { size: 14 }),
        "Tree"
      ] }),
      /* @__PURE__ */ jsxs("button", { role: "tab", className: "tm-tab", "aria-selected": view === "table", onClick: () => setView("table"), "data-testid": "tm-members-table-tab", children: [
        /* @__PURE__ */ jsx(Table2, { size: 14 }),
        "Table"
      ] })
    ] }),
    view === "tree" && /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
        /* @__PURE__ */ jsx(Network, { size: 15 }),
        "Team tree",
        /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
        /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: "drag to move · ctrl + scroll to zoom" })
      ] }),
      /* @__PURE__ */ jsx(TeamTreeView, { state, api })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-page-grid", children: [
      /* @__PURE__ */ jsxs("div", { style: { minWidth: 0 }, children: [
        view === "table" && /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
          /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
            /* @__PURE__ */ jsx(Users, { size: 15 }),
            "Leads",
            /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
            /* @__PURE__ */ jsx(Approx, { kind: "identity" })
          ] }),
          registered.length === 0 ? /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "None yet. Add a Bot below." }) : /* @__PURE__ */ jsx("div", { className: "tm-xscroll", children: /* @__PURE__ */ jsxs("table", { className: "tm-table", "data-testid": "tm-leads-table", children: [
            /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
              /* @__PURE__ */ jsx("th", { children: "Lead" }),
              /* @__PURE__ */ jsx("th", { children: "Project" }),
              /* @__PURE__ */ jsx("th", { children: "Groups" }),
              /* @__PURE__ */ jsx("th", {})
            ] }) }),
            /* @__PURE__ */ jsx("tbody", { children: registered.map((l) => {
              const k = leadKind(l);
              return /* @__PURE__ */ jsxs("tr", { children: [
                /* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsxs("div", { className: "tm-lead-cell", children: [
                  /* @__PURE__ */ jsx(Avatar, { who: l.lead_id, leads }),
                  /* @__PURE__ */ jsxs("div", { style: { minWidth: 0 }, children: [
                    /* @__PURE__ */ jsx("div", { className: "tm-break", style: { fontWeight: 600, color: "var(--text-strong)" }, children: l.handle }),
                    /* @__PURE__ */ jsx("div", { className: "tm-muted", children: k.kind === "legacy" ? /* @__PURE__ */ jsx("span", { className: "tm-legacy", title: "An older lead chat from before leads were Bots. It keeps working; add a Bot instead for new leads.", children: "Legacy lead" }) : k.label })
                  ] })
                ] }) }),
                /* @__PURE__ */ jsx("td", { className: "tm-break", children: projectOf(l) || /* @__PURE__ */ jsx("span", { className: "tm-muted", children: "—" }) }),
                /* @__PURE__ */ jsx("td", { className: "tm-mono", children: groupCount(l.lead_id) }),
                /* @__PURE__ */ jsx("td", { style: { textAlign: "right" }, children: /* @__PURE__ */ jsx(Btn, { danger: true, disabled: busy, onClick: () => setRemoving(l), "data-testid": "tm-remove-lead", children: "Remove" }) })
              ] }, l.lead_id);
            }) })
          ] }) })
        ] }),
        /* @__PURE__ */ jsx(AddBotsCard, { bots, botsError, leads, api, write, busy, reload })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "tm-card", style: { minWidth: 0 }, children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
          /* @__PURE__ */ jsx(Plus, { size: 15 }),
          "New group"
        ] }),
        /* @__PURE__ */ jsxs("form", { className: "tm-form", onSubmit: (e) => {
          e.preventDefault();
          openGroup(title.trim()).then((ok) => {
            if (ok) {
              setTitle("");
              setPicked([]);
              setMgr("");
            }
          });
        }, children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("label", { className: "tm-label", htmlFor: "tm-gtitle", children: "Group name" }),
            /* @__PURE__ */ jsx(Input, { id: "tm-gtitle", value: title, onChange: (e) => setTitle(e.target.value), placeholder: "e.g. release-train", style: { width: "100%" } })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("span", { className: "tm-label", children: "Members (2–6 leads, from any project; you do not count)" }),
            registered.length < 2 && /* @__PURE__ */ jsxs("div", { className: "tm-note is-info", role: "status", "data-testid": "tm-need-bots", children: [
              /* @__PURE__ */ jsx(Users, { size: 14 }),
              /* @__PURE__ */ jsxs("span", { children: [
                "A group is made from Bots in the team; nobody is created here. ",
                registered.length === 0 ? "There are none yet." : "There is only one.",
                " ",
                "Add them on the left, or ",
                /* @__PURE__ */ jsx(BotsLink, { children: "create Bots on the Bots page" }),
                "."
              ] })
            ] }),
            teams.length > 0 && /* @__PURE__ */ jsxs("div", { style: { marginBottom: 6 }, children: [
              /* @__PURE__ */ jsx("label", { className: "tm-label", htmlFor: "tm-gteam", children: "Start from a Bot team (optional)" }),
              /* @__PURE__ */ jsxs(
                "select",
                {
                  id: "tm-gteam",
                  className: "tm-select",
                  value: "",
                  "data-testid": "tm-from-team",
                  style: { fontSize: 13, padding: "6px 28px 6px 10px", maxWidth: "100%" },
                  onChange: (e) => {
                    const t = teams.find((x) => x.id === e.target.value);
                    if (!t) return;
                    const ids = teamLeadIds(t, leads);
                    setPicked(ids);
                    if (!title.trim()) setTitle(String(t.name || "").toLowerCase().replace(/\s+/g, "-"));
                    notify?.(ids.length < (t.members || []).length ? `Picked ${ids.length} of ${(t.members || []).length} Bots from ${t.name}. Add the others to the team first.` : `Picked the ${ids.length} Bots of ${t.name}.`, { type: "info" });
                  },
                  children: [
                    /* @__PURE__ */ jsx("option", { value: "", children: "Choose a team…" }),
                    teams.map((t) => /* @__PURE__ */ jsxs("option", { value: t.id, children: [
                      t.name,
                      " (",
                      (t.members || []).length,
                      ")"
                    ] }, t.id))
                  ]
                }
              )
            ] }),
            /* @__PURE__ */ jsx("div", { className: "tm-pick", children: registered.map((l) => /* @__PURE__ */ jsxs("label", { children: [
              /* @__PURE__ */ jsx("input", { type: "checkbox", checked: picked.includes(l.lead_id), onChange: (e) => setPicked(e.target.checked ? [...picked, l.lead_id] : picked.filter((x) => x !== l.lead_id)) }),
              /* @__PURE__ */ jsx(Avatar, { who: l.lead_id, leads, size: "sm" }),
              shortHandle(l.handle),
              projectOf(l) && /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
                "· ",
                projectOf(l)
              ] })
            ] }, l.lead_id)) })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("label", { className: "tm-label", htmlFor: "tm-gmgr", children: "Manager (may use @everyone)" }),
            /* @__PURE__ */ jsxs("select", { id: "tm-gmgr", className: "tm-select", value: mgr, onChange: (e) => setMgr(e.target.value), style: { fontSize: 13, padding: "6px 28px 6px 10px", maxWidth: "100%" }, children: [
              /* @__PURE__ */ jsx("option", { value: "", children: "Only me" }),
              picked.map((id) => /* @__PURE__ */ jsx("option", { value: id, children: shortHandle(leads.get(id)?.handle) }, id))
            ] })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Every group gets its own bar raiser. Creating it wakes nobody; the first message does." }),
          /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx(Btn, { primary: true, type: "submit", disabled: busy || !title.trim() || picked.length < 2 || picked.length > 6, children: "Create group" }) })
        ] })
      ] })
    ] })
  ] });
}
function RemoveLeadDialog({ lead, api, write, busy, onClose }) {
  const [imp, setImp] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    api.get(`${BASE}/leads/${encodeURIComponent(lead.lead_id)}/impact`).then((r) => {
      if (live) setImp(r);
    }, (e) => {
      if (live) setErr(errText(e));
    });
    return () => {
      live = false;
    };
  }, [api, lead.lead_id]);
  const lines = impactLines(imp, { bot: lead.kind === "bot" });
  return /* @__PURE__ */ jsx(Modal, { open: true, onClose: busy ? () => {
  } : onClose, title: `Remove ${lead.handle} from the team?`, maxWidth: 520, children: /* @__PURE__ */ jsxs("div", { className: "tm-form", "data-testid": "tm-remove-dialog", children: [
    err ? /* @__PURE__ */ jsx("div", { className: "tm-field-err", role: "alert", children: err }) : !imp ? /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Checking what this touches…" }) : /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Removing it from the team affects:" }),
      lines.length > 0 && /* @__PURE__ */ jsx("ul", { className: "tm-impact", children: lines.map((x, i) => /* @__PURE__ */ jsxs("li", { className: x.kind === "warn" ? "is-warn" : "", children: [
        x.kind === "warn" ? /* @__PURE__ */ jsx(TriangleAlert, { size: 14 }) : x.kind === "keep" ? /* @__PURE__ */ jsx(Check, { size: 14 }) : /* @__PURE__ */ jsx(Hash, { size: 14 }),
        /* @__PURE__ */ jsx("span", { children: x.text })
      ] }, i)) }),
      /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "This takes it out of the team only. It stops getting team wakes and cannot post in team groups." })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "tm-dialog-actions", children: [
      /* @__PURE__ */ jsx(Btn, { type: "button", disabled: busy, onClick: onClose, children: "Cancel" }),
      /* @__PURE__ */ jsx(
        Btn,
        {
          danger: true,
          type: "button",
          disabled: busy || !imp,
          "data-testid": "tm-remove-confirm",
          onClick: () => write(() => removeFromTeam(api, lead.lead_id, lead.kind === "bot" ? lead.bot : ""), `${lead.handle} left the team; the Bot is kept`).then((ok) => {
            if (ok) onClose();
          }),
          children: "Remove from team"
        }
      )
    ] })
  ] }) });
}
function RelayView({ state, leads }) {
  const relays = allRelays(state);
  const byHandle = new Map([...leads.values()].map((l) => [l.handle, l]));
  return /* @__PURE__ */ jsxs("div", { className: "tm-page", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
        /* @__PURE__ */ jsx(Network, { size: 15 }),
        "Tree relay",
        /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
        /* @__PURE__ */ jsx(Approx, { kind: "relay" })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Workers inside one tree do not join the group. To pass word, they go through their nearest common parent: W1 → C1 → W2. Each row below is a note a lead wrote with team_relay_note after passing word." })
    ] }),
    relays.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-empty", children: "No relay notes yet." }),
    relays.map((r) => {
      const parent = byHandle.get(r.via_session);
      return /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-case-row", children: [
          /* @__PURE__ */ jsx(Avatar, { who: r.by, leads, size: "sm" }),
          /* @__PURE__ */ jsx("b", { style: { color: "var(--text-strong)" }, children: whoName(r.by, leads) }),
          /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
            "noted ",
            fmtClock(r.ts)
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "tm-relay", children: [
          /* @__PURE__ */ jsxs("div", { className: "tm-node", children: [
            /* @__PURE__ */ jsx("div", { className: "tm-node-k", children: "W1 · sender" }),
            /* @__PURE__ */ jsx("div", { className: "tm-node-v", title: r.from_session, children: r.from_session })
          ] }),
          /* @__PURE__ */ jsx("span", { className: "tm-arrow", children: /* @__PURE__ */ jsx(ArrowRight, { size: 16 }) }),
          /* @__PURE__ */ jsxs("div", { className: "tm-node is-parent", children: [
            /* @__PURE__ */ jsx("div", { className: "tm-node-k", children: "C1 · common parent" }),
            /* @__PURE__ */ jsx("div", { className: "tm-node-v", title: r.via_session, children: parent ? parent.handle : r.via_session })
          ] }),
          /* @__PURE__ */ jsx("span", { className: "tm-arrow", children: /* @__PURE__ */ jsx(ArrowRight, { size: 16 }) }),
          /* @__PURE__ */ jsxs("div", { className: "tm-node", children: [
            /* @__PURE__ */ jsx("div", { className: "tm-node-k", children: "W2 · receiver" }),
            /* @__PURE__ */ jsx("div", { className: "tm-node-v", title: r.to_session, children: r.to_session })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "tm-relay-sum tm-break", children: [
          "“",
          r.summary,
          "”"
        ] })
      ] }, `${r.channel_id}:${r.seq}`);
    })
  ] });
}
function LedgerView({ state }) {
  const rows = ledgerRows(state);
  const files = [...new Set(rows.map((r) => r.file))];
  const [file, setFile] = useState("");
  const [open, setOpen] = useState(null);
  const shown = rows.filter((r) => !file || r.file === file).slice(0, 300);
  return /* @__PURE__ */ jsx("div", { className: "tm-page", style: { maxWidth: 1300 }, children: /* @__PURE__ */ jsxs("div", { className: "tm-card", children: [
    /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
      /* @__PURE__ */ jsx(ScrollText, { size: 15 }),
      "Raw ledger rows",
      /* @__PURE__ */ jsx("span", { className: "tm-muted", style: { fontWeight: 400 }, children: "append-only, newest first, click a row for the full JSON" }),
      /* @__PURE__ */ jsx("span", { className: "tm-spacer" }),
      /* @__PURE__ */ jsxs("select", { className: "tm-select", value: file, onChange: (e) => setFile(e.target.value), "aria-label": "Filter by file", children: [
        /* @__PURE__ */ jsx("option", { value: "", children: "All files" }),
        files.map((f) => /* @__PURE__ */ jsx("option", { value: f, children: f }, f))
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "tm-xscroll", children: /* @__PURE__ */ jsxs("table", { className: "tm-table tm-ledger", children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("th", { children: "File" }),
        /* @__PURE__ */ jsx("th", { children: "seq" }),
        /* @__PURE__ */ jsx("th", { children: "Time" }),
        /* @__PURE__ */ jsx("th", { children: "type" }),
        /* @__PURE__ */ jsx("th", { children: "by" }),
        /* @__PURE__ */ jsx("th", { children: "data" })
      ] }) }),
      /* @__PURE__ */ jsx("tbody", { children: shown.map((r) => {
        const k = `${r.file}:${r.seq}`;
        return /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("td", { className: "tm-muted", children: r.file }),
          /* @__PURE__ */ jsx("td", { children: r.seq }),
          /* @__PURE__ */ jsx("td", { className: "tm-muted", children: fmtClock(r.ts) }),
          /* @__PURE__ */ jsx("td", { className: "tm-type", children: r.type }),
          /* @__PURE__ */ jsx("td", { children: r.by }),
          /* @__PURE__ */ jsx("td", { className: `tm-json ${open === k ? "is-open" : ""}`, onClick: () => setOpen(open === k ? null : k), children: JSON.stringify(r.data, null, open === k ? 2 : 0) })
        ] }, k);
      }) })
    ] }) }),
    shown.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-empty", children: "No rows." })
  ] }) });
}
export {
  TeamModePage as default
};
