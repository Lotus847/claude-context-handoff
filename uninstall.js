'use strict';
// Uninstaller for claude-context-handoff. Removes the gauge hook + statusline (only ours),
// and the /handoff skill. Leaves your runtime config + saved handoffs in place (delete
// ~/.claude/context-handoff yourself if you want them gone). Safe to re-run.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const SKILL_DIR = path.join(CLAUDE_DIR, 'skills', 'handoff');
const RUNTIME = path.join(CLAUDE_DIR, 'context-handoff');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const MARK = 'context-handoff';

let removed = [];

// settings.json: strip our hooks + statusline
try {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  const cfg = JSON.parse(raw);
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    if (cfg.hooks) {
      for (const ev of Object.keys(cfg.hooks)) {
        if (!Array.isArray(cfg.hooks[ev])) continue;
        const before = cfg.hooks[ev].length;
        cfg.hooks[ev] = cfg.hooks[ev].filter(entry => !((entry.hooks || []).some(h => (h.command || '').includes(MARK))));
        if (cfg.hooks[ev].length !== before) removed.push(`hook:${ev}`);
        if (cfg.hooks[ev].length === 0) delete cfg.hooks[ev];
      }
    }
    if (cfg.statusLine && typeof cfg.statusLine.command === 'string' && cfg.statusLine.command.includes(MARK)) {
      delete cfg.statusLine; removed.push('statusLine');
    }
    const tmp = SETTINGS + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, SETTINGS);
  }
} catch (e) { console.error('Could not update settings.json (' + ((e && e.message) || e) + ') — remove the context-handoff hook/statusline by hand.'); }

// skill
try { if (fs.existsSync(SKILL_DIR)) { fs.rmSync(SKILL_DIR, { recursive: true, force: true }); removed.push('skill'); } } catch {}

console.log('✅ Uninstalled context-handoff: ' + (removed.length ? removed.join(', ') : 'nothing found'));
console.log('   Runtime + config + saved handoffs left at: ' + RUNTIME + '  (delete manually to remove fully).');
