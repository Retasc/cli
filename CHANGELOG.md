# Changelog

All notable changes to `@retasc/cli` are recorded here, newest first. Every version
published to npm has an entry; the ones predating this file were reconstructed from the
release commits and the issues they reference.

Dates are the npm publish date. Each entry names the RTSC issue behind it.

## 1.61.3 (2026-10-20)

- **RTSC-1205** — **the CLI's source is public.** npm's Repository link now opens
  [github.com/Retasc/cli](https://github.com/Retasc/cli), which gets the source of every
  release under the MIT license. It used to point at a private repo, so every visitor got a
  404. Bug reports still go to support@retasc.com. The CLI itself works exactly as in 1.61.2.

## 1.61.2 (2026-10-10)

- **RTSC-1194** — **a session that sat idle no longer loses Retasc.** When the server
  retires the proxy's session key because nothing used it, the proxy now mints a new one
  from the same folder credential and repeats your call, where before every call failed
  until you restarted. Your claims and their tokens stay as they were. It does this only
  for a key the server expired: a key someone revoked by hand, a retired tool or a rotated
  key stays stopped. It pairs with a server change that waits seven days, not one hour,
  before treating an unused session key as abandoned, so CLIs that have not updated are
  covered by that half.

## 1.61.1 (2026-10-07)

- **RTSC-806** — **a downloaded attachment can no longer be written outside your
  project through a symlink.** The proxy saves attachments under
  `.retasc/attachments/<id>/` in your project. It already refused a symlink in place of
  the file itself, but it followed one in place of any of those folders, so a repo that
  shipped `.retasc` as a link could have the download land wherever the link pointed. Now
  every folder from your project down to the file is checked first, and a link in any of
  them stops the download before the file is fetched. Delete the link and ask again.

## 1.61.0 (2026-10-05)

- **RTSC-1172** — **a signup from the command line is now credited to the ad that
  brought it.** When the CLI can't open a browser on its own machine (over SSH, in a
  container), the sign-in link it prints now goes through retasc.com, which sends you
  straight on to GitHub's or Google's code page and picks up the ad click your browser
  carries on the way. Creating an org also sends this machine's public IP address, so an
  ad clicked in another browser, or on another machine on the same network, can still be
  matched. The address is compared against ad clicks from the last 24 hours and is not
  stored. `retasc join` does neither, since an invited teammate joins an org that already
  exists. The privacy policy covers this under "Advertising measurement".

## 1.60.1 (2026-09-29)

- **RTSC-1156** — **an agent is no longer labelled Claude Code just because it ran
  `retasc bind`.** `init`, `bind`, `join` and `key mint` used to record every new agent as
  Claude Code unless you passed `--runtime`, so a Grok, Cursor or Codex agent that set
  itself up showed as "Your name's Claude Code" in the Dash for good. With no `--runtime`
  the agent is now named after the tool that actually connects. `--runtime` still sets
  the label when you pass it.

## 1.60.0 (2026-09-28)

- **RTSC-1155** — **after `/clear` or `/resume`, every supported tool now learns which
  claims its window still holds**, as Claude Code already did. Before, only Claude Code's
  new conversation was told, so in Codex, Cursor, Gemini, OpenCode, Grok and Pi a claim
  could stay held for hours with nobody working on it. Codex hears it with its first
  prompt; the others hear it on their next Retasc call. Where the tool restarts Retasc on
  `/clear` (Pi does), the new Retasc session takes the previous one's claims over, so they
  keep renewing instead of lapsing unreachable for 30 minutes. In Cursor and OpenCode,
  where one window can run several conversations, the notice asks you before anything is
  released.
- **RTSC-1155** — Cursor gets a small per-prompt hook (`retasc hook prompt`), added next
  to the one Retasc already installed there, because Cursor's session-start hook does not
  run on `/clear` or `/resume`.

## 1.59.0 (2026-09-28)

- **RTSC-1154** — **a Pi agent no longer loses its claim by sitting idle.** Pi's MCP
  adapter closes a server that has been idle for 10 minutes, which stopped Retasc from
  renewing your claims while the agent was still working. `retasc setup` now writes a
  Retasc entry into Pi's own `~/.pi/agent/mcp.json` that stays alive once started, and a
  Retasc session inside Pi adds it by itself on machines set up earlier. You still need
  an MCP extension in Pi (`pi install npm:pi-mcp-adapter`).
- **RTSC-1154** — **Gemini CLI's session hook runs.** Gemini reads the hook timeout in
  milliseconds, so the value we wrote stopped the hook at once and Gemini sessions
  recorded no transcript or model. Existing entries are corrected automatically.
- **RTSC-1154** — OpenCode reports each new session after `/new`, not only the first one,
  and never a subagent's. The plugin on your machine is updated automatically.
- **RTSC-1154** — Cursor and Grok also run Claude Code's hooks. Retasc's Claude Code hook
  now recognises them and stays out, so their sessions are no longer filed under Claude
  Code.

## 1.58.0 (2026-09-28)

- **RTSC-1153** — **the CLI now keeps itself up to date, and it is on by default.** Until
  now every way Retasc starts stayed on the version you installed until you ran a command,
  and the only prompt to do so was a notice your agent had to pass on. Once a day the
  watchdog now checks npm in the background and, if a newer CLI is out, installs it. Your
  running session keeps its version and the next one starts the new one, so nothing
  changes mid-session. It never edits a file git tracks, never replaces an `npm link`ed
  install, and stays off in CI. You are told once, and `retasc config auto-update off`
  turns it off until you turn it back on (`RETASC_AUTO_UPDATE=0` does the same for one
  shell). `retasc doctor` shows whether it is on and what the last update did.
- **RTSC-1153** — shared `.mcp.json` files say `@retasc/cli@latest` again. npx checks the
  registry for a tag on every start (npm 9 and later) and falls back to its cached copy
  offline, so a pinned version was the thing that went stale. `retasc update` moves a
  pinned marker to `@latest` once, and `doctor` no longer warns about `@latest`.
- **RTSC-1153** — the "newer CLI available" notice now appears only when the automatic
  update is not working: it failed, it has not managed to check for three days, or a
  session still starts an older build after an update landed.

## 1.57.0 (2026-09-28)

- **RTSC-1127** — **new `retasc update`: one command that upgrades a connected machine,
  and asks nothing.** The "newer CLI available" notice used to say `npx … bind`. `bind`
  connects a folder; it does not upgrade one. Run from a fresh terminal it signed you in
  again and offered the org picker, in a bound folder it asked "Replace it?", and either
  way it left a global `retasc` on the old build. Before that the notice said `npm i -g`,
  which never touches a folder whose marker starts Retasc through npx. `update` does both
  halves: it upgrades a global install if there is one, re-wires the harness entries
  `retasc setup` wrote, and re-pins every bound folder's npx marker (`./.mcp.json` and
  Claude Code's local scope) to its own version. The folders come from your keystore, so
  it works from any terminal, and it never signs in, never prompts and never downgrades.
  Run it pinned: `npx -y @retasc/cli@1.57.0 update`. A build older than the published one
  hands over to the newest instead of reporting success, and a rewritten `.mcp.json` that
  git tracks is named so the diff is not a surprise. Restart your agent sessions after.
- **RTSC-1127** — the CLI's own update notice and `retasc doctor`'s stale-`@latest`
  warning now prescribe `update` instead of `bind`.

## 1.56.3 (2026-09-27)

- **RTSC-1150** — **after a `/clear` in Claude Code, the new conversation is told which
  claims the window still holds.** The watchdog keeps renewing every claim across a
  `/clear`, because a `/clear` often means "fresh context, same issue", and dropping a lease
  mid-work costs more than holding one too long. What was missing is that the new
  conversation had no way to know it held anything, so a claim could stay held for hours
  with nobody working it. The SessionStart hook now also runs on `clear`, and on `clear` or
  an in-window `/resume` it names the issues the window holds, so the agent carries on,
  releases them before claiming other work, or asks you. Nothing is released on its own.
  The proxy lists issue ids only, never claim tokens, and only claims the server last
  confirmed, so a claim whose renewals are failing is never announced as held. A machine
  wired with the old `startup|resume` matcher is widened at its next session start. The
  notice comes from the copy of the CLI that `retasc setup` wired into Claude Code, so
  update that copy (`npm i -g @retasc/cli` for a global install) to get it.

## 1.56.2 (2026-09-21)

- **RTSC-1092** — **the CLI now tells you when it is the stale one, and gives advice that
  works.** Until now the update notice said `npm i -g @retasc/cli@latest`, which cannot fix
  a CLI that npx started: the global install and the npx cache are different copies, and
  npx caches by the literal spec string and never re-resolves `@latest`. Measured — a proxy
  ran **1.51.0 for eight days across five releases** while `retasc --version` reported
  1.56.0, because the global copy had been kept dutifully current and that was never what
  started. Following the old advice changed nothing and looked like it had worked.
  A copy started by npx is now told so, and told to run `retasc bind` **pinned to the
  published version** — an exact spec gets its own cache entry, so it cannot be served a
  stale one, and `bind` rewrites the marker with the launcher that machine can actually
  run. It also **stops offering to install**: a global install would succeed and fix
  nothing there.
  Detection reads this module's own path rather than `npm_config_user_agent`, which any
  npm invocation sets — including `npm run` against a perfectly ordinary global install.
- **RTSC-1092** — **`retasc doctor` now checks the marker it was blind to.** 1.56.1 added a
  warning for a folder pinned to a moving tag, but only looked at the binding Claude Code
  uses. Where a `claude-local` entry shadows `./.mcp.json`, that file went unchecked — and
  it is exactly the one **Pi's MCP adapter, Codex and Cursor** read. A folder in that state
  got four green checks. Both are reported now, and the warning names which file to fix.
  **Nothing to do on upgrade**, and no behaviour changes for a folder that was already
  healthy. If you have been running `npx @retasc/cli@latest`, run `retasc doctor` once —
  it will tell you whether your agent has been starting the build you think it has.

## 1.56.1 (2026-09-21)

- **RTSC-1091** — **`doctor` now tells you when your folder is pinned to a moving tag.**
  A marker that says `@retasc/cli@latest` looks healthy and is not: npx caches by the
  literal spec string and never re-resolves a dist-tag, so it keeps serving whatever it
  fetched the first time and every release after that silently does nothing. Measured on
  2026-09-21 — a folder had been running **1.51.0 for eight days across five releases**
  while `retasc --version` reported 1.56.0, and the only symptom was a feature quietly
  missing.
  `doctor` reported four green checks on that folder, and it was not wrong: the marker
  *starts*, and "does it start" was the only question it had ever asked. It now also asks
  whether it starts the version you think it does, and says what to run.
  **A warning, never a failure** — the folder works, and the exit code is untouched.
  **The fix is `retasc bind`, not `npm i -g`.** The global binary and the npx cache are
  different copies, and your agent loads the npx one, so installing globally can leave a
  stale proxy running and look like it worked. `bind` rewrites the marker with the
  launcher that machine can actually run, and pins it.
  Also here: the published setup docs no longer put `@latest` in any command, and
  `release-cli` repins them on every release so they cannot fall behind silently.

## 1.56.0 (2026-09-21)

- **RTSC-822** — **Codex, Cursor, OpenCode and Gemini CLI now report their own sessions**, so
  the Agents page can name the conversation each one is having and its resume line reopens it.
  Until now only Claude Code and Grok could: Claude Code through a `SessionStart` hook, Grok
  because it exports `GROK_SESSION_ID` to MCP servers directly. Everything else said "no
  session-id adapter yet", forever.
  Every adapter was built from a payload **captured on a real install**, and two vendor docs
  turned out to be wrong. Codex has no `SessionStart` at all, so its hook rides
  `UserPromptSubmit`, and its hooks live in `~/.codex/hooks.json` in Claude Code's own schema
  rather than in `config.toml`. Cursor is `cursor-agent`, its schema is flat with no matcher,
  and its payload carries no `cwd` — only `workspace_roots`. OpenCode is a plugin, not a hook.
  **Codex needs one manual step and `setup` says so.** Codex gates hooks behind a trust record
  in its own config, so a freshly written hook does not fire until you approve it. We do not
  write that hash for you — marking our own hook trusted on your behalf would bypass a gate
  Codex put there deliberately — so the receipt tells you rather than reporting a success that
  will not happen.
  **Gemini is wired from its bundle and was never observed running**, because a live session
  needs `GEMINI_API_KEY` and the machine it was built on has none. The receipt says that too,
  instead of letting a row imply it was watched working.
  Two fields are never read or stored: Cursor sends `user_email`, Codex sends your literal
  prompt. Verified by piping the real captured payloads through the built binary.
  **Re-run `retasc setup`** to wire the new adapters; nothing breaks if you do not.

