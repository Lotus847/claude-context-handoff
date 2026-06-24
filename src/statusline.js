'use strict';
// Statusline: formats Claude Code's native `context_window` (authoritative — its
// used_percentage = total_input_tokens / context_window_size = (input + cache_creation +
// cache_read) / window; verified to match /context). Renders an ACCUMULATING bar.
//
// Claude Code's reported total_input_tokens bounces between the main-loop context and
// smaller sub-call contexts, so a raw % jitters. We keep a per-session HIGH-WATER MARK
// (in tmp) so the bar climbs smoothly and only drops on a big fall (= a real compaction).
// Must stay instant.

const fs = require('fs');
const path = require('path');
const os = require('os');
const c = require('./lib/common');

const A = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m' };
let input = {}; try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}

const cfg = c.loadConfig();
if (cfg.debug) { try { fs.appendFileSync(path.join(c.RUNTIME_DIR, 'statusline.log'), JSON.stringify({ cw: input.context_window || null, sid: input.session_id }) + '\n'); } catch {} }

const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || '';
const proj = cwd ? (path.basename(cwd) || 'home') : 'home';
const model = (input.model && (input.model.display_name || input.model.id)) || '';
const cw = input.context_window || null;

function barStr(pct, width) {
  const f = Math.max(0, Math.min(width, Math.round(pct / 100 * width)));
  return '█'.repeat(f) + '░'.repeat(width - f);
}

let ctxStr;
if (cw && typeof cw.used_percentage === 'number') {
  const size = cw.context_window_size || 0;
  const curTok = cw.total_input_tokens != null ? cw.total_input_tokens
               : (cw.current_usage ? c.contextTokensFromUsage(cw.current_usage) : 0);
  let peakTok = curTok;
  try {
    const sid = input.session_id || 'nosid';
    const pf = path.join(os.tmpdir(), `claude-handoff-bar-${sid}.json`);
    const prev = c.readJson(pf, null) || {};
    const prevPeak = prev.peakTok || 0;
    peakTok = (size && (prevPeak - curTok) > 0.30 * size) ? curTok : Math.max(prevPeak, curTok); // big drop = compaction → reset
    fs.writeFileSync(pf, JSON.stringify({ peakTok }));
  } catch {}
  const pct = size ? Math.round(peakTok / size * 100) : cw.used_percentage;
  const sizeK = size >= 1e6 ? (size / 1e6) + 'M' : Math.round(size / 1000) + 'k';
  const tier = c.handoffTier(size ? peakTok / size : 0, peakTok, cfg); // color by the real trigger tier (incl. token floors)
  const color = tier === 'urgent' ? A.red : tier === 'notify' ? A.yellow : A.green;
  let body = `[${barStr(pct, 14)}] ${pct}%`;
  if (size) body += ` (${Math.round(peakTok / 1000)}k/${sizeK})`;
  const hint = tier === 'urgent' ? `  ${A.bold}${A.red}⚠ /handoff${A.reset}` : tier === 'notify' ? `  ${A.yellow}⚠ soon${A.reset}` : '';
  ctxStr = `${color}🧠 ${body}${A.reset}${hint}`;
} else {
  ctxStr = `${A.dim}🧠 ctx —${A.reset}`;
}

const parts = [`${A.dim}${proj}${A.reset}`, ctxStr];
if (model) parts.push(`${A.dim}${model}${A.reset}`);
process.stdout.write(parts.join(`${A.dim} │ ${A.reset}`));
process.exit(0);
