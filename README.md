# Lakshya

A portal where a team of coding agents builds software together. Each teammate is a persona (Product Manager, Project Manager, Software Engineer, Frontend Engineer, QA Engineer, Test Engineer, or your own) running as its own live **Claude Code**, **Codex** or **OpenCode** session in a real PTY. The agents talk to each other over **A2A** (the Agent2Agent protocol).

```sh
bun install
bun dev            # http://127.0.0.1:4777
```

![An agent's live terminal: the Software Engineer has finished an A2A task and summarised it](docs/screenshots/terminal.png)

| | |
| --- | --- |
| ![Approval prompt flagged as Needs you, with Accept and Decline](docs/screenshots/needs-you.png) | ![Tasks flyout showing a task's A2A thread and result](docs/screenshots/tasks.png) |
| **Needs you.** When an agent stops at an approval prompt, it turns red in the sidebar and an Accept / Decline banner appears. | **Tasks.** Every A2A task, with the full message thread and the result artifact. |
| ![All sessions grid with four agents](docs/screenshots/all-sessions.png) | ![Persona editor](docs/screenshots/personas.png) |
| **All sessions.** Every running agent at once, each redrawn to fit its tile. | **Personas.** Role, rules, runtime, model, permissions and who each one may talk to. |

<p align="center"><img src="docs/screenshots/mobile.png" alt="Lakshya on a phone" width="300"></p>

Type a request in the bar at the bottom. The Product Manager picks it up, writes a brief and hands it to the Project Manager. The Project Manager splits the work, starts engineer and QA sessions, and tracks each task to done. Every agent appears in the sidebar as a terminal you can watch and type into. Tasks and their full A2A history are in the **Tasks** flyout.

## Run with Docker Compose

```sh
cp .env.example .env         # set LAKSHYA_PASSWORD (required) and any agent credentials
docker compose up -d --build # http://localhost:8080, log in with LAKSHYA_USER / LAKSHYA_PASSWORD
```

Locally, `compose.override.yaml` (loaded automatically) publishes Caddy on `127.0.0.1:8080`.

Two containers:

- **`lakshya`**: the portal, plus Claude Code, Codex and OpenCode.
  - Runs as a non-root user. Claude Code refuses YOLO mode as root.
  - Its port is not published. Only Caddy can reach it.
- **`caddy`**: basic auth in front of everything, including the API, the terminal and event WebSockets, and the A2A endpoints.
  - You put a plain password in `.env`; Caddy hashes it at startup.
  - `docker compose up` refuses to start without one.

Agents inside the container reach the portal directly on 127.0.0.1 with their own session tokens, so they never go through auth.

| Volume | Holds |
| --- | --- |
| `lakshya-data` | The database and per-session files. |
| `lakshya-home` | CLI logins and settings (`~/.claude`, `~/.codex`, OpenCode). |
| `./workspace` → `/workspace` | The code the agents write. Change it with `LAKSHYA_WORKSPACE`. |

**Agent logins.** Set these in `.env`, or log in once inside the container; logins persist in `lakshya-home`.

| Agent | In `.env` | Or log in inside the container |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (for a subscription, create one with `claude setup-token` on any machine) | `docker compose exec -it lakshya claude`, then `/login` |
| Codex | `OPENAI_API_KEY` | `docker compose exec -it lakshya codex login --device-auth` (ChatGPT plan) |
| OpenCode | provider keys | `docker compose exec -it lakshya opencode auth login`; its free models work with no login |

An agent without credentials shows up as **Needs you** ("Not logged in").

**On first start**, the entrypoint:

- skips Claude Code's first-run onboarding;
- marks `/workspace` as trusted for Claude Code and Codex, so agents don't stop at a "trust this folder?" menu (set `AOS_TRUST_WORKSPACE=0` to answer those yourself);
- sets a git identity so agents can commit.

**HTTPS.** Basic auth over plain HTTP sends the password in the clear, so use HTTPS for anything beyond localhost:

1. Point a domain at the host.
2. In `.env`, set `LAKSHYA_SITE=your.domain` and `LAKSHYA_PUBLIC_URL=https://your.domain`.
3. Run `docker compose -f compose.yaml -f docker/compose.https.yaml up -d`. Caddy gets a certificate automatically.

**Build options.**

- Pin the CLI versions: `docker compose build --build-arg CLAUDE_CODE_VERSION=2.1.282 --build-arg CODEX_VERSION=0.157.0 --build-arg OPENCODE_VERSION=1.18.32`.
- Leave a CLI out with `none`.

Redeploying restarts the container, which ends every running agent session. Tasks and history stay.

## Deploy on Dokploy

Dokploy deploys the Compose file straight from this repo. Its Traefik handles your domain and HTTPS, and our Caddy still does basic auth behind it.

1. **Create → Compose**. Set the provider to this Git repo, branch `main`, and the compose path to `./compose.yaml`.
2. **Environment**. At minimum:
   ```
   LAKSHYA_PASSWORD=<a long random password>
   LAKSHYA_PUBLIC_URL=https://lakshya.example.com
   LAKSHYA_WORKSPACE=../files/workspace
   ```
   Add agent credentials too (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and `OPENAI_API_KEY`).
   - `LAKSHYA_WORKSPACE` matters. Dokploy re-clones the repo on every deploy, and `../files` is the folder it keeps. Leave the default `./workspace` and the agents' code is wiped at each redeploy.
3. **Domains → Add domain**:
   - Service: `caddy`
   - Container port: `8080`
   - HTTPS on, with a Let's Encrypt certificate
   - Leave `LAKSHYA_SITE` at its default `:8080`: Traefik terminates TLS, and Caddy only checks the password.
4. **Deploy.** Open the domain and log in with `LAKSHYA_USER` (default `admin`) and your password.

Notes:
- **Nothing is published on the host.** Dokploy runs `compose.yaml` alone, so the `compose.override.yaml` port mapping isn't loaded. Traefik reaches Caddy over Dokploy's network.
- **The first deploy builds both images on the server.** Expect a few minutes; the Lakshya image is about 2.3 GB, mostly the agent CLIs.
- **Logins made inside the container** (`claude` `/login`, `codex login --device-auth`) are kept in the `lakshya-home` volume, so they survive redeploys. Run them from Dokploy's terminal for the `lakshya` container.
- **Backups.** Dokploy's volume backups work on `lakshya-data` (tasks, personas, history) and `lakshya-home`.
- **Redeploys end running agent sessions.** Deploy between tasks.

## How it works

```
 browser ──ws──► Bun.serve ──Bun.spawn({ terminal })──► claude / codex / opencode   (one PTY per agent)
                    │                                        │
                    │◄──── A2A JSON-RPC (message/send …) ─────┤  a2a MCP server (stdio, one per agent)
                    │                                        │
                    └── types "[A2A] New task … call check_inbox" into the agent's prompt when it is idle
```

- **Sessions** (`src/server/sessions.ts`). Each agent is a CLI started with `Bun.spawn({ terminal })` (Bun's built-in PTY). A headless xterm mirrors every screen. That lets the server tell whether an agent is *idle*, *working* or *needs you* (an approval prompt is on screen). It also lets a browser that connects late replay the screen.
- **A2A** (`src/server/a2a.ts`, `src/server/index.ts`). The portal is an A2A server that hosts every agent:
  - `GET /.well-known/agent-card.json` is the entry persona's card. `GET /a2a/:agent/.well-known/agent-card.json` returns the card for any persona or session.
  - `POST /a2a/:agent` is JSON-RPC 2.0: `message/send`, `message/stream` (SSE), `tasks/get`, `tasks/cancel`.
  - Tasks move through `submitted → working → input-required → completed | failed | canceled | rejected`, with history and artifacts.
  - Outside A2A clients can call it too. Agents identify themselves with a per-session bearer token.
- **MCP bridge** (`src/mcp/a2a-mcp.ts`). This is how a CLI agent speaks A2A. Tools: `list_agents`, `send_message`, `check_inbox`, `update_task`, `get_task`, `wait_for_task`, `cancel_task`, `list_tasks`, plus `spawn_agent` / `stop_agent` for personas allowed to spawn.
- **Delivery**. When a message arrives, the server queues a one-line `[A2A] …` notice and types it into the agent's prompt once the screen has been quiet for 1.5s. Nothing is typed while an approval prompt is showing.
- **Autopilot loop** (`src/server/supervisor.ts`). The server re-prompts agents that sit idle while they still owe a task, and re-delivers lost notices. After 3 reminders it tells the requester the task has stalled. Personas are also told to loop (build, check against the definition of done, send it back) until the work is done. Turn it off in Settings.
- **Auto-spawn**. Messaging a persona with no running session starts one. Personas with *Can start sessions* can also run extra instances in parallel.

## Personas

Open **Settings → Edit personas**. For each persona you can set:

- Name, sidebar code and color
- Runtime (Claude Code, Codex or OpenCode) and model
- Permission mode
- Instructions and rules, which are appended to the agent's system prompt
- Who it may open tasks with (enforced by the server)
- Whether it takes requests from the request bar, orchestrates, or can spawn sessions

## Approvals and YOLO

Personas default to *edit files freely, ask before commands*. Approval prompts show up as a red **Needs you** mark, with Accept and Decline buttons above the terminal.

**Settings → YOLO for new agents** skips every prompt for agents started from then on:

- Claude Code: `--dangerously-skip-permissions`
- Codex: `--dangerously-bypass-approvals-and-sandbox`
- OpenCode: `--auto`

You can also set YOLO per persona.

### Codex

- The default workspace sits inside this repo. Codex only runs in folders it trusts, and it ignores trust passed with `-c`.
- The first time Codex opens an untrusted folder, it shows a trust menu. The portal marks that session **Needs you** and types nothing until you answer.
- Permission modes map to Codex flags:
  - Ask: no flags
  - Edit files freely: `--sandbox workspace-write --ask-for-approval on-request` (Codex removed `--full-auto`)
  - YOLO: `--dangerously-bypass-approvals-and-sandbox`

## Configuration

| Env | Default | |
| --- | --- | --- |
| `AOS_PORT` / `AOS_HOST` | `4777` / `127.0.0.1` | Where the portal listens. It has no login of its own: keep it on localhost, or put it behind the Compose setup's Caddy. |
| `AOS_PUBLIC_URL` | `http://127.0.0.1:4777` | The address outside A2A clients use, advertised in the agent cards. |
| `AOS_WORKSPACE` | `./workspace` | Folder the agents work in (also editable in Settings). |
| `AOS_DATA_DIR` | `./data` | SQLite database and per-session files (role prompt, MCP config, command). |
| `AOS_CLAUDE_BIN`, `AOS_CODEX_BIN`, `AOS_OPENCODE_BIN` | found on `PATH` | CLI locations. |
| `AOS_CLAUDE_ARGS`, `AOS_CODEX_ARGS`, `AOS_OPENCODE_ARGS` | | Extra flags for every session of that runtime. |

The product name is set in one place: `src/shared/brand.ts`.

## Development

```sh
bun test                          # A2A, delivery, permissions, streaming, autopilot, Codex (fake agents, no LLM calls)
AOS_LIVE_CODEX=1 bun test         # also runs a real Codex agent in YOLO mode (needs `codex login`)
bun run typecheck
bun scripts/peek.ts <session-id>  # print an agent's current screen as text
bun scripts/type.ts <session-id> '\r'
```

The UI is React with shadcn/ui on Tailwind v4, bundled by Bun's HTML imports (`bunfig.toml` loads `bun-plugin-tailwind`). Add components with `bunx --bun shadcn@latest add <name>`.
