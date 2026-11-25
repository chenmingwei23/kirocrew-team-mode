import { useState, useCallback, useEffect } from "react";
const css = '/* Team Mode page. Every colour, radius and font reads a host design token\n   (--bg, --card, --text, --accent, --radius-md, --font-body ...), so the page\n   follows the dashboard\'s light, dark and theme-pack palettes. Class names are\n   prefixed `tm-` so nothing leaks into the host. */\n\n.tm { display: flex; flex-direction: column; height: 100%; min-height: 0; flex: 1; color: var(--text); font-family: var(--font-body); font-size: 14px; background: var(--bg); }\n.tm * { box-sizing: border-box; }\n.tm button { font-family: inherit; }\n.tm-mono { font-family: var(--mono); }\n\n/* ── top bar ── */\n.tm-top { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg); flex-wrap: wrap; }\n.tm-title { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 18px; color: var(--text-strong); letter-spacing: -.01em; }\n.tm-title-sub { font-weight: 400; font-size: 12px; color: var(--muted); }\n.tm-tabs { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-elevated); overflow-x: auto; scrollbar-width: none; }\n.tm-tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: var(--radius-sm); border: 0; background: transparent; color: var(--muted); font-size: 13px; cursor: pointer; white-space: nowrap; }\n.tm-tab:hover { color: var(--text); background: var(--bg-hover); }\n.tm-tab[aria-selected="true"] { color: var(--accent); background: var(--accent-subtle); font-weight: 500; }\n.tm-top-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }\n.tm-live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }\n.tm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-subtle); }\n.tm-dot.is-stopped { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-subtle); }\n.tm-dot.is-off { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-subtle); }\n\n.tm-stop { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: var(--radius-md); border: 1px solid var(--danger); background: var(--danger); color: var(--danger-fg, #fff); font-weight: 600; font-size: 13px; cursor: pointer; }\n.tm-stop:hover { filter: brightness(1.08); }\n.tm-stop:disabled { opacity: .6; cursor: progress; }\n.tm-resume { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: var(--radius-md); border: 1px solid var(--ok); background: var(--ok-subtle); color: var(--ok-text, var(--ok)); font-weight: 600; font-size: 13px; cursor: pointer; }\n\n.tm-banner { display: flex; align-items: center; gap: 10px; padding: 8px 16px; font-size: 13px; border-bottom: 1px solid var(--border); }\n.tm-banner.is-stopped { background: var(--danger-subtle); color: var(--danger-text, var(--danger)); }\n.tm-banner.is-error { background: var(--warn-subtle); color: var(--warn-text, var(--warn)); }\n\n/* ── approximation chip ── */\n.tm-approx { display: inline-flex; align-items: center; gap: 3px; padding: 0 6px; height: 18px; border-radius: 999px; border: 1px dashed color-mix(in srgb, var(--warn) 60%, transparent); color: var(--warn-text, var(--warn)); background: color-mix(in srgb, var(--warn) 8%, transparent); font-size: 11px; font-weight: 500; white-space: nowrap; cursor: help; vertical-align: middle; }\n\n/* ── body grid ── */\n.tm-body { flex: 1; min-height: 0; position: relative; display: grid; grid-template-columns: 248px minmax(0, 1fr) 340px; }\n.tm-body.is-single { display: flex; flex-direction: column; overflow: auto; }\n.tm-rail { border-right: 1px solid var(--border); overflow-y: auto; padding: 12px 8px; background: var(--bg); }\n.tm-side { border-left: 1px solid var(--border); overflow-y: auto; padding: 12px; background: var(--bg); position: relative; }\n.tm-center { display: flex; flex-direction: column; min-width: 0; min-height: 0; position: relative; }\n\n.tm-sec { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); padding: 10px 8px 6px; display: flex; align-items: center; gap: 6px; }\n.tm-sec:first-child { padding-top: 2px; }\n.tm-ch { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: var(--radius-md); border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; font-size: 14px; }\n.tm-ch:hover { background: var(--bg-hover); }\n.tm-ch[aria-current="true"] { background: var(--accent-subtle); color: var(--text-strong); }\n.tm-ch-icon { width: 26px; height: 26px; border-radius: var(--radius-sm); display: grid; place-items: center; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--muted); flex-shrink: 0; }\n.tm-ch-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tm-ch-meta { font-size: 11px; color: var(--muted); }\n.tm-unread { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--accent); color: var(--accent-fg); font-size: 11px; font-weight: 700; display: grid; place-items: center; font-family: var(--mono); }\n\n/* ── channel header + conversation ── */\n.tm-chhead { display: flex; align-items: center; gap: 10px; padding: 10px 18px; border-bottom: 1px solid var(--border); min-height: 52px; flex-wrap: wrap; }\n.tm-chhead-name { font-weight: 600; color: var(--text-strong); font-size: 15px; }\n.tm-chhead-meta { font-size: 12px; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }\n.tm-avstack { display: inline-flex; }\n.tm-avstack > * { margin-left: -6px; box-shadow: 0 0 0 2px var(--bg); }\n.tm-avstack > *:first-child { margin-left: 0; }\n\n.tm-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px 8px; }\n.tm-msg { display: flex; gap: 10px; padding: 6px 0; max-width: 760px; }\n.tm-msg.is-owner { flex-direction: row-reverse; margin-left: auto; }\n.tm-msg-body { min-width: 0; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }\n.tm-msg.is-owner .tm-msg-body { align-items: flex-end; }\n.tm-msg-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }\n.tm-msg-who { font-weight: 600; color: var(--text-strong); font-size: 13px; }\n.tm-role { font-family: var(--mono); font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--bg-hover); color: var(--muted); }\n.tm-bubble { padding: 9px 13px; border-radius: 14px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text); line-height: 1.55; white-space: pre-wrap; word-break: break-word; }\n.tm-msg.is-owner .tm-bubble { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }\n.tm-msg.is-held .tm-bubble { border: 1px dashed var(--warn); background: var(--warn-subtle); color: var(--text); opacity: .9; }\n/* A message card turns over on click / Enter / Space (App.jsx:FlipCard); the face swaps at the half turn. */\n.tm-flip { display: flex; flex-direction: column; gap: 4px; align-items: inherit; max-width: 100%; cursor: pointer; border-radius: 14px; transform-origin: center; }\n.tm-flip:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }\n.tm-flip.is-turning { animation: tm-flip 320ms ease-in-out; }\n@keyframes tm-flip { 0% { transform: perspective(900px) rotateY(0); } 50% { transform: perspective(900px) rotateY(90deg); } 100% { transform: perspective(900px) rotateY(0); } }\n@media (prefers-reduced-motion: reduce) { .tm-flip.is-turning { animation: none; } }\n.tm-msg-back { margin: 0; padding: 9px 13px; border-radius: 14px; background: var(--card); border: 1px solid var(--border-strong, var(--border)); color: var(--text); display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; font-size: 12.5px; line-height: 1.5; min-width: 240px; }\n.tm-msg-back dt { color: var(--muted); font-weight: 600; white-space: nowrap; }\n.tm-msg-back dd { margin: 0; }\n.tm-mention { color: var(--accent); font-weight: 600; }\n.tm-msg.is-owner .tm-mention { color: inherit; text-decoration: underline; text-underline-offset: 2px; }\n.tm-chips { display: flex; flex-wrap: wrap; gap: 6px; }\n.tm-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: var(--card); color: var(--muted); white-space: nowrap; }\n.tm-chip.is-assign { border-color: color-mix(in srgb, var(--aim) 45%, transparent); background: var(--aim-subtle); color: var(--aim); }\n.tm-chip.is-ok { border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: var(--ok-subtle); color: var(--ok-text, var(--ok)); }\n.tm-chip.is-warn { border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: var(--warn-subtle); color: var(--warn-text, var(--warn)); }\n.tm-chip.is-err { border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: var(--danger-subtle); color: var(--danger-text, var(--danger)); }\n.tm-chip.is-info { border-color: color-mix(in srgb, var(--info) 45%, transparent); background: color-mix(in srgb, var(--info) 12%, transparent); color: var(--info-text, var(--info)); }\n.tm-stub { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px 4px 6px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: 13px; }\n.tm-stub:hover { border-color: var(--border-strong); background: var(--bg-hover); }\n.tm-stub b { color: var(--accent); font-weight: 600; }\n.tm-sys { display: flex; align-items: flex-start; gap: 8px; margin: 8px auto; max-width: 620px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--aim-subtle); color: var(--text); font-size: 13px; border: 1px solid color-mix(in srgb, var(--aim) 30%, transparent); }\n.tm-sys-icon { color: var(--aim); margin-top: 2px; flex-shrink: 0; }\n.tm-daysep { text-align: center; font-size: 12px; color: var(--muted); padding: 4px 0 10px; }\n\n/* ── avatar ── */\n.tm-av { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; flex-shrink: 0; color: #fff; user-select: none; }\n.tm-av.sm { width: 22px; height: 22px; font-size: 10px; }\n.tm-av.h0 { background: color-mix(in srgb, var(--info) 85%, #000); }\n.tm-av.h1 { background: color-mix(in srgb, var(--ok) 80%, #000); }\n.tm-av.h2 { background: color-mix(in srgb, var(--warn) 80%, #000); }\n.tm-av.h3 { background: color-mix(in srgb, var(--aim) 85%, #000); }\n.tm-av.h4 { background: color-mix(in srgb, var(--danger) 75%, #000); }\n.tm-av.owner { background: var(--accent); color: var(--accent-fg); }\n.tm-av.br { background: var(--aim-subtle); color: var(--aim); border: 1px solid color-mix(in srgb, var(--aim) 40%, transparent); }\n\n/* ── composer ── */\n.tm-composer { border-top: 1px solid var(--border); padding: 10px 18px 14px; background: var(--bg); position: relative; }\n.tm-composer-target { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin-bottom: 6px; flex-wrap: wrap; }\n.tm-composer-box { display: flex; align-items: flex-end; gap: 8px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-elevated); padding: 6px 6px 6px 12px; }\n.tm-composer-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle); }\n.tm-textarea { flex: 1; min-width: 0; resize: none; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; line-height: 1.5; padding: 6px 0; max-height: 140px; }\n.tm-textarea::placeholder { color: var(--muted); opacity: .7; }\n.tm-send { width: 34px; height: 34px; border-radius: 50%; border: 0; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; cursor: pointer; flex-shrink: 0; }\n.tm-send:disabled { background: var(--bg-hover); color: var(--muted); cursor: not-allowed; }\n.tm-icobtn { width: 30px; height: 30px; border-radius: var(--radius-md); border: 0; background: transparent; color: var(--muted); display: grid; place-items: center; cursor: pointer; flex-shrink: 0; }\n.tm-icobtn:hover { background: var(--bg-hover); color: var(--text); }\n.tm-pop { position: absolute; bottom: calc(100% - 4px); left: 18px; min-width: 260px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); padding: 4px; z-index: 20; }\n.tm-pop-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; background: transparent; color: var(--text); border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; text-align: left; }\n.tm-pop-item[aria-selected="true"], .tm-pop-item:hover { background: var(--bg-hover); }\n.tm-pop-item small { color: var(--muted); margin-left: auto; font-size: 11px; }\n\n/* ── thread drawer ── */\n.tm-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(460px, 100%); background: var(--bg); border-left: 1px solid var(--border); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; z-index: 15; animation: tm-slide .18s ease-out; }\n@keyframes tm-slide { from { transform: translateX(16px); opacity: 0 } to { transform: none; opacity: 1 } }\n@media (prefers-reduced-motion: reduce) { .tm-drawer { animation: none; } }\n.tm-drawer-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--border); }\n.tm-drawer-root { padding: 12px 16px; border-bottom: 1px dashed var(--border); background: var(--bg-elevated); }\n\n/* ── meeting panel (after ui-demo-v4\'s meeting side panel) ── */\n.tm-mdrawer { width: min(540px, 100%); }\n.tm-mhead { padding: 10px 16px 6px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); font-size: 13px; }\n.tm-mpeople { display: flex; flex-wrap: wrap; gap: 6px; }\n.tm-mperson { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 3px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); font-size: 12px; color: var(--text); }\n.tm-mperson.is-dim { opacity: .65; }\n.tm-mbudget { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; margin-top: 4px; }\n.tm-mtabs { padding: 6px 12px; border-bottom: 1px solid var(--border); overflow-x: auto; }\n.tm-mbody { padding: 10px 16px; }\n.tm-mnote { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 12.5px; }\n.tm-agenda { margin: 0; padding: 0; list-style: none; }\n.tm-agenda-item + .tm-agenda-item { border-top: 1px solid var(--border); }\n.tm-agenda-row { display: flex; gap: 10px; align-items: flex-start; width: 100%; padding: 9px 0; border: 0; background: transparent; color: var(--text); text-align: left; cursor: pointer; font-size: 13.5px; }\n.tm-agenda-row b { color: var(--text-strong); font-weight: 600; display: block; }\n.tm-agenda-row small { color: var(--muted); font-size: 12px; display: block; }\n.tm-agenda-n { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 11.5px; font-weight: 700; flex: none; background: var(--bg-hover); color: var(--muted); }\n.tm-agenda-n.done { background: var(--ok-subtle); color: var(--ok-text, var(--ok)); }\n.tm-agenda-n.cur { background: var(--accent); color: var(--accent-fg, #fff); }\n.tm-agenda-n.wait { background: var(--warn-subtle); color: var(--warn); }\n.tm-agenda-item.is-needs { box-shadow: inset 3px 0 0 var(--danger); background: color-mix(in srgb, var(--danger) 5%, transparent); padding-left: 8px; margin-left: -8px; border-radius: var(--radius-sm); }\n.tm-stages { display: flex; gap: 0; margin: -2px 0 8px 32px; padding: 0; list-style: none; font-size: 11.5px; }\n.tm-stage { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 3px; padding-top: 6px; border-top: 3px solid var(--border); color: var(--muted); }\n.tm-stage + .tm-stage { margin-left: 3px; }\n.tm-stage-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }\n.tm-stage-note { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.tm-stage.is-done { border-top-color: var(--ok); color: var(--ok-text, var(--ok)); }\n.tm-stage.is-current { border-top-color: var(--accent); color: var(--text-strong); font-weight: 600; }\n.tm-stage.is-current .tm-stage-label { font-weight: 600; }\n.tm-stage.is-skipped { border-top-style: dashed; opacity: .7; }\n.tm-stage.is-needs { border-top-color: var(--danger); color: var(--danger-text, var(--danger)); }\n.tm-stage.is-needs .tm-stage-label { background: var(--danger-subtle); border-radius: 4px; padding: 0 4px; align-self: flex-start; }\n.tm-agenda-body { padding: 0 0 10px 32px; font-size: 13px; display: flex; flex-direction: column; gap: 6px; }\n.tm-outcome { border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); background: var(--ok-subtle); border-radius: var(--radius-md); padding: 8px 10px; }\n.tm-proposals, .tm-speeches { display: flex; flex-direction: column; gap: 6px; }\n.tm-proposal, .tm-ballot { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 10px; background: var(--card); }\n.tm-proposal.is-win { border-color: color-mix(in srgb, var(--ok) 50%, transparent); }\n.tm-speech { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-top: 1px dashed var(--border); }\n.tm-speech.is-owner { background: var(--accent-subtle); border-radius: var(--radius-sm); padding: 6px; border-top: 0; }\n.tm-minutes, .tm-minutes-post { border: 1px solid var(--border); border-radius: 16px; background: var(--bg-elevated); padding: 14px; font-size: 13px; }\n.tm-minutes h4 { font-size: 13.5px; color: var(--text-strong); display: flex; align-items: center; gap: 8px; margin: 0 0 6px; }\n.tm-minutes ol, .tm-minutes ul { margin: 8px 0 0 18px; padding: 0; line-height: 1.7; }\n.tm-minutes-post { margin: 10px auto; max-width: 648px; }\n.tm-minutes-head { display: flex; align-items: center; gap: 8px; color: var(--text-strong); margin-bottom: 6px; }\n.tm-minutes-head .tm-spacer { flex: 1; }\n.tm-minutes-text { white-space: pre-wrap; font-size: 12.5px; color: var(--text); line-height: 1.6; }\n.tm-action { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }\n.tm-stub.is-meeting { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }\n.tm-live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex-shrink: 0; box-shadow: 0 0 0 3px var(--ok-subtle); }\n\n/* ── side cards ── */\n.tm-card { border: 1px solid var(--border); background: var(--card); border-radius: var(--radius-lg); padding: 12px; margin-bottom: 12px; box-shadow: var(--shadow-sm); }\n.tm-card-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text-strong); margin-bottom: 10px; flex-wrap: wrap; }\n.tm-card-title .tm-spacer { flex: 1; }\n.tm-muted { color: var(--muted); font-size: 12px; }\n.tm-lane { font-family: var(--mono); font-size: 11px; padding: 1px 7px; border-radius: 999px; font-weight: 600; }\n.tm-lane.llm { background: var(--accent-subtle); color: var(--accent); }\n.tm-lane.rules { background: var(--warn-subtle); color: var(--warn-text, var(--warn)); }\n.tm-brief-group { border-left: 2px solid var(--border-strong); padding: 2px 0 2px 10px; margin: 8px 0; }\n.tm-brief-place { font-size: 12px; color: var(--muted); margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }\n.tm-brief-item { font-size: 13px; line-height: 1.5; display: flex; gap: 8px; }\n.tm-brief-pointers { display: block; font-family: var(--mono); font-size: 11px; color: var(--muted); }\n.tm-seq { font-family: var(--mono); font-size: 11px; color: var(--muted); white-space: nowrap; padding-top: 2px; }\n.tm-mem-sec { border-top: 1px solid var(--border); padding: 8px 0 6px; }\n.tm-mem-sec:first-of-type { border-top: 0; padding-top: 0; }\n.tm-mem-head { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }\n.tm-mem-head .tm-spacer { flex: 1; }\n.tm-mem-cap { font-family: var(--mono); font-weight: 400; text-transform: none; cursor: help; }\n.tm-mem-line { display: flex; gap: 8px; align-items: baseline; font-size: 13px; line-height: 1.5; margin: 3px 0; color: var(--text); }\n.tm-mem-line .tm-chip { font-size: 11px; padding: 0 7px; flex-shrink: 0; }\n.tm-mem-none, .tm-mem-more { font-size: 12px; margin: 2px 0; }\n.tm-mem-more { font-style: italic; }\n.tm-mem-toggle { margin-top: 6px; font-size: 12px; padding: 3px 10px 3px 6px; }\n.tm-mem-history { margin-top: 8px; display: grid; gap: 8px; }\n.tm-mem-old { border-left: 2px solid var(--border-strong); padding: 2px 0 2px 10px; }\n.tm-mem-old .tm-mem-line { color: var(--muted); }\n.tm-mem-old b { color: var(--text); font-weight: 600; }\n.tm-select { appearance: none; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-sm); padding: 3px 24px 3px 8px; font: inherit; font-size: 12px; cursor: pointer; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%); background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%; background-size: 4px 4px; background-repeat: no-repeat; }\n\n.tm-case { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px; margin-top: 8px; background: var(--bg-elevated); }\n.tm-case.is-call { border-color: color-mix(in srgb, var(--danger) 50%, transparent); background: color-mix(in srgb, var(--danger) 6%, var(--bg-elevated)); }\n.tm-case-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }\n.tm-case-q { font-size: 13px; line-height: 1.5; margin: 8px 0; color: var(--text-strong); }\n.tm-case-why { font-size: 12px; color: var(--muted); line-height: 1.5; }\n.tm-answer { display: flex; gap: 6px; margin-top: 8px; }\n.tm-answer input { flex: 1; min-width: 0; }\n.tm-fields { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; font-size: 12px; line-height: 1.45; }\n.tm-fields dt { color: var(--muted); }\n.tm-fields dd { margin: 0; color: var(--text-strong); overflow-wrap: anywhere; }\n.tm-verdict { margin: 8px 0; padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--card); }\n.tm-verdict.is-block { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }\n.tm-verdict.is-hold { border-color: color-mix(in srgb, var(--warn) 45%, transparent); border-style: dashed; }\n.tm-verdict-head { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); margin-bottom: 6px; }\n.tm-evidence { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 4px; vertical-align: middle; }\n.tm-ev { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); background: var(--card); cursor: help; }\n.tm-ev.is-claim { border-style: dashed; color: var(--warn-text, var(--warn)); border-color: color-mix(in srgb, var(--warn) 50%, transparent); }\n.tm-pcard { margin-top: 8px; padding: 10px; border-radius: var(--radius-md); border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); background: var(--card); }\n.tm-pcard.is-closed { border-color: var(--border); opacity: .92; }\n.tm-pcard-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }\n.tm-pcard-actions button { display: inline-flex; align-items: center; gap: 4px; }\n.tm-standing { display: flex; align-items: flex-start; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--text); cursor: pointer; }\n.tm-standing input { margin-top: 2px; accent-color: var(--aim); }\n.tm-pcard-note { margin-top: 6px; font-size: 12px; line-height: 1.45; }\n\n/* ── needs you ── */\n.tm-waiting { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent); background: var(--warn-subtle); color: var(--warn-text, var(--warn)); font-size: 12px; font-weight: 600; cursor: pointer; }\n.tm-waiting:hover { filter: brightness(1.05); }\n.tm-unread.is-warn { background: var(--warn); color: var(--warn-fg, #1a1200); margin-left: 2px; }\n.tm-needs { width: 100%; max-width: 760px; margin: 0 auto; padding: 16px; }\n.tm-recap { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }\n.tm-recap li { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }\n.tm-recap .tm-stub { padding: 2px 8px; font-size: 12px; }\n.tm-decision { border-color: color-mix(in srgb, var(--danger) 50%, transparent); background: color-mix(in srgb, var(--danger) 5%, var(--card)); padding: 16px; }\n.tm-decision-q { font-size: 15px; line-height: 1.55; margin: 6px 0 10px; color: var(--text-strong); }\n.tm-decision .tm-case-row { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }\n.tm-decision .tm-answer { margin-top: 12px; }\n.tm-needs-empty { display: flex; gap: 10px; align-items: flex-start; }\n\n.tm-meter { margin: 8px 0; }\n.tm-meter-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; margin-bottom: 4px; gap: 8px; }\n.tm-meter-row b { font-family: var(--mono); font-size: 13px; color: var(--text-strong); font-weight: 600; }\n.tm-bar { height: 6px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }\n.tm-bar > i { display: block; height: 100%; background: var(--accent); border-radius: inherit; }\n.tm-bar > i.is-hot { background: var(--warn); }\n.tm-bar > i.is-full { background: var(--danger); }\n.tm-stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }\n.tm-stat { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 10px; background: var(--bg-elevated); }\n.tm-stat-l { font-size: 11px; color: var(--muted); }\n.tm-stat-v { font-family: var(--mono); font-size: 15px; font-weight: 600; color: var(--text-strong); margin-top: 2px; }\n\n/* ── pages (members / relay / ledger) ── */\n.tm-page { padding: 16px; max-width: 1100px; width: 100%; margin: 0 auto; }\n.tm-page-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 14px; }\n.tm-table { width: 100%; border-collapse: collapse; font-size: 13px; }\n.tm-table th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--border); }\n.tm-table td { padding: 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); vertical-align: middle; }\n.tm-table tr:last-child td { border-bottom: 0; }\n.tm-lead-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.tm-form { display: flex; flex-direction: column; gap: 10px; }\n.tm-label { font-size: 12px; color: var(--muted); margin-bottom: 4px; display: block; }\n.tm-pick { display: flex; flex-wrap: wrap; gap: 6px; }\n.tm-pick label { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px 4px 4px; border: 1px solid var(--border); border-radius: 999px; cursor: pointer; font-size: 13px; background: var(--bg-elevated); }\n.tm-pick label:has(input:checked) { border-color: var(--accent); background: var(--accent-subtle); }\n.tm-pick input { accent-color: var(--accent); margin: 0 0 0 4px; }\n.tm-bot-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); flex-wrap: wrap; }\n.tm-bot-row:last-child { border-bottom: 0; }\n.tm-bot-main { flex: 1; min-width: 0; }\n.tm-bot-why { flex: 1 1 100%; font-size: 12px; }\n.tm-legacy { display: inline-block; padding: 0 6px; border: 1px dashed var(--border); border-radius: 999px; font-size: 11px; }\n.tm-panel { padding: 12px; display: flex; flex-direction: column; gap: 10px; font-size: 13px; }\n.tm-panel-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }\n.tm-panel-row:last-child { border-bottom: 0; }\n\n.tm-relay { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: center; gap: 6px; margin: 6px 0 4px; }\n.tm-node { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 10px; background: var(--bg-elevated); min-width: 0; }\n.tm-node.is-parent { border-color: var(--accent); background: var(--accent-subtle); }\n.tm-node-k { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 600; }\n.tm-node-v { font-family: var(--mono); font-size: 12px; color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }\n.tm-arrow { color: var(--muted); display: grid; place-items: center; }\n.tm-relay-sum { font-size: 13px; color: var(--text); margin-top: 6px; }\n\n.tm-ledger td { font-family: var(--mono); font-size: 12px; }\n.tm-ledger td.tm-json { color: var(--muted); max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }\n.tm-ledger td.tm-json.is-open { white-space: pre-wrap; word-break: break-all; color: var(--text); }\n.tm-type { color: var(--accent); }\n\n.tm-break { overflow-wrap: anywhere; word-break: break-word; }\n.tm-chip.is-wrap { white-space: normal; max-width: 100%; overflow-wrap: anywhere; }\n.tm-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tm-xscroll { overflow-x: auto; }\n.tm-pop-handle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n\n.tm-empty { text-align: center; color: var(--muted); padding: 32px 12px; font-size: 13px; }\n\n/* ── members: team tree (Owner -> leads, left to right, role card on the right) ── */\n.tm-members-tabs { display: inline-flex; margin-bottom: 12px; }\n.tm-tree-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 12px; min-height: 440px; }\n.tm-tree-view { position: relative; overflow: hidden; height: 460px; border: 1px solid var(--border); border-radius: var(--radius-md); cursor: grab; touch-action: none;\n  background-color: var(--bg-elevated); background-image: radial-gradient(color-mix(in srgb, var(--muted) 28%, transparent) 1px, transparent 1px); background-size: 18px 18px; }\n.tm-tree-view:active { cursor: grabbing; }\n.tm-tree-inner { position: absolute; left: 0; top: 0; transform-origin: 0 0; }\n.tm-tree-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }\n.tm-tree-edges path { fill: none; stroke: var(--border-strong); stroke-width: 1.6; }\n.tm-tree-edges path.is-sel { stroke: var(--accent); stroke-width: 2.4; }\n.tm-tnode { position: absolute; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; text-align: left; cursor: pointer; color: var(--text);\n  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); font: inherit; overflow: hidden; }\n.tm-tnode:hover { border-color: var(--border-strong); }\n.tm-tnode:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\n.tm-tnode.is-sel { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-subtle), var(--shadow-sm); }\n.tm-tnode.is-legacy { border-style: dashed; }\n.tm-legacy-tag { flex: none; white-space: nowrap; line-height: 1.35; font-style: normal; font-size: 11px; margin-right: 4px; padding: 0 6px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent); background: var(--warn-subtle); color: var(--warn-text, var(--warn)) !important; font-weight: 600; }\n.tm-tnode.is-owner { flex-direction: row; align-items: center; gap: 10px; background: var(--accent-subtle); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }\n.tm-tnode-row { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.tm-tnode-main { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.25; }\n.tm-tnode-main b { color: var(--text-strong); font-weight: 600; font-size: 14px; }\n.tm-tnode-main small { color: var(--muted); font-size: 11.5px; }\n.tm-tnode-duty { font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tm-tnode-duty.is-empty { color: var(--muted); font-style: italic; }\n.tm-tnode-groups { display: flex; gap: 6px; align-items: center; min-width: 0; overflow: hidden; font-size: 11.5px; }\n.tm-tgroup { display: inline-flex; align-items: center; gap: 2px; padding: 1px 7px 1px 5px; border-radius: 999px; background: var(--bg-hover); color: var(--muted); white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }\n.tm-tnode-project { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; color: var(--accent); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.tm-tnode-project.is-empty { color: var(--muted); font-weight: 400; font-style: italic; }\n.tm-tworker { position: absolute; display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 6px 10px; border: 1px dashed var(--border-strong); border-radius: var(--radius-md); background: var(--card); line-height: 1.25; overflow: hidden; }\n.tm-tworker b { font-size: 12.5px; font-weight: 600; color: var(--text-strong); }\n.tm-tworker small { font-size: 11px; color: var(--muted); }\n.tm-tworker.is-sel { border-color: color-mix(in srgb, var(--accent) 60%, transparent); }\n.tm-tree-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: 13px; padding: 0 16px; pointer-events: none; }\n.tm-tree-empty-box { pointer-events: auto; max-width: 340px; display: flex; flex-direction: column; gap: 8px; padding: 16px; border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); background: var(--card); }\n.tm-tree-empty-box b { color: var(--text-strong); font-size: 14px; }\n.tm-tree-empty-act { display: flex; align-items: center; gap: 10px; }\n.tm-ttoggle { position: absolute; min-width: 28px; height: 28px; padding: 0 7px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; cursor: pointer;\n  border: 1px solid var(--border-strong); background: var(--card); color: var(--text); font-size: 12px; font-weight: 600; box-shadow: var(--shadow-sm); z-index: 1; }\n.tm-ttoggle:hover { border-color: var(--accent); color: var(--accent); }\n.tm-ttoggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\n.tm-ttoggle.is-open { background: var(--accent-subtle); border-color: color-mix(in srgb, var(--accent) 50%, transparent); color: var(--accent); }\n.tm-tree-bar { position: absolute; left: 10px; top: 10px; display: flex; gap: 2px; padding: 3px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm); cursor: default; }\n.tm-tree-bar button { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text); cursor: pointer; font-size: 12px; }\n.tm-tree-bar button:hover:not(:disabled) { background: var(--bg-hover); }\n.tm-tree-bar button:disabled { opacity: .35; cursor: not-allowed; }\n.tm-tree-zoom { position: absolute; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 2px; padding: 3px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm); cursor: default; }\n.tm-tree-zoom button { display: inline-flex; align-items: center; gap: 4px; height: 26px; min-width: 26px; justify-content: center; padding: 0 6px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text); cursor: pointer; font-size: 12px; }\n.tm-tree-zoom button:hover:not(:disabled) { background: var(--bg-hover); }\n.tm-tree-zoom button:disabled { opacity: .35; cursor: not-allowed; }\n.tm-tree-zoom .tm-mono { font-size: 12px; min-width: 40px; text-align: center; color: var(--muted); }\n.tm-tree-fit { border-left: 1px solid var(--border) !important; border-radius: 0 var(--radius-sm) var(--radius-sm) 0 !important; padding-left: 8px !important; }\n.tm-rolecard { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-elevated); padding: 14px; overflow-y: auto; max-height: 460px; font-size: 13px; }\n.tm-rolecard-head { display: flex; align-items: center; gap: 10px; }\n.tm-rolecard-name { font-weight: 700; font-size: 15px; color: var(--text-strong); }\n.tm-rolecard-sec { margin-top: 14px; }\n.tm-rolecard-k { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }\n.tm-rolecard-list { margin: 0; padding-left: 18px; line-height: 1.55; }\n@media (max-width: 760px) {\n  .tm-tree-wrap { grid-template-columns: 1fr; }\n  .tm-tree-view { height: 360px; }\n  .tm-rolecard { max-height: none; }\n}\n\n/* ── narrow (phone) ── */\n.tm-narrow-switch { display: none; }\n@media (max-width: 760px) {\n  .tm-top { padding: 8px 12px; gap: 8px; }\n  .tm-title { font-size: 16px; }\n  .tm-title-sub, .tm-live-text { display: none; }\n  .tm-tabs { order: 3; width: 100%; }\n  .tm-body { display: flex; flex-direction: column; }\n  .tm-rail { border-right: 0; border-bottom: 1px solid var(--border); padding: 8px; display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; flex-shrink: 0; scrollbar-width: none; }\n  .tm-rail .tm-sec { display: none; }\n  .tm-rail .tm-ch { width: auto; flex-shrink: 0; border: 1px solid var(--border); padding: 4px 10px 4px 4px; }\n  .tm-rail .tm-ch-meta { display: none; }\n  .tm-ch-name { max-width: 150px; }\n  .tm-narrow-switch { display: flex; padding: 8px 12px 0; }\n  .tm-body[data-pane="chat"] .tm-side { display: none; }\n  .tm-body[data-pane="side"] .tm-center, .tm-body[data-pane="side"] .tm-rail { display: none; }\n  .tm-side { border-left: 0; flex: 1; }\n  .tm-center { flex: 1; }\n  .tm-scroll { padding: 10px 12px 6px; }\n  .tm-chhead { padding: 8px 12px; }\n  .tm-composer { padding: 8px 12px 12px; }\n  .tm-msg { max-width: 100%; }\n  .tm-page { padding: 12px; }\n  .tm-page-grid { grid-template-columns: 1fr; }\n  .tm-relay { grid-template-columns: 1fr; }\n  .tm-arrow { transform: rotate(90deg); height: 16px; }\n  .tm-drawer { width: 100%; }\n  .tm-hide-narrow { display: none; }\n}\n\n/* ── leads now (right rail, top) ── */\n.tm-now-count { font-size: 12px; font-weight: 500; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); background: var(--bg-elevated); white-space: nowrap; }\n.tm-now-count.is-on { border-color: color-mix(in srgb, var(--warn) 55%, transparent); background: var(--warn-subtle); color: var(--warn-text, var(--warn)); font-weight: 600; }\n.tm-now-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }\n.tm-now-item { --tone: var(--border-strong, var(--border)); border-radius: var(--radius-md); border: 1px solid var(--border); border-left: 3px solid var(--tone); background: var(--bg-elevated); overflow: hidden; }\n.tm-now-item.is-err { --tone: var(--danger); background: color-mix(in srgb, var(--danger) 6%, var(--bg-elevated)); }\n.tm-now-item.is-warn { --tone: var(--warn); }\n.tm-now-item.is-assign { --tone: var(--aim); }\n.tm-now-item.is-info { --tone: var(--info); }\n.tm-now-btn { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }\n.tm-now-btn:hover { background: var(--bg-hover); }\n.tm-now-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }\n.tm-now-btn.is-static { cursor: default; }\n.tm-now-btn.is-static:hover { background: transparent; }\n.tm-now-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }\n.tm-now-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }\n.tm-now-name { color: var(--text-strong); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.tm-now-project { align-self: flex-start; max-width: 100%; margin-top: -1px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--border); background: var(--card); color: var(--muted); font-size: 11px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.tm-now-tags { display: flex; gap: 4px; min-width: 0; flex-wrap: wrap; }\n.tm-now-project.is-legacy { border-style: dashed; color: var(--warn-text, var(--warn)); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }\n.tm-now-status { margin-left: auto; font-size: 12px; font-weight: 600; white-space: nowrap; color: var(--muted); }\n.tm-now-status.is-err { color: var(--danger-text, var(--danger)); }\n.tm-now-status.is-warn { color: var(--warn-text, var(--warn)); }\n.tm-now-status.is-assign { color: var(--aim); }\n.tm-now-status.is-info { color: var(--info-text, var(--info)); }\n.tm-now-age { font-weight: 400; color: var(--muted); }\n.tm-now-why { font-size: 12px; color: var(--text); overflow-wrap: anywhere; }\n.tm-now-go { color: var(--muted); flex: none; }\n.tm-now-foot { margin-top: 8px; font-size: 11px; }\n\n/* W-LC: limits, models, close group, remove impact */\n.tm-note { display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; margin: 0 0 8px; border-radius: var(--radius-sm); font-size: 12px; line-height: 1.45; border: 1px solid var(--border); }\n.tm-note svg { flex-shrink: 0; margin-top: 2px; }\n.tm-note.is-warn { background: var(--warn-subtle); border-color: color-mix(in srgb, var(--warn) 40%, transparent); color: var(--warn-text, var(--warn)); }\n.tm-note.is-info { background: color-mix(in srgb, var(--info) 10%, transparent); border-color: color-mix(in srgb, var(--info) 35%, transparent); color: var(--info-text, var(--info)); }\n.tm-limits-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); font-size: 12px; flex-wrap: wrap; }\n.tm-limit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }\n.tm-limit-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text); min-width: 0; }\n.tm-limit-field input, .tm-limit-field .tm-select { width: 100%; font-size: 13px; padding-top: 6px; padding-bottom: 6px; }\n.tm-impact { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }\n.tm-impact li { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--text); padding: 6px 8px; border-radius: var(--radius-sm); background: var(--bg-hover); }\n.tm-impact li svg { flex-shrink: 0; margin-top: 2px; color: var(--muted); }\n.tm-impact li.is-warn svg { color: var(--warn-text, var(--warn)); }\n.tm-chhead > .tm-chip, .tm-chhead > button { margin-left: auto; flex-shrink: 0; }\n@media (max-width: 760px) { .tm-limit-grid { grid-template-columns: 1fr; } }\n.tm-link { color: var(--aim); text-decoration: underline; text-underline-offset: 2px; }\n.tm-impact li svg.lucide-check { color: var(--ok-text, var(--ok)); }\n';
function isBot(row) {
  return !!row && typeof row.name === "string" && row.name !== "default" && row.source !== "builtin";
}
function botHandle(row) {
  const raw = String(row?.display_name || "").trim() || String(row?.name || "").trim();
  return raw.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
}
function workerRow(w) {
  return {
    key: String(w?.key || ""),
    title: String(w?.title || ""),
    status: String(w?.status || ""),
    // The host's side-panel group (done, working, with_conductor, ...): the tree's label.
    group: String(w?.group || ""),
    dispatched_by: String(w?.dispatched_by || "")
  };
}
function botRows(members, workspaces, workersBySlot) {
  const rows = Array.isArray(members?.members) ? members.members : Array.isArray(members) ? members : [];
  const wsList = Array.isArray(workspaces?.workspaces) ? workspaces.workspaces : [];
  const wsDefault = typeof workspaces?.default === "string" ? workspaces.default : "";
  const paths = new Map(wsList.map((w) => [w.name, w.path || null]));
  const byslot = workersBySlot || {};
  return rows.filter(isBot).map((m) => {
    const slot = typeof m.slot_key === "string" ? m.slot_key : "";
    const project = String(m.workspace || "") || wsDefault;
    const body = slot ? byslot[slot] : null;
    return {
      handle: botHandle(m),
      name: String(m.display_name || "").trim() || m.name,
      bot: m.name,
      slot_key: slot,
      session_label: slot ? `dashboard:${slot}` : "",
      project,
      project_path: paths.get(project) ?? null,
      description: String(m.description || ""),
      running: !!m.running,
      last_active_ts: typeof m.last_active_ts === "number" ? m.last_active_ts : null,
      workers: body && Array.isArray(body.workers) ? body.workers.map(workerRow) : null
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function leadForBot(bot, leads) {
  return [...leads?.values?.() || leads || []].find((l) => l.active !== false && (l.bot === bot.bot || bot.session_label && l.session_label === bot.session_label));
}
function leadKind(lead) {
  return lead?.kind === "bot" ? { kind: "bot", label: "Bot" } : { kind: "legacy", label: "Legacy lead" };
}
function addCheck(bot, leads) {
  if (!bot.slot_key) return { ok: false, why: "Open this Bot once on the Bots page first." };
  if (leadForBot(bot, leads)) return { ok: false, why: "Already in the team." };
  if (!bot.handle) return { ok: false, why: "This Bot has no usable name." };
  const clash = [...leads?.values?.() || leads || []].find((l) => l.active !== false && l.handle === bot.handle);
  if (clash) return { ok: false, why: `A lead named ${bot.handle} is already in the team.` };
  return { ok: true };
}
const ADD_ERRORS = {
  already_in_team: "This Bot is already in the team.",
  handle_taken: "Another lead in the team already has this name. Rename one of the Bots first.",
  not_a_bot: "That is not a Bot chat. Open the Bot once on the Bots page, then try again.",
  bad_bot: "That Bot name cannot be used here.",
  bad_handle: "This Bot has no usable name. Give it a display name on the Bots page.",
  bad_project: "This Bot's project name cannot be used here.",
  unknown_lead: "That lead is not in the team any more."
};
function addBotError(err) {
  const text = String(err?.body || err?.message || err || "");
  const m = text.match(/"reason"\s*:\s*"([a-z_]+)"/);
  const code = m ? m[1] : "";
  return ADD_ERRORS[code] || `Could not add the Bot${code ? ` (${code.replace(/_/g, " ")})` : ""}. Try again.`;
}
function addBody(bot) {
  return { bot: bot.bot, slot_key: bot.slot_key, display_name: bot.name === bot.bot ? "" : bot.name, project: bot.project };
}
function teamLeadIds(team, leads) {
  const list = [...leads?.values?.() || leads || []].filter((l) => l.active !== false && l.kind === "bot");
  return (team?.members || []).map((key) => list.find((l) => l.bot === key)?.lead_id).filter(Boolean);
}
function botGroups(state, leadId) {
  const groups = (state?.channels || []).filter((c) => c.kind === "group" && !c.closed);
  const has = (c) => !!leadId && (c.members || []).includes(leadId);
  return { in: groups.filter(has), open: groups.filter((c) => !has(c)) };
}
const GROUP_ERRORS = {
  group_size: "A group has 2 to 6 leads. This one is full.",
  group_closed: "That group is closed.",
  no_such_channel: "That group is gone.",
  not_a_lead: "This Bot is not in the team any more.",
  not_allowed: "Only the owner can change this group."
};
function groupError(err) {
  const text = String(err?.body || err?.message || err || "");
  const m = text.match(/"reason"\s*:\s*"([a-z_]+)"/);
  return m && GROUP_ERRORS[m[1]] || "Could not change the group. Try again.";
}
const CHAT_TOOLS = "/api/apps/team-mode/bot-grants";
function chatToolsSwitch(view, crew) {
  const declared = Array.isArray(view?.declaredScopes) ? view.declaredScopes : [];
  const scopes = Array.isArray(view?.scopes) ? view.scopes : [];
  const bots = Array.isArray(view?.bots) ? view.bots : [];
  return { show: declared.includes("tools"), approved: scopes.includes("tools"), on: !!crew && bots.includes(crew) };
}
function chatToolsBody(view, crew, on) {
  const others = (Array.isArray(view?.bots) ? view.bots : []).filter((b) => b !== crew);
  return { bots: on ? [...others, crew] : others };
}
async function removeFromTeam(api, leadId, crew) {
  await api.del(`/api/apps/team-mode/leads/${encodeURIComponent(leadId)}`);
  if (!crew) return;
  const view = await api.get(CHAT_TOOLS);
  if (chatToolsSwitch(view, crew).on) await api.put(CHAT_TOOLS, chatToolsBody(view, crew, false));
}
const CHAT_TOOLS_ERRORS = {
  app_not_installed: "Team Mode is not installed.",
  owner_only: "Only the owner can change this.",
  invalid_bot_grants: "Too many Bots are ticked for Team Mode.",
  bot_grants_not_saved: "Bot access was not saved. Try again."
};
function chatToolsError(err) {
  const text = String(err?.body || err?.message || err || "");
  const m = text.match(/"code"\s*:\s*"([a-z_]+)"/);
  return m && CHAT_TOOLS_ERRORS[m[1]] || "Could not change the switch. Try again.";
}
const OWNER = "owner";
const OWNER_NAME = "Owner";
function mergeState(prev, next) {
  if (!next || typeof next !== "object") return prev;
  if (!prev) return { ...next, entries: { ...next.entries || {} } };
  const entries = { ...prev.entries || {} };
  for (const [cid, rows] of Object.entries(next.entries || {})) {
    const bySeq = new Map((entries[cid] || []).map((r) => [r.seq, r]));
    for (const r of rows || []) bySeq.set(r.seq, r);
    entries[cid] = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
  return { ...prev, ...next, entries };
}
function actorId(by) {
  return typeof by === "string" && by.startsWith("lead:") ? by.slice(5) : by || "";
}
function leadIndex(state) {
  const map = /* @__PURE__ */ new Map();
  (state?.leads || []).forEach((l, i) => map.set(l.lead_id, { ...l, hue: i }));
  return map;
}
function activeLeadCount(leads, ids) {
  const list = ids ? ids.map((id) => leads.get(id)) : [...leads.values()];
  return list.filter((l) => l && l.active !== false).length;
}
function shortHandle(handle) {
  return String(handle || "").replace(/^tm-demo-/, "");
}
function channelName(ch, leads) {
  if (!ch) return "";
  if (ch.kind === "group") return ch.title || ch.id;
  const names = (ch.members || []).map((id) => shortHandle(leads.get(id)?.handle || id));
  if ((ch.people || []).includes(OWNER)) names.push(OWNER_NAME);
  return names.join(" · ");
}
function foldChannel(rows) {
  const messages = [];
  const bySeq = /* @__PURE__ */ new Map();
  const byMsgId = /* @__PURE__ */ new Map();
  const threads = /* @__PURE__ */ new Map();
  const assignments = /* @__PURE__ */ new Map();
  const relays = [];
  for (const row of rows || []) {
    const d = row.data || {};
    switch (row.type) {
      case "message/posted": {
        const m = { seq: row.seq, ts: row.ts, by: actorId(row.by), rawBy: row.by, ...d, held: false, assignments: [], redirected: [] };
        messages.push(m);
        bySeq.set(row.seq, m);
        byMsgId.set(d.msg_id, m);
        const th = d.thread_id && threads.get(d.thread_id);
        if (th) {
          th.count += 1;
          th.last_ts = row.ts;
          th.replies.push(m);
        }
        break;
      }
      case "thread/opened":
        threads.set(d.thread_id, { thread_id: d.thread_id, root_seq: d.root_seq, opener: d.opener, participants: [], count: 0, last_ts: row.ts, replies: [], mode: d.mode || "chat", meeting_id: d.meeting_id || null });
        break;
      case "thread/member_added": {
        const th = threads.get(d.thread_id);
        if (th && !th.participants.includes(d.who)) th.participants.push(d.who);
        break;
      }
      case "message/held": {
        const m = byMsgId.get(d.msg_id);
        if (m) {
          m.held = true;
          m.held_reason = d.reason;
        }
        break;
      }
      case "message/released": {
        const m = byMsgId.get(d.msg_id);
        if (m) {
          m.held = false;
          m.released = true;
        }
        break;
      }
      case "assignment/opened": {
        const a = { ...d, state: "open", opened_ts: row.ts };
        assignments.set(d.assignment_id, a);
        bySeq.get(d.msg_seq)?.assignments.push(a);
        break;
      }
      case "assignment/taken":
      case "assignment/declined":
      case "assignment/asked":
      case "assignment/closed":
      case "assignment/unanswered": {
        const a = assignments.get(d.assignment_id);
        if (a) {
          a.state = row.type.split("/")[1];
          a.reason = d.reason || "";
          a.empty = !!d.empty;
        }
        break;
      }
      case "relay/noted":
        relays.push({ seq: row.seq, ts: row.ts, by: actorId(row.by), ...d });
        break;
      case "reply/redirected": {
        const m = bySeq.get(d.reply_to);
        if (m && !m.redirected.some((x) => x.who === d.who)) m.redirected.push({ who: d.who, answers: d.answers_in_main });
        break;
      }
    }
  }
  const main = messages.filter((m) => !m.thread_id || m.also_main);
  return { messages, main, bySeq, threads, assignments, relays };
}
const MEETING_STATE = {
  convening: ["Convening", "is-info"],
  open: ["In session", "is-assign"],
  adjourning: ["Adjourning", "is-warn"],
  closed: ["Adjourned", "is-ok"],
  cancelled: ["Cancelled", ""]
};
const OUTCOME = {
  consensus: ["Consensus", "is-ok"],
  vote: ["Vote", "is-ok"],
  bar_raiser_ruling: ["Bar raiser ruling", "is-assign"],
  deferred: ["Deferred", "is-warn"],
  no_outcome: ["No outcome", "is-err"]
};
function readableIds(text, itemId, refs) {
  if (typeof text !== "string") return text;
  const where = (i) => itemId === `I${i}` ? "" : ` of item ${i}`;
  let out = text.replace(/\bI(\d+)-P(\d+)\b/g, (_, i, p) => `Proposal ${p}${where(i)}`).replace(/\b(?:([Bb])allot\s+)?I(\d+)-B(\d+)\b/g, (_, b, i, n) => `${b === "B" ? "Vote" : "vote"} ${n}${where(i)}`);
  if (refs) {
    out = out.replace(/\b(?:record\s+|owner(?:'s)?\s+(?:message\s+)?|message\s+)?seqs?\s+(\d+(?:(?:\s*,\s*|\s+and\s+|\s*&\s*)\d+)*)/gi, (_, list) => {
      const words = [...new Set(list.match(/\d+/g).map((n) => refs[n] || "an earlier entry"))];
      return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
    });
  }
  return out;
}
function meetingRows(rows, meetingId) {
  return (rows || []).filter((r) => {
    const d = r.data || {};
    return d.meeting_id === meetingId || d.meeting?.meeting_id === meetingId || d.minutes_of === meetingId;
  });
}
function openGrants(item) {
  const out = [];
  for (const rd of Object.values(item?.rounds || {})) for (const g of Object.values(rd.grants || {})) if (g.state === "open") out.push(g);
  return out;
}
function reasonKind(reason) {
  return String(reason || "").split(":")[0];
}
const REASON_LABEL = {
  owner: "message from Owner",
  mention: "@-mentioned",
  everyone: "@everyone",
  cc: "cc",
  dm: "direct message",
  assign: "new assignment",
  answer: "reply to its assignment",
  rewake: "assignment still open",
  pulled_in: "added to a thread",
  batch: "group batch ready",
  thread: "new thread reply",
  assignment_unanswered: "assignment unanswered",
  meeting_invite: "meeting invitation",
  meeting_turn: "meeting turn",
  meeting_chair: "chair check due",
  meeting_vote: "meeting vote"
};
function reasonLabel(reason) {
  const kind = reasonKind(reason);
  return REASON_LABEL[kind] || kind.replace(/_/g, " ");
}
function threadLabel(threadId, titles) {
  const t = titles && titles[String(threadId || "")];
  return t ? `thread: “${t}”` : "thread";
}
function threadForRoot(folded, seq) {
  for (const th of folded.threads.values()) if (th.root_seq === seq) return th;
  return null;
}
function allRelays(state) {
  const out = [];
  for (const [cid, rows] of Object.entries(state?.entries || {})) {
    for (const r of rows) if (r.type === "relay/noted") out.push({ channel_id: cid, seq: r.seq, ts: r.ts, by: actorId(r.by), ...r.data });
  }
  return out.sort((a, b) => b.ts - a.ts);
}
function ledgerRows(state) {
  if (Array.isArray(state?.ledger)) return state.ledger;
  const out = [];
  for (const [cid, rows] of Object.entries(state?.entries || {})) {
    for (const r of rows) out.push({ file: `channels/${cid}.jsonl`, ...r });
  }
  return out.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
}
function splitMentions(text, handles) {
  const parts = [];
  const re = /@([\w.-]+)/g;
  let last = 0;
  let m;
  while (m = re.exec(text || "")) {
    const name = m[1];
    if (name !== "everyone" && !handles.has(name)) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[0], mention: name });
    last = m.index + m[0].length;
  }
  if (last < (text || "").length) parts.push({ text: text.slice(last) });
  return parts;
}
function parseOwnerMentions(text, leads) {
  const byHandle = new Map([...leads.values()].map((l) => [l.handle, l.lead_id]));
  const mentions = [];
  let everyone = false;
  for (const m of (text || "").matchAll(/@([\w.-]+)/g)) {
    if (m[1] === "everyone") everyone = true;
    else if (byHandle.has(m[1]) && !mentions.includes(byHandle.get(m[1]))) mentions.push(byHandle.get(m[1]));
  }
  return { mentions, everyone };
}
function fmtClock(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1e3);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtTokens(n) {
  if (!n && n !== 0) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
const LIMIT_FIELDS = [
  { key: "total_wakes", label: "Deliveries in total" },
  { key: "total_tokens_est", label: "Tokens in total (estimate)" },
  { key: "hourly_wake", label: "Wakes per hour" },
  { key: "wakes_per_lead_hour", label: "Wakes per lead per hour" },
  { key: "hourly_message", label: "Messages per hour" },
  { key: "hourly_secretary", label: "Secretary runs per hour" },
  { key: "hourly_bar_raiser", label: "Bar raiser cases per hour" },
  { key: "owner_away_secs", label: "Pause batch wakes after you are away", unit: "min" }
];
const toShown = (f, v) => f.unit === "min" ? Math.round(v / 60) : v;
const fromShown = (f, v) => f.unit === "min" ? v * 60 : v;
function limitRows(budget) {
  const l = budget?.limits || {};
  const caps = l.caps || {};
  const hard = l.hard || {};
  const asked = l.asked || {};
  const clamped = new Set(l.clamped || []);
  return LIMIT_FIELDS.map((f) => ({
    ...f,
    applied: toShown(f, caps[f.key] ?? 0),
    hard: toShown(f, hard[f.key] ?? 0),
    asked: asked[f.key] === void 0 ? null : toShown(f, asked[f.key]),
    clamped: clamped.has(f.key)
  }));
}
function limitsBody(fields) {
  const out = {};
  for (const f of LIMIT_FIELDS) {
    const raw = String(fields?.[f.key] ?? "").trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) return { error: `${f.label}: enter a whole number of at least 1.` };
    out[f.key] = fromShown(f, Number(raw));
  }
  return { limits: out };
}
const LC_REFUSAL = {
  unknown_lead: "This lead is already removed.",
  open_items: "Clear the open items first.",
  group_closed: "This group is already closed.",
  bad_model_id: "A model id is lower-case letters, digits, dots and dashes, like claude-haiku-4.5.",
  bad_limit: "Enter a whole number of at least 1 (at least 1 minute for the away pause)."
};
function errText(err) {
  let parsed = null;
  try {
    parsed = JSON.parse(err?.body || "");
  } catch {
  }
  const reason = parsed?.reason;
  if (reason && LC_REFUSAL[reason]) return LC_REFUSAL[reason];
  return err?.message || String(err);
}
const ROLE_LABEL = { secretary: "Secretary", bar_raiser: "Bar raiser" };
const INTENT_LABEL = { easy: "Easy", default: "Default", smartest: "Smartest" };
function modelRows(models) {
  const routes = models?.routes || {};
  return Object.entries(models?.roles || {}).map(([role, intent]) => ({
    role,
    label: ROLE_LABEL[role] || role,
    intent,
    model: routes[intent] || "—"
  }));
}
function impactLines(imp, { bot = false } = {}) {
  if (!imp) return [];
  const out = [{ kind: "keep", text: "The Bot itself is kept: its chat, memory and history stay" }];
  if (bot) out.push({ kind: "info", text: "Its “Answer from its own chat” switch and its wake job are turned off" });
  for (const g of imp.groups || []) {
    out.push({
      kind: g.short ? "warn" : "info",
      text: g.short ? `#${g.title}: only ${g.left} active lead${g.left === 1 ? "" : "s"} left (a group needs 2)` : `#${g.title}: stops getting messages and wakes`
    });
  }
  if (imp.dms) out.push({ kind: "info", text: `${imp.dms} direct message${imp.dms === 1 ? "" : "s"} stop${imp.dms === 1 ? "s" : ""} reaching it` });
  for (const r of imp.requests || []) out.push({ kind: "warn", text: `${r.text} in #${r.group} is still ${r.state === "taken" ? "in progress" : "open"}` });
  for (const a of imp.actions || []) out.push({ kind: "warn", text: `Action item “${a.title}” in #${a.group} loses its owner (${a.state})` });
  for (const m of imp.meetings || []) out.push({ kind: "warn", text: `Meeting “${m.title}” in #${m.group} loses its ${m.role}` });
  for (const c of imp.cases || []) out.push({ kind: "warn", text: `A bar raiser case in ${c.group === "a direct message" ? c.group : `#${c.group}`} is ${c.state}` });
  const seen = /* @__PURE__ */ new Map();
  for (const l of out) {
    const s = seen.get(l.text);
    if (s) s.n += 1;
    else seen.set(l.text, { ...l, n: 1 });
  }
  return [...seen.values()].map(({ n, ...l }) => n > 1 ? { ...l, text: `${l.text} (${n} times)` } : l);
}
const CASE_ACTION = {
  continue: "Continue",
  narrow: "Narrow the question",
  close_thread: "Close this chain",
  veto: "Block it",
  hold: "Hold: cannot judge yet",
  suggest_meeting: "Suggest a meeting",
  call_person: "Hand to a person",
  rule: "Rule",
  defer: "Defer the item"
};
const PERSON_CLASS = {
  spend: "costs money",
  security: "security",
  irreversible: "cannot be undone",
  exhausted: "bar raiser out of budget",
  requested: "someone asked for a person"
};
const VOID = {
  new_attempt: "Replaced by a newer card on this chain. Answer that one.",
  expired: "This card expired.",
  changed: "This card changed. Reload and read it again.",
  already_used: "Already answered.",
  not_called: "No card to answer."
};
function caseStatus(c) {
  const cp = c.called_person;
  if (c.defaulted) return ["Default action", "is-warn"];
  if (!c.acted) return ["Reviewing", "is-info"];
  if (cp?.standing) return ["Within your standing approval", "is-ok"];
  if (c.answer) return [{ approve: "You approved", no: "You said no", change: "You answered" }[c.answer.decision] || "You answered", "is-ok"];
  if (c.lapsed) return ["No answer · counted as No", "is-warn"];
  if (cp && cp.card && cp.void) return [cp.void === "new_attempt" ? "Replaced" : "Closed", ""];
  if (cp) return ["Needs your answer", "is-err"];
  if (c.acted.action === "veto") return ["BLOCK", "is-err"];
  if (c.acted.action === "hold") return ["HOLD", "is-warn"];
  return ["Done", "is-ok"];
}
function cardAnswerBody(c, decision, { text = "", standing = false } = {}) {
  const card_hash = c?.called_person?.card_hash;
  if (decision === "skip") return { skip: true, card_hash };
  return {
    decision,
    card_hash,
    ...text.trim() ? { text: text.trim() } : {},
    ...standing && decision !== "change" ? { standing: { hours: 24 } } : {}
  };
}
function cardOpen(c) {
  const cp = c.called_person;
  return Boolean(cp && cp.card && !cp.standing && !c.answer && !c.lapsed && !cp.void);
}
function cardVoidText(c) {
  return VOID[c.called_person?.void] || "";
}
function fmtLeft(secs) {
  if (secs <= 0) return "expired";
  const h = Math.floor(secs / 3600);
  const m = Math.floor(secs % 3600 / 60);
  return h ? `in ${h}h ${m}m` : `in ${m}m`;
}
function cardRows(card, now) {
  if (!card) return [];
  const undo = { yes: "Yes", no: "No", partly: "Partly" }[card.reversible] || card.reversible;
  const tried = (card.tried || []).map((a) => CASE_ACTION[a] || a).join(", ") || "Nothing yet";
  return [
    ["What", card.what],
    ["Who", card.who],
    ["Cost", card.cost],
    ["Can undo", undo],
    ["Attempt", String(card.attempt)],
    ["Tried before", tried],
    ["Expires", `${fmtClock(card.expires)} (${fmtLeft(card.expires - now)})`],
    ["If you say no", CASE_ACTION[card.if_no] || card.if_no]
  ];
}
function evidenceParts(evidence) {
  const word = { record: "record", owner: "you", party_claim: "claim" };
  return (evidence || []).map((e) => ({ seq: e.seq, source: e.source, label: `${word[e.source] || "record"} #${e.seq}` }));
}
function assignmentsByLead(state) {
  const out = /* @__PURE__ */ new Map();
  for (const rows of Object.values(state?.entries || {})) {
    for (const a of foldChannel(rows).assignments.values()) {
      if (!out.has(a.to)) out.set(a.to, []);
      out.get(a.to).push(a);
    }
  }
  return out;
}
function nameOf(id, leads) {
  if (id === OWNER) return OWNER_NAME;
  const h = leads.get(id)?.handle;
  return h ? shortHandle(h) : "a teammate";
}
const LEAD_STATUS = {
  stopped: ["Stopped", "is-err"],
  waiting: ["Waiting on you", "is-warn"],
  no_answer: ["No answer", "is-err"],
  assigned: ["Assigned", "is-assign"],
  quiet: ["Nothing pending", ""]
};
function leadKindLabel(kind) {
  return leadKind({ kind }).label;
}
function cleanWorkers(list) {
  if (!Array.isArray(list)) return null;
  return list.filter((w) => w && (w.name || w.title)).map((w) => ({
    name: String(w.name || w.title),
    role: typeof w.role === "string" ? w.role : "",
    status: typeof w.status === "string" ? w.status : "",
    workers: cleanWorkers(w.workers) || []
  }));
}
function appLeadSource(state) {
  return (state?.leads || []).map((l, i) => ({ l, i })).filter(({ l }) => l.active !== false).map(({ l, i }) => {
    const label = String(l.session_label || "");
    return {
      key: l.lead_id,
      hue: i,
      name: shortHandle(l.display_name || l.handle),
      role: typeof l.duty === "string" ? l.duty : "",
      project: typeof l.project === "string" ? l.project : "",
      kind: leadKindLabel(l.kind),
      legacy: l.kind !== "bot",
      slotKey: label.startsWith("dashboard:") ? label.slice("dashboard:".length) : null,
      workers: cleanWorkers(l.workers)
    };
  });
}
function rosterLeadSource(rows) {
  const bots = (rows || []).filter((r) => r && r.bot);
  return (state) => appLeadSource(state).map((n) => {
    const lead = (state?.leads || []).find((l) => l.lead_id === n.key);
    if (!lead || lead.kind !== "bot") return n;
    const r = bots.find((b) => leadForBot(b, [lead]));
    if (!r) return n;
    return {
      ...n,
      name: shortHandle(r.name || r.handle) || n.name,
      project: typeof r.project === "string" ? r.project : n.project,
      role: r.description || n.role,
      workers: Array.isArray(r.workers) ? crewWorkersToTree(r.workers, r.slot_key) : null
    };
  });
}
const WORKER_GROUP_LABEL = {
  approval: "Needs approval",
  working: "Working",
  with_conductor: "Asking its Bot",
  waiting: "Waiting",
  done: "Done"
};
const WORKER_STATUS_LABEL = {
  needs_approval: "Needs approval",
  working: "Working",
  asking: "Asking its Bot",
  idle: "Waiting",
  closed: "Done",
  waiting: "Waiting",
  done: "Done"
};
function workerStateLabel(row) {
  return WORKER_GROUP_LABEL[row?.group] || WORKER_STATUS_LABEL[row?.status] || "";
}
function crewWorkersToTree(rows, rootKey) {
  const byParent = /* @__PURE__ */ new Map();
  for (const r of rows || []) {
    if (!r || !r.key) continue;
    const p = r.dispatched_by || rootKey;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(r);
  }
  const seen = /* @__PURE__ */ new Set([rootKey]);
  const build = (parent) => (byParent.get(parent) || []).filter((r) => !seen.has(r.key)).map((r) => {
    seen.add(r.key);
    return { name: r.title || "Untitled session", role: "", status: workerStateLabel(r), workers: build(r.key) };
  });
  return build(rootKey);
}
function hiddenWorkerCount(lead) {
  return Array.isArray(lead?.workers) && lead.workers.length ? countWorkers(lead.workers) : null;
}
function visibleTree(leads, expanded) {
  return (leads || []).map((l) => {
    const n = hiddenWorkerCount(l);
    const open = n !== null && expanded.has(l.key);
    return { ...l, open, hiddenCount: n !== null && !open ? n : 0, canToggle: n !== null, workers: open ? l.workers : null };
  });
}
function expandAllKeys(leads) {
  return new Set((leads || []).filter((l) => hiddenWorkerCount(l) !== null).map((l) => l.key));
}
const EXPANDED_STORE_KEY = "kirocrew.team-mode.tree-expanded";
function loadExpanded(storage) {
  try {
    const v = JSON.parse(storage?.getItem(EXPANDED_STORE_KEY) || "[]");
    return new Set(Array.isArray(v) ? v.filter((k) => typeof k === "string") : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function saveExpanded(storage, expanded) {
  try {
    storage?.setItem(EXPANDED_STORE_KEY, JSON.stringify([...expanded]));
  } catch {
  }
}
const BOTS_PAGE = "/members";
function countWorkers(list) {
  return (list || []).reduce((n, w) => n + 1 + countWorkers(w.workers), 0);
}
function teamTree(state, source = appLeadSource) {
  const leads = leadIndex(state);
  const active = source(state);
  const groups = (state?.channels || []).filter((c) => c.kind === "group");
  const byLead = assignmentsByLead(state);
  const openCalls = (state?.cases || []).filter((c) => c.called_person && !c.answer);
  const briefs = state?.briefs || [];
  return {
    owner: { name: OWNER_NAME, leadCount: active.length, groupCount: groups.length },
    leads: active.map((n) => {
      const mine = groups.filter((g) => (g.members || []).includes(n.key));
      const mineIds = new Set(mine.map((g) => g.id));
      const as = byLead.get(n.key) || [];
      const waits = [];
      for (const c of openCalls) {
        if (!mineIds.has(c.channel_id)) continue;
        const g = mine.find((x) => x.id === c.channel_id);
        waits.push({ text: c.called_person.question ? fold1(c.called_person.question, leads) : "The bar raiser called you.", where: `#${g.title || "group"}`, who: OWNER_NAME });
      }
      for (const a of as.filter((x) => x.state === "asked")) {
        waits.push({ text: `Asked ${nameOf(a.from, leads)} a question about an assignment.`, where: a.thread_id ? "thread" : "main", who: nameOf(a.from, leads) });
      }
      const count = (s) => as.filter((x) => x.state === s).length;
      const status = state?.stopped ? "stopped" : waits.some((w) => w.who === OWNER_NAME) ? "waiting" : count("unanswered") ? "no_answer" : count("open") ? "assigned" : "quiet";
      const myBriefs = briefs.filter((b) => b.lead_id === n.key);
      return {
        ...n,
        groups: mine.map((g) => g.title || "Untitled group"),
        status,
        statusLabel: LEAD_STATUS[status][0],
        statusTone: LEAD_STATUS[status][1],
        waits,
        assignments: { open: count("open"), taken: count("taken"), asked: count("asked"), unanswered: count("unanswered") },
        routines: {
          // The app sees secretary briefs it wrote; it cannot list the lead's cron jobs.
          briefs: myBriefs.length,
          lastBriefTs: myBriefs.length ? myBriefs[myBriefs.length - 1].ts : null,
          cronJobs: null
        }
      };
    })
  };
}
function fold1(text, leads) {
  let t = String(text || "");
  for (const l of leads.values()) t = t.split(l.lead_id).join(shortHandle(l.handle));
  return t;
}
function roleCardFields(lead) {
  const r = lead.routines;
  return {
    Name: lead.name,
    Project: lead.project || "No project on record.",
    Owns: lead.role || "No role written yet.",
    Workers: lead.workers === null || lead.workers === void 0 ? ["Team Mode cannot see this lead’s workers yet."] : lead.workers.length ? flatWorkers(lead.workers).map(({ w, depth }) => `${"· ".repeat(depth)}${w.name}${w.role ? ` — ${w.role}` : ""}`) : ["No workers."],
    Status: lead.statusLabel,
    "Waiting on a person": lead.waits.length ? lead.waits.map((w) => `${w.who}: ${w.text} (${w.where})`) : ["Nothing is waiting on a person."],
    Assignments: `${lead.assignments.open} new · ${lead.assignments.taken} taken · ${lead.assignments.asked} asked back · ${lead.assignments.unanswered} unanswered`,
    Routines: [
      r.briefs ? `Secretary brief · ${r.briefs} so far · last ${fmtClock(r.lastBriefTs)}` : "Secretary brief · none yet",
      "Scheduled jobs · Team Mode cannot see them"
    ],
    Groups: lead.groups.length ? lead.groups.map((g) => `#${g}`) : ["Not in a group yet."]
  };
}
function flatWorkers(list, depth = 0, out = []) {
  for (const w of list || []) {
    out.push({ w, depth });
    flatWorkers(w.workers, depth + 1, out);
  }
  return out;
}
const TREE = { ownerW: 168, ownerH: 72, leadW: 260, leadH: 124, workerW: 200, workerH: 56, gapX: 120, workerGapX: 64, gapY: 22, pad: 32 };
function layoutTree(leads, g = TREE) {
  const list = typeof leads === "number" ? Array.from({ length: leads }, () => ({ workers: null })) : leads || [];
  const kids = (n) => n.workers || [];
  const stackH = (c) => c.reduce((s, w) => s + span(w, g.workerH), 0) + Math.max(0, c.length - 1) * g.gapY;
  const span = (n, h) => Math.max(h, stackH(kids(n)));
  const spans = list.map((l) => span(l, g.leadH));
  const colH = spans.reduce((s, x) => s + x, 0) + Math.max(0, list.length - 1) * g.gapY;
  const height = Math.max(colH, g.ownerH) + 2 * g.pad;
  const owner = { x: g.pad, y: (height - g.ownerH) / 2, w: g.ownerW, h: g.ownerH };
  const lx = g.pad + g.ownerW + g.gapX;
  const boxes = [];
  const workers = [];
  const edges = [];
  let right = list.length ? lx + g.leadW : lx;
  const curve = (a, b, lead) => {
    const sx = a.x + a.w;
    const sy = a.y + a.h / 2;
    const ty = b.y + b.h / 2;
    const mx = (sx + b.x) / 2;
    edges.push({ d: `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${b.x},${ty}`, lead });
  };
  const place = (parent, children, x, top, lead) => {
    let y2 = top;
    for (const w of children) {
      const s = span(w, g.workerH);
      const box = { x, y: y2 + (s - g.workerH) / 2, w: g.workerW, h: g.workerH, lead, name: w.name, role: w.role || "", status: w.status || "" };
      workers.push(box);
      curve(parent, box, lead);
      right = Math.max(right, x + g.workerW);
      place(box, kids(w), x + g.workerW + g.workerGapX, y2 + (s - stackH(kids(w))) / 2, lead);
      y2 += s + g.gapY;
    }
  };
  let y = (height - colH) / 2;
  list.forEach((l, i) => {
    const s = spans[i];
    const box = { x: lx, y: y + (s - g.leadH) / 2, w: g.leadW, h: g.leadH };
    boxes.push(box);
    curve(owner, box, i);
    place(box, kids(l), lx + g.leadW + g.workerGapX, y + (s - stackH(kids(l))) / 2, i);
    y += s + g.gapY;
  });
  return { width: right + g.pad, height, owner, leads: boxes, workers, edges };
}
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}
function fitZoom(view, content) {
  if (!view?.width || !view?.height || !content?.width || !content?.height) return 1;
  return clampZoom(Math.floor(Math.min(1, view.width / content.width, view.height / content.height) * 100) / 100);
}
const REFRESH_MS = 1e4;
async function loadBots(api, { withWorkers = false } = {}) {
  const [members, workspaces, teams] = await Promise.all([
    api.get("/api/members"),
    api.get("/api/workspaces").catch(() => null),
    api.get("/api/teams").catch(() => null)
  ]);
  let workers = {};
  if (withWorkers) {
    const slots = (members?.members || []).map((m) => m.slot_key).filter(Boolean);
    const bodies = await Promise.all(slots.map((s) => api.get(`/api/chat/slots/${encodeURIComponent(s)}/crew-workers`).catch(() => null)));
    workers = Object.fromEntries(slots.map((s, i) => [s, bodies[i]]));
  }
  return { bots: botRows(members, workspaces, workers), teams: teams?.teams || [] };
}
function useBots(api, opts = {}) {
  const [data, setData] = useState({ bots: null, teams: [] });
  const [error, setError] = useState(null);
  const withWorkers = !!opts.withWorkers;
  const reload = useCallback(async () => {
    try {
      setData(await loadBots(api, { withWorkers }));
      setError(null);
    } catch (e) {
      setError(e?.message || String(e));
    }
  }, [api, withWorkers]);
  useEffect(() => {
    reload();
    const id = setInterval(() => {
      if (!document.hidden) reload();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [reload]);
  return { ...data, error, loading: data.bots === null && !error, reload };
}
export {
  countWorkers as $,
  teamTree as A,
  rosterLeadSource as B,
  loadExpanded as C,
  visibleTree as D,
  expandAllKeys as E,
  layoutTree as F,
  fitZoom as G,
  BOTS_PAGE as H,
  INTENT_LABEL as I,
  ZOOM_MAX as J,
  addCheck as K,
  threadForRoot as L,
  MEETING_STATE as M,
  OUTCOME as N,
  OWNER as O,
  readableIds as P,
  caseStatus as Q,
  CASE_ACTION as R,
  PERSON_CLASS as S,
  evidenceParts as T,
  limitsBody as U,
  cardOpen as V,
  cardRows as W,
  cardVoidText as X,
  saveExpanded as Y,
  ZOOM_MIN as Z,
  roleCardFields as _,
  actorId as a,
  addBody as a0,
  addBotError as a1,
  splitMentions as a2,
  openGrants as a3,
  cardAnswerBody as a4,
  clampZoom as a5,
  botGroups as a6,
  groupError as a7,
  CHAT_TOOLS as a8,
  chatToolsSwitch as a9,
  chatToolsBody as aa,
  chatToolsError as ab,
  leadKind as b,
  leadIndex as c,
  css as d,
  activeLeadCount as e,
  fmtClock as f,
  foldChannel as g,
  allRelays as h,
  ledgerRows as i,
  channelName as j,
  meetingRows as k,
  leadForBot as l,
  mergeState as m,
  OWNER_NAME as n,
  threadLabel as o,
  parseOwnerMentions as p,
  limitRows as q,
  reasonLabel as r,
  shortHandle as s,
  teamLeadIds as t,
  useBots as u,
  fmtTokens as v,
  modelRows as w,
  errText as x,
  impactLines as y,
  removeFromTeam as z
};
