'use strict';
// context-gauge — UserPromptSubmit hook. A Claude session can't see its own context
// usage; this reads the real per-turn token usage Claude Code records in the transcript,
// computes how full the window is, and once a threshold is crossed injects a
// [context-handoff] nudge telling the model to finish the step then invoke /handoff.
//
//   (hook JSON on stdin)                  -> gauge, maybe nudge
//   node context-gauge.js --probe [path]  -> print computed ctx% (sanity check vs /context)
//   node context-gauge.js --where [cwd]   -> print handoff paths for a folder (used by /handoff)

const fs = require('fs');
const path = require('path');
const os = require('os');
const c = require('./lib/common');

const argv = process.argv.slice(2);
const cfg = c.loadConfig();
const k = n => Math.round(n / 1000);

if (argv.includes('--where')) {
  const cwd = argv[argv.indexOf('--where') + 1] || process.cwd();
  const session_id = process.env.CLAUDE_CODE_SESSION_ID || '';
  process.stdout.write(JSON.stringify(c.handoffPathsFor(c.projectKeyFrom({ cwd, session_id })), null, 2) + '\n');
  process.exit(0);
}

if (argv.includes('--probe')) {
  const explicit = argv[argv.indexOf('--probe') + 1];
  const tpath = (explicit && !explicit.startsWith('--')) ? explicit : findNewestTranscriptForCwd(process.cwd());
  const out = { transcript: tpath || null };
  if (tpath) {
    const u = c.readLastUsage(tpath);
    if (u) {
      const limit = c.resolveContextLimit({ model: u.model, contextTokens: u.contextTokens, cfg });
      out.model = u.model; out.contextTokens = u.contextTokens; out.limit = limit;
      out.pct = +(u.contextTokens / limit * 100).toFixed(1);
      out.tier = c.handoffTier(u.contextTokens / limit, u.contextTokens, cfg);
    } else out.error = 'no usage found in transcript tail';
  } else out.error = 'no transcript found for cwd ' + process.cwd();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

// ---- hook -------------------------------------------------------------------
try {
  if (cfg.enabled === false) process.exit(0);
  const input = c.parseHookInput();
  if (cfg.debug) {
    try { fs.appendFileSync(path.join(c.RUNTIME_DIR, 'context-gauge.log'),
      `[gauge] keys=${Object.keys(input).join(',')} context_window=${JSON.stringify(input.context_window || null)}\n`); } catch {}
  }

  let contextTokens, limit;
  const cw = input.context_window;
  if (cw && typeof cw.used_percentage === 'number') {
    limit = cw.context_window_size || c.resolveContextLimit({ hookInput: input, cfg });
    contextTokens = cw.total_input_tokens != null ? cw.total_input_tokens
                  : (cw.current_usage ? c.contextTokensFromUsage(cw.current_usage)
                  : Math.round((cw.used_percentage / 100) * limit));
  } else {
    const tpath = input.transcript_path || input.transcriptPath;
    if (!tpath) process.exit(0);
    const u = c.readLastUsage(tpath);
    if (!u || !u.contextTokens) process.exit(0);
    contextTokens = u.contextTokens;
    limit = c.resolveContextLimit({ hookInput: input, model: u.model, contextTokens, cfg });
  }

  const pct = contextTokens / limit;
  const tier = c.handoffTier(pct, contextTokens, cfg);
  const sid = c.sessionIdFrom(input);
  const marker = c.gaugeMarkerPath(sid);
  const prevTier = (c.readJson(marker, {}) || {}).tier || null;

  if (c.tierRank(tier) < c.tierRank(prevTier)) { try { fs.writeFileSync(marker, JSON.stringify({ tier })); } catch {} process.exit(0); }
  if (!tier || c.tierRank(tier) <= c.tierRank(prevTier)) process.exit(0);

  try { fs.writeFileSync(marker, JSON.stringify({ tier })); } catch {}
  const pctStr = Math.round(pct * 100) + '%';
  const msg = tier === 'urgent'
    ? `[context-handoff] ⚠ Context is ~${pctStr} full (~${k(contextTokens)}k of ${k(limit)}k tokens) — quality is degrading and auto-compaction is near. Wrap up the current action NOW, then invoke the /handoff skill immediately to write a high-fidelity handoff and open a fresh session.`
    : `[context-handoff] Context is ~${pctStr} full (~${k(contextTokens)}k of ${k(limit)}k tokens) — drifting past optimal usage. Finish the current step cleanly, then invoke the /handoff skill to write a handoff prompt and continue in a fresh session.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg } }));
} catch {}
process.exit(0);

// Newest *.jsonl under ~/.claude/projects/* whose recorded cwd matches (best-effort).
function findNewestTranscriptForCwd(cwd) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const target = String(cwd).replace(/[\\/]+/g, '/').toLowerCase();
  let best = null, bestM = -1, folders = [];
  try { folders = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const folder of folders) {
    const fdir = path.join(projects, folder);
    let files = [];
    try { files = fs.readdirSync(fdir).filter(f => f.endsWith('.jsonl')); } catch {}
    for (const f of files) {
      const fp = path.join(fdir, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs <= bestM) continue;
      let head = ''; try { const fd = fs.openSync(fp, 'r'); const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, 65536, 0); fs.closeSync(fd); head = b.toString('utf8', 0, n); } catch { continue; }
      const m = head.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (m && m[1].replace(/\\\\/g, '/').replace(/[\\/]+/g, '/').toLowerCase() === target) { best = fp; bestM = st.mtimeMs; }
    }
  }
  return best;
}
