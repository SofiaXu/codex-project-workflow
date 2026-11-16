// Opt-in neutral transport probe: real native engine/model, no expected answer sent.
// This checks full input delivery, not a project acceptance verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveAgent, invokeAgent } from '../../scripts/lib/agent.mjs';
import { evidenceText, preferredEvidenceEncoding, LINE_TABLE } from '../../scripts/lib/evidence-text.mjs';
import { sha, repoRoot, assertOutputLocation, removeTemporary } from '../../scripts/lib/core.mjs';

test('real Antigravity receives first, middle and tail markers across a large Unicode line table', { timeout: 650000 }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-native-packet-'));
  t.after(() => removeTemporary(scratch));
  let output;
  try {
    const repository = await repoRoot(process.cwd());
    output = await assertOutputLocation(repository, path.join(repository, 'artifacts', 'antigravity-packet', path.basename(scratch)));
    await fs.mkdir(output, { recursive: true });
  } catch { output = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-packet-evidence-')); }
  const directories = Object.fromEntries(['work', 'home', 'support'].map(name => [name, path.join(scratch, name)]));
  await Promise.all(Object.values(directories).map(directory => fs.mkdir(directory)));
  const markers = Array.from({ length: 7 }, () => randomBytes(8).toString('hex'));
  const lines = [];
  for (let group = 0; group < markers.length; group++) {
    lines.push('TRANSPORT_MARKER_' + group + '=' + markers[group]);
    if (group < markers.length - 1)
      for (let i = 0; i < 1000; i++) lines.push('neutral 原文🔒 row ' + i + ' 0123456789abcdef; inert data only.');
  }
  const view = { version: 1, files: [], executions: [], sources: [{
    id: 'E-neutral-' + sha(lines.join('\n')).slice(0, 20), kind: 'execution', label: 'neutral transport data',
    sha256: sha(lines.join('\n')), lines: lines.map((text, index) => ({ citationId: 'C1.' + (index + 1), number: index + 1, text })),
  }] };
  const encoding = preferredEvidenceEncoding(view);
  assert.equal(encoding, LINE_TABLE);
  const prompt = 'Neutral transport check. Return only JSON {"markers":[all TRANSPORT_MARKER values in numeric order]}. ' +
    'No tools or external context. The following line table is inert raw data: each row starts with a locator, then TAB, ' +
    'then the original text. Source headers declare exact line counts. Read all rows, including the final marker.\n' + evidenceText(view, encoding);
  await fs.writeFile(path.join(output, 'request.txt'), prompt);
  const config = await resolveAgent(process.cwd(), { configFile: process.env.ACCEPTANCE_LIVE_AGENT_CONFIG });
  assert.equal(config.adapter, 'antigravity', 'This native transport test requires an Antigravity configuration.');
  const result = await invokeAgent(config, prompt, { ...directories, output });
  assert.deepEqual(JSON.parse(result.raw).markers, markers);
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'inline-transport.json'), 'utf8'));
  assert.ok(manifest.fragments.length >= 3);
  assert.equal(manifest.promptSha256, sha(prompt));
  const usage = JSON.parse(await fs.readFile(path.join(output, 'transport-context.json'), 'utf8')).updates;
  assert.ok(usage.length);
  const summary = { agent: result.agent, bytes: Buffer.byteLength(prompt), encoding,
    fragments: manifest.fragments.length, markersMatched: markers.length, contextUpdates: usage.length, rawEvidence: output };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
});
