'use strict';
// Open the new session, named + seeded to continue from a HANDOFF.md, via the per-OS
// platform layer. On unsupported OSes it prints the exact command to run manually.
//
//   node launch-handoff.js --cwd "<dir>" --handoff "<HANDOFF.md path>" --name "<name>" [--mode tab|window] [--flags "..."] [--dry-run]

const c = require('./lib/common');
const plat = require('./lib/platform');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : def;
}
const dry = process.argv.includes('--dry-run');
const cfg = c.loadConfig();
const cwd = arg('--cwd', process.cwd());
const handoff = arg('--handoff', '');
const name = arg('--name', 'handoff continuation');
const mode = arg('--mode', cfg.newSessionMode || 'tab');
const flags = arg('--flags', cfg.newSessionFlags != null ? cfg.newSessionFlags : '--permission-mode auto');
const doTrust = cfg.trustNewSessionFolder === true;

// Short, quote/semicolon-free seed prompt — full context lives in HANDOFF.md (and the
// SessionStart hook, if installed, also surfaces it).
const prompt = handoff
  ? `Continue our work from a previous session that ran low on context. First read the handoff doc at ${handoff} (it has the full context and a cold-start), then carry out its NEXT ACTION.`
  : `Continue our previous work. Read the latest HANDOFF.md, then carry out its NEXT ACTION.`;

if (dry) {
  console.log(JSON.stringify({ dryRun: true, platform: plat.PLATFORM, mode, flags, trust: doTrust, cwd, name, command: plat.claudeCommand({ flags, name, prompt }) }, null, 2));
  process.exit(0);
}
const trust = doTrust ? plat.setFolderTrust(cwd) : 'disabled';
const res = plat.launchSession({ cwd, name, prompt, flags, mode });
console.log(JSON.stringify(Object.assign({ trust }, res)));
process.exit(0);
