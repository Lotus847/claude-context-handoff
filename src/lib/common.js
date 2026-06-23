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
  notifyPct: 0.70,            // first "drifting past optimal" nudge at this fraction of the window
  urgentPct: 0.88,            // "act now" — auto-compaction is near
  softCapTokens: null,        // optional absolute early-notify floor (e.g. 300000 on a 1M-context model); null disables
  contextLimitTokens: null,   // pin this machine's window size (e.g. 1000000); null = auto-detect
  contextLimits: { default: 200000, '1m': 1000000 }, // fallback window size by model id
  newSessionFlags: '--permission-mode auto', // flags for the launched session; '' for none, '--dangerously-skip-permissions' for fully hands-free (disables ALL gates)
  newSessionMode: 'tab',      // 'tab' = new tab in current Windows Terminal window; 'window' = separate window
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

function handoffTier(pct, tokens, cfg) {
  cfg = cfg || {};
  const notifyPct = cfg.notifyPct != null ? cfg.notifyPct : 0.70;
  const urgentPct = cfg.urgentPct != null ? cfg.urgentPct : 0.88;
  const soft = cfg.softCapTokens || null;
  if (pct >= urgentPct) return 'urgent';
  if (pct >= notifyPct || (soft && tokens >= soft)) return 'notify';
  return null;
}
function tierRank(t) { return t === 'urgent' ? 2 : t === 'notify' ? 1 : 0; }

function handoffPathsFor(key) {
  const dir = path.join(DATA_DIR, key);
  return { key, dir, handoffPath: path.join(dir, 'HANDOFF.md'), sidecarPath: path.join(dir, 'handoff.json') };
}
function gaugeMarkerPath(sid) { return path.join(os.tmpdir(), `claude-handoff-gauge-${sid}.json`); }

module.exports = {
  RUNTIME_DIR, CONFIG_PATH, DATA_DIR, DEFAULT_CONFIG, loadConfig,
  readStdin, parseHookInput, sessionIdFrom, slugify, projectKeyFrom,
  ensureDir, readJson, safeRead, writeFileAtomic, writeJsonAtomic,
  contextTokensFromUsage, modelContextLimit, resolveContextLimit, readLastUsage,
  handoffTier, tierRank, handoffPathsFor, gaugeMarkerPath
};
