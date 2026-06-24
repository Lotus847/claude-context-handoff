'use strict';
// Open the handoff continuation session via the per-OS platform layer. Default mode
// "agent" → a background session in `claude agents` (no new terminal). "tab"/"window"
// are Windows terminal fallbacks. Prints the result (incl. the `claude attach <id>` hint).
//
// The continuation inherits the old session's NAME with a version bump ("Work" → "Work V2"),
// and — if the old session had an EXPLICIT `/color` — that color (re-emitted into the new
// session's transcript; renders on attach). Auto/default colors aren't stored, so can't be copied.
//
//   node launch-handoff.js --cwd "<dir>" --handoff "<HANDOFF.md path>" [--name "<name>"] [--mode agent|tab|window] [--flags "..."] [--print-name] [--dry-run]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const c = require('./lib/common');
const plat = require('./lib/platform');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : def;
}
const dry = process.argv.includes('--dry-run');
const cfg = c.loadConfig();

// ---- Name inheritance: carry the old name forward with a version bump -------------------------
//   "Work" → "Work V2",  "Work V2" → "Work V3",  "Work V10" → "Work V11".
function bumpName(nm) {
  const s = String(nm == null ? '' : nm).trim();
  if (!s) return '';
  const m = /^(.*\S)\s+[vV](\d+)$/.exec(s);
  return m ? `${m[1]} V${parseInt(m[2], 10) + 1}` : `${s} V2`;
}
// This session's current display name, from the live agent list, matched by session id.
function resolveCurrentName() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!sid) return '';
  try {
    const r = spawnSync(c.detectClaudeBin(), ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const arr = JSON.parse(r.stdout || '[]');
    const me = Array.isArray(arr) ? arr.find(a => a && a.sessionId === sid) : null;
    return me && me.name ? String(me.name) : '';
  } catch { return ''; }
}

// ---- Color inheritance: copy only an EXPLICIT /color -----------------------------------------
// A chat's color is on disk ONLY if `/color` was run (event {"type":"agent-color",...} in its
// transcript); auto/default colors aren't stored. Re-emit the old color into the NEW session's
// transcript so it shows on attach. Best-effort (color lives only in the UI; not verifiable here).
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }
function transcriptPath(sid) {
  if (!sid) return '';
  const root = path.join(os.homedir(), '.claude', 'projects');
  try { for (const d of fs.readdirSync(root)) { const f = path.join(root, d, sid + '.jsonl'); if (fs.existsSync(f)) return f; } } catch {}
  return '';
}
function lastAgentColor(sid) {
  const tx = transcriptPath(sid);
  if (!tx) return '';
  try {
    const lines = fs.readFileSync(tx, 'utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].indexOf('"agent-color"') < 0) continue;
      try { const o = JSON.parse(lines[i]); if (o && o.type === 'agent-color' && COLORS.indexOf(String(o.agentColor)) >= 0) return String(o.agentColor); } catch {}
    }
  } catch {}
  return '';
}
function applyColorToNew(shortId, color) {
  if (!color) return 'no-explicit-color';
  if (!shortId) return 'skip:no-id';
  let nsid = '';
  try {
    const r = spawnSync(c.detectClaudeBin(), ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const arr = JSON.parse(r.stdout || '[]');
    const ent = Array.isArray(arr) ? arr.find(a => a && a.id === shortId) : null;
    nsid = ent && ent.sessionId ? String(ent.sessionId) : '';
  } catch {}
  if (!nsid) return 'skip:no-session';
  let tx = '';
  for (let i = 0; i < 15 && !tx; i++) { tx = transcriptPath(nsid); if (!tx) sleepMs(400); }
  if (!tx) return 'skip:no-transcript-yet';
  try { fs.appendFileSync(tx, JSON.stringify({ type: 'agent-color', agentColor: color, sessionId: nsid }) + '\n'); return 'applied:' + color; }
  catch (e) { return 'error:' + ((e && e.message) || e); }
}

const inheritColor = cfg.inheritColor !== false;
const currentColor = inheritColor ? lastAgentColor(process.env.CLAUDE_CODE_SESSION_ID || '') : '';

// --print-name: resolve {currentName, newName, currentColor} for /handoff (handoff.json + display).
if (process.argv.includes('--print-name')) {
  const cur = resolveCurrentName();
  console.log(JSON.stringify({ currentName: cur, newName: bumpName(cur) || 'handoff continuation', currentColor: currentColor || null }));
  process.exit(0);
}

const cwd = arg('--cwd', process.cwd());
const handoff = arg('--handoff', '');
const nameProvided = process.argv.indexOf('--name') >= 0;
let name = arg('--name', '');
if (!nameProvided || !name) { const auto = bumpName(resolveCurrentName()); if (auto) name = auto; }
if (!name) name = 'handoff continuation';
const mode = arg('--mode', cfg.newSessionMode || 'agent');
const flags = arg('--flags', cfg.newSessionFlags != null ? cfg.newSessionFlags : '--permission-mode auto');
const doTrust = cfg.trustNewSessionFolder === true;

const prompt = handoff
  ? `Continue our work from a previous session that ran low on context. First read the handoff doc at ${handoff} (it has the full context and a cold-start), then carry out its NEXT ACTION.`
  : `Continue our previous work. Read the latest HANDOFF.md, then carry out its NEXT ACTION.`;

// Pre-accept folder trust before launching (important in agent mode — no terminal to accept it).
const trust = dry ? (doTrust ? 'would-set' : 'disabled') : (doTrust ? plat.setFolderTrust(cwd) : 'disabled');
const res = plat.launchSession({ cwd, name, prompt, flags, mode, dry });
const colorInherited = (!dry && mode === 'agent') ? applyColorToNew(res && res.id, currentColor)
                                                  : (currentColor ? 'skip:dry-or-non-agent' : 'no-explicit-color');
console.log(JSON.stringify(Object.assign({ trust, color: currentColor || null, colorInherited }, res), null, 2));
process.exit(0);
