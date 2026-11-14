// Opt-in: verifies an already-installed global copy without changing its settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SOURCE, defaultDestination, distributionFiles } from '../../scripts/install.mjs';
import { git, run, sha, repoRoot, removeTemporary } from '../../scripts/lib/core.mjs';

test('global distribution matches source, runs capture/collect/review, and repository artifacts are ignored', async t => {
  const installed = defaultDestination();
  for (const name of await distributionFiles())
    assert.equal(sha(await fs.readFile(path.join(installed, name))), sha(await fs.readFile(path.join(SOURCE, name))), 'Global resource mismatch: ' + name);
  const repository = await repoRoot(SOURCE);
  const ignored = await run('git', ['check-ignore', '--no-index', '--', 'artifacts/acceptance-probe'], { cwd: repository });
  assert.equal(ignored.code, 0); assert.match(ignored.stdout.toString(), /artifacts/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-installed-'));
  t.after(() => removeTemporary(root));
  await git(root, ['init', '-q']);
  await fs.writeFile(path.join(root, '.gitignore'), '/artifacts/\n');
  await fs.writeFile(path.join(root, 'plan.md'), 'R1: sum(2,3)=5; non-numeric input throws TypeError.\n');
  await fs.writeFile(path.join(root, 'api.mjs'), 'export const sum=(a,b)=>a+b;\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'original']);
  const base = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
  await fs.writeFile(path.join(root, 'api.mjs'), 'export function sum(a,b){if(typeof a!=="number"||typeof b!=="number")throw new TypeError();return a+b;}\n');
  await fs.writeFile(path.join(root, 'behavior.test.mjs'), 'import assert from "node:assert/strict";import {sum} from "./api.mjs";assert.equal(sum(2,3),5);assert.throws(()=>sum("2",3),TypeError);console.log("exact result and TypeError assertions passed");\n');
  const cli = path.join(installed, 'scripts/adjudicate.mjs');
  async function invoke(args) {
    const execution = await run(process.execPath, [cli, ...args], { cwd: root });
    assert.equal(execution.code, 0, execution.stdout.toString() + execution.stderr.toString());
    return execution.stdout.toString();
  }
  assert.match(await invoke(['--help']), /capture/);
  const captured = JSON.parse(await invoke(['capture', '--repo', root, '--out', path.join(root, 'artifacts/run'), '--', process.execPath, 'behavior.test.mjs']));
  assert.equal(captured.validity, 'CLEAN'); assert.equal(captured.exitCode, 0);
  await invoke(['collect', '--repo', root, '--base', base, '--plan', 'plan.md', '--plan-ref', base,
    '--run', path.join(root, 'artifacts/run/run.json'), '--out', path.join(root, 'artifacts/bundle')]);
  const config = path.join(root, 'artifacts/agent.json');
  await fs.writeFile(config, JSON.stringify({ version: 1, adapter: 'custom', transport: 'acp',
    command: process.execPath, args: [path.join(installed, 'tests/mock-agent.mjs')],
    isolation: { toolsDisabled: true, instructionsDisabled: true, memoryDisabled: true } }));
  const result = JSON.parse(await invoke(['review', '--repo', root, '--bundle', path.join(root, 'artifacts/bundle/bundle.json'),
    '--config', config, '--out', path.join(root, 'artifacts/review')]));
  assert.equal(result.verdict, 'PASS'); assert.equal(result.agent.name, 'fixture-agent');
  console.log('ASSERT global resource SHA-256 equality, actual global CLI and ignored artifacts: PASS; protocol fixture only, real model tests are separate.');
});
