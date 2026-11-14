// Opt-in: calls the selected real third-party Agent using existing authentication.
// Expected outcomes stay in this runner, outside each Agent's frozen fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { git, capture, collect, removeTemporary, assertOutputLocation, exists } from '../../scripts/lib/core.mjs';
import { review } from '../../scripts/lib/agent.mjs';

async function specimen(t, variant) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-live-'));
  let archive;
  try {
    const project = (await git(process.cwd(), ['rev-parse', '--show-toplevel'])).toString().trim();
    archive = await assertOutputLocation(project, path.join(project, 'artifacts', 'acceptance-live', path.basename(root)));
  } catch { archive = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-live-archive-')); }
  t.after(async () => {
    try {
      if (await exists(path.join(root, 'artifacts'))) {
        await fs.cp(path.join(root, 'artifacts'), archive, { recursive: true, errorOnExist: true, force: false });
        console.log(JSON.stringify({ rawEvidence: archive }));
      }
    } finally { await removeTemporary(root); }
  });
  const write = async (name, text) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  };
  await git(root, ['init', '-q']);
  await write('.gitignore', '/artifacts/\n');
  await write('plan.md', '# Approved requirements\n\nR1: normalize(value) must trim whitespace AND lowercase the string. normalize("  AbC  ") must equal "abc".\nR2: A non-string must throw TypeError, a blank string must throw RangeError. Tests must assert both behaviors.\nR3: Remove legacy.mjs and legacyNormalize; migrate the JavaScript consumer, Python launcher, YAML command configuration, and guide to valid replacement entry points. No active reference to the removed interface may remain.\n');
  await write('legacy.mjs', 'export function legacyNormalize(value) { return value.trim(); }\n');
  await write('consumer.mjs', 'import {legacyNormalize} from "./legacy.mjs"; console.log(legacyNormalize(" AbC "));\n');
  await write('worker.py', 'import subprocess\nsubprocess.run(["node", "legacy.mjs"], check=True)\n');
  await write('.github/task.yml', 'command: node legacy.mjs\n');
  await write('guide.md', 'Run node legacy.mjs and import legacyNormalize from legacy.mjs.\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'approved requirements and baseline']);
  const base = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
  await fs.unlink(path.join(root, 'legacy.mjs'));
  if (variant === 'a') {
    await write('api.mjs', 'export function normalize(value) { return value.trim(); }\n');
    await write('behavior.test.mjs', 'import assert from "node:assert/strict"; import {normalize} from "./api.mjs"; assert.equal(typeof normalize(" AbC "),"string"); console.log("ASSERT return type is string: PASS");\n');
  } else {
    await write('api.mjs', 'export function normalize(value) { if (typeof value !== "string") throw new TypeError("string required"); const text=value.trim(); if (!text) throw new RangeError("nonblank required"); return text.toLowerCase(); }\n');
    await write('consumer.mjs', 'import {normalize} from "./api.mjs"; console.log(normalize(" AbC "));\n');
    await write('worker.py', 'import subprocess\nsubprocess.run(["node", "consumer.mjs"], check=True)\n');
    await write('.github/task.yml', 'command: node consumer.mjs\n');
    await write('guide.md', 'Import normalize from api.mjs; run node consumer.mjs.\n');
    await write('behavior.test.mjs', [
      'import assert from "node:assert/strict";',
      'import {readFileSync,existsSync} from "node:fs";',
      'import {execFileSync} from "node:child_process";',
      'import {normalize} from "./api.mjs";',
      'assert.equal(normalize("  AbC  "),"abc"); console.log("R1 exact normalized output: PASS");',
      'assert.throws(()=>normalize(42),TypeError); assert.throws(()=>normalize("   "),RangeError); console.log("R2 TypeError and RangeError: PASS");',
      'assert.equal(execFileSync(process.execPath,["consumer.mjs"],{encoding:"utf8"}).trim(),"abc");',
      'for (const file of ["consumer.mjs","worker.py",".github/task.yml","guide.md"]) {',
      ' const text=readFileSync(file,"utf8"); assert.doesNotMatch(text,/legacy\\.mjs|legacyNormalize/);',
      ' const entries=[...text.matchAll(/(?:api|consumer)\\.mjs/g)].map(match=>match[0]); assert.ok(entries.length);',
      ' for (const entry of entries) assert.ok(existsSync(entry)); console.log("R3 references resolve: "+file);',
      '}',
      'assert.equal(existsSync("legacy.mjs"),false); console.log("R3 removed module absent; JS consumer executes: PASS");',
    ].join('\n') + '\n');
  }
  const execution = await capture({ repo: root, out: path.join(root, 'artifacts/run'), command: [process.execPath, 'behavior.test.mjs'] });
  assert.equal(execution.validity, 'CLEAN'); assert.equal(execution.exitCode, 0);
  const bundle = await collect({ repo: root, out: path.join(root, 'artifacts/bundle'), base,
    plan: 'plan.md', planRef: base, runs: [path.join(root, 'artifacts/run/run.json')] });
  const result = await review({ repo: root, bundleFile: path.join(root, 'artifacts/bundle/bundle.json'),
    out: path.join(root, 'artifacts/review'), configFile: process.env.ACCEPTANCE_LIVE_AGENT_CONFIG });
  assert.ok(result.agent?.name && result.agent?.version && result.agent?.model, result.error);
  assert.ok(!result.agent.name.startsWith('fixture-'), 'Real-Agent test cannot use the protocol fixture.');
  const payload = await fs.readFile(path.join(root, 'artifacts/review/request.txt'), 'utf8');
  assert.ok(payload.includes('<frozen-evidence>'));
  assert.doesNotMatch(payload, /expectedVerdict|expectedChecks|self-acceptance|implementation-summary/);
  assert.deepEqual([...new Set(bundle.sources.map(source => source.kind))].sort(), ['diff', 'execution', 'plan']);
  console.log(JSON.stringify({ case: variant, agent: result.agent, verdict: result.verdict,
    checks: Object.fromEntries(Object.entries(result.checks || {}).map(([key, value]) => [key, value.status])) }));
  if (result.error) console.log(JSON.stringify({ case: variant, error: result.error }));
  return result;
}
test('real blind specimen a detects omitted requirements, dangling consumers and missing behavior assertions', { timeout: 650000 }, async t => {
  const result = await specimen(t, 'a');
  assert.equal(result.verdict, 'FAIL', result.error);
  assert.equal(result.checks.requirements.status, 'FAIL');
  assert.equal(result.checks.deletions.status, 'FAIL');
  assert.ok(['FAIL', 'INSUFFICIENT_EVIDENCE'].includes(result.checks.assertions.status));
});
test('real blind specimen b accepts implemented requirements, migrated consumers and executed counterexamples', { timeout: 650000 }, async t => {
  const result = await specimen(t, 'b');
  assert.equal(result.verdict, 'PASS', result.error);
  assert.equal(result.checks.requirements.status, 'PASS');
  assert.ok(['PASS', 'NOT_APPLICABLE'].includes(result.checks.deletions.status));
  assert.equal(result.checks.assertions.status, 'PASS');
});
