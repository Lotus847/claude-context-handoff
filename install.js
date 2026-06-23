'use strict';
// Installer for claude-context-handoff. Idempotent + non-destructive:
//   - copies the runtime scripts to ~/.claude/context-handoff
//   - installs the /handoff skill to ~/.claude/skills/handoff (filling the runtime path)
//   - merges the gauge hook + statusline into ~/.claude/settings.json (backup, atomic,
//     preserving every existing hook/setting; safe to re-run)
// Run:  node install.js        Remove:  node uninstall.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const SKILL_DIR = path.join(CLAUDE_DIR, 'skills', 'handoff');
const RUNTIME = path.join(CLAUDE_DIR, 'context-handoff');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const MARK = 'context-handoff';                 // identifies our settings.json entries
const NODE = process.execPath.replace(/\\/g, '/');
const runtimeFwd = RUNTIME.replace(/\\/g, '/'); // forward slashes work for node on every OS

// 1) runtime scripts
fs.mkdirSync(RUNTIME, { recursive: true });
fs.cpSync(path.join(HERE, 'src'), RUNTIME, { recursive: true });

// 2) config (preserve an existing one across re-installs)
const cfgDest = path.join(RUNTIME, 'config.json');
if (!fs.existsSync(cfgDest)) fs.copyFileSync(path.join(HERE, 'config.example.json'), cfgDest);

// 3) skill (fill the {{RUNTIME}} placeholder)
fs.mkdirSync(SKILL_DIR, { recursive: true });
const skill = fs.readFileSync(path.join(HERE, 'skill', 'handoff', 'SKILL.md'), 'utf8').split('{{RUNTIME}}').join(runtimeFwd);
fs.writeFileSync(path.join(SKILL_DIR, 'SKILL.md'), skill);

// 4) settings.json — hooks + statusline
let raw = '{}';
try { raw = fs.readFileSync(SETTINGS, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let cfg;
try { cfg = JSON.parse(raw); } catch (e) { console.error(`settings.json is not valid JSON; fix it first, then re-run. (${e.message})`); process.exit(1); }
if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) { console.error('settings.json is not a JSON object; aborting without writing.'); process.exit(1); }

const bak = SETTINGS + '.context-handoff-bak';
try { if (!fs.existsSync(bak) && raw !== '{}') fs.writeFileSync(bak, raw); } catch {}

cfg.hooks = cfg.hooks || {};
for (const ev of Object.keys(cfg.hooks)) {                     // strip our prior entries (idempotent)
  if (!Array.isArray(cfg.hooks[ev])) continue;
  cfg.hooks[ev] = cfg.hooks[ev].filter(entry => !((entry.hooks || []).some(h => (h.command || '').includes(MARK))));
  if (cfg.hooks[ev].length === 0) delete cfg.hooks[ev];
}
const gaugeCmd = `"${NODE}" "${runtimeFwd}/context-gauge.js"`;
cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit || [];
cfg.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: gaugeCmd, statusMessage: 'Context gauge' }] });

const slCmd = `"${NODE}" "${runtimeFwd}/statusline.js"`;
const slIsOurs = cfg.statusLine && typeof cfg.statusLine.command === 'string' && cfg.statusLine.command.includes(MARK);
if (!cfg.statusLine || slIsOurs) cfg.statusLine = { type: 'command', command: slCmd, padding: 2 };
else console.log('NOTE: an existing (non-context-handoff) statusLine was left untouched.');

const tmp = SETTINGS + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
fs.renameSync(tmp, SETTINGS);

// 5) report
console.log('\n✅ claude-context-handoff installed.');
console.log('   skill   : ' + path.join(SKILL_DIR, 'SKILL.md'));
console.log('   runtime : ' + RUNTIME);
console.log('   config  : ' + cfgDest);
console.log('   settings: gauge hook + statusline merged into ' + SETTINGS + (raw !== '{}' ? ' (backup: ' + bak + ')' : ''));
console.log('\nClaude Code re-reads hooks, statusline, and skills live (file watcher), so this is active');
console.log('in open chats on their next prompt — no restart needed. Type /handoff anytime, or let the');
console.log('gauge nudge you as context fills. Tune thresholds/behavior in ' + cfgDest + '.');
if (process.platform !== 'win32') {
  console.log('\n⚠ Platform: ' + process.platform + ' — the gauge + statusline + /handoff doc work, but auto-LAUNCH');
  console.log('  and auto-CLOSE of sessions are Windows-only for now; on other OSes /handoff prints the exact');
  console.log('  command to run manually. (Contributions to src/lib/platform.js welcome.)');
}
console.log('\nSafety: auto-launched sessions use --permission-mode auto (gated). Folder-trust auto-accept is OFF');
console.log('by default (it edits a Claude Code security gate) — enable trustNewSessionFolder only if you understand it.');
