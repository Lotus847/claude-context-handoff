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
function closeWindows() {
  const ps = cmd => { try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  let pid = process.pid; const chain = [];
  for (let i = 0; i < 15 && pid > 0; i++) {
    const row = ps(`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){"$($p.Name)|$($p.ParentProcessId)"}`);
    if (!row || row.indexOf('|') < 0) break;
    const [name, ppidStr] = row.split('|');
    chain.push(`${pid}:${(name || '').trim()}`);
    if (/^claude(\.exe)?$/i.test((name || '').trim())) {
      try { spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' }); } catch {}
      return { closed: true, pid, chain };
    }
    const ppid = parseInt(ppidStr, 10);
    if (!ppid || ppid === pid) break;
    pid = ppid;
  }
  return { closed: false, chain };
}

function closeSession() {
  if (PLATFORM === 'win32') return closeWindows();
  return { closed: false, unsupported: PLATFORM, note: `Auto-close for ${PLATFORM} is not implemented yet — close the tab/window manually.` };
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
