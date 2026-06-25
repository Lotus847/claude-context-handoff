'use strict';
// Per-OS launching/closing of handoff sessions.
//   agent  (default) — `claude --bg`: a BACKGROUND session that appears in `claude agents`
//                      (Agent View); no terminal spawned; cross-platform.
//   tab    — new tab in the current Windows Terminal window (Windows only).
//   window — separate terminal window (Windows only).
// On macOS/Linux, tab/window aren't implemented and return the manual command (agent works).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');
const c = require('./common');

const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'

function claudeCommand({ flags, name, prompt }) {
  const f = flags ? flags + ' ' : '';
  return `claude ${f}-n "${name}" "${prompt}"`;
}
const cleanWin = s => String(s == null ? '' : s).replace(/["\r\n]/g, ' ').replace(/%/g, '%%').trim();

// ---- agent mode (cross-platform): background session in `claude agents` -----
function launchAgent({ cwd, name, prompt, flags, dry }) {
  const bin = c.detectClaudeBin();
  const flagsArr = (flags || '').trim() ? flags.trim().split(/\s+/) : [];
  const args = ['--bg', ...flagsArr, '-n', name, prompt];           // arg array → no shell quoting
  if (dry) return { dryRun: true, mode: 'agent', command: [bin, ...args] };
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
  const out = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');       // strip ANSI; stdout: "backgrounded · <id> · <name>"
  const m = out.match(/backgrounded\s*·\s*([0-9a-f]+)\s*·/i) || out.match(/\battach\s+([0-9a-f]{6,})/i);
  const id = m ? m[1] : null;
  return { launched: r.status === 0, mode: 'agent', name, id, attach: id ? `claude attach ${id}` : null, status: r.status, stderr: (r.stderr || '').slice(0, 200) };
}

// ---- Windows tab/window ----------------------------------------------------
function launchWindows({ cwd, name, prompt, flags, mode, dry }) {
  const n = cleanWin(name).slice(0, 60) || 'handoff continuation';
  const p = cleanWin(prompt);
  const fl = String(flags || '').replace(/["\r\n]/g, ' ').replace(/%/g, '%%').trim();
  const cmdFile = path.join(os.tmpdir(), `claude-handoff-launch-${process.pid}.cmd`);
  const body = `@echo off\r\ntitle ${n}\r\ncd /d "${cwd}"\r\n${claudeCommand({ flags: fl, name: n, prompt: p })}\r\n`;
  const args = mode === 'window' ? ['/c', 'start', '', 'cmd', '/k', cmdFile] : ['/c', 'wt', '-w', '0', 'new-tab', 'cmd', '/k', cmdFile];
  const m = mode === 'window' ? 'window' : 'tab';
  if (dry) return { dryRun: true, mode: m, cmdBody: body, spawn: ['cmd.exe', ...args] };
  fs.writeFileSync(cmdFile, body);
  spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { launched: true, mode: m, cmdFile };
}

function launchSession(opts) {
  const mode = opts.mode || 'agent';
  if (mode === 'agent') return launchAgent(opts);                   // cross-platform
  if (PLATFORM === 'win32') return launchWindows(opts);
  return {
    launched: false, unsupported: PLATFORM,
    manual: `cd "${opts.cwd}" && ${claudeCommand(opts)}`,
    note: `'${mode}' launch is Windows-only; run the command above, or set newSessionMode "agent" (cross-platform).`
  };
}

// ---- close the current session (force-terminate the host process) ----------
// Close THIS session's tree. Claude Code nests several claude.exe layers and runs many
// sessions under a SHARED supervisor claude.exe, so we climb the linear claude chain and stop
// just BELOW the supervisor (parent isn't claude, or is a claude with >1 claude child) — then
// tree-kill that PID. The killer is launched OUT of our tree (WMI Create) so it survives
// killing its own ancestors. Closes only this session; siblings are untouched.
// Close the CURRENT session cleanly via the Claude Code DAEMON. Do NOT taskkill the session's
// processes: every session runs under a shared daemon (`claude daemon run`) via a per-session
// --bg-pty-host, and the daemon RESPAWNS a session whose processes you kill (so it won't close).
// `claude stop <session-id>` tells the daemon to end it (and lets the session's Stop hooks run).
// Cross-platform.
function closeSession() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!sid) return { closed: false, note: 'no CLAUDE_CODE_SESSION_ID in env — close the tab manually (Ctrl+C / /exit)' };
  // LANDMINE: `claude stop` takes the SHORT 8-char agent id (the first block of the session
  // UUID). Passing the full UUID is REJECTED with "No job matching ...". Derive the short id.
  const shortId = sid.slice(0, 8);
  const bin = c.detectClaudeBin();
  const r = spawnSync(bin, ['stop', shortId], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '').trim();
  // Remove the bg-agent job record so the stopped session doesn't linger as a "stopped" stub in
  // `claude agents --all`. NON-destructive: the conversation transcript on disk is kept.
  // SECURITY: shortId is a session-UUID prefix, but validate it and confirm the resolved path
  // stays inside jobs/ so a malformed CLAUDE_CODE_SESSION_ID can never let a recursive/force
  // rmSync escape the jobs dir (path traversal).
  let removedFromList = 'skip';
  if (r.status === 0 && /^[A-Za-z0-9_-]{1,64}$/.test(shortId)) {
    const jobsBase = path.resolve(os.homedir(), '.claude', 'jobs');
    const target = path.resolve(jobsBase, shortId);
    if (target === jobsBase || !target.startsWith(jobsBase + path.sep)) { removedFromList = 'skip:path-escape'; }
    else { try { fs.rmSync(target, { recursive: true, force: true }); removedFromList = 'job-record-deleted'; } catch (e) { removedFromList = 'error'; } }
  } else if (r.status === 0) { removedFromList = 'skip:invalid-id'; }
  return { closed: r.status === 0, removedFromList, sessionId: sid, id: shortId, via: 'claude stop', out: out.slice(0, 160) };
}

// Pre-accept a folder's workspace-trust dialog by editing ~/.claude.json (cross-platform).
// SECURITY: disables a Claude Code safety gate for that folder; only call on explicit opt-in
// (config.trustNewSessionFolder). Important for agent mode (a bg session has no terminal to
// accept the dialog). Safe write: validate, back up once, atomic.
function setFolderTrust(dir) {
  try {
    const cfgPath = path.join(os.homedir(), '.claude.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return 'skip:not-object';
    const key = String(dir).replace(/\\/g, '/').replace(/\/+$/, '');
    j.projects = j.projects || {};
    j.projects[key] = j.projects[key] || {};
    if (j.projects[key].hasTrustDialogAccepted === true) return 'already';
    const bak = cfgPath + '.handoff-bak';
    try { if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw); } catch {}
    j.projects[key].hasTrustDialogAccepted = true;
    const tmp = cfgPath + '.handoff.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
    fs.renameSync(tmp, cfgPath);
    return 'set';
  } catch (e) { return 'error:' + ((e && e.message) || e); }
}

module.exports = { PLATFORM, claudeCommand, launchSession, closeSession, setFolderTrust };
