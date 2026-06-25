# claude-context-handoff

**A Claude Code session that notices when its own context window is filling, writes a high-fidelity handoff, and opens a fresh session to continue — automatically.**

Long Claude Code sessions degrade: the context window fills, early turns get compacted away, and the model starts re-reading files and losing the thread. The problem is that **a session can't see its own context usage** — there's no built-in signal telling the model "you're getting full."

This fixes that with two sensors and one action:

- **A gauge hook** (the model's eyes) reads the real per-turn token usage Claude Code records in the transcript, and when you cross a threshold it injects a `[context-handoff]` nudge the model reads.
- **A statusline** (your eyes) shows a live *accumulating* bar `🧠 [████████░░░░░░] 64% (640k/1M)`, green → yellow → red.
- **A `/handoff` skill** (the hands) that — on the nudge, or when you type `/handoff` — writes a full-fidelity `HANDOFF.md` (authored while the session still holds the full context), then **opens a new session — by default a background session in `claude agents` (Agent View), with no new terminal — named and seeded to continue**, and offers to close the old one.

## Install

Requires [Node.js](https://nodejs.org) 18+ and [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/Lotus847/claude-context-handoff
cd claude-context-handoff
node install.js
```

That copies the runtime to `~/.claude/context-handoff`, installs the `/handoff` skill, and merges the gauge hook + statusline into `~/.claude/settings.json` (it backs up first, preserves your existing hooks, and is safe to re-run). Claude Code re-reads hooks/statusline/skills **live**, so it's active in open chats on their next prompt — no restart needed.

Remove with `node uninstall.js`.

## Usage

- **Automatic:** as context fills, the statusline turns yellow then red, and the model gets a `[context-handoff]` nudge to finish its step and hand off.
- **Manual:** type `/handoff` anytime.

Either way, `/handoff`:
1. reads the current context %,
2. refreshes whatever durable memory you have (native auto-memory / `CLAUDE.md` / your notes — skipped if you have none),
3. writes `~/.claude/context-handoff/handoffs/<project>/HANDOFF.md` with a ready-to-paste cold-start,
4. opens a **new session in `claude agents`** (Agent View) by default — named for tracking, seeded to read the handoff, running **in auto mode**, and prints a `claude attach <id>` command (or a Windows Terminal tab/window if you set `newSessionMode`),
5. asks whether to close the old session.

## Configuration

Edit `~/.claude/context-handoff/config.json` (re-read live):

| Key | Default | Meaning |
|-----|---------|---------|
| `notifyPct` | `0.55` | Notify % gate — binds on 200k windows (≈ the quality knee) |
| `urgentPct` | `0.70` | Urgent % gate — binds on 200k; safely below the ~83.5% auto-compaction ceiling |
| `softCapTokens` | `300000` | Absolute **notify** floor (tokens) — binds on large (1M) windows, where a % gate fires far too late |
| `urgentCapTokens` | `450000` | Absolute **urgent** floor (tokens) — binds on large windows (~where context-rot clearly degrades) |
| `contextLimitTokens` | `null` | Pin your window size (e.g. `1000000`); `null` = auto-detect |
| `newSessionFlags` | `"--permission-mode auto"` | Flags for the launched session. `""` for none; `"--dangerously-skip-permissions"` for fully hands-free (disables **all** gates) |
| `newSessionMode` | `"agent"` | `"agent"` = background session in `claude agents` (Agent View; no terminal, cross-platform); `"tab"` = new Windows Terminal tab; `"window"` = separate window |
| `trustNewSessionFolder` | `false` | Pre-accept the folder's trust dialog (see Security) |

## Platform support

| Feature | Windows | macOS / Linux |
|---------|:-------:|:-------------:|
| Gauge hook + statusline + `/handoff` doc | ✅ | ✅ |
| Launch new session — **`agent`** mode (`claude --bg`, default) | ✅ | ✅ |
| Launch — `tab` / `window` mode | ✅ (Windows Terminal / `start`) | ⏳ prints the manual command |
| Auto-**close** the old session | ✅ | ⏳ close manually |

The default `agent` mode (background session in Agent View) works everywhere. The cross-platform auto-close uses `claude stop` (daemon-clean — a *killed* session would just respawn) plus a job-record delete; the Windows-only `tab`/`window` modes use `wt`/`cmd`; the macOS/Linux seam is `src/lib/platform.js`. **PRs welcome.**

## Security notes

- Launched sessions default to `--permission-mode auto` (auto-approves safe actions, still gates risky ones) — **not** a full bypass.
- `trustNewSessionFolder` is **off by default**. Turning it on makes the launcher set `hasTrustDialogAccepted=true` for the launched folder in `~/.claude.json`, skipping Claude Code's workspace-trust dialog. That's a convenience that disables a safety gate — only enable it if you understand the trade-off.
- Closing the old session is a **force-terminate** of that session's process, so Claude Code's own `Stop`/`SessionEnd` hooks may not run. If you rely on those, close the tab manually.

## How it works

Claude Code writes each assistant turn's token `usage` into the session transcript, and hands the statusline a `context_window` object — both give the true context size (`used% = (input + cache_creation + cache_read) / context_window_size`, matching `/context`). The gauge reads it, compares against the trigger thresholds, and nudges once per tier crossing (re-arming after a compaction drops the window). The statusline tracks a per-session **high-water mark** so the bar *accumulates* smoothly instead of bouncing when Claude Code momentarily reports a smaller sub-call context. The `/handoff` skill is the high-fidelity, *active* complement to passive auto-summaries: it's authored by the session that still holds the full context.

**How the trigger point is computed.** Two forces set it: (1) Claude Code **auto-compacts at ~83.5%** of the window (scales: ~167k on 200k, ~835k on 1M), so the handoff must fire below that with ~15k headroom; (2) **quality degrades long before that** — for reasoning-heavy agent work, "context rot" onset is ~300-450k tokens *regardless of window size* (RULER, NoLiMa, Chroma context-rot research). So a pure percentage gate is right for 200k windows but far too late for 1M (70% = 700k, well past the rot onset). The trigger is therefore **`min(percentage gate, absolute token floor)`**: the `*Pct` gates bind on 200k windows; the `*CapTokens` floors bind on 1M windows, catching quality erosion at ~30-45% instead of waiting for 70%.

## License

MIT © Loreto Chiovari
