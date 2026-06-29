---
name: handoff
description: Hand the current session off to a fresh one when context is drifting from optimal — invoke this when a [context-handoff] nudge fires, when the statusline shows a high ctx %, when you notice drift (re-reading files you already read, a post-compaction "continued from previous conversation" summary, losing the thread), or whenever the user types /handoff. It refreshes durable memory (if any), writes a high-fidelity HANDOFF.md, then opens a new terminal session — named for tracking and seeded to continue from the handoff — and offers to close the old one.
---

# Handoff — pass the baton to a fresh session

A long session degrades: the context window fills, early turns get compacted away, and you start re-reading and losing the thread. You cannot see your own context % — a hook (`context-gauge.js`) measures it from the transcript and nudges you, and the statusline shows it to the user. This skill captures the session's full-fidelity state **while you still hold it** and hands it to a clean session.

## When to run it
- A `[context-handoff]` nudge appeared in context (the gauge crossed a threshold).
- The statusline shows a yellow/red `ctx %`.
- You notice drift even without a nudge: re-reading files already read, a post-compaction summary, repeating yourself, losing track of the goal.
- The user typed `/handoff` (run it regardless of how full context is).

## Rule: finish the current step first
If you're mid-edit or mid-action, **complete it and reach a clean stopping point before handing off** — never leave a half-applied change. (Exception: an `urgent`-tier nudge means wrap up fast and hand off.)

## Steps (do them in order)

**1 — Read the current context level.** If a nudge already told you the %, use it. Otherwise:
```
node "{{RUNTIME}}/context-gauge.js" --probe
```
Prints `{ contextTokens, limit, pct, tier, model }`. Note `pct` — you'll stamp it into the handoff.

**2 — Refresh durable memory (if you have any).** Capture genuinely **new, durable, reusable** facts learned this session (project state/decisions, a hard-won landmine, a preference) into whatever memory system you use — Claude Code's auto-memory, your project `CLAUDE.md`, or your own notes. Update existing notes rather than duplicating; use absolute dates. If you have no durable-memory system, **skip this** — the HANDOFF doc below carries the working state. Never invent notes.

**3 — Find where the handoff goes.**
```
node "{{RUNTIME}}/context-gauge.js" --where
```
Prints `{ key, dir, handoffPath, sidecarPath }` for this session. Use those **exact** paths. Get a timestamp:
```
node -e "console.log(new Date().toISOString())"
```

**4 — Write the handoff doc** to `handoffPath` (`HANDOFF.md`). Author it yourself at full fidelity — the next session inherits only what you write here, so capture the *epistemic* state (what you tried, what bit you, what's proven vs assumed), not just the operational one. Structure — **if a section is empty, write "None — <reason>" rather than omitting it** (the absence of a landmine is itself signal):

```markdown
# HANDOFF — <short title>   ·  ctx <NN>% at <ISO time>

> High-fidelity handoff authored by the working session at context drift. Ends with a ready-to-go cold-start.

## Snapshot
- **What this is:** <one line>
- **Where things stand:** <2–4 sentences>

## NEXT ACTION
<the single most important next step — exact file / command / decision, actionable immediately>

## What just happened
- <recent meaningful actions & decisions, most recent first>

## Key files, paths, commands & IDs
- <absolute paths, commits, branches, URLs, IDs, exact commands>

## Open questions / blockers / user-gated
- <waiting-on items>

## Decisions & constraints (do not relitigate)
- <decision> — chose because <why> — rejected <alternative(s)> because <why-NOT> (always include the why-not; a verdict without its argument gets relitigated)

## Tried & rejected (do not retry)
- <approach you attempted> — abandoned because <what actually went wrong / why it can't work> (write "None — nothing was tried and dropped" if empty)

## Gotchas / landmines
- <non-obvious trap, ordering constraint, footgun, or env quirk the next session will hit> (write "None observed" if empty)

## Verified vs assumed
- **Verified:** <claim> — proven by <exact command → the observed output you actually saw>
- **Assumed (unproven — re-check before relying on it):** <belief you're acting on but never confirmed> (write "None — everything below was observed" if empty)

## Cold-start prompt (paste this into a fresh session)
<a complete, self-contained paragraph that re-bootstraps the work from zero: what we're building, where we are, the exact next action, and which files to read first>
```

**5 — Choose a meaningful session name** so it's trackable in the prompt box, the tab title, and `/resume`. Short (≤ 50 chars), CLI-safe — letters, digits, spaces, dashes only; **no quotes, semicolons, or `%`**. e.g. `auth refactor — continue`.

**6 — Write the sidecar** `handoff.json` to `sidecarPath`:
```json
{ "at": "<ISO timestamp>", "contextPct": <NN>, "sessionId": "<this session id>", "newSessionName": "<the name from step 5>" }
```

**7 — Open the new session.**
```
node "{{RUNTIME}}/launch-handoff.js" --cwd "<this session's cwd>" --handoff "<handoffPath>" --name "<name from step 5>"
```
By default (`config.newSessionMode: "agent"`) this starts a **background session that appears in `claude agents`** (Agent View) — **no new terminal**, cross-platform — named + seeded to read `HANDOFF.md` and carry out its NEXT ACTION **in auto mode** (`config.newSessionFlags`, default `--permission-mode auto`; if it needs approval it surfaces under "Needs input"). The launcher returns the session **`id`** and an exact **`claude attach <id>`** command — relay them. (Other modes: `"tab"`/`"window"` open a Windows Terminal tab/window; on macOS/Linux those print a manual command.) If `config.trustNewSessionFolder` is enabled it pre-accepts the folder's trust dialog (off by default — it edits a Claude Code security gate; especially relevant in agent mode since a background session has no terminal to accept it). Tip: add `--dry-run` to preview.

**8 — Offer to close THIS (old) session.** Report the context %, what memory you refreshed, and that the new session `<name>` is in **`claude agents`** — give the `claude attach <id>` command from the launcher output (or, in tab/window mode, that it opened directly). Then **ask in chat**: *"Close this old session too?"*
- **If yes:** `node "{{RUNTIME}}/close-session.js"` — ends THIS session via the daemon (`claude stop <short-id>`, windowless) and deletes its bg-agent **job record** so it leaves the `claude agents` list (non-destructive — the conversation transcript is kept). Do **not** taskkill: the shared `claude daemon run` supervisor RESPAWNS a killed session. **Caveat — FleetView keep-alive:** if the old session is open/active in **Agent View**, FleetView can **re-dispatch it via `--resume`** a minute or two after the stop (there's no CLI to remove an agent from FleetView's tracked set), so it may reappear — tell the user to **dismiss it (✕) in Agent View** if it does.
- **If no:** leave it open.

Always also print the **Cold-start prompt inline** and the `HANDOFF.md` path as a fallback (in case auto-launch didn't apply, e.g. non-Windows). Keep the final message tight.
