'use strict';
// Self-contained helpers for the context-handoff system. No external dependencies.
// Installed to <runtime>/lib/common.js where <runtime> defaults to ~/.claude/context-handoff.

const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_DIR = path.join(__dirname, '..');                 // <runtime> (this file is <runtime>/lib/common.js)
const CONFIG_PATH = path.join(RUNTIME_DIR, 'config.json');
const DATA_DIR = path.join(RUNTIME_DIR, 'handoffs');            // per-project handoff docs live here

const DEFAULT_CONFIG = {
  enabled: true,
  notifyPct: 0.55,            // notify % gate (binds on 200k windows ≈ quality knee)
  urgentPct: 0.70,            // urgent % gate (binds on 200k; safely below the ~83.5% auto-compaction ceiling)
  softCapTokens: 300000,      // absolute NOTIFY floor — binds on 1M windows (~context-rot onset); null disables
  urgentCapTokens: 450000,    // absolute URGENT floor — binds on 1M windows (~clearly degrading); null disables
  contextLimitTokens: null,   // pin this machine's window size (e.g. 1000000); null = auto-detect
  contextLimits: { default: 200000, '1m': 1000000 }, // fallback window size by model id
  newSessionFlags: '--permission-mode auto', // flags for the launched session; '' for none, '--dangerously-skip-permissions' for fully hands-free (disables ALL gates)
  newSessionMode: 'agent',    // 'agent' = background session in `claude agents` (Agent View; no new terminal, cross-platform); 'tab' = new Windows Terminal tab; 'window' = separate window
  trustNewSessionFolder: false, // pre-accept the launched folder's trust dialog by editing ~/.claude.json (off by default — it changes a security gate; opt in if you understand it)
  debug: false
};

function loadConfig() {
  try { return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEFAULT_CONFIG); }
}

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
function parseHookInput() { try { return JSON.parse(readStdin()) || {}; } catch { return {}; } }

