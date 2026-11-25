import { jsxs, jsx, Fragment } from "react/jsx-runtime";
import { useState, useCallback, useEffect } from "react";
import { useAppApi, useAppInfo, useNotify, useNavigate } from "@kirocrew/app-sdk";
import { Btn, Toggle, Modal } from "@kirocrew/app-sdk/ui";
import { Users, Hash, TriangleAlert, Plus, Check } from "lucide-react";
import { u as useBots, a6 as botGroups, d as css, a1 as addBotError, a0 as addBody, a7 as groupError, z as removeFromTeam, a8 as CHAT_TOOLS, a9 as chatToolsSwitch, x as errText, y as impactLines, aa as chatToolsBody, ab as chatToolsError } from "./useBots.mjs";
const BASE = "/api/apps/team-mode";
function TeamModePanel() {
  const api = useAppApi();
  const info = useAppInfo();
  const notify = useNotify();
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [state, setState] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState("");
  const [removing, setRemoving] = useState(false);
  const { bots } = useBots(api);
  const active = info?.active !== false;
  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([api.get(`${BASE}/panel`), api.get(`${BASE}/state`)]);
      setMe(p);
      setState(s);
      setErr("");
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }, [api]);
  useEffect(() => {
    if (!active) return void 0;
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 5e3);
    return () => clearInterval(id);
  }, [load, active]);
  const act = async (fn, ok, toText) => {
    setBusy(true);
    try {
      await fn();
      if (ok) notify?.(ok, { type: "success" });
      await load();
      return true;
    } catch (e) {
      const msg = toText(e);
      setErr(msg);
      notify?.(msg, { type: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const bot = me?.slot_key ? (bots || []).find((b) => b.slot_key === me.slot_key) : null;
  const name = bot?.name || "This Bot";
  const groups = botGroups(state, me?.lead_id);
  return /* @__PURE__ */ jsxs("div", { className: "tm", "data-testid": "tm-panel", children: [
    /* @__PURE__ */ jsx("style", { children: css }),
    /* @__PURE__ */ jsxs("div", { className: "tm-panel", children: [
      /* @__PURE__ */ jsxs("div", { className: "tm-card-title", children: [
        /* @__PURE__ */ jsx(Users, { size: 15 }),
        "Team Mode"
      ] }),
      err && /* @__PURE__ */ jsx("div", { className: "tm-field-err", role: "alert", children: err }),
      !me && !err && /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Loading…" }),
      me && !me.bot && /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Open this tab on a Bot's page to see its Team Mode groups." }),
      me?.bot && !me.lead_id && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          name,
          " is not in the team. A Bot in the team can be added to group chats with Bots from other projects."
        ] }),
        /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx(
          Btn,
          {
            primary: true,
            disabled: busy || !bot,
            "data-testid": "tm-panel-join",
            onClick: () => act(() => api.post(`${BASE}/leads`, addBody(bot)), `${name} joined the team`, addBotError),
            children: "Add to team"
          }
        ) })
      ] }),
      me?.bot && me.lead_id && /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          bot?.project ? `Project: ${bot.project}. ` : "",
          name,
          " is in ",
          groups.in.length,
          " group",
          groups.in.length === 1 ? "" : "s",
          "."
        ] }),
        /* @__PURE__ */ jsxs("div", { "data-testid": "tm-panel-groups", children: [
          groups.in.length === 0 && /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "No groups yet." }),
          groups.in.map((g) => /* @__PURE__ */ jsxs("div", { className: "tm-panel-row", children: [
            /* @__PURE__ */ jsx(Hash, { size: 13 }),
            /* @__PURE__ */ jsx("span", { className: "tm-break", style: { flex: 1 }, children: g.title }),
            /* @__PURE__ */ jsxs("span", { className: "tm-muted", children: [
              (g.members || []).length,
              " leads"
            ] })
          ] }, g.id))
        ] }),
        groups.in.length > 1 && /* @__PURE__ */ jsxs("div", { className: "tm-note is-info", children: [
          /* @__PURE__ */ jsx(TriangleAlert, { size: 14 }),
          /* @__PURE__ */ jsxs("span", { children: [
            "One memory for all ",
            groups.in.length,
            " groups: what it reads in one group can come up in another."
          ] })
        ] }),
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("label", { className: "tm-label", htmlFor: "tm-panel-pick", children: "Add to group" }),
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 6 }, children: [
            /* @__PURE__ */ jsxs("select", { id: "tm-panel-pick", className: "tm-select", value: pick, onChange: (e) => setPick(e.target.value), disabled: busy || groups.open.length === 0, style: { flex: 1, minWidth: 0, fontSize: 13 }, children: [
              /* @__PURE__ */ jsx("option", { value: "", children: groups.open.length === 0 ? "No other groups" : "Choose a group…" }),
              groups.open.map((g) => /* @__PURE__ */ jsx("option", { value: g.id, children: g.title }, g.id))
            ] }),
            /* @__PURE__ */ jsxs(
              Btn,
              {
                primary: true,
                disabled: busy || !pick,
                "data-testid": "tm-panel-add",
                onClick: () => act(
                  () => api.post(`${BASE}/groups/${encodeURIComponent(pick)}/members`, { add: [me.lead_id] }),
                  `${name} was added to #${groups.open.find((g) => g.id === pick)?.title || "the group"}`,
                  groupError
                ).then((ok) => {
                  if (ok) setPick("");
                }),
                children: [
                  /* @__PURE__ */ jsx(Plus, { size: 13 }),
                  "Add"
                ]
              }
            )
          ] })
        ] }),
        bot?.bot && /* @__PURE__ */ jsx(ChatToolsSwitch, { api, crew: bot.bot, name, leadId: me.lead_id, notify }),
        /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx(Btn, { danger: true, disabled: busy, "data-testid": "tm-panel-remove", onClick: () => setRemoving(true), children: "Remove from team" }) }),
        /* @__PURE__ */ jsxs("div", { className: "tm-muted", children: [
          "Remove takes ",
          name,
          " out of the team only. The Bot is kept."
        ] }),
        removing && /* @__PURE__ */ jsx(
          RemoveDialog,
          {
            api,
            leadId: me.lead_id,
            name,
            busy,
            onClose: () => setRemoving(false),
            onConfirm: () => act(() => removeFromTeam(api, me.lead_id, bot?.bot || ""), `${name} left the team; the Bot is kept`, addBotError).then(() => setRemoving(false))
          }
        )
      ] }),
      /* @__PURE__ */ jsx("div", { className: "tm-muted", children: /* @__PURE__ */ jsx("a", { href: "/apps/team-mode", className: "tm-link", onClick: (e) => {
        e.preventDefault();
        navigate("/apps/team-mode");
      }, children: "Open Team Mode" }) })
    ] })
  ] });
}
function ChatToolsSwitch({ api, crew, name, leadId, notify }) {
  const url = CHAT_TOOLS;
  const [view, setView] = useState(null);
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    api.get(url).then((v) => {
      if (live) setView(v);
    }, () => {
      if (live) setView(null);
    });
    return () => {
      live = false;
    };
  }, [api, url]);
  const { show, approved, on } = chatToolsSwitch(view, crew);
  if (!show) return null;
  const confirm = async () => {
    const next = ask;
    setBusy(true);
    setErr("");
    try {
      setView(await api.put(url, chatToolsBody(view, crew, next)));
      if (next && leadId) await api.post(`${BASE}/leads/${encodeURIComponent(leadId)}/wake`, {}).catch(() => null);
      notify?.(next ? `${name} can now answer the team from its own chat` : `Team Mode tools are off for ${name}`, { type: "success" });
      setAsk(null);
    } catch (e) {
      setErr(chatToolsError(e));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs("div", { className: "tm-panel-switch", "data-testid": "tm-panel-chat-tools", children: [
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
      /* @__PURE__ */ jsxs("span", { style: { flex: 1 }, children: [
        /* @__PURE__ */ jsx("span", { className: "tm-label", style: { display: "block", margin: 0 }, children: "Answer from its own chat" }),
        /* @__PURE__ */ jsx("span", { className: "tm-muted", children: !approved ? "Approve Team Mode's Bot tools access on its app page first." : on ? `On: ${name} is woken in its own chat when the team needs it.` : "Off: Team Mode cannot wake this Bot." })
      ] }),
      /* @__PURE__ */ jsx("span", { "data-testid": "tm-panel-chat-tools-toggle", "data-on": on ? "true" : "false", children: /* @__PURE__ */ jsx(Toggle, { checked: on, disabled: busy || !approved && !on, label: "Answer from its own chat", onChange: (v) => setAsk(v) }) })
    ] }),
    ask !== null && /* @__PURE__ */ jsx(
      Modal,
      {
        open: true,
        onClose: busy ? () => {
        } : () => {
          setAsk(null);
          setErr("");
        },
        title: ask ? `Let ${name} answer the team from its own chat?` : `Turn off Team Mode tools for ${name}?`,
        maxWidth: 480,
        children: /* @__PURE__ */ jsxs("div", { className: "tm-form", "data-testid": "tm-panel-chat-tools-dialog", children: [
          /* @__PURE__ */ jsx("ul", { className: "tm-impact", children: (ask ? [
            `${name}'s own chat gets the Team Mode tools.`,
            `When someone @-mentions ${name} in a group, Team Mode wakes that chat. Each wake is a full turn and uses credits.`,
            "You can turn this off at any time."
          ] : [
            `${name}'s chat loses the Team Mode tools, and its wake job is removed.`,
            "Its next turn starts a fresh conversation. The messages stay visible.",
            `${name} stays in the team and in its groups.`
          ]).map((t, i) => /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx(Check, { size: 14 }),
            /* @__PURE__ */ jsx("span", { children: t })
          ] }, i)) }),
          err && /* @__PURE__ */ jsx("div", { className: "tm-field-err", role: "alert", children: err }),
          /* @__PURE__ */ jsxs("div", { className: "tm-dialog-actions", children: [
            /* @__PURE__ */ jsx(Btn, { type: "button", disabled: busy, onClick: () => {
              setAsk(null);
              setErr("");
            }, children: "Cancel" }),
            /* @__PURE__ */ jsx(Btn, { primary: ask, danger: !ask, type: "button", disabled: busy, "data-testid": "tm-panel-chat-tools-confirm", onClick: confirm, children: ask ? "Turn on" : "Turn off" })
          ] })
        ] })
      }
    )
  ] });
}
function RemoveDialog({ api, leadId, name, busy, onClose, onConfirm }) {
  const [imp, setImp] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    api.get(`${BASE}/leads/${encodeURIComponent(leadId)}/impact`).then((r) => {
      if (live) setImp(r);
    }, (e) => {
      if (live) setErr(errText(e));
    });
    return () => {
      live = false;
    };
  }, [api, leadId]);
  const lines = impactLines(imp, { bot: true });
  return /* @__PURE__ */ jsx(Modal, { open: true, onClose: busy ? () => {
  } : onClose, title: `Remove ${name} from the team?`, maxWidth: 480, children: /* @__PURE__ */ jsxs("div", { className: "tm-form", "data-testid": "tm-panel-remove-dialog", children: [
    err ? /* @__PURE__ */ jsx("div", { className: "tm-field-err", role: "alert", children: err }) : !imp ? /* @__PURE__ */ jsx("div", { className: "tm-muted", children: "Checking what this touches…" }) : /* @__PURE__ */ jsx("ul", { className: "tm-impact", children: lines.map((x, i) => /* @__PURE__ */ jsxs("li", { className: x.kind === "warn" ? "is-warn" : "", children: [
      x.kind === "warn" ? /* @__PURE__ */ jsx(TriangleAlert, { size: 14 }) : x.kind === "keep" ? /* @__PURE__ */ jsx(Check, { size: 14 }) : /* @__PURE__ */ jsx(Hash, { size: 14 }),
      /* @__PURE__ */ jsx("span", { children: x.text })
    ] }, i)) }),
    /* @__PURE__ */ jsxs("div", { className: "tm-dialog-actions", children: [
      /* @__PURE__ */ jsx(Btn, { type: "button", disabled: busy, onClick: onClose, children: "Cancel" }),
      /* @__PURE__ */ jsx(Btn, { danger: true, type: "button", disabled: busy || !imp, "data-testid": "tm-panel-remove-confirm", onClick: onConfirm, children: "Remove from team" })
    ] })
  ] }) });
}
export {
  TeamModePanel as default
};