- **RTSC-1080, RTSC-1084** — **Pi is a runtime of its own.** Its work was being filed under
  Claude Code's name — not a mislabelled Pi, but Pi's issues attributed to another tool, on
  another machine, pointing at another tool's transcript. `pi` was missing from the server's
  runtime vocabulary, so the proxy fell back to the workspace's remembered Claude Code
  credential. A Pi session now mints its own key and draws as Pi.
  **Pi also names its conversation now**, derived from the folder it is running in. The route
  pi.dev documents (`PI_SESSION_ID`, `PI_SESSION_FILE`) does not exist in the shipped 0.74.2 —
  those names appear nowhere in the install — and Pi has no MCP client of its own to ask, so
  the folder is the meeting point. Only the id is reported: never the path, never a byte of
  the file. A transcript a live session is still writing to is never opened, and a transcript
  from an earlier session in the same folder is refused rather than reported with confidence.
  **Needs the matching backend**, which is already deployed to production.
  Note for anyone whose product name contains the letters "pi": `pi` is matched **exactly**,
  deliberately, so Copilot is not relabelled as Pi and is not handed Pi's resume verb.
  The first attempt at this shipped and did nothing, and the fix is in this same release. It
  gated on `AI_AGENT=pi`, which Pi sets for its **shell tool** — but the supported path does
  not go through bash: `pi-mcp-adapter` runs inside Pi's own process and the proxy is that
  process's child, which never sees the shell tool's environment. The handshake is what works
  on the path people actually use (`clientInfo.name` arrives as `pi-mcp-<server>`), and the
  gate now takes either signal, so driving the proxy from a shell by hand still works. Found
  by running it against a real Pi session rather than by reading it.

- Pi has no MCP client of its own and `retasc setup` does not wire it. It reaches Retasc
  through the third-party `pi-mcp-adapter`, which reads the same `./.mcp.json` marker every
  other client reads — `pi install npm:pi-mcp-adapter`, then `retasc bind`. The Retasc Agent
  Skill carries the setup and the one caveat worth knowing: that adapter starts servers on
  demand, so the proxy never lives long enough to heartbeat your lease. `checkpoint` at
  pauses rather than trusting the watchdog there.

## 1.55.0 (2026-09-19)

- **RTSC-1057** — the proxy now reports how long **this machine** keeps a session
  transcript, read from the harness's own settings (Claude Code's `cleanupPeriodDays`),
  so the Dash can name the day a conversation will be gone instead of quoting a
  documented default at you. It was saying "deleted after 30 days by default", which is
  wrong by eleven months for anyone who set it to a year.
  A **number of days, never a path and never the file** — the same boundary the
  transcript id and the workspace already sit on: Retasc holds the id, the machine holds
  the conversation. It is sent only for a harness whose retention the proxy actually
  read, so Codex, Gemini CLI, Cursor and OpenCode send nothing and the Dash keeps the
  shorter sentence for them rather than borrowing Claude Code's number.
  **Nothing to do on upgrade**, and nothing breaks on an older CLI: the field is
  optional, an install that never sends it is ordinary, and the panel simply does not
  name a day. The backend that accepts it is already deployed.

## 1.54.0 (2026-09-19)

- **RTSC-1061** — nothing asks which subscription pays for an agent any more, so
  `retasc plan` is gone and `retasc bind` no longer puts the question. **Breaking if
  you scripted it**; `retasc plan` now exits with `unknown command 'plan'`.
  The question was asked once per runtime to give model spend a denominator, and the
  one surface that was going to read the answer was canceled. Nothing consumed it after
  that, so every install spent a turn of its first session collecting a fact with no
  reader on the other end. The `PLAN_UNKNOWN` setup state went with it, along with the
  `list_plans` and `set_plan` MCP tools — the server is at 56 tools now, down from 58.
  **Upgrade if you are on 1.53.1 or older.** The backend functions behind `retasc plan`
  are already removed, so on an un-upgraded CLI that one command fails with a raw
  `Could not find public function` instead of a clean message. Every other command is
  unaffected, `retasc bind` included: its plan step was already written to be skipped
  rather than to fail the bind. Answers recorded before this are no longer read and are
  deleted in a follow-up.

## 1.53.1 (2026-09-18)

- **RTSC-1042** — the proxy now sweeps this machine's dead worktrees on the first
  claim of a session. Reap used to run only when *this* session marked an issue
  `done`, so an author who sent work to `review` kept the tree after the reviewer
  merged and closed it on another laptop. `retasc tidy --prune --auto` deletes
  local trees whose issue is `done` or `canceled` and whose commits are already
  on trunk or fully pushed to origin, with a one-hour grace and a cap of ten per
  session. A branch that never landed on trunk is not deleted from origin.
  **Nothing to do**: the next claim on a machine with leftover trees starts the
  drain.

## 1.53.0 (2026-09-15)

- **RTSC-1014** — every tool you start in a bound folder now gets its **own credential**,
  so one can be retired without stopping the others. Before this, Claude Code, Grok and
  Codex started in the same folder all read the same `.mcp.json` and authenticated as one
  credential: retiring any of them stopped all three and cost you a `retasc bind`.
  The proxy mints the new credential at the `initialize` handshake — the first moment the
  tool has a name — and caches it in the keystore, so it fires once per (folder × tool)
  rather than once per session. **Nothing to do**: a folder bound before this upgrades
  itself as each tool next starts, with no re-bind and no edit to `.mcp.json`.
  Two behaviours worth knowing. A tool retired in a folder is served **nothing** there and
  says so, rather than quietly falling back to the folder's shared key — that fallback
  would have undone the retire. And a client that never sends `initialize` still gets a
  per-session key exactly as before, since with no client name there is no tool to name.
  What it is not: the folder's workspace key stays valid, so this is fleet management, not
  a security boundary. An older CLI, or a tool pointed straight at `mcp.retasc.com` with
  the key from `.mcp.json`, is not stopped by it.

## 1.52.0 (2026-09-14)

- **RTSC-958** — a user never names an agent, so `--agent <name>` is gone from `init`,
  `bind`, `key mint` and `join`. **Breaking if you scripted it**; those commands now exit
  with `unknown option '--agent'`. Drop the flag and you get the same agent you would
  have got by omitting it.
  The flag looked like a label and was not one. An agent's identity was `{you}'s
  {runtime}` and the roster grouped rows by that string, so a typed variant — `"Em de
  Vries's claude-code 2"`, say — did not rename an agent, it forked a second one that
  kept its own finished count, spend and send-back rate forever. Nothing warned anyone,
  and there is no rename door in the product to undo it with. The help text made it
  worse by advertising the exact shape to vary: `(default: auto, "{you}'s {runtime}")`.
  Every custom name in the org that found this was junk or an accident: one accidental
  fork of the author's own agent, three from a test an agent ran wrong, two fixtures.
  No other surface names an agent either — the Dash has no naming UI, and the
  setup-token flow always passed an empty name.
  `retasc plan --agent <nameOrId>` is a SELECTOR, not a name, and is untouched.
  The server keeps ACCEPTING `agentName` and ignores it, so 1.48 and 1.51 keep minting
  rather than failing validation — an older client simply gets the generated name. That
  half is already live, so this release removes the flag rather than changing behaviour.

## 1.51.0 (2026-09-13)

- **RTSC-962** — the proxy now reports git worktrees nobody claimed, so Retasc can see
  work an agent started without saying so. Retasc fenced the END of work and nothing at
  the START: `done` rejects on a claim mismatch, `review` demands a handoff, but the
  server never sees an agent edit a file — so an agent could build thousands of lines
  against an issue the queue still showed as free, and a second agent would read it as
  untouched and duplicate or decompose it.
  The server still reads no git. This process does: a `rtsc-NN/<slug>` worktree with no
  live claim behind it is reported, and the issue gets a **provisional hold** — visible
  on `get_issue`, withheld from `next_issue` / `next_batch`, lapsing after an hour.
  A hold is not a lease and never refuses an explicit `claim_issue`, so the agent that
  forgot to claim always gets its own work back.
  Only ACTIVE worktrees count (uncommitted changes, or a commit in the last day), so an
  abandoned directory cannot park an issue; git runs asynchronously and off the critical
  path, so the census never delays a tool call; and each unclaimed worktree is announced
  once, not on every call. A server without the tool simply produces no holds.

## 1.50.0 (2026-09-11)

- **RTSC-901** — `retasc plan`: which subscription pays for each of your agents, listed
  and set one line per (agent, harness). Retasc cannot read this anywhere — no transcript
  field, telemetry attribute or environment variable carries it, and the only machine
  source sits behind the human's own keychain — so it is asked for once and kept.
  The options are READ FROM THE SERVER on every run, never compiled in: a tier a vendor
  ships this morning is on the list this afternoon, on the build you already have.
- **RTSC-901** — `bind` asks the same question at setup, but only when `--runtime` was
  STATED. That flag defaults to `claude-code`, which is a fine label for a row and the
  wrong subject for this question: `retasc setup` wires every harness on the machine, so
  asking "which Claude plan?" of someone setting up Codex records a fact about the wrong
  product. Left unstated, the question falls to the first MCP handshake, which knows
  which harness actually connected.
- A non-interactive run answers nothing rather than defaulting. A plan nobody chose reads
  on the Agents page exactly like one they did.

## 1.49.1 (2026-09-09)

- **RTSC-879** — the proxy sends NO `Authorization` header when it has no key, instead of
  `Bearer ` with nothing after it. An empty bearer is not a weaker credential, it is a
  malformed one, and where a keyless proxy now runs that difference decides whether the
  thing works at all: in a Claude Code cloud container the documented way to supply a
  credential is an environment API credential, which Anthropic's egress proxy injects as
  an `Authorization` header after the request leaves the VM — and which also lets the
  request through a network allowlist that would otherwise refuse the host. Injection
  wants the header absent, and whether it overwrites one already present is undocumented,
  so sending an empty bearer staked the whole path on undocumented behaviour. With a key
  present nothing changes.

## 1.49.0 (2026-09-09)

- **RTSC-879** — a committed `.mcp.json` now names `npx -y @retasc/cli@<version> mcp-proxy`
  instead of a bare `retasc`, so it starts on a machine that is not the one that wrote it.
  `portableLauncher` used to pass an on-PATH resolution straight through on the belief that
  a bare binary "was at least portable"; it is portable only across machines that happen to
  have a global install. A container has none. Measured in a Claude Code cloud session on a
  fresh clone: the MCP server died at `ENOENT: Executable not found in $PATH: retasc` before
  it could do anything else. Startup on the shared marker now pays npx resolution (about 6s
  cold, ~1s off the cache); user-level configs, which never travel, keep the direct binary.
- **RTSC-879** — `retasc bind --json` can now sign in from a container. An agent-driven
  bind takes the DEVICE grant instead of the browser one, in two steps: the first call
  prints an approve URL and an eight-character code and **exits**, the human approves on
  any device, and running the same command again resumes the same grant and finishes.
  Previously an agent got the browser door, which redirects to `127.0.0.1` on the machine
  running the CLI — unreachable when the human is somewhere else, which in a cloud
  container they always are. New continuable outcome state `SIGN_IN_PENDING` so an agent
  can tell "waiting on a click" from "nothing has started" and does not issue a second
  code that invalidates the one its human is reading. CI and `RETASC_NO_BROWSER` still
  refuse immediately: neither has anyone to approve anything.
- **RTSC-879** — `retasc doctor` no longer installs a package to check a marker. For an
  npx marker it probes `npx --version` rather than executing the pinned package spec,
  which was a registry fetch on every run and reported "your agent CANNOT start Retasc"
  for a healthy marker whenever npm was unreachable. Its remedy line is corrected too: a
  global install can no longer change what `bind` writes into a shared marker.
- **RTSC-879** — the repo's own committed `.mcp.json`, and the marker blocks published in
  `web/auth.md` and the agent-skill, now show the npx form. They were the bare binary,
  which is the exact thing this release stops emitting. Those hand-written blocks say
  `@latest` rather than a pinned version on purpose: `release:cli` publishes from `main`
  AFTER a merge, so a committed marker pinning the version being released would 404 for
  every fresh clone in the window between the two — trading this release's ENOENT for an
  E404. `bind` still writes the pinned form, which is correct because it only ever names
  a version that already exists.
- **[no-issue]** — test fix: the setup-hook test pinned `RETASC_HOME` to a temp dir. It
  fell through to the real home directory, so it passed on a clean CI runner and failed
  on any machine that had actually run `retasc setup`.

## 1.48.1 (2026-09-08)

- **RTSC-878** — `retasc doctor` no longer condemns the entry `retasc setup` writes. Its
  machine-global check dated from RTSC-91, when every top-level `mcpServers.retasc` carried
  a key or a workspace id and so routed every unbound folder to one org; presence alone was
  a correct test for that. RTSC-780 then made one global entry mandatory, the keyless `auto`
  marker, which carries no identity at all, and the check was never taught the difference.
  Doctor therefore printed `✗ GLOBAL Retasc server registered` at the marker and offered
  `claude mcp remove -s user retasc` as the fix, which strips Retasc from every folder
  without a binding of its own. It cost a customer a day.
