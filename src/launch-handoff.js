'use strict';
// Open the handoff continuation session via the per-OS platform layer. Default mode
// "agent" → a background session in `claude agents` (no new terminal). "tab"/"window"
// are Windows terminal fallbacks. Prints the result (incl. the `claude attach <id>` hint).
//
//   node launch-handoff.js --cwd "<dir>" --handoff "<HANDOFF.md path>" --name "<name>" [--mode agent|tab|window] [--flags "..."] [--dry-run]

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
const mode = arg('--mode', cfg.newSessionMode || 'agent');
const flags = arg('--flags', cfg.newSessionFlags != null ? cfg.newSessionFlags : '--permission-mode auto');
const doTrust = cfg.trustNewSessionFolder === true;

const prompt = handoff
  ? `Continue our work from a previous session that ran low on context. First read the handoff doc at ${handoff} (it has the full context and a cold-start), then carry out its NEXT ACTION.`
  : `Continue our previous work. Read the latest HANDOFF.md, then carry out its NEXT ACTION.`;

// Pre-accept folder trust before launching (important in agent mode — no terminal to accept it).
const trust = dry ? (doTrust ? 'would-set' : 'disabled') : (doTrust ? plat.setFolderTrust(cwd) : 'disabled');
const res = plat.launchSession({ cwd, name, prompt, flags, mode, dry });
console.log(JSON.stringify(Object.assign({ trust }, res), null, 2));
process.exit(0);