function sessionIdFrom(input) {
  if (input.session_id) return String(input.session_id);
  if (input.sessionId) return String(input.sessionId);
  const tp = input.transcript_path || input.transcriptPath;
  if (tp) return path.basename(String(tp)).replace(/\.jsonl$/i, '');
  return 'unknown';
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// A storage key for the session's handoff doc. Real project folders key by their leaf
// name; the home dir (no project) keys per-session so handoffs never collide.
function projectKeyFrom(input) {
  const cwd = input.cwd || input.workspace && input.workspace.current_dir || process.cwd();
  const home = os.homedir().replace(/[\\/]+$/, '');
  const norm = String(cwd).replace(/[\\/]+$/, '');
  if (norm.toLowerCase() === home.toLowerCase()) return 'session-' + sessionIdFrom(input).slice(0, 8);
  const leaf = norm.split(/[\\/]/).filter(Boolean).pop();
  return slugify(leaf) || ('session-' + sessionIdFrom(input).slice(0, 8));
}

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

let _seq = 0;
function writeFileAtomic(p, content) {
  const tmp = `${p}.${process.pid}.${_seq++}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}
function writeJsonAtomic(p, obj) { writeFileAtomic(p, JSON.stringify(obj, null, 2)); }

// --- context-window gauge ---------------------------------------------------

// Tokens occupying the context window for one assistant turn (the figure the statusline shows).
function contextTokensFromUsage(u) {
  if (!u || typeof u !== 'object') return 0;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

// 1M-context variants carry "[1m]" (or a standalone "1m") in the id; else default 200k.
function modelContextLimit(modelId, cfg) {
  const limits = (cfg && cfg.contextLimits) || {};
  const big = limits['1m'] || 1000000;
  const def = (limits.default != null ? limits.default : 200000);
  const id = String(modelId || '');
  if (/\[1m\]/i.test(id) || /(^|[-_])1m($|[-_\]])/i.test(id)) return big;
  return def;
}

// Resolve the TRUE window size: hook/statusline context_window > config pin > model id > heuristic.
function resolveContextLimit(opts) {
  opts = opts || {};
  const cfg = opts.cfg || {};
  const cw = opts.hookInput && opts.hookInput.context_window;
  if (cw && cw.context_window_size) return cw.context_window_size;
  if (cfg.contextLimitTokens) return cfg.contextLimitTokens;
  let lim = modelContextLimit(opts.model, cfg);
  if (opts.contextTokens && opts.contextTokens > lim) lim = (cfg.contextLimits && cfg.contextLimits['1m']) || 1000000;
  return lim;
}

// Tail-read a transcript and return the LATEST assistant usage (robust to compaction).
function readLastUsage(transcriptPath, opts) {
  opts = opts || {};
  const maxBytes = opts.maxBytes || 2 * 1024 * 1024;
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, start);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln || ln[0] !== '{') continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const msg = o.message;
    if (o.type === 'assistant' && msg && msg.usage) {
      return { contextTokens: contextTokensFromUsage(msg.usage), model: msg.model || null, usage: msg.usage };
    }
  }
  return null;
}

// Trigger model = min(percentage gate, absolute token floor). The % gate binds on small
// (200k) windows; the absolute floors bind on large (1M) windows, where a % gate fires far
// too late (quality/recall erodes by ~300-450k tokens regardless of how big the window is).
function handoffTier(pct, tokens, cfg) {
  cfg = cfg || {};
  const notifyPct = cfg.notifyPct != null ? cfg.notifyPct : 0.55;
  const urgentPct = cfg.urgentPct != null ? cfg.urgentPct : 0.70;
  const soft = cfg.softCapTokens || null;     // absolute notify floor (binds on large windows)
  const hard = cfg.urgentCapTokens || null;   // absolute urgent floor (binds on large windows)
  if (pct >= urgentPct || (hard && tokens >= hard)) return 'urgent';
  if (pct >= notifyPct || (soft && tokens >= soft)) return 'notify';
  return null;
}
function tierRank(t) { return t === 'urgent' ? 2 : t === 'notify' ? 1 : 0; }

function handoffPathsFor(key) {
  const dir = path.join(DATA_DIR, key);
  return { key, dir, handoffPath: path.join(dir, 'HANDOFF.md'), sidecarPath: path.join(dir, 'handoff.json') };
}
function gaugeMarkerPath(sid) { return path.join(os.tmpdir(), `claude-handoff-gauge-${sid}.json`); }

// Resolve the claude binary (for spawning a background session). Prefer the standard
// install path; fall back to 'claude' on PATH.
function detectClaudeBin() {
  const cands = [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return 'claude';
}

// ---- Subscription usage gauge (the account-wide rolling 5h + weekly rate limits Claude Code
// pipes into the statusline as `rate_limits`; Pro/Max only, populated after the first API response).
function usageTier(pctFrac, ucfg) {
  ucfg = ucfg || {};
  const notify = ucfg.notifyPct != null ? ucfg.notifyPct : 0.75;
  const urgent = ucfg.urgentPct != null ? ucfg.urgentPct : 0.90;
  if (pctFrac >= urgent) return 'urgent';
  if (pctFrac >= notify) return 'notify';
  return null;
}
// A window's `resets_at` → tiny local-time label ('3p' / '3:10p'; kind 'wk' → weekday). '' if bad.
function formatReset(resetsAt, kind) {
  try {
    if (resetsAt == null) return '';
    let d;
    if (typeof resetsAt === 'number' || /^\d+$/.test(String(resetsAt))) { let n = Number(resetsAt); if (n < 1e12) n *= 1000; d = new Date(n); }
    else { d = new Date(String(resetsAt)); }
    if (isNaN(d.getTime())) return '';
    if (kind === 'wk') return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? 'p' : 'a';
    h = h % 12; if (h === 0) h = 12;
    return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, '0')}${ap}`;
  } catch { return ''; }
}
// Time REMAINING until a window resets, compact ('2h13m' / '47m' / '<1m'); '' if past/unparseable.
function formatCountdown(resetsAt) {
  try {
    if (resetsAt == null) return '';
    let n;
    if (typeof resetsAt === 'number' || /^\d+$/.test(String(resetsAt))) { n = Number(resetsAt); if (n < 1e12) n *= 1000; }
    else { const d = new Date(String(resetsAt)); if (isNaN(d.getTime())) return ''; n = d.getTime(); }
    const ms = n - Date.now(); if (ms <= 0) return '';
    const mins = Math.round(ms / 60000); if (mins < 1) return '<1m';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m`;
  } catch { return ''; }
}
// Live 5h burn rate (%/15min). Persists (t,p) samples in a GLOBAL tmp file (usage is account-wide);
// recent rate needs a real ≥3-min span (no seconds-old base → no divide-by-tiny spike); falls back
// to the whole-window average once ≥15 min into the window. Sane-capped ≤99. null if not computable.
function fiveHourRate(curPct, resetsAt, filePath) {
  try {
    if (typeof curPct !== 'number') return null;
    const f = filePath || path.join(os.tmpdir(), 'claude-usage-5h-samples.json');
    const nowS = Math.floor(Date.now() / 1000);
    const st = readJson(f, null) || {};
    let s = Array.isArray(st.samples) ? st.samples.filter(x => x && typeof x.t === 'number' && typeof x.p === 'number') : [];
    const last = s.length ? s[s.length - 1] : null;
    if (last && curPct < last.p - 5) s = [];                          // reset → drop stale history
    if (!last || nowS - last.t >= 30) s.push({ t: nowS, p: curPct });
    s = s.filter(x => x.t >= nowS - 25 * 60);
    try { fs.writeFileSync(f, JSON.stringify({ samples: s })); } catch {}
    const base = s.find(x => nowS - x.t >= 180);
    if (base && curPct >= base.p) {
      const per15 = (curPct - base.p) / (nowS - base.t) * 900;
      if (per15 >= 0.1) return Math.min(per15, 99);
    }
    let R = Number(resetsAt);
    if (isFinite(R) && R > 0) {
      if (R > 1e12) R = Math.floor(R / 1000);
      const winStart = R - 5 * 3600, el = nowS - winStart;
      if (el >= 900 && curPct > 0) return Math.min(curPct / el * 900, 99);
    }
    return null;
  } catch { return null; }
}
// Pace verdict: project curPct forward at rate15 (%/15m) to the reset — 'out' (with etaMin to 100%),
// 'track' (finishes ≥85% but under), or 'room'. null if not computable.
function usagePace(curPct, rate15, resetsAt) {
  try {
    if (typeof curPct !== 'number' || typeof rate15 !== 'number') return null;
    let R = Number(resetsAt); if (!isFinite(R) || R <= 0) return null;
    if (R > 1e12) R = Math.floor(R / 1000);
    const nowS = Math.floor(Date.now() / 1000);
    const minsTillReset = (R - nowS) / 60; if (minsTillReset <= 0) return null;
    const ratePerMin = rate15 / 15;
    const projected = curPct + ratePerMin * minsTillReset;
    if (ratePerMin > 0 && projected >= 100) return { state: 'out', etaMin: Math.max(0, Math.round((100 - curPct) / ratePerMin)), projected: Math.round(projected) };
    return { state: projected >= 85 ? 'track' : 'room', projected: Math.round(projected) };
  } catch { return null; }
}

module.exports = {
  RUNTIME_DIR, CONFIG_PATH, DATA_DIR, DEFAULT_CONFIG, loadConfig,
  readStdin, parseHookInput, sessionIdFrom, slugify, projectKeyFrom,
  ensureDir, readJson, safeRead, writeFileAtomic, writeJsonAtomic,
  contextTokensFromUsage, modelContextLimit, resolveContextLimit, readLastUsage,
  handoffTier, tierRank, handoffPathsFor, gaugeMarkerPath, detectClaudeBin,
  usageTier, formatReset, formatCountdown, fiveHourRate, usagePace
};