- The check now reads the entry's identity: `RETASC_WORKSPACE=auto` with no key resolved is
  reported as correct and named, so someone who just ran `setup` can see that what it wrote
  is what belongs there. Every other shape stays illegal, including a keyless entry that
  names a real `ws_` workspace, which still routes every unbound folder to one binding.
- The exemption is not granted on the sentinel alone. `parseServerEntry` reads
  `RETASC_WORKSPACE` before it looks for a key in an `Authorization` header or in
  `RETASC_MCP_KEY`, so an entry carrying both the `auto` sentinel and a real credential
  parses as an innocent keyless marker; judging the parse alone would have exempted a live
  machine-global registration pointing every unbound folder at that key's org. The raw
  entry is examined too, and anything carrying credential material or a `url` of its own
  stays illegal whatever its `env` claims.

## 1.48.0 (2026-09-08)

- **RTSC-859** — `retasc key mint --hosted`: a key now says at mint what it is for.
  `workspace` (the default, and what every bind door says explicitly) expects the local
  watchdog; `hosted` is for a cloud agent or CI that will never have one.

  Why: a workspace key sent raw to the server with no proxy is two things at once and the
  server cannot tell which, a hosted agent working as documented or a laptop whose config
  went stale. Both got the same advice on every claim, run `bind`, which a hosted agent
  cannot do. With `kind` on the row, a hosted key is told the one true thing (renew your
  own leases) and shows "no folder (hosted)" on the Agents page as a fact rather than a
  gap; a workspace key with no runner gets the firm remedy, because for that row it is
  true. A key that said nothing, which includes every key minted before this and any bare
  `key mint` since, keeps the old hedged text, since nothing on the row can say which it
  is. `--hosted` and `--install` are refused together: one wires a local watchdog, the
  other says there will never be one.

  `retasc mcp install --no-watchdog` is not deprecated (it writes exactly a hosted
  deployment's config) but now says, once, that a key used that way should be minted
  `--hosted`.

## 1.47.0 (2026-09-08)

- **RTSC-864** — `retasc key mint` now prints every remote-key config block a hosted
  agent can paste, including the TOML one that did not exist.

  A key is shown once, and until now that was all `key mint` printed. Anyone wiring a
  host that cannot run our proxy (a claude.ai connector, Codex Cloud, CI) had to invent
  the config, and for two of the six harnesses it was not inventable: `tomlBlock` emitted
  only the stdio proxy shape, so Codex and Grok users had nothing correct to paste at all.
  The new `tomlHttpBlock` fills that in, and all three blocks now print next to the key
  while it is still on the screen.

  The two TOML dialects are separate on purpose, and the reason is the dangerous part.
  Verified against both real binaries: Codex reads `[mcp_servers.retasc.http_headers]`
  and Grok reads `[mcp_servers.retasc.headers]`, and each loads the other's file without
  a warning while ignoring the header. The result is a server that reports itself
  enabled and configured, and returns UNAUTHORIZED on the first tool call.

  The blocks also say, next to themselves, that a key belongs in a user-scope config or
  a platform secret store and never in a tracked `.mcp.json`, which the repo's pre-commit
  hook refuses anyway. Where a container DOES have an environment, the proxy with
  `RETASC_MCP_KEY` set is still the better door: it renews leases for you.

## 1.46.0 (2026-09-08)

- **RTSC-855** — `retasc doctor` and `retasc setup` now say whether the **Retasc Agent
  Skill** is installed on this machine, and print the one command that installs it.

  Wiring the MCP server gives an agent the ability to claim work. The skill is what tells
  it what a lease is, that a claim needs its own worktree, what a checkpoint is for, and
  how a handoff into review works. Nothing connected the two, so an agent could be fully
  wired and still have the tools without the manual, and no surface anywhere would
  mention it. The server cannot fill the gap: MCP carries a bearer token and no
  filesystem, so only something running on the machine can look.

  The hard part is not finding the file, it is not being wrong about it. A false "not
  installed" shown to somebody who followed our own instructions teaches them to distrust
  everything else `doctor` says, so the check knows all three routes a skill really
  arrives by: global (`~/.claude/skills` and each harness's equivalent), project (the
  `skills` installer's DEFAULT scope, which lands in the working directory), and, for
  Claude Code, an installed plugin's own folder, since `/plugin install retasc@retasc` is
  one of the routes our public README offers and it writes none of the above. It honours
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GROK_HOME` for the same reason. The printed
  command carries `-g` so it installs where the check looks. A harness whose convention
  we cannot verify is skipped rather than accused, one harness holding the skill silences
  the nudge for the rest, absence is reported with `ℹ` rather than `✗`, and neither
  command changes its exit code over any of it.

## 1.45.0 (2026-09-08)

- **RTSC-862** — a binding now covers every **git worktree** of the repo it was made in.

  `findBindingByPath` walks up from the current directory looking for a bound folder and
  stops at the first `.git`, which is what stops `retasc bind` in `~` from silently
  binding every project beneath it. But `.git` is a FILE at the root of every worktree,
  so that stop fired on the first step inside one: every worktree resolved to nothing,
  with no error and no hint, and the tools were simply absent. Repos whose workflow
  creates a worktree per task (this one included) hit it constantly, and the rational
  workaround — paste a raw key into a config that works everywhere — silently costs the
  watchdog, session rows, transcripts and the folder name.

  "Same repository" is decided by git's common dir, the one directory every worktree
  shares, read from disk rather than by shelling out to git. A sibling repo checked out
  inside a bound directory still resolves to nothing, so the cross-org property RTSC-91
  exists for is untouched. Binding a worktree deliberately still wins over its repo's
  binding.

  `retasc doctor` says when a folder resolved this way, instead of the old warning that
  the id "was bound at a different folder" — advice which, for a worktree, would have
  minted a second key and a second agent for one repo.

## 1.44.0 (2026-09-08)

- **RTSC-861** — the proxy now tells Retasc which CLI version it is. It rides on
  `mint_session_key`, the one call every proxy already makes at startup, as an optional
  `cliVersion` argument, so an older build that sends nothing still mints exactly as
  before.

  Why it matters: the update notice (RTSC-520) fires from a `postAction` hook on
  `retasc <command>`, and someone whose only contact with the CLI is the proxy their
  harness spawns runs no commands and never sees it. Three live setups were found on
  builds older than 1.41.0 with no way to find out. The server can now say so in the
  tool result, which reaches every harness, and with this version it can name the exact
  gap instead of inferring one from behaviour.

## 1.43.0 (2026-09-05)

- **RTSC-799** - `tidy`, `done` and `claim` now work out which branch is this repo's trunk
  instead of assuming it is called `main`. Until this release `tidy` compared every branch
  against `origin/main`, a name written into the source with no flag, no config and no way
  to see it. In a repo whose trunk is `master` that comparison does not fail into view:
  `git merge-base --is-ancestor` exits 128 for an unreadable ref, the code tested only for
  0, and so a broken lookup and an honest "not merged" produced the same word. Every branch
  read `merged: no`, nothing was ever reapable, and because `claim` creates a worktree per
  issue and only `tidy` removes one, the worktrees accumulated with nothing printed to say
  why. The team who reported it had thirty of them, built up over months, and could not tell
  from the outside whether the tool was wrong or their setup was.
  The trunk now comes from `origin/HEAD`, which is what `git clone` already records and what
  `git fetch` re-records when it goes stale. Override it per repo with
  `git config --local retasc.base origin/develop`, or per run with a new `--base` on `tidy`
  and `done`. Read at `--local` scope on purpose: a plain `git config --get` also sees
  `~/.gitconfig`, and one machine-wide value would have quietly redefined the trunk in every
  repo on the box and outranked each repo's own `origin/HEAD`. When the trunk cannot be
  worked out at all, that is an error naming the ref and every way to set one, because a
  command that cannot tell what merged means must not go on to report that nothing did.
  Ancestry now has three answers rather than two. "Git could not tell" is carried through as
  its own state, prints as `?`, and is never deleted, not even under `--force`: that flag
  means "unmerged, but I know the work landed elsewhere", which is a judgement about a branch
  git actually reported on. Every run also prints the trunk it measured against, which is the
  line that would have turned this into a one-minute diagnosis, and a shallow clone warns,
  since missing history produces the same uniform "no".
  Care taken with the sharp edges, because this turns a command that deleted nothing in those
  repos into one that deletes:
  - A stale `origin/HEAD`, which outlives the branch it names when a remote renames its trunk
    and which git before 2.45 never repairs, falls through to the next candidate with a note
    rather than refusing `claim`, `tidy` and `done` in a repo that is otherwise healthy.
  - `done` still closes the issue when the trunk cannot be resolved. The control-plane close
    is the durable half and a CI checkout legitimately has no `origin/HEAD`; the teardown is
    what needs a trunk, so that is what reports.
  - The first `--prune` after upgrading asks once before deleting five or more branches, since
    it may be clearing months of work a team believed this command never touched. Scripts and
    the MCP auto-reap never see the question, and `--yes` skips it.
  - `claim` fetches before it proves the base exists, so a just-pushed base still works, and
    resolves before taking the lease, so a claim is never held for a worktree that cannot be
    created. It also prints the trunk it branched from.
  - A bare repository is refused rather than operated on (the old path resolved to its parent
    directory), a detached HEAD no longer defeats the "that's your current branch" guard, and
    the watchdog now logs a non-zero exit from an auto-reap instead of swallowing it.

## 1.42.1 (2026-09-05)

- **RTSC-832** — the model now actually appears. 1.42.0 read it from the SessionStart
  hook's `model` field, and Claude Code 2.1.261 does not send one: a captured payload is
  `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source` and nothing else.
  The row therefore filled in only after a `/model` switch, which is backwards.
  Claude Code does write the model on every assistant message in the transcript, so the
  proxy reads it from there instead, and every session gets one.
- The read is bounded to the last 64KB: transcripts reach megabytes and this runs on a
  throttle for the whole session. Reading backwards from the end also means a `/model`
  switch is picked up by the same read, with or without the hook.
- Only the model STRING is ever sent. The transcript path stays on the machine that
  wrote it, and nothing else from the file leaves it.

## 1.42.0 (2026-09-05)

- **RTSC-821** — a session now reports WHICH MODEL ran it. The MCP handshake carries the
  client's name and version only, which is the CLI build and not the model, so this could
  never have come from the connection: `retasc hook session-start` now passes the
  SessionStart payload's `model` (plus `agent_type` and `agent_id` when the session is a
  subagent) alongside the transcript id, and the Dash's session panel names it.
- A second hook, `retasc hook model-switch`, is wired on `PostModelSwitch`, so changing
  model mid-conversation reaches the Dash and it can say what the session started on.
  `retasc setup` wires both in one write. It deliberately does NOT touch the record's
  timestamp: that is the window that stops an old record being adopted by a later session
  in the same folder, and a switch an hour in must not make an hour-old record look new.
- The proxy keeps watching for a model change after the id is recorded, under the same
  bounded budget it already had, so a session that switches model on every turn still
  cannot make it talk to the server on every turn.
- Absent stays ordinary. Claude Code omits `model` from some payloads and Codex, Gemini,
  Cursor and OpenCode have no session hook at all, so a junk or missing model is dropped
  rather than raised, and never costs the transcript id it travelled with.

## 1.41.1 (2026-09-04)

- **RTSC-812** — no runtime change. Two comments in `cli/src` said project deletion did
  not exist: `bind` called an unwanted empty project something "that cannot be deleted
  (org-granularity delete only)", and the `import` confirm said "there is no per-project
  delete". An owner can delete a project from the Dash now, so both were wrong, and the
  import one sat on the last screen before an irreversible write.

## 1.41.0 (2026-09-04)

- **RTSC-825** — every workspace now carries the name of the folder it is bound to. The
  server never receives a path, so the name can only come from the machine that has one:
  `retasc bind` sends it when the key is minted, and the watchdog proxy re-sends it at
  every session start, so a folder bound before this existed is named the next time an
  agent runs there. Only the folder's own name travels, never the path above it, and it
  is the folder the BINDING names, so a session opened in a subdirectory still reports the
  bound folder rather than renaming the row to whatever directory it started in. The
  Dash shows it as `workspace` on the Agents page and on the Connect page, and shows
  nothing at all where a workspace has not reported one; a key retired before this
  shipped can never report one, so it stays blank.

## 1.40.0 (2026-09-04)

- **RTSC-820** — every session now tells Retasc which conversation it is. `retasc setup`
  wires a Claude Code `SessionStart` hook (`retasc hook session-start`) into
  `~/.claude/settings.json`, idempotently and beside whatever hooks you already have; the
  hook leaves the session's id in the keystore dir, and the watchdog proxy picks it up and
  records it on its session key through a new `record_session` tool. Grok needs no hook:
  the proxy reads `GROK_SESSION_ID` at startup. The Dash's Agents page then ends each
  session's panel with the line that reopens it on the machine that ran it,
  `claude --resume <uuid>`. Only the NAME of the transcript is stored, never its
  contents and never a path. A session started before `setup` re-ran shows
  "none recorded" and names the missing hook.

## 1.39.4 (2026-09-03)

- **RTSC-810** — `retasc unbind` revokes the key it says it revokes. It had two faults in
  one lookup, and each on its own was enough to leave the credential live: it destructured
  `{ keys }` off `listKeys`, which returns a bare array, and it derived the folder's key
  prefix with a 12-character slice while the server stores 14. An exact compare between a
  12-character string and a 14-character one is never true, so every run since `unbind`
  shipped (RTSC-721) printed "not found server-side (already revoked, or the org is
  gone)" and moved on. The length now mirrors the server's own `displayPrefixOf`, and the
  test reads that file, so the two cannot drift apart again. A session child key can no
  longer be the one revoked either: those are minted in memory by the proxy and never
  reach the keystore, so a match on one would mean revoking a key this folder does not own.
- **RTSC-810** — `retasc bind --org-id X --project-id Y` learns the project's prefix. The
  provisioning form skipped every branch that looks a project up, so nothing knew the
  prefix: the key went out nameless, the keystore entry was written without `prefix` or
  `orgName`, and the receipt card printed an empty one. It now resolves the project the
  same way the interactive pickers do.
- **RTSC-810** — a key is named after the folder it was bound in, not after the project.
  The Keys list is the folder map (`client-a` → `ENG`), which is what tells you which
  machine a credential belongs to; `ENG key` on every row told nobody anything. Naming is
  the server's job now, so no door can store a nameless key: the Dash mint form with the
  name left blank and `retasc key mint` without `--name` both fall back to the project's
  own name rather than leaving the Dash to print "Unnamed key".

## 1.39.3 (2026-09-02)

- **RTSC-801** — (security) `save_attachment_file` no longer reads a workspace's own secrets,
  and no longer follows a file swapped in after it was checked. The proxy reads attachments
  on the agent's behalf, which is what keeps the API key away from the model, and the cost of
  that is a read the harness never prompts on: whatever this path allows, an agent can upload
  to an issue every org member can read. Containment to the attach root was doing all the work
  and it was never the boundary it looked like, because the files worth stealing are not
  outside a workspace, they are in it. `.env.local`, a legacy inline-key `.mcp.json` and
  `.retasc/` all live inside a normal root, so a prompt-injected "attach the config" was
  confined to exactly the secrets. Anything hidden below the root is now refused, dotfiles and
  dot-directories alike, along with `secrets.md` and, wherever `RETASC_DIR` puts it, the
  keystore itself. A root that contains your home directory (`~` or `/`, both previously
  accepted) is refused outright rather than carved down, since it makes every credential on
  the machine attachable, including every other workspace's key. Those rules all judge a name,
  so a file with more than one hard link is refused too: path resolution follows symlinks but
  not links, and `ln .env.local notes.txt` would otherwise hand the check a name it has no
  reason to refuse while the bytes stay the same. The one carve-out is `.retasc/attachments/`,
  which is where the proxy writes files fetched by `get_attachment_file`: refusing that would
  be the proxy declining to read a file the proxy itself wrote, and downloading from one issue
  to attach to another is a real thing agents do. Anything hidden deeper inside it is still
  refused.
  The second half is a race: the path was resolved and stat'd, a full
  `prepare_attachment_upload` round trip went to the server, and only then was the file opened
  by path, so a `ln -sf` in that window was followed on the read. The read now opens the file
  `O_NOFOLLOW` and non-blocking, and proceeds only if the descriptor's device, inode and size
  are the ones that passed the check. Opening non-blocking is not a detail: a `mkfifo` in that
  same window would otherwise have blocked the proxy's event loop outright, stopping every
  heartbeat it owes and stranding every lease it holds.
  Legitimate attachments, screenshots, logs and documents, are unaffected: none of them are
  hidden files.

## 1.39.2 (2026-09-02)

- **RTSC-808** — `retasc setup` no longer writes OpenCode's config into your real home when
  `RETASC_HOME` says otherwise. That variable exists so anything exercising the harness module
  cannot reconfigure the machine it runs on, and every other harness honours it; OpenCode read
  `XDG_CONFIG_HOME` first and so ignored the override wherever that variable is set. The
  precedence is now override, then environment, then default, and `XDG_CONFIG_HOME` is still
  honoured when no override is in play, because OpenCode really does read it.
  This is also why CI had been red on `main` for five consecutive merges. macOS does not set
  `XDG_CONFIG_HOME` and GitHub's Linux runners do, so the test guarding this passed on every
  developer machine and failed on every CI run, and no PR in the repo could show a green build.

## 1.39.1 (2026-09-02)

- **RTSC-800** — (security) a keystore-resolved key now travels only to the keystore's own
  url, whether the competing url arrives in the `.mcp.json` entry or in the environment.
  1.6.0 made this promise for the entry, which covered `claim`/`tidy`/`done` but not the
  proxy: the proxy is the one caller that ever reads a committed marker, and it passes no
  entry at all. The harness copies the marker's `env` block into the spawned process, so a
  `RETASC_MCP_URL` planted next to `RETASC_WORKSPACE` in a repo's committed `.mcp.json`
  arrived as an environment url, outranked the keystore, and every teammate's proxy sent its
  real workspace key to that host on the next start, during session-key minting, with no
  prompt. An environment url is now honored only alongside an explicit `RETASC_MCP_KEY`,
  where the key and the url share a trust domain.
  Nothing legitimate loses a path: `bind` already stores the deployment's url into the
  binding, so a self-hosted url is in the keystore before the proxy asks for it.
  This closes the url, and only the url. A committed marker also chooses the `command` that
  runs and can set any other variable, so a marker you do not trust is code execution by the
  MCP config format's own design, and the harness's project-trust prompt is the boundary for
  that. What this removes is the one variant that reads as ordinary configuration in review.

## 1.39.0 (2026-08-30)

- **RTSC-793** — `retasc setup` now wires Cursor, OpenCode and Gemini CLI too, bringing it
  to six harnesses. Until this release those three could be installed and running on your
  machine and `setup` would say nothing about them: it only ever named harnesses it already
  knew, so an unsupported one was not reported as skipped, it was invisible, and the receipt
  read as complete. That is the same silent half-install the previous release existed to end,
  one harness over.
  Each was admitted the same way the first three were, by checking a real installation rather
  than a config format from memory. The check that decides it is whether the harness starts
  its MCP server in the project directory, because the entry we write names no project and
  works out the folder for itself; one that started somewhere else would resolve every folder
  to the same wrong place with no symptom. All three passed.
  Cursor is wired by editing `~/.cursor/mcp.json` directly, and carefully: that file is named
  .json but Cursor accepts comments in it, so we splice our entry in textually and leave every
  comment, every other server and everything else exactly where it was. OpenCode and Gemini
  are wired through their own `opencode mcp add` and `gemini mcp add`, which is better than a
  writer of ours when a harness ships one that works: their file format stays their business.
  Note for Cursor users: it is `cursor-agent`, the agent, that gets the tools. The `cursor`
  command is the editor launcher and is a different program.
  Also fixed: the setup receipt could run a path into the word beside it, printing
  `~/.codex/config.tomlupdated`, which read like a corrupted path in the one place whose job
  is to say plainly that everything worked.

## 1.38.2 (2026-08-30)

- **RTSC-789** — `bind` keeps this folder's key instead of minting a new one on every run.
  The guard meant to prevent that (RTSC-262) read the `--org-id`/`--project-id` flags, so it
  only ever fired for a provisioning script. The canonical `npx @retasc/cli@latest bind`
  leaves both undefined and could never reach it: pick the same org and the same project
  from the menu and it minted anyway, leaving the old key live. The check now runs where
  the target is known, after the pick, so how you got there stops mattering. A different
  org or project still mints, as it must.
  A kept key is resolved against the server before it is kept. `bind` clears a binding only
  when the server answers `UNAUTHORIZED`, so a folder can reach the reuse branch holding a
  key whose health is unknown: a 5xx, a proxy sign-in page, a refusal whose wording drifts.
  Keeping one of those would have stranded the folder for good, since `doctor` sends that
  exact state back to `bind`. It falls back to minting instead, which is the self-healing
  the old mint-every-run was providing by accident.

## 1.38.1 (2026-08-28)

- **RTSC-780 follow-up** — `retasc init` now sets a folder up the same way every other
  door does. 1.38.0 taught `bind`, `join` and `bind --setup` to wire every harness on the
  machine, but `init` kept its own copy of that work: it minted a key and wrote a
  key-bearing entry for Claude Code and nothing else. So the one command named onboarding
  was the one that still left Codex with no Retasc tools, which is the exact failure
  1.38.0 exists to end.
  Fixed by deleting the duplicate rather than teaching it the same trick. Everything after
  the org is now `bind`'s job, which also means `init` writes the keystore binding an
  `auto` marker resolves against, guards a folder that is already bound instead of
  overwriting it, and prints the same receipt.
  `--scope` and `--no-watchdog` are gone from `init`: both described the shape of an entry
  it no longer writes. `-y/--yes` and `--no-install` are there instead, matching `bind`.

## 1.38.0 (2026-08-28)

- **RTSC-780** — `retasc setup` wires Retasc into every MCP harness on the machine, once,
  and `retasc bind` now runs it for you. Until this release the CLI could wire exactly one
  harness: it spawned `claude mcp add`, and if that worked it stopped. Codex, Grok and
  anything else got nothing, which is why an agent bound to the same project as two
  working Claude Code sessions could sit there unable to claim a single issue.
  The entry we write names no project and carries no key. The watchdog proxy works out
  which project it is in from the directory it was spawned in, so one line in a global
  config is correct in every folder, and the folder still decides the org exactly as
  before. Adding a harness is one entry in the registry; Claude Code, Codex and Grok ship
  today, each verified against a real installation rather than a config format from
  memory.
  A folder you have not bound yet is now an ordinary state rather than a broken install,
  so it gets a real answer: the tool call comes back naming the folder and telling you to
  run `retasc bind` in it. Previously a keyless call surfaced as an authentication or
  network failure while the CLI's own login was global and still fine, which reads as
  "the Retasc server is down" and sends you to check a server that is serving everyone
  else. The server cannot name your folder; the proxy runs in it, so it can.
  Which folder counts is bounded by the repository: a subdirectory resolves to its repo,
  and a repo checked out inside a bound directory resolves to nothing. Binding a
  directory must not quietly bind every unrelated project underneath it.
  Existing markers are untouched: one naming a workspace id keeps resolving through that
  id, and keeps priority over the folder.

- **RTSC-781** — `--runtime` now says what it does. It sets the agent's label in the
  Dash, and it never chose where config was written, but it is offered on the commands
  that install MCP config and documented with a list of harness names, so
  `key mint --runtime codex --install` named Codex, wired Claude Code, and said nothing.
  The help text says label, and the commands that mint a key and write a key-bearing
  entry now say plainly that they write for this folder only, that a key never belongs
  in a machine-wide config, and that `retasc setup` is what wires the harness you named.

## 1.37.0 (2026-08-26)

- **RTSC-749** — `retasc triage` reads and approves work filed from outside your org. Work
  that arrives through a GitHub or GitLab connector is written by whoever can file on that
  repo, and since RTSC-746 no agent can pick it up until a person has read it and approved
  it. This is that decision from the terminal: `retasc triage` lists what is waiting,
  `retasc triage RTSC-42` prints the full body and then asks.
  It is deliberately hard to automate, because the CLI runs where coding agents run: there
  is no `--approve` flag, the command refuses to run without an interactive terminal, and
  confirming means retyping the issue id rather than pressing y. Saying no is as cheap as
  saying yes (type `reject`) — the safe answer must never be the expensive one. The Dash
  stays the recommended surface: an agent that can drive a real PTY on your machine could
  drive this command too, and only logging the CLI out takes that away.

## 1.36.1 (2026-08-25)

- **RTSC-645** — `retasc gate install` no longer throws away your edits. It rewrites the
  commit-msg hook and the Action on every run, so a gate you had customized (say, one that
  also checks the branch number) used to vanish behind a green "✓ Updated" with nothing
  saying so. Generated files now carry a hash of their own contents, so a later run can tell
  "still exactly what we wrote" from "someone changed this". A changed file is copied to
  `.bak` first, keeping its permissions, and the run tells you where the copy went; a second
  round of edits goes to `.bak.2` rather than overwriting the first. Untouched files are
  replaced silently as before, including when you re-key the gate to a different prefix, so
  the common path gained no prompts and no flags.

## 1.36.0 (2026-08-25)

- **RTSC-520** — the CLI now says when it is out of date. There was no version check
  anywhere in `cli/`, so a global install went stale silently and stayed that way for as
  long as the machine lived — and a stale CLI does not merely lack features, it *lies*:
  its copy describes SERVER behaviour, so 1.11.0 kept telling people a decline "covers the
  whole org, including later migrations" long after RTSC-507 made that false, and 1.10.0
  had no Google door, so it sent Google-only humans through GitHub and minted them a
  second identity. After any login-gated command an outdated build now prints one line
  naming both versions and asks whether to update:

  ```
  A newer retasc is available (1.36.0, you have 1.35.2).
  Update now? [y/N]
  ```

  Notify then ask, never a silent `npm i -g`: interactive terminals only (no TTY prints
  the notice and nothing else, so scripted runs are unchanged), at most once a day with a
  decline remembered, and a failed install — EACCES on a root-owned prefix is the common
  one — reports itself and names `npm i -g @retasc/cli@latest` without ever failing the
  command you actually ran. A successful update says it applies from your next command and
  that agents need restarting to pick up the new MCP server. The MCP proxy never prints it.

  The published version is resolved server-side from the npm registry, cached hourly, and
  handed down on `manage:me` — a call every login-gated command already makes, so checking
  costs no round trip and no shared rate limit, and no release step can forget to update
  it. An optional `RETASC_CLI_MIN_HONEST` marks the oldest version whose copy still matches
  the server; below it the notice says so plainly, because "a newer version exists" and
  "what this build just told you may be false" are different problems.

## 1.35.2 (2026-08-25)

- **RTSC-743** — the last CLI replies that answered a person with a machine shape now
  answer in sentences. A failed MCP request used to paste 200 characters of the raw
  response body after the status, which on that endpoint is either a JSON-RPC envelope or,
  when the failure lands at Cloudflare rather than in Convex, a page of HTML; it now says
  what the status means and what to do about it, and reads the body for a message rather
  than printing it. A reply that is not JSON at all (a proxy error page, a captive portal)
  named a JSON parser's position; it now names what actually answered. `retasc login`
  stringified GitHub's whole OAuth payload into its error, burying `error_description`,
  the one field in it written for a person. `whoami` and `doctor` could surface a bare
  parser complaint from `resolveBinding`, which is a poor answer to "what is broken?" from
  the two commands you run when something already is. And `retasc import` printed the
  summary with the wire payload's own field names as labels — `issuesCreated`,
  `commentsInserted`, `attachmentsRehosted` — where it now prints Issues created,
  Comments and Attachments copied. Along the way, `doctor` and `whoami` stop telling you
  to re-run `retasc bind` when the thing that answered was a proxy rather than Retasc:
  that failure carries no verdict on your key, and re-binding to fix it mints a new one
  for nothing.

## 1.35.1 (2026-08-25)

- **RTSC-478** — a network failure now names its own cause. Node reports every failed
  `fetch` as the literal `fetch failed` and puts the diagnosis on `err.cause.code`, which
  the CLI read past, so `retasc login` on a machine whose TLS trust store Node cannot read
  died on `✗ fetch failed` and nothing else. It now prints
  `✗ fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)` — a searchable string naming the
  real problem. `cli/README.md` gains a troubleshooting entry keyed on that code, covering
  both causes: a corporate TLS-inspecting proxy, and a Homebrew `openssl@3` keg that lost
  its CA symlink (the confusing one, since `curl` and `npm` keep working).

## 1.35.0 (2026-08-25)

- **RTSC-709** — `retasc issue show` and `retasc issue list` read the queue from a
  terminal. `tidy` and `done` both reason about issue status, and until now a human asked
  to accept their verdict had no way to see that status without opening the Dash. Both
  default to the current `rtsc-NN/` branch's issue, `list` takes the same filters the MCP
  surface does (status, priority, label, author, assignee, SLA, limit), and both take
  `--json`.
- **RTSC-709** — `retasc checkpoint` and `retasc check-claim` close the claim lifecycle.
  `claim`, `next`, `release` and `done` all existed, so a human could take work, hand it
  back and finish it, but could not record progress on it or answer the question
  `workflow.md` says to settle at runtime: is anything actually renewing my lease?
  `check-claim` prints the last renewal time and exits non-zero when you do not hold the
  issue, so a script can branch on it.
- **RTSC-709** — `done` reads the issue back before it closes it. It was one word that
  closed an issue with no read path to confirm first, and it closed one whose PR was still
  open and unreviewed. It now prints the id, the title, the status transition and whether
  the branch is merged, and asks before closing on a TTY. `--dry-run` shows the readback
  and the teardown plan without touching anything, `-y` skips the prompt, and a non-TTY
  still closes, so scripts are unchanged.
- **RTSC-709** — `cli/README.md` now records which MCP tools are deliberately Dash-and-MCP-only,
  and why, so their absence from the CLI reads as a decision rather than an oversight.

## 1.34.1 (2026-08-25)

- **RTSC-741** — a rejected write no longer costs you the lease. The watchdog decided
  when to stop heartbeating an issue by looking at the request you sent, never at whether
  the server accepted it. So a `save_issue` that came back an error still dropped the
  issue from the heartbeat map while you were still holding it. Nothing renewed it after
  that, it ran out its half hour, and the reclaimer handed your work to another agent
  while you were in the middle of it, with no sign anything had gone wrong. Every drop
  now requires the call to have actually succeeded. The trigger is the new server-side
  rule that moving an issue into `review` must carry a handoff: a rejection on that write
  is the expected first attempt for any agent that has not learned the field yet, so a
  rare edge became a common one.

## 1.34.0 (2026-08-24)

- **RTSC-731** — `bind` stops asking whether you want to join an org you are already in.
  A teammate given access to a second project was shown "Join Retasc, or start your own
  workspace?", with the second option one keystroke away from creating a duplicate
  organization that cannot be deleted from the terminal. Invites that only add projects
  to a membership you already have are no longer treated as onboarding, and no longer
  suppress the single-org shortcut. Your agent still hears about them, and
  `setup_status` now asks about them in its own words, naming the project and the
  organization so "Retasc the org" and "Retasc the project" can't be confused.
- **RTSC-731** — the invite questions hand back a value your agent can actually use.
  Both onboarding questions told the agent to pass the chosen answer to `accept_invite`'s
  `org` flag, then offered "join" as that answer — so an agent doing exactly what it was
  told got "no invite to join is waiting for you", while one that ignored the instruction
  and read the prose succeeded. The accept option now carries the organization itself.

## 1.33.0 (2026-08-23)

- **RTSC-722** — the setup questions arrive as a matrix your agent can actually render.
  1.32.0 sent three of the four as free text, and a picker cannot draw a question with no
  options, so the whole set collapsed back into the numbered list in prose that RTSC-720
  existed to remove. They now carry defaults derived from the folder you are standing in:
  in `~/the egg` you get `The Egg`, `The Egg`, `EGG`, and the folder confirm, four clicks
  instead of three typed answers. Every question keeps a "Something else" escape.
  Folders that name nothing about the work (`/Users`, your home directory, `src`, a
  dotfile, anything too long for the server to accept) suggest nothing and fall back to
  text, because a plausible wrong default is worse than no default when what you are
  confirming is which folder gets connected. Picking a project in an org that has more
  than four is a picker too now, instead of an unrenderable list of every project.

## 1.32.0 (2026-08-23)

- **RTSC-720** — when `bind --json` stops to ask, it hands your agent the exact questions
  as data: what to call the workspace, the first project, its prefix, and a confirmation
  naming the precise folder about to be connected — with the flag each answer fills. Your
  agent presents them instead of paraphrasing a status line, which is the difference
  between being asked "what should we call it?" and being told "you have no organization"
  by an agent waiting for you to notice.
- **RTSC-721** — `retasc unbind` exists. It puts a folder back the way it was before
  `bind`: the keystore entry, the MCP entry in either location it can live, and the
  agent key — revoked server-side when your session can, named for the Dash when it
  cannot. Until now undoing a binding meant hand-editing five places, one of them keyed
  by an id nothing surfaces, with the key left live throughout. It confirms before
  removing anything, names the absolute folder, and leaves your sign-in alone —
  `retasc logout` is still its own decision.
- **RTSC-721** — `bind` heals a dead binding instead of interrogating you about it. Come
  back months later, after the workspace was deleted or the key revoked, and `bind` used
  to ask "Replace it?" about a binding that no longer worked — a confusing question at
  the exact moment you were least equipped to answer it. It now says the binding is no
  longer accepted, clears it, and reconnects. Only on the server's own refusal: a network
  failure still lands on the cautious path, because clearing a healthy credential to fix
  a problem your machine does not have would be worse than asking.

## 1.31.1 (2026-08-23)

- **RTSC-715** — setup no longer finishes by wiring a `retasc` command that is not there.
  Run as `npx @retasc/cli@latest bind`, the CLI asked whether `retasc` was on your PATH
  and got yes, because npx puts its own cache directory on the PATH of whatever it runs.
  So the answer was true while `bind` ran and false the moment it exited, and your agent
  started with `ENOENT: Executable not found in $PATH: "retasc"` after a setup that had
  reported success. It now checks that the command it found will still resolve afterwards,
  and falls back to a global install or a pinned `npx` launcher when it will not.

## 1.31.0 (2026-08-23)

- **RTSC-713** — your agent can set Retasc up for you. It runs `bind` itself now, so
  nothing asks you to open a terminal and type a command: you paste one line into the
  chat, click Approve in the browser that opens, and restart your agent. The command it
  runs is `bind --json`, the door built for a machine to drive.
- **RTSC-713** — `bind --json` reports what it did and what it still needs, one JSON
  object per line, and prints the approve URL the moment it exists rather than at the
  end. Your agent posts that URL to you as a link, which is what makes this work on a
  machine where the browser does not open by itself.
- **RTSC-713** — a setup that paused is no longer dressed as a crash. "Signed in, but you
  have not said which project this folder is for" exits 0 and says exactly that; only a
  real dead end exits non-zero. It used to exit 1 with `✗ UNAUTHENTICATED`, and an agent
  reading that reasonably concluded setup had failed and stopped, one question short of
  done, holding a session that had actually worked.
- **RTSC-713** — sign-in no longer refuses merely because nothing is attached to a
  terminal. It asks whether a browser can be reached, which is the thing that actually
  matters. SSH, containers and CI still refuse, and still refuse fast: over SSH the
  approve link targets `127.0.0.1` on whichever machine opened it, so it could never
  reach the CLI waiting on the remote host.
- **RTSC-713** — every outcome names the absolute folder it is about to connect, so a
  wrong one can be caught before anything is written. A wrong folder has no symptom
  otherwise: the agent still calls in and the Dash still looks healthy.
- **RTSC-691** — `retasc login` opens your browser instead of asking you to retype an
  eight-character code. Click Approve once and you are signed in, and you pick GitHub,
  Google or a passkey in the Dash where you are usually signed in already, instead of
  answering that question in the terminal. The device flow is still there and still
  works; it is the fallback now rather than the only door.
- **RTSC-691** — the code path stays for the places a browser round trip cannot work:
  inside a container, and over SSH, where the redirect would target `127.0.0.1` on
  whichever machine opened the link and so could never reach the CLI waiting on the
  remote host. `RETASC_NO_BROWSER=1` forces it everywhere.
- **RTSC-691** — `retasc release <RTSC-NN> --claim-token <token>` exists. Two error
  messages in `retasc claim` had been telling people to run it for a while, and it was
  not a command. The token is the one printed when you claimed; the server fences on it,
  which is what stops one agent releasing another's work. Releasing leaves your worktree
  and branch alone — `retasc tidy` is what reaps those.
- **RTSC-691** — `retasc bind` prints "restart your agent" whether or not a human is
  watching. It was suppressed when output was not a terminal, which is exactly when an
  agent is the one reading it and the one that has to pass the message on.
- **RTSC-691** — `bind` clears the credential-less bootstrap entry that would otherwise
  shadow the binding it just wrote, when the two land in different scopes.

## 1.30.0 (2026-08-20)

- **RTSC-681** — your agent can read a file you attached to an issue. Uploading has
  been one call since 1.24.0; reading one back needed an API key the model does not
  have and is told not to go looking for, so a certificate attached for an agent to
  verify was something it could see the name of and nothing else. `get_attachment_file`
  closes it: name the attachment id, the proxy downloads it with the credential it
  already holds and hands back a path to read. Any size, and the bytes never pass
  through the model's context.
- **RTSC-681** — downloads land under `.retasc/attachments/` in your workspace, one
  folder per attachment, never overwriting anything and never following a symlink, in
  a directory that ignores itself so a customer's certificate cannot be committed by
  accident. There is no destination argument on purpose: a write the proxy performs
  skips the prompt your harness would otherwise show you, so it only ever writes to
  the one place it owns. Copy the file where you want it and your normal tools ask you
  first, which is the point.

## 1.29.0 (2026-08-19)

- **RTSC-672** — every command we hand out now says `npx @retasc/cli@latest`. npx caches
  by spec, so a bare `npx @retasc/cli` can keep serving whatever version you first ran —
  which meant the people most likely to re-run a command, the ones who hit a bug and were
  told it was fixed, were exactly the ones liable to be served the broken build again.
  `@latest` is a tag, not a pin: it re-resolves every time and can never go stale, where a
  version number written into docs absolutely can.
- **RTSC-672** — a first-run failure names the build that produced it, so "it still
  doesn't work" and "you're running last week's CLI" stop looking identical.

## 1.28.0 (2026-08-19)

- **RTSC-676** — signing in opens your browser. It used to print a URL and an
  eight-character code and leave you to switch windows, navigate, and retype it. Now the
  page opens for you, pre-filled when the provider supplies RFC 8628's complete URL. The
  URL and code are still printed first and always: there is no browser inside a container
  or over SSH, which is where `bind` runs most, so the browser is a convenience layered
  on top and never the only way through. A missing `xdg-open` changes nothing.
  `RETASC_NO_BROWSER=1` turns it off.
- **RTSC-676** — the finish screen's closing lines are flush left, and it ends with a
  blank line instead of welding the shell prompt to the last thing you read.

## 1.27.0 (2026-08-19)

- **RTSC-673** — `bind` ends by telling you what to do, not by dumping config. It used to
  close on fourteen lines of MCP JSON plus "(Claude Code CLI not detected)": a block
  instructing you to paste something we had just written to disk for you, and a note that
  reads like a fault on a screen whose whole content is that everything worked. Between
  them they buried the one thing a new owner needed. Now it prints a receipt card — org,
  project, where the key went, what landed in your repo — and then says to start your
  agent. The closing lines follow the project: an empty one invites you to describe what
  you're building, a project with work in it tells you to say "next issue". The JSON still
  prints when the marker could not be written anywhere, which is the case it exists for.

## 1.26.0 (2026-08-19)

- **RTSC-670** — `retasc bind` can sign you in again. It has opened with the device flow
  since 1.20-era, but a leftover session guard in the command wrapper exited first, so on
  a machine that had never signed in — the only state a new owner is ever in — `bind`
  printed "Not signed in" and stopped. Owner onboarding dead-ended at its first
  documented command, on every release for three weeks. The guard was correct when it was
  written and became redundant the moment `bind` grew its own sign-in; nothing noticed
  because no test ran the CLI with no session. Four now do.
- **RTSC-671** — errors name the command you actually ran. Told to `npx @retasc/cli bind`
  and then answered with "Run `retasc login` first", you were pointed at a binary that
  invocation never installs — a recoverable stumble turned into a dead end. Every "run X
  first" message now renders `npx -y @retasc/cli@<version> …` or `retasc …` to match how
  you started it.

## 1.25.0 (2026-08-19)

- **RTSC-669** — the invite project picker takes several projects. 1.24.0 shipped it
  single-select, which left "two of these four" expressible nowhere: the workaround —
  repeating `--project-id` — needs ids that nothing in the CLI lists, which is the gap
  the picker existed to close. Answer `2,4` (or `2 4`) and the invite grants exactly
  those. Naming every project collapses to all projects, so the grant follows the org as
  it grows rather than freezing today's list. `1) All projects` can't be combined with
  individual ones: that's a contradiction about the widest grant there is, so it re-asks
  instead of guessing which half you meant.

## 1.24.0 (2026-08-19)

- **RTSC-667** — `retasc members invite` asks instead of demanding ids. It used to
  require `--org-id`, and the new `--project-id` made that worse: nothing in the CLI
  lists project ids, so a scoped invite meant fetching one from the Dash. Run it with no
  flags in a terminal and it asks which org (only the ones you can actually invite into)
  and which projects, with **All projects** as the first option rather than the thing you
  get by not answering. It asks nothing when there is nothing to choose — one eligible
  org, or fewer than two projects — and a script with no TTY behaves exactly as before.
  The flags still work and still win.
- **RTSC-666** — the PROJECTS column in `retasc members list` comma-joins, so two
  projects read as `XTRO, XTRO Marketing` rather than running together.
- **RTSC-664** — invite someone to one project, not the whole org. Membership was org-level,
  so anyone you invited read every project you had. `retasc members invite` now takes
  `--project-id <id>`, repeatable, and the invitee lands scoped to exactly those projects.
  Omitting it still grants every project, so an existing script keeps its behaviour untouched
  and an org that never scopes anyone never notices this shipped. `retasc members list` gains
  a PROJECTS column naming what each code confers, with `All` for the unscoped ones — an
  unscoped invite is the WIDEST grant, and a column that rendered it as a dash would read as
  "none". Enforcement is server-side at every door, agent auth included: a key whose project
  leaves its principal's scope stops authenticating on its very next call.

## 1.23.0 (2026-08-17)

- **RTSC-660** — the proxy attaches files for you. Attaching a file was the one Retasc write
  an agent could not finish on its own: the server handed back an upload URL and told the
  caller to POST the bytes with "your API key", which under MCP lives in the proxy, not in
  the model. Agents were resorting to reading the key out of `~/.retasc/bindings.json`, and
  harnesses were blocking that as credential harvesting. The proxy now serves
  `save_attachment_file(issue, path, title?)` itself: it reads the file and uploads it with
  the key it already holds, so nothing about the credential reaches the model and the bytes
  never pass through its context. Readable paths are confined to a root — `RETASC_ATTACH_ROOT`
  if set, otherwise the proxy's working directory — compared after resolving symlinks on both
  sides, with `.git` and non-regular files refused, because reading a file on the agent's
  behalf skips the harness's own file-access prompt. Every accepted read is logged to stderr
  with its resolved path. Calls that pass `contentBase64` instead are forwarded to the server
  untouched.

## 1.22.0 (2026-08-12)

- **RTSC-646** — the watchdog now says when it is **not** renewing a lease. Its lease set is
  in-memory and built only from claim traffic this proxy saw, so a claim made in another
  terminal, over direct HTTP MCP, or by a previous proxy before a harness restart was renewed
  by nobody — silently, until the reclaimer took the issue away mid-build. Touching such a
  lease now prints a warning naming the issue and what to do about it (`release_issue` is
  exempt: it ends a lease rather than needing one). A heartbeat rejected as `UNAUTHORIZED` is
  also called out loudly, once: that means the session's **credential** died, not the lease,
  so every claim stops renewing at the same moment and each lapses at its own expiry. The
  proxy keeps tracking and keeps trying, because re-minting the key inside the TTL recovers
  all of them. The `mcp install --watchdog` text no longer stops at "no per-claim
  heartbeats" — it names both bounds: the proxy must be running, and it only renews claims
  it saw this session make.

## 1.21.1 (2026-08-10)

- **RTSC-643** — `retasc gate install` keys the gate to **this folder's** project, not the
  machine-wide default. It used to read `defaultProjectPrefix` (stamped by whichever project
  you last ran `retasc init` for), so in a bound folder it could install a commit gate keyed
  to a different project — rejecting every valid commit — while reporting success. It now asks
  the folder's own binding first (`whoami` over the workspace key, or the keystore's cached
  prefix offline; a subdirectory run checks the git toplevel too), prints where the prefix
  came from, warns when the global default disagrees, and only uses the global default when
  the folder is genuinely unbound. Bound-but-unresolvable fails loudly instead of guessing.

## 1.21.0 (2026-08-07)

- **RTSC-527** — the re-import warning dates the last import in **your** timezone. The day
  was formatted from `toISOString()`, which rolls back one east of Greenwich: at UTC+7 an
  import made five hours ago read as yesterday's, which is the opposite of useful for a line
  whose job is to say how long ago it was. The Dash gained the same date in the same shape
  in this release, and moved onto the same durable per-source history the CLI already read,
  so the two surfaces now describe one import the same way.

## 1.20.0 (2026-08-04)

- **RTSC-561** — the org gained an **admin** role, and the CLI stopped refusing it.
  `retasc billing` gated on `role !== "owner"` client-side, so it would have refused an
  admin locally for a call the server allows. Owner-only copy in `bind` and the command
  help now names both roles.

## 1.19.0 (2026-08-03)

- **RTSC-495** — `retasc bind --setup <code>` sets a folder up with no sign-in and nothing
  to answer, so an agent can do it on behalf of someone who does not use a terminal.

  The Dash's connect step now hands over a block you paste to your agent, with this command
  inside it. Everything the interactive `bind` would ask was already answered in the
  browser, and the code carries those answers across. An agent's shell is not a TTY, so the
  ordinary path refuses it outright at the first prompt.

  ```
  npx @retasc/cli bind --setup rtscsetup_…
  ```

  The code is single-use and lives ten minutes. The alternative — pasting a real API key
  into the prompt — needed no backend at all, but would have left a long-lived credential in
  an agent's conversation history forever.

  A folder that is already connected is refused rather than silently replaced, and the
  refusal happens BEFORE the code is spent, so a mix-up costs nothing.

- **RTSC-532** — the agent says which folder it is in, and the key remembers.

  Binding the wrong folder used to look exactly like success: the agent still called in, so
  the Dash went green, while the folder you actually work in had no Retasc in it. The prompt
  now asks the agent to report its full path and wait before it runs anything, and the
  confirmation names the real path instead of "This folder".

  The key it creates is named after that folder, so the Keys page shows which folder each
  key belongs to (`client-a`) instead of naming them all after the project (`ENG key`).

## 1.18.0 (2026-08-02)

- **RTSC-530** — setting up from scratch now asks where your work comes from, and imports it
  in the same command.

  `retasc bind` used to offer one thing at the project step: name a new project. So someone
  arriving from Jira had to invent a project they didn't want, run `retasc import`
  afterwards to get the one they did, and leave the empty one behind — and projects can't be
  deleted individually.

  ```
  Where does your work come from?
    1) Linear
    2) Jira
    3) Asana
    4) ClickUp
    5) Shortcut
    6) Start from scratch   (name a project; your agents file into it)
  ```

  Pick a tracker and the import runs right there, then the folder binds to the project it
  created. Pick "start from scratch" and it behaves exactly as before. This is the same fork
  the Dash has always offered; importing isn't a separate errand, it's one of the ways a
  first project comes into existence.

  Only when the org has no projects — binding a second folder in an existing org is still
  just picking from the list. Declining at the import confirmation falls back to naming a
  project rather than abandoning setup: you still asked to bind the folder.

## 1.17.0 (2026-08-02)

- **RTSC-529** — the column mapping is a numbered picker, like every other prompt.

  It was the only one that made you type a word. Picking an org, a project, a source, a
  list, a reviewer, a sign-in door or whether to install globally are all numbered lists
  reading `Choose a number` — and the reviewer picker appears two lines below this one, so a
  single import taught two input styles within four lines of output.

  ```
    to do
      1) todo   (suggested)
      2) doing
      3) done
      4) canceled
    Choose a number [1]:
  ```

  Enter still takes the suggestion, now marked in the list rather than described beside it.
  Typing the word still works for anyone who has learned the vocabulary; it just isn't what
  the prompt advertises.

## 1.16.1 (2026-08-02)

- **RTSC-528** — two things the first real `retasc import` run turned up.

  **The progress bar never appeared.** It only started drawing once it had seen the run
  reported as running, and a 15-issue import finishes before that is ever observed, so the
  output went straight from `Importing…` to `✓ Imported.` with a silent gap. It now draws
  the moment the run starts, sweeping while it waits for counts and switching to the real
  bar once they arrive. Still silent without a terminal and under `NO_COLOR`.

  **The column prompt didn't say what to do.** It read
  `to do  [todo]  (todo / doing / done / canceled):`, where nothing is a verb, so the first
  person to run it had to guess that you type one of the words. Now:

  ```
    to do
      Enter to keep todo, or type: doing, done, canceled
    >
  ```

  The suggestion is no longer repeated among the alternatives, which is what made the old
  line read as four equal options behind a mysterious bracket.

## 1.16.0 (2026-08-02)

- **RTSC-526** — `retasc import` catches up with the Dash on four things.

  **It warns before a second import.** Re-importing does not duplicate anything, but it
  does re-sync: status, labels, title and body are replaced with whatever the source says
  now. Import from Jira, spend two weeks moving issues along in Retasc, re-import to pick up
  new tickets, and those two weeks of changes snap back. You now get told, with the date of
  the last import, before the confirmation.

  **The run shows progress**, as a bar that fills while it works, rather than a silent wait
  that looks like it has hung. The run is server-side, so pressing Ctrl-C out of boredom
  never stopped it anyway.

  **The column list is grouped** under your own tool's sections (Not started, Active, Done,
  Closed) instead of arriving flat. On a twenty-column board that is the difference between
  scannable and a wall.

  **Columns that were not mapped are named.** If a column appears between the moment you set
  the mapping and the moment the import runs, its issues land in `todo`. They used to show
  as a number; now they are listed, with what to do about it.

## 1.15.0 (2026-08-02)

- **RTSC-524** — new command: `retasc import`. Bring a Linear, Jira, Asana, ClickUp or
  Shortcut project across without opening a browser.

  This was the last thing the terminal could not do. Everything else — sign in, make or join
  an org, create a project, wire the folder, pull work — already worked end to end, but
  importing meant stopping and finishing in the Dash.

  ```
  retasc import
  retasc import --source jira --org-id …
  ```

  It walks you through the source, your credentials, which team or project to take, and then
  **what each of your columns means**. That last part is the point, and it is asked rather
  than guessed: a tool lets its users name their own columns, so the only honest way to know
  what one means is to ask you. Pressing Enter accepts a suggestion derived from the
  column's *type* in your tool, never its name — a column called "Rejected" that is really
  an in-progress lane maps to `doing`, not `canceled`.

  A column mapped to `review` needs a named reviewer, chosen per column, because two
  "awaiting acceptance" columns can belong to different people. Columns holding work nobody
  has started cannot be mapped to `review` at all, and the CLI says why rather than letting
  the server refuse it later.

  **Your source token is never an argument.** There is no `--token`, because anything passed
  that way lands in shell history and in `ps` output. Secrets are typed with echo off, or
  taken from `RETASC_IMPORT_<FIELD>` for scripted runs.

  The run is confirmed before anything is written, and afterwards you are offered the
  imported identity the migration just created for you, through the same prompt
  `retasc join` uses.

## 1.14.0 (2026-08-02)

- **RTSC-523** — setup asks before installing anything on your machine.

  `retasc bind` and `retasc join` are one command you paste and answer, and somewhere in the
  middle they ran `npm install -g @retasc/cli`. It said so, but it never asked. That is the
  only step in a folder-scoped command that changes the machine rather than the folder, and
  a shared npm prefix is exactly what plenty of developers keep clean.

  ```
  Install the retasc command on this machine?

    1) Yes, globally          A `retasc` command you can use anywhere.
                              Best if you'll use Retasc in more than one project.
    2) No, run it on demand   Nothing is installed. Your agent fetches it when it
                              starts, which adds a couple of seconds and needs a
                              network connection.
  ```

  Both answers leave the folder bound identically. Option 2 is not a per-project install:
  nothing is written to the folder, so it needs no `package.json` and cannot fail for want
  of an npm project. Your answer is remembered, because it is a question about the machine
  and the machine has not changed by the time you bind a second folder.

  You are only asked when it would actually happen. If `retasc` already works, there is
  nothing to decide and nothing is said.

  **Without a TTY it installs, exactly as before.** That is deliberate rather than a
  leftover: when an agent runs setup on someone's behalf, that person never types `retasc`,
  but their agent starts the MCP server every session, and the on-demand route would cost
  them seconds and a network dependency every single time. `--no-install` on `bind` and
  `join` declines without a TTY, for a developer whose own agent is doing the setup.

## 1.13.1 (2026-08-02)

- **RTSC-522** — the changelog is public, and five releases that were never written down now
  are.

  It used to be unreachable by anyone who installs the CLI: it did not ship in the tarball,
  the README never mentioned it, and the source repo is private so the npm repository link
  404s for the public. It is now at
  [docs.retasc.com/changelog](https://docs.retasc.com/changelog), and ships in the package.

  1.1.0, 1.1.1, 1.1.3, 1.2.1 and 1.2.2 were published and never described. They are
  reconstructed here from their release commits and the issues they reference, so every
  version on npm now has an entry. Each one carries its publish date.

  Also fixed two npm-facing details: the package description still said "sign in with
  GitHub", which stopped being the whole truth at 1.11.0, and the bug-report link pointed at
  a private repository that 404s for everyone npm showed it to.

## 1.13.0 (2026-08-02)

- **RTSC-521** — five commands stopped answering you with a JSON dump.

  `whoami`, `org create`, `project create`, `key list` and `members list` printed the raw
  payload. `whoami` is the one people actually noticed, because it is the command you run to
  find out who you are:

  ```
  {
    "orgs": [],
    "user": {
      "email": "you@example.com",
      "id": "mh7edhnpet55dqr9m48yked29s8bqr9j",
      "name": "Your Name"
    }
  }
  ```

  The one fact you wanted was a bracket to parse, next to a document id that means nothing.
  Now:

  ```
  Signed in    Your Name <you@example.com>
  Orgs         none
  ```

  `key list` and `members list` are aligned tables, and state reads as words: a revoked key
  says `revoked` rather than an epoch, and a spent invite shows no expiry date because the
  date stopped meaning anything. Auto-minted session keys are folded into a count instead of
  drowning the keys you can actually manage.

  Ids follow one rule: shown when a command takes them, dropped when nothing does. So
  `org create` gives you the org id and names the command that wants it, and never mentions
  `ownerMemberId`.

  **`--json` on all five, emitting exactly what they printed before.** Anything scripted
  against the old output keeps working by adding the flag.

  `whoami`'s binding block is unchanged. It was already the useful half.

## 1.12.0 (2026-08-02)

- **RTSC-519** — `retasc bind` now tells you it finished, and what to do next.

  It used to end on the last thing it *did* ("This folder is bound to org Acme / project
  ACM") and stop. So the person who set up their own org was left reading a status line and
  guessing whether anything else was required, while the invited teammate, who arrives
  through `retasc join`, was told. Both commands now end the same way:

  ```
  Start your agent in this folder, or restart it if it's already open, and it'll pull from the queue.
  ```

  The restart half matters: `.mcp.json` is read when an MCP client starts, so an agent
  already open on that folder won't see Retasc until it restarts — and `bind` is routinely
  run from inside a session that's already there.

  The sentence lives in the tail both commands share, rather than a copy in each, so
  neither can lose it again.

- **RTSC-507** — "none of these are me" now covers the tools you were asked about, not the
  whole org forever.

  Declining wrote one org-wide flag, checked before the list of imported people was even
  read. So the January answer "I was never in ClickUp" — correct, and the cheapest possible
  answer to give — meant that when the org migrated off Jira in June, where you *did* have
  an account, you were never offered your placeholder. Not by `retasc identity`, not by
  `retasc join`, not by the Dash, not ever. Your Jira authorship, comments and assignments
  stayed on a placeholder permanently, and only an owner could repair it.

  Claiming was already tracked per source, so someone who *claimed* their ClickUp identity
  was correctly re-asked at every later migration. Declining being the more final of the two
  was backwards.

  The decline row now names what it covers:

  ```
    3) None of these are me (covers ClickUp and Jira only)
  ```

  and `retasc identity` says so when nothing is left:

  ```
  You've answered about every tool imported into Acme so far.
  Run this again after the next migration, each one is asked about separately.
  ```

  That replaces wording saying the answer "covers the whole org, including later
  migrations" and pointing at an owner. It existed only to describe this bug.

  **Needs the matching backend deploy.** The copy above is a promise the server keeps, so
  publish this only after `convex deploy` and `migrations:backfillDismissedSources` have
  run. Against an older backend the CLI would say a later import will ask again, and it
  would not.

## 1.11.0 (2026-08-02)

- **RTSC-508** — you can now sign in with **Google**, not only GitHub.

  Google sign-in shipped for the web Dash first, which left a one-way street: an account
  created through that door reached the Dash and nothing else, because every login-gated
  command here sat behind a GitHub-only device flow. `retasc login` would start a GitHub
  device flow for an account GitHub had never heard of. That blocked `bind`, `init`, `key`,
  `members`, `billing` and `identity` outright — including the sign-in step *inside*
  `retasc bind` and `retasc join`, so a teammate invited through the web could not finish
  setting up their folder at all.

  With no flag, `login` now asks which door you use:

  ```
  How do you sign in to Retasc?
    1) GitHub
    2) Google
  Choose a number:
  ```

  After a successful sign-in the door is remembered, so later logins offer it back and
  Enter takes it:

  ```
  How do you sign in to Retasc?
    1) GitHub
    2) Google   (last used)
  Choose a number [2]:
  ```

  A default only ever appears once it is a recorded fact about you. On a first login there
  is none, and Enter is not an answer — because the wrong door is not a mistake you correct
  next time (see below). The remembered door is a default, not a lock: the other one is
  still one keystroke, and a typo re-prompts rather than being read as "the usual".

  `retasc login --google` / `--github` skip the question. A non-interactive run is
  unchanged: no prompt, GitHub, exactly as before. The same question appears inside `bind`
  and `join` when they sign you in for you.

  **Signing in through the wrong door is not a typo you correct on the next run.** Google
  and GitHub are deliberately separate identities — doors are linked only on a provider's
  own immutable account id, never on a matching email address, because email is an
  account-takeover vector. So a Google sign-in by someone who already has a GitHub account
  here creates a *second* identity with its own membership, and the CLI cannot merge them
  back. That is why the question is asked rather than guessed, and why a non-answer
  re-prompts instead of falling through to a door.

  Needs `AUTH_GOOGLE_DEVICE_ID` / `AUTH_GOOGLE_DEVICE_SECRET` on the deployment
  (`operations/runbooks/google-device-client.md`). Where they aren't set, the CLI says so
  in one line and names GitHub as the way in meanwhile, rather than failing opaquely.

## 1.10.0 (2026-08-01)

- **RTSC-477** — new command: `retasc identity`. It shows the people a migration carried
  into your org and asks which one is you — the same question `retasc join` asks, on demand.

  ```
  retasc identity              # defaults to your only org
  retasc identity --org-id …   # when you're in several
  ```

  `join` asks this once, at the moment you accept an invite. Placeholders arrive with
  *every* migration, though, and claiming is per source tool rather than per person: the
  backend is built for "claim your ClickUp one now, your Jira one in six months". So a team
  that onboarded by CLI a year ago had no terminal path to a later import's history at all,
  and had to open the Dash or leave it on placeholders. Three narrower cases `join` skips on
  purpose are covered too: `--yes`, a non-interactive run, and `--no-bind`.

  It asks the question, so it needs a TTY and refuses without one rather than exiting 0 in
  silence. There is deliberately no `--yes` and no `identity claim <name>`: linking someone
  pulls their authorship *and* their dispatch lane onto your account, irreversibly, with no
  CLI way back, so it is never answered on a script's behalf.

  It also names the ending, which `join` does not. "Nothing waiting for you" and "you've
  already said none of these are you" are the same empty list from the inside and mean
  opposite things — the second is permanent and org-wide, so it still applies after a later
  migration that really did carry you across. That case now says so, and points at the
  owner, who is the only one who can undo it.

## 1.9.0 (2026-07-31)

**Behaviour change, read this if you script `join`:** `retasc join <code>` used to redeem an
invite and stop. It now also sets up the folder you run it in — mints a key, writes a
binding, wires the MCP marker. **`--no-bind` reproduces the old behaviour exactly**, same
output and same exit code. Every other command is unchanged.

`join` also no longer exits 1 telling you to run `retasc login` first. It starts the device
flow itself when there is no session, and refuses with the same message `bind` uses when
there is no TTY to run one in.

- **RTSC-492** — `retasc join` is now the whole of an invited teammate's setup, in one
  command run from the folder their agent will work in:

  ```
  npx @retasc/cli join https://dash.retasc.com/join#rtscinv_…
  ```

  It signs them in (device flow, only when there is no session), redeems the invite,
  offers them any identity a migration carried across, picks the project, makes `retasc`
  durable, mints a key, binds the folder and wires the MCP marker. It used to be three
  commands with an ordering trap in them, and the first of those three was `retasc login`
  — which is not something you can tell someone who has installed nothing yet.

  The target case is that an invited teammate never opens the Dash at all. With no imports
  and one project, the only thing they type is the GitHub device code: every prompt is
  conditional on there being a real choice.

  - Takes a full invite link or a bare `rtscinv_…` code. The code is what the server
    matches, so unwrapping a paste belongs at the edge that accepts typed input, not in the
    mutation that grants membership.
  - A member is never offered a project they cannot create (`createProject` is owner-only),
    and an org with no projects names what to ask an owner for instead of failing opaquely.
  - Imported placeholders are offered once per source tool, each behind an explicit
    confirm, in the same words the Dash uses. `--yes` skips that question and never answers
    it: claiming another person's history is irreversible and has no CLI path back.
  - `--no-bind` keeps the old redeem-only behaviour for anything scripted against it.

  Under it, `bind` and `join` now share one implementation of the folder half — the project
  pick, the launcher ladder, the mint, the binding and the marker — so the fix that landed
  in 1.8.0 cannot drift back out of one of them.

- **RTSC-498** — `retasc doctor` now says which platform the CLI is actually tested
  on. Nothing in the product stated one: the READMEs never mentioned platforms and
  `package.json` declares only `engines.node`, so someone hitting a problem on Linux
  or Windows had no way to tell their own mistake from a bug from a platform we never
  targeted. macOS is the only platform we run end to end.

  It's a note in `doctor` rather than a line in the README on purpose. A README is read
  by everyone, and for the majority on macOS a standing disclaimer about platforms they
  aren't using is noise they read before they've even installed. `doctor` already knows
  which machine it's on, so the people the limit applies to are exactly the people who
  see it, and on macOS nothing is printed at all.

  The note claims a limit, not a blockage: much of the CLI is plain Node and should work
  fine, and `package.json` still carries no `os` field, so installing is never refused
  anywhere Node 18+ runs. Windows and Linux are named as platforms we intend to support
  properly; anything else is told it's untested without being promised a roadmap it
  isn't on.

## 1.8.0 (2026-07-31)

- **RTSC-493** — the MCP marker no longer names a command that may not exist. It
  used to hardcode `retasc`, which is only on PATH after a global install — but the
  Dash tells people to run `npx @retasc/cli bind`, and npx unpacks into its own cache
  and installs nothing. So a bind printed every success line, really did bind the
  folder, and left an agent that could not start the Retasc MCP server at all. The
  failure surfaced later, somewhere else, as a broken server rather than a failed setup.

  `bind` now resolves a launcher and **proves it by running it** before writing
  anything: it uses an existing `retasc` if there is one, otherwise installs the CLI
  globally, and if that install lands where PATH cannot see it, the marker names the
  binary's absolute path instead. Only when none of that works does it fall back to a
  version-pinned `npx`, which is slower and needs the network — and if even that will
  not start, it says so outright rather than reporting success.

  `retasc doctor` now checks the same thing, so a folder bound by an older version
  reports why its agent cannot start and names the repair.

## 1.7.2 (2026-07-21)

- **RTSC-297** — `retasc bind` no longer strands a new org silently. It creates
  the org server-side before the project picker runs, so aborting at the project
  step (reachable by a typo since 1.x's picker gives up after 3 bad answers) left
  an org behind with no project, no key, and no local binding — invisible from
  the CLI and quietly accruing on the billing rail. Bind now names the org and
  prints the exact resume command (`retasc bind --org-id <id>`) when it aborts
  before the workspace is bound. Selecting a pre-existing org and then aborting
  is untouched — nothing is reclaimed.

## 1.7.1 (2026-07-21)

- **RTSC-321** — the liveness watchdog now stops heartbeating an issue the moment
  it moves to `review` (RTSC-257): the server releases the lease there, so the
  proxy no longer pings a dead lease until the next heartbeat fails. It is treated
  as a release, not a close — the branch/worktree is preserved for the review + PR
  (never reaped). The reviewer's send-back (`review → todo`) still self-heals via
  the failed-heartbeat path, since it can't be told apart from a `doing → todo`
  edit by request args alone.

## 1.7.0 (2026-07-21)

- **RTSC-306** — `retasc claim` / `retasc next` now pull **lane-scoped by
  default**: only issues assigned to your principal or left unassigned, never
  another human's work. The old `--mine` flag is retired — that behavior is the
  default now. The new `--all-lanes` flag opts back into the whole ready pool
  when you need to pick up an absent teammate's work. When your lane is empty but
  ready work is stranded in another lane, the CLI says so and points you at
  `--all-lanes` instead of reading as "nothing to do".

## 1.6.3 (2026-07-20)

- **RTSC-266** — README now links the setup page, the docs quickstart, and the
  parallel-agents guide instead of only the bare homepage. npm package pages are
  a real entry point and only re-render on publish, so this ships as its own
  patch release. No code changes.

## 1.6.2 (2026-07-20)

- **RTSC-269** — `retasc bind`'s org/project picker no longer treats a typo as
  "create new". Answering `1)` (a fumbled `1`) used to select nothing and fall
  straight through to **creating a new org/project**, which then hit the owner
  gate and surfaced as a redacted Server Error. Invalid input now re-prompts;
  only the explicit trailing option creates. The answer must be plain digits, so
  the non-canonical forms `Number()` happily parses (`0x4`, `4e0`, `+4`, `4.0`)
  can't reach the create branch either.
- **RTSC-269** — the picker gives up after 3 invalid answers instead of looping,
  and a closed stdin (Ctrl-D, or a pipe running dry) now exits with an error
  rather than hanging. `readline.question()` never settles at EOF, so any prompt
  in `bind` could previously wedge the CLI with no output and no exit.

## 1.6.1 (2026-07-20)

- **RTSC-263** — owner/member permission denials now print a readable reason and the
  next step instead of an opaque `Server Error`. Hitting an owner-only command as a
  member reports "Owner role required." with "Ask `<owner>` to create a project." on its
  own line. The backend change does the work; the CLI already read the structured
  payload (1.5.0), so this release carries only the hardening below.
- **RTSC-263** — `formatError` now strips U+0085, U+2028 and U+2029 in addition to the
  ASCII control characters. All three are mandatory line breaks, so a server message
  interpolating a user-controlled name could previously forge extra lines in terminal
  output.

## 1.6.0 (2026-07-20)

- **RTSC-262** — `doctor` and `whoami` no longer report "not bound" for a folder whose
  Retasc MCP is registered in **Claude Code local scope** (the `claude mcp add` default —
  stored in Claude's own config, not `./.mcp.json`). The binding lookup now reads both
  legal per-folder locations, and when both exist the **local-scope entry wins**, matching
  Claude Code's documented precedence (local > project) — doctor names the org the agent
  *actually* uses, and warns when a differing `./.mcp.json` marker is being shadowed.
- **RTSC-262** — `claim`/`tidy`/`done` resolve the key through the same entry selection,
  so the CLI can no longer say "✓ bound" in one command and "No Retasc MCP key found" in
  another for the same folder.
- **RTSC-262** — the illegal-global-server check is now **presence-based**: a hand-added
  user-scope entry is detected in every shape (including keyless), and an unreadable
  `~/.claude.json` reports "cannot verify" instead of a false all-clear.
- **RTSC-262** — honest failure modes: server-unreachable (timeouts, 5xx, rate limits) is
  no longer reported as a rejected key, `whoami`/`doctor` requests are bounded by a 10s
  timeout, and server-derived strings are stripped of control characters before printing.
- **RTSC-262** — `bind` hardening: re-binding to the *same* org/project is an idempotent
  success (no key churn for provisioning scripts); replacing a *different* binding
  non-interactively without `--yes` now fails loudly with exit 1 instead of silently
  succeeding as a no-op; a cloned repo's committed marker no longer triggers the
  replace prompt (minting your own key under it is what `bind` is for).
- **RTSC-262** — (security) a keystore-resolved key now only ever travels to the
  keystore's own URL — a hostile `RETASC_MCP_URL` planted next to a committed secret-free
  marker can no longer redirect a teammate's real key.

## 1.5.0 (2026-07-20)

- **RTSC-261** — backend failures you're meant to act on now print what actually went
  wrong instead of `✗ Server Error`. Convex masks any plain server throw in production, so
  every precondition — a consumed invite code, an expired one, a suspended membership —
  reached the terminal as the same opaque string. `retasc join` was the worst case: an
  invited teammate hit an unreadable wall at the very first step.

  Errors now carry a machine-readable `code`, a readable `message`, and an optional `hint`
  printed on its own line:

  ```
  ✗ CONSUMED: This invite was already used.
    → ask an owner for a fresh invite link
  ```

  This release covers invite redemption; the remaining surfaces (auth/key problems,
  not-found lookups, billing gating, import/restore) follow. Internal invariants stay
  masked deliberately — those are our bugs, not yours, and their messages describe server
  state. **Upgrade before your teammates redeem invites**: an older CLI can't read the new
  payload and prints it as raw JSON.

## 1.4.0 (2026-07-19)

- **RTSC-279** — new `retasc billing` command: the org's whole billing picture in the
  terminal instead of only in the Dash. Prints the subscription and spending caps, what's
  owed right now, and the charge + confirmed on-chain payment history — both **org-scoped
  across every payment link the org has ever used**, so changing payment link no longer
  hides prior history. Owner-only (it reuses the same owner-gated functions the Dash
  renders; the client-side role check is UX, the server still gates). `--org-id` selects the
  org when you belong to more than one, `--json` emits the raw payload. Payments are a live
  read of Xenarch's authoritative records and degrade to a note rather than failing the
  command.
- **RTSC-279** — (server-side, no CLI change) the MCP usage meter now reports **two**
  clearly-named figures instead of one misleading `wouldBeBillUsd`:
  `lifetimeMeteredEstimateUsd` (all-time activity repriced at today's rate card — a
  diagnostic, not an amount owed) and `pendingUsd` (what is actually owed right now, the
  same figure the Dash shows). A new `billing_summary` MCP tool exposes the full billing
  detail to agents whose human principal owns the org.

## 1.3.2 (2026-07-17)

- **RTSC-250** — serialize `patchConfig` under a cross-process advisory lock so
  concurrent CLI/MCP processes can't lose an update. Previously a lock-free
  load-modify-save meant a `defaultOrgId`/`defaultProjectPrefix` write racing the
  hourly token refresh could write back the old single-use `refreshToken`,
  breaking the next refresh and forcing a device re-login a non-interactive
  context can't perform. The lock re-reads the freshest config inside the
  critical section and stamps a nonce so a stolen-from holder never deletes the
  new owner's lock. Also sweeps orphaned `.config.json.<uuid>.tmp` files left by a
  hard kill, age-gated so a concurrent writer's in-flight temp is never touched.

## 1.3.1 (2026-07-17)

- **RTSC-179** — atomic config write (temp file + rename) so a reader never sees
  a truncated `config.json`; adds `RETASC_DIR` support.
- **RTSC-178** — token refresh now classifies transient backend errors vs a
  genuinely expired refresh token, so a one-off backend blip no longer drags a
  valid session through a full device re-login.

## 1.3.0 (2026-07-08)

- Auto-reap branches on MCP close: when the watchdog proxy observes a session's
  own claim close terminally and successfully, it removes that issue's clean,
  merged `rtsc-NN/*` worktree and branch out-of-band (`retasc tidy --prune --only
  <id>`), instead of orphaning them until a human ran `retasc tidy`. Exposes
  `tidy --only <RTSC-NN>`.

## 1.2.4 (2026-07-07)

- **RTSC-170** — credential-file permission hardening: `config.json`,
  `bindings.json`, and the fallback `.mcp.json` are written `0600` (dirs `0700`)
  with no world-readable creation window.

## 1.2.3 (2026-07-05)

- **RTSC-150** — watchdog `isClaimLost` fix: no longer drops a live lease when a
  payload field merely contains the string `CLAIM_LOST`.

## 1.2.2 (2026-07-04)

- **RTSC-148** — `retasc claim` takes the issue as a positional argument, and never
  silently falls through to `next_issue`.

  `retasc claim 143`, `claim RTSC-143` and `claim rtsc-143` all resolve to that issue; a
  bare number expands against the *workspace's* prefix, resolved over the workspace key
  rather than global config. Excess arguments now error loudly instead of being dropped by
  Commander, which was how "claim this specific issue" quietly became "claim whatever is
  next".

## 1.2.1 (2026-07-04)

- **RTSC-143** — one tolerant tool-result parser, and a loud failure when the claim fence
  is off.

  The proxy and `claim` each had their own silent copy of the parser; they are now one
  (`lib/toolresult.ts`), which recovers the leading JSON value when a footer trails the
  payload, refuses to recover from an `isError` response or concatenated JSON, and warns on
  stderr when it degrades so a shape regression is never silent.

  Session-key minting retries once with a 5s timeout and checks `res.ok`. On a double
  failure it still fails soft, but says loudly that the per-session claim fence is OFF, and
  the proxy appends that notice to `whoami` so the agent sees the degraded state rather than
  it sitting in an MCP log file nobody opens.

## 1.2.0 (2026-07-04)

- **RTSC-137** — org-membership commands: `retasc members invite|list|revoke` and
  `retasc join`.

## 1.1.3 (2026-07-02)

- **RTSC-131** — `retasc --version` reads `package.json` instead of a frozen literal.

  It was hardcoded to `1.1.1`, so the published 1.1.2 still reported 1.1.1. The version is
  now read at runtime relative to the compiled file, making `package.json` the single source
  of truth.

## 1.1.2 (2026-07-02)

- **RTSC-130** — republish the bind auto-wire fix that had changed CLI source
  without a version bump (npm versions are immutable).

## 1.1.1 (2026-06-28)

- **RTSC-98** — `claim`, `tidy` and `done` resolve the keystore key through the same
  resolver the proxy uses.

  After 1.1.0 moved keys out of the repo, a secret-free `.mcp.json` was understood by the
  proxy but not by those three commands, which still only knew the legacy inline-key path
  and bailed with "No Retasc MCP key found". The two resolvers had drifted, so they are now
  one (`resolveConn` in `lib/keystore.ts`): explicit `RETASC_MCP_KEY`, then a legacy inline
  key, then the canonical secret-free marker. Legacy markers keep working.

## 1.1.0 (2026-06-28)

- **RTSC-92** — workspace keys move to a home keystore, and the folder marker becomes
  secret-free.

  Secrets no longer sit in a project tree. The key lives in `~/.retasc/bindings.json` (mode
  0600), keyed by an opaque workspace id rather than a path, so nothing leaks a home
  directory and a checkout stays portable across a team. What lands in the repo is a marker
  carrying only that id, which is why `./.mcp.json` is safe to commit.

  `doctor` reports whether a binding is keystore-backed or legacy, and flags a workspace id
  already bound at a different folder. A cloned repo whose marker has no key on this machine
  is reported as such rather than as broken.

## 1.0.0 (2026-06-27)

- **RTSC-89** — initial npm publish as `@retasc/cli` (bin stays `retasc`).
