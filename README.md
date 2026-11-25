# Team Mode (demo app)

A demo of Swarm Team Mode built only on the Kiro Crew app platform. It changes no
core code. Disable the app and every page, tool, route and wake it added is gone;
its data stays in its own data directory until you uninstall with `--purge-data`.

## Why it is a standalone app directory, not a builtin

A builtin lives under `src/kiro_crew/apps/builtins/` and is loaded from the
installed `kiro_crew` package, so trying one means running this branch's gateway.
A directory installed with `kirocrew app install <path>` is copied into
`<data home>/apps/team-mode/` and goes live on the gateway that is already running
(`kirocrew app enable` applies live over the owner socket; hook routes register on
enable without a restart). That is the only way to demo it on the live gateway
without switching it to branch code.

## Layout

| Path | Runs in | Job |
|---|---|---|
| `app.json` | gateway | Manifest. `defaultEnabled: false` |
| `teamapp/hooks.py` | gateway process | HTTP routes under `/api/apps/team-mode/`, wake loop, secretary and bar raiser runs |
| `teamapp/*.py` | gateway and MCP server | Ledger, folds, limits (shared code) |
| `agents/lead.json` | kiro-cli | The demo lead agent. The `team` MCP server is declared here, not at manifest top level, so only sessions running this agent get the tools; the owner's other sessions never see them |
| `mcp/server.py` | one stdio process per lead session | The tools leads call |
| `ui/index.mjs` | browser | The Team Mode page (`export default` React component) |

## Install (live gateway, no restart)

```bash
kirocrew app install <path-to-this-checkout>
# trust it once: App Store -> Team Mode -> Enable, confirm the third-party dialog
kirocrew app enable team-mode
kirocrew app disable team-mode     # off switch; data kept
```

After editing the source, `kirocrew app update team-mode` re-copies it and restarts
the app's hooks, keeping data.

## Team tools in a Bot's own chat

`contributes.botChatServers` offers the `team` server of the `lead` agent to the
chats of the owner's Bots, and `permissions.bots` declares the `tools` scope that
mounts it. The server joins a Bot's own chat only when all of these hold:

1. the gateway has the `bot_chat_app_tools` feature preview on;
2. Team Mode is enabled;
3. the owner approved the `tools` Bot scope on the app's detail page;
4. the owner ticked the Bot under "Bots this app can reach".

A Bot lead is woken through the host's Bot API: `permissions.bots` also declares
`read` (to find the Bot's id in `GET /api/members`) and `wake`
(`POST /api/members/{id}/wake` with `{"ref": ...}`). Each `wake/due` the wake loop
writes for a Bot lead is followed by one wake call, and its result is recorded in the
lead's member file as `wake/sent` or `wake/refused` (with the host's reason, also
logged as a warning). The owner approves `read` and `wake` with `tools` on the
detail page; an unticked Bot is refused `bot_not_ticked`.

The "Answer from its own chat" switch on a Bot's Team Mode tab ticks or unticks
that one Bot in the same list (`/api/apps/team-mode/bot-grants`). Unticking takes
the tools off at the start of the chat's next turn. A Bot pinned to the Kiro CLI
harness gets no app servers; pin it to Kiro Agent, Claude Code or Codex.

## Tests

```bash
python3 -m pytest tests/<file>.py      # backend, one file at a time
cd ui-src && npm ci && npm test        # UI model tests (node --test)
cd ui-src && npm run build             # rebuilds ui/index.mjs and ui/panel.mjs
```
