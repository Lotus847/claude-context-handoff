'use strict';
// Per-OS layer for launching/closing sessions. Windows is implemented; macOS/Linux
// throw a clear "not yet implemented" with the exact command to run manually, so the
// rest of the system is OS-agnostic and contributors have an obvious seam to fill.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync, spawnSync } = require('child_process');

const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'

// Build the `claude` invocation common to all platforms.
function claudeCommand({ flags, name, prompt }) {
  const f = flags ? flags + ' ' : '';
  return `claude ${f}-n "${name}" "${prompt}"`;
}

// ---- Windows ---------------------------------------------------------------

// cmd wraps quoted args and expands %VAR% — strip quotes/newlines, escape %.
const cleanWin = s => String(s == null ? '' : s).replace(/["\r\n]/g, ' ').replace(/%/g, '%%').trim();

function launchWindows({ cwd, name, prompt, flags, mode }) {
  const n = cleanWin(name).slice(0, 60) || 'handoff continuation';
  const p = cleanWin(prompt);
  const fl = String(flags || '').replace(/["\r\n]/g, ' ').replace(/%/g, '%%').trim();
  const cmdFile = path.join(os.tmpdir(), `claude-handoff-launch-${process.pid}.cmd`);
  // title labels the WT tab; cd then launch claude. Everything in a .cmd so nothing
  // has to survive inter-process quoting.
  const body = `@echo off\r\ntitle ${n}\r\ncd /d "${cwd}"\r\n${claudeCommand({ flags: fl, name: n, prompt: p })}\r\n`;
  // wt is invoked THROUGH cmd so the WindowsApps execution-alias resolves.
  const args = mode === 'window'
    ? ['/c', 'start', '', 'cmd', '/k', cmdFile]
    : ['/c', 'wt', '-w', '0', 'new-tab', 'cmd', '/k', cmdFile];
  fs.writeFileSync(cmdFile, body);
  spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { launched: true, mode: mode === 'window' ? 'window' : 'tab', cmdFile };
}

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

// ---- public surface --------------------------------------------------------

function launchSession(opts) {
  if (PLATFORM === 'win32') return launchWindows(opts);
  // Not yet implemented elsewhere — hand back the exact command to run manually.
  return {
    launched: false,
    unsupported: PLATFORM,
    manual: `cd "${opts.cwd}" && ${claudeCommand(opts)}`,
    note: `Auto-launch for ${PLATFORM} is not implemented yet. Run the command above in a new terminal. (Contributions welcome — implement launch in src/lib/platform.js.)`
  };
}

function closeSession() {
  if (PLATFORM === 'win32') return closeWindows();
  return { closed: false, unsupported: PLATFORM, note: `Auto-close for ${PLATFORM} is not implemented yet — close the tab/window manually.` };
}

// Pre-accept a folder's workspace-trust dialog by editing ~/.claude.json (cross-platform).
// SECURITY: this disables a Claude Code safety gate for that folder; only call when the user
// has explicitly opted in (config.trustNewSessionFolder). Safe write: validate, backup, atomic.
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
