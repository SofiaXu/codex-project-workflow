import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installLocalSkill, SOURCE, distributionFiles } from '../scripts/install.mjs';
import { removeTemporary, sha, exists } from '../scripts/lib/core.mjs';

test('complete local distribution preserves user configuration and launchers on repeated installation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-install-'));
  t.after(() => removeTemporary(directory));
  const target = path.join(directory, 'skill');
  const first = await installLocalSkill(target);
  const names = new Set(first.files.map(file => file.path));
  for (const required of ['SKILL.md', 'LICENSE', 'package-lock.json', 'agents/openai.yaml',
    'references/evidence-contract.md', 'scripts/adjudicate.mjs', 'scripts/dsh-guard.mjs'])
    assert.ok(names.has(required), 'Missing independent distribution resource: ' + required);
  assert.equal(await exists(path.join(target, 'node_modules')), false);
  await fs.writeFile(path.join(target, 'config.local.json'), '{"keep":"user-selected-agent"}\n');
  await fs.mkdir(path.join(target, 'local'));
  await fs.writeFile(path.join(target, 'local', 'launcher.mjs'), '// preserve user launcher\n');
  await fs.writeFile(path.join(target, 'custom-note.txt'), 'preserve destination-only resource');
  const second = await installLocalSkill(target);
  assert.equal(await fs.readFile(path.join(target, 'config.local.json'), 'utf8'), '{"keep":"user-selected-agent"}\n');
  assert.equal(await fs.readFile(path.join(target, 'local', 'launcher.mjs'), 'utf8'), '// preserve user launcher\n');
  assert.equal(await fs.readFile(path.join(target, 'custom-note.txt'), 'utf8'), 'preserve destination-only resource');
  assert.equal(second.files.length, (await distributionFiles()).length);
  for (const file of second.files) {
    assert.equal(sha(await fs.readFile(path.join(target, file.path))), file.sha256);
    assert.equal(sha(await fs.readFile(path.join(SOURCE, file.path))), file.sha256);
  }
  await assert.rejects(installLocalSkill(SOURCE), /outside the source/);
});
