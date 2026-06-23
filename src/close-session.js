'use strict';
// Close the CURRENT Claude Code session — invoked ONLY on explicit user confirm from
// /handoff, after the new session has opened. Finds the host process by walking parents
// from here (so it never closes sibling sessions) and terminates it.
//
// NOTE: this is a force-close — Claude Code's own Stop/SessionEnd hooks may NOT run.
// If you rely on those (e.g. a commit-on-stop hook), close the tab manually instead.
//
//   node close-session.js [--dry-run]

const plat = require('./lib/platform');

if (process.argv.includes('--dry-run')) {
  // Report what would happen without killing anything.
  const fs = require('fs');
  console.log(JSON.stringify({ dryRun: true, platform: plat.PLATFORM, note: 'would locate the host session process via parent-walk and terminate it' }, null, 2));
  process.exit(0);
}
const res = plat.closeSession();
console.log(JSON.stringify(res));
process.exit(0);
