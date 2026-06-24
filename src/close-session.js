'use strict';
// Close the CURRENT Claude Code session — invoked ONLY on explicit user confirm from
// /handoff, after the new session has opened. Uses `claude stop <session-id>` so the shared
// Claude Code DAEMON ends THIS session cleanly (and runs its Stop hooks). Does NOT close
// sibling sessions. (Don't taskkill — the daemon just respawns a killed session.)
//
//   node close-session.js [--dry-run]

const plat = require('./lib/platform');

if (process.argv.includes('--dry-run')) {
  // Report what would happen without killing anything.
  const fs = require('fs');
  console.log(JSON.stringify({ dryRun: true, platform: plat.PLATFORM, note: 'would save state, then `claude stop <short-id>` (daemon-clean; conversation kept; resume via `claude attach <short-id>`)' }, null, 2));
  process.exit(0);
}
const res = plat.closeSession();
console.log(JSON.stringify(res));
process.exit(0);
