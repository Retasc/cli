# retasc

**Retasc is a work queue for AI coding agents. Two agents can never hold the same issue.**

Over [MCP](https://modelcontextprotocol.io), a heterogeneous fleet of agents atomically
claims unblocked, prioritized tasks and runs in parallel — server-enforced, no collisions.
Issues live in a persistent, multi-tenant store; agents reach them through one MCP endpoint.
The `retasc` CLI signs you in, creates projects, mints agent API keys, and wires the MCP
server into your agent in a single command.

→ [retasc.com](https://retasc.com) · [Set up your agent](https://retasc.com/wire) · [Quickstart](https://docs.retasc.com/quickstart) · [Changelog](https://docs.retasc.com/changelog)

## Install

```sh
npm i -g @retasc/cli
```

This installs the `retasc` command. Requires Node.js ≥ 18.

Already installed? `retasc --version` tells you what you have, and
[the changelog](https://docs.retasc.com/changelog) says what changed since. Every published
version is listed there with a date.

## Quickstart

```sh
# 1. Sign in with GitHub (device flow) — once per machine
retasc login

# 2. Bind THIS folder to one org + project (pick or create), and wire the watchdog
cd ~/acme
retasc bind

# 3. Your agent (e.g. Claude Code) can now pull work over MCP — scoped to this folder
```

`retasc bind` is the per-workspace binder: it picks (or creates) an org + project, mints an
agent API key for that pair, and wires the Retasc MCP server into **this folder only**. The key
is stored in your home keystore (`~/.retasc/bindings.json`); the folder's `.mcp.json` is a
**secret-free marker** (safe to commit). Each workspace is bound to exactly one org/project, so
an agent can never file issues into the wrong one — the server enforces it by the key. From then
on your agent calls `next_issue` / `next_batch` to atomically claim the top unblocked,
prioritized work, and several agents run at once without ever claiming the same issue — see
[Running Claude Code agents in parallel](https://retasc.com/guides/claude-code-parallel-agents)
for that workflow end to end.

Run `retasc whoami` (shows this folder's binding) or `retasc doctor` (checks it) any time.

## What the agent gets over MCP

- **Atomic claim + lease/TTL + fencing** — concurrency control on work items, so no two agents
  take the same issue. A claim is a lease; `heartbeat` keeps it alive, `checkpoint` records
  progress, and a reclaimer frees stalled leases so the next agent resumes from the checkpoint.
- **Dependency-graph-driven dispatch** — `next_issue`, `next_batch`, and effective priority. A
  blocker inherits the urgency of everything it gates, so agents just take what the queue hands
  them.
- **A persistent, multi-tenant, identity-bearing store** of human-legible work.

The CLI speaks the same lease: `retasc claim`, `retasc checkpoint`, `retasc check-claim`,
`retasc release` and `retasc done` are the human forms of the tools an agent calls, over
this folder's own key. A person and an agent working the same queue see the same rows.

## Common commands

| Command | What it does |
|---------|--------------|
| `retasc login` / `retasc logout` | Sign in / out (GitHub device flow) |
| `retasc bind` | Bind THIS folder to one org + project, wire the watchdog (the per-workspace setup) |
| `retasc whoami` | Show this folder's org/project binding, plus your orgs |
| `retasc doctor` | Check this folder is correctly + safely bound |
| `retasc init …` | Create org + project, mint a key, wire the MCP — one shot (non-interactive) |
| `retasc org create` / `retasc project create` | Create orgs / projects |
| `retasc key mint \| list \| rotate \| revoke` | Manage agent API keys |
| `retasc mcp install` | Register the Retasc MCP server with your agent |
| `retasc gate install` | Install a commit↔issue traceability gate in a repo |
| `retasc config` | Show the resolved CLI config (paths + endpoints) |

Working an issue from the terminal:

| Command | What it does |
|---------|--------------|
| `retasc claim [issue]` / `retasc next` | Claim an issue (or the next unblocked one) and drop into a fresh worktree |
| `retasc issue show [issue]` | Show one issue in full (defaults to the current `rtsc-NN/` branch's issue) |
| `retasc issue list` | List issues, filtered by status, priority, label, author, assignee or SLA state |
| `retasc checkpoint [issue]` | Record a handoff note on your claimed issue, and renew its lease |
| `retasc check-claim [issue]` | Does this session still hold the lease, and is anything renewing it? |
| `retasc release <issue>` | Hand a claim back to the queue. Leaves your worktree and branch alone |
| `retasc done` | Close the issue and tear down its worktree + branch (asks first; `--dry-run` previews) |
| `retasc tidy` | Reconcile `rtsc-NN/*` branches against issue status; reap the done + merged ones |

Run `retasc --help` or `retasc <command> --help` for the full set.

## What the CLI deliberately does not do

The MCP server exposes 49 tools. The CLI has commands for 27 of them, and the gap is a decision
rather than a backlog (RTSC-709). The CLI's job is to sign you in, set up a workspace, and
let a **human** take, track and close a piece of work at a terminal. Everything else is for
the **agent** (over MCP, where it already is) or the **Dash** (where a person can see it).

So these have no CLI command, on purpose:

| Area | Tools | Why not here |
|------|-------|--------------|
| Comments | `save_comment`, `list_comments`, `retract_comment` | A thread is something you read, not something you page through a terminal. Agents comment over MCP; people comment in the Dash |
| Attachments | `save_attachment`, `list_attachments`, `get_attachment`, `get_attachment_file`, `save_attachment_file`, `prepare_attachment_upload`, `obsolete_attachment` | Binary in, binary out. The Dash previews them; a terminal can only tell you they exist. `retasc proxy` already serves these for your agent, which is who attaches things |
| Dependency graph | `add_relation`, `remove_relation` | Editing the graph is planning work, and planning wants the whole graph in front of you |
| Labels | `save_label`, `list_labels` | Org-wide taxonomy, set once in the Dash |
| Wave dispatch | `next_batch` | It claims N issues at once for a fleet. One human at one terminal takes one issue: that is `retasc claim` |
| Queue diagnosis | `queue_status` | The Dash queue view is this, with the graph drawn |
| Member state | `suspend_member`, `reactivate_member` | Owner administration, next to the rest of it in the Dash |
| Projects | `get_project`, `list_projects` | A workspace is bound to exactly one project (`retasc whoami` says which). Listing the others is a Dash question |
| Connectors | `list_connectors`, `revoke_connector` | OAuth-shaped setup, done where the OAuth happens |

Two more are reachable but not as their own command, which is also deliberate:

- **`heartbeat`** — `retasc checkpoint` renews the lease and leaves the note that makes a
  handoff resumable. A bare renewal with nothing to say is the watchdog's job, and
  `retasc bind` wires that up for you.
- **`get_issue`** — it is what `retasc issue show` and `retasc tidy` call.

If you want any of the above from a terminal anyway, say so in an issue: the point of this
list is that their absence is a choice we wrote down, not one nobody has noticed.

## Troubleshooting

### `fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)` or `(SELF_SIGNED_CERT_IN_CHAIN)`

Node cannot verify the TLS certificate, so every request the CLI makes dies before it is
sent. It usually shows up on `retasc login`, because that is the first command that talks
to the network. Two causes, and the code tells you which:

- **A corporate TLS-inspecting proxy** (Zscaler and similar) re-signs traffic with a root
  Node does not trust — normally `SELF_SIGNED_CERT_IN_CHAIN`. Point Node at your
  organisation's CA bundle:

  ```bash
  export NODE_EXTRA_CA_CERTS=/path/to/your-company-ca.pem
  ```

- **A Homebrew Node whose OpenSSL keg lost its CA symlink** — normally
  `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, and the confusing one, because `curl` and `npm`
  keep working: they do not read the file Node reads. Relink it:

  ```bash
  brew postinstall openssl@3
  ```

Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`. It turns off certificate verification for
every connection the process makes, including the one carrying your session token.
`NODE_EXTRA_CA_CERTS` fixes the same failures with verification left on.

## Guides

- [Run multiple Claude Code agents in parallel](https://retasc.com/guides/claude-code-parallel-agents)
- [Claude Code subagents: dispatching waves with next_batch](https://retasc.com/guides/claude-code-subagents)
- [Claude Code agent teams share tasks until the session ends](https://retasc.com/guides/claude-code-agent-teams)
- [Cursor background agents on a shared backlog](https://retasc.com/guides/cursor-background-agents)
- [Turn GitHub Issues into a work queue your agents drain](https://retasc.com/guides/github-issues-ai-agents)
- [What is an agent swarm, and how do you keep one from colliding?](https://retasc.com/guides/agent-swarm)
- [Linear vs Jira vs an agent-first tracker](https://retasc.com/guides/linear-vs-jira-vs-agent-first)

All seven at [retasc.com/guides](https://retasc.com/guides).

## Links

- Website — [retasc.com](https://retasc.com)
- Set up your agent — [retasc.com/wire](https://retasc.com/wire)
- Docs + quickstart — [docs.retasc.com/quickstart](https://docs.retasc.com/quickstart)
- Changelog — [docs.retasc.com/changelog](https://docs.retasc.com/changelog), and [CHANGELOG.md](https://github.com/Retasc/cli/blob/main/CHANGELOG.md) in the repo
- Source — [github.com/Retasc/cli](https://github.com/Retasc/cli)
- Support — [support@retasc.com](mailto:support@retasc.com)

## Source code

The CLI's source is at [github.com/Retasc/cli](https://github.com/Retasc/cli). Each release is
copied there from the private repo where Retasc builds the CLI next to its server, so issues
and pull requests are closed for now. Send bug reports to
[support@retasc.com](mailto:support@retasc.com). The test suite is not published yet.

## Security

Report a vulnerability privately through the
[Security tab](https://github.com/Retasc/cli/security) of the repo.

## License

MIT, copyright Reply200 Inc. See [LICENSE](https://github.com/Retasc/cli/blob/main/LICENSE).

## Trademarks

Retasc and the Retasc logo are trademarks of Reply200 Inc. The MIT License covers the code and
text in this repository. It does not license the Retasc name or logo. You may use them only to
refer to Retasc and this project, never to name, brand or endorse another product or service.
