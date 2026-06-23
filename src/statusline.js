'use strict';
// Statusline: Claude Code pipes a JSON blob on stdin that already includes a native
// `context_window` object — so this just formats it (no transcript reads). Must stay
// instant (300ms debounce; in-flight runs are cancelled).

const fs = require('fs');
const path = require('path');
const c = require('./lib/common');

const A = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m' };
let input = {}; try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}

const cfg = c.loadConfig();
const notify = (cfg.notifyPct != null ? cfg.notifyPct : 0.70) * 100;
const urgent = (cfg.urgentPct != null ? cfg.urgentPct : 0.88) * 100;

const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || '';
const proj = cwd ? (path.basename(cwd) || 'home') : 'home';
const model = (input.model && (input.model.display_name || input.model.id)) || '';

const cw = input.context_window || null;
let ctxStr;
if (cw && typeof cw.used_percentage === 'number') {
  const pct = Math.round(cw.used_percentage);
  const used = cw.total_input_tokens != null ? cw.total_input_tokens
             : (cw.current_usage ? c.contextTokensFromUsage(cw.current_usage) : null);
  const size = cw.context_window_size || null;
  const color = pct >= urgent ? A.red : pct >= notify ? A.yellow : A.green;
  let body = `ctx ${pct}%`;
  if (used != null && size) body += ` (${Math.round(used / 1000)}k/${Math.round(size / 1000)}k)`;
  const hint = pct >= urgent ? `  ${A.bold}${A.red}⚠ /handoff now${A.reset}` : pct >= notify ? `  ${A.yellow}⚠ /handoff soon${A.reset}` : '';
  ctxStr = `${color}🧠 ${body}${A.reset}${hint}`;
} else {
  ctxStr = `${A.dim}🧠 ctx —${A.reset}`;
}

const parts = [`${A.dim}${proj}${A.reset}`, ctxStr];
if (model) parts.push(`${A.dim}${model}${A.reset}`);
process.stdout.write(parts.join(`${A.dim} │ ${A.reset}`));
process.exit(0);
