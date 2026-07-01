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

// Subscription plan-quota gauge: the account-wide rolling 5h + weekly limits Claude Code pipes in
// as `rate_limits` (Pro/Max only; populated after the first API response). Same across all sessions.
// Renders compact, e.g.  📊 5h 44% (3.7%/15m) ↺ 2h13m room · wk 18%
const ucfg = cfg.usage || {};
let usageStr = '';
if (ucfg.enabled !== false) {
  const rl = input.rate_limits || input.rateLimits || null;
  const showAt = ucfg.showResetPct != null ? ucfg.showResetPct : 0.80;
  const seg = (w, kind) => {
    if (!w || typeof w.used_percentage !== 'number') return null;
    const pct = Math.round(w.used_percentage);
    const frac = pct / 100;
    const tier = c.usageTier(frac, ucfg);
    const col = tier === 'urgent' ? A.red : tier === 'notify' ? A.yellow : A.green;
    let s = `${col}${kind} ${pct}%${A.reset}`;
    const rat = w.resets_at != null ? w.resets_at : w.resetsAt;
    if (kind === '5h') {
      // live burn rate (%/15m) + countdown + pace verdict — your pace, how long, and whether it fits
      const rate = c.fiveHourRate(pct, rat);
      if (rate != null) s += `${A.dim} (${Math.round(rate * 10) / 10}%/15m)${A.reset}`;
      const cd = c.formatCountdown(rat);
      if (cd) s += `${A.dim} ↺ ${cd}${A.reset}`;
      const pace = rate != null ? c.usagePace(pct, rate, rat) : null;
      if (pace) {
        if (pace.state === 'out') s += ` ${A.red}⚠ out ~${pace.etaMin}m${A.reset}`;
        else if (pace.state === 'track') s += ` ${A.yellow}on-track${A.reset}`;
        else s += ` ${A.green}room${A.reset}`;
      }
    } else if (frac >= showAt) {
      const r = c.formatReset(rat, kind);
      if (r) s += `${A.dim} ↺ ${r}${A.reset}`;
    }
    return s;
  };
  const segs = [
    seg(rl && (rl.five_hour || rl.fiveHour), '5h'),
    seg(rl && (rl.seven_day || rl.sevenDay), 'wk')
  ].filter(Boolean);
  if (segs.length) usageStr = `${A.dim}📊${A.reset} ` + segs.join(`${A.dim} · ${A.reset}`);
}

const parts = [`${A.dim}${proj}${A.reset}`, ctxStr];
if (usageStr) parts.push(usageStr);
if (model) parts.push(`${A.dim}${model}${A.reset}`);
process.stdout.write(parts.join(`${A.dim} │ ${A.reset}`));
process.exit(0);
