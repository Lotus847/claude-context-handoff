'use strict';
// Self-test for the context-handoff lib. Run: node test/selftest.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const c = require('../src/lib/common');

let pass = 0, fail = 0;
function eq(n, g, w) { const ok = g === w; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  got=${JSON.stringify(g)}${ok ? '' : ' want=' + JSON.stringify(w)}`); ok ? pass++ : fail++; }
function truthy(n, g) { const ok = !!g; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  got=${JSON.stringify(g)}`); ok ? pass++ : fail++; }

eq('ctxTokens sum (excludes output)', c.contextTokensFromUsage({ input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 9 }), 150);
eq('ctxTokens null -> 0', c.contextTokensFromUsage(null), 0);
eq('limit default 200k', c.modelContextLimit('claude-opus-4-8', {}), 200000);
eq('limit [1m] -> 1M', c.modelContextLimit('claude-opus-4-8[1m]', {}), 1000000);
eq('limit -1m -> 1M', c.modelContextLimit('claude-sonnet-4-6-1m', {}), 1000000);
eq('resolve hook context_window', c.resolveContextLimit({ hookInput: { context_window: { context_window_size: 1000000 } }, cfg: {} }), 1000000);
eq('resolve config pin', c.resolveContextLimit({ cfg: { contextLimitTokens: 1000000 } }), 1000000);
eq('resolve model default', c.resolveContextLimit({ model: 'claude-opus-4-8', contextTokens: 50000, cfg: {} }), 200000);
eq('resolve heuristic bump', c.resolveContextLimit({ model: 'claude-opus-4-8', contextTokens: 250000, cfg: {} }), 1000000);

const cfg = { notifyPct: 0.70, urgentPct: 0.88, softCapTokens: 300000 };
eq('tier null low', c.handoffTier(0.2, 50000, cfg), null);
eq('tier notify pct', c.handoffTier(0.72, 10, cfg), 'notify');
eq('tier notify softcap', c.handoffTier(0.1, 350000, cfg), 'notify');
eq('tier urgent', c.handoffTier(0.9, 10, cfg), 'urgent');
truthy('tierRank ordering', c.tierRank('urgent') > c.tierRank('notify') && c.tierRank('notify') > c.tierRank(null));

truthy('key home -> session-', /^session-/.test(c.projectKeyFrom({ cwd: os.homedir(), session_id: 'abcd1234-xx' })));
eq('key project leaf', c.projectKeyFrom({ cwd: path.join('C:', 'dev', 'my-app'), session_id: 'x' }), 'my-app');

const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cht-'));
const tf = path.join(tdir, 's.jsonl');
fs.writeFileSync(tf, [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8[1m]', usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 5 } } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8[1m]', usage: { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 95000, output_tokens: 5 } } })
].join('\n') + '\n');
const lu = c.readLastUsage(tf);
eq('readLastUsage picks newest', lu && lu.contextTokens, 100000);
eq('readLastUsage model', lu && lu.model, 'claude-opus-4-8[1m]');
eq('readLastUsage missing -> null', c.readLastUsage(path.join(tdir, 'nope.jsonl')), null);
const hp = c.handoffPathsFor('demo');
truthy('handoffPaths HANDOFF.md', /demo[\\/]HANDOFF\.md$/.test(hp.handoffPath));
try { fs.rmSync(tdir, { recursive: true, force: true }); } catch {}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
