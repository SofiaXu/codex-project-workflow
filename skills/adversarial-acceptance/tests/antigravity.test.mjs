import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { invokeAgent, resolveAgent } from '../scripts/lib/agent.mjs';
import { removeTemporary, sha } from '../scripts/lib/core.mjs';
const mock = fileURLToPath(new URL('./mock-antigravity.mjs', import.meta.url));

async function fixture(t, mode = 'normal', model = 'gemini-4-carbon-high') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-antigravity-'));
  t.after(() => removeTemporary(root));
  const directories = Object.fromEntries(['work', 'home', 'support', 'output'].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map(dir => fs.mkdir(dir)));
  const configuration = { version: 1, adapter: 'antigravity', transport: 'acp', command: process.execPath,
    args: [mock, mode], model, timeoutMs: 15000 };
  const configFile = path.join(root, 'agent.json');
  await fs.writeFile(configFile, JSON.stringify(configuration));
  const config = await resolveAgent(root, { configFile });
  return { ...directories, config, invoke: (prompt = 'ONLY_INLINE_PACKET', options = {}) =>
    invokeAgent(config, prompt, { ...directories, ...options }) };
}
test('Antigravity ACP uses an empty profile and selects exact model plus High thinking', async t => {
  const f = await fixture(t);
  process.env.ACCEPTANCE_TEST_SECRET = 'never-inherit';
  t.after(() => { delete process.env.ACCEPTANCE_TEST_SECRET; });
  const result = await f.invoke();
  assert.equal(result.raw, 'NATIVE_RESPONSE');
  assert.equal(result.agent.name, 'Antigravity ACP Server');
  assert.equal(result.agent.version, '1.5.9');
  assert.equal(result.agent.model, 'gemini-4-carbon-high');
  assert.deepEqual(result.agent.configuration, { model: 'gemini-4-carbon', thought_level: 'high' });
  assert.equal(result.agent.protocolVersion, 1);
  const alternate = await fixture(t, 'normal', 'gemini-4-argon-high');
  assert.equal((await alternate.invoke()).agent.model, 'gemini-4-argon-high');
});
test('Antigravity refuses unavailable models, ignored High, wrong identity and profile changes before prompting', async t => {
  for (const mode of ['missing-model', 'ignore-thinking', 'wrong-identity', 'profile-drift', 'old-version']) {
    const f = await fixture(t, mode);
    await assert.rejects(f.invoke(), /Antigravity/);
    const diagnostics = await fs.readFile(path.join(f.output, 'agent-stderr.raw'), 'utf8').catch(() => '');
    assert.doesNotMatch(diagnostics, /NATIVE_PROMPT_RECEIVED/, mode);
  }
});
test('Antigravity rejects model downgrades and tool attempts during a prompt', async t => {
  for (const mode of ['model-drift', 'tool']) {
    const f = await fixture(t, mode);
    await assert.rejects(f.invoke(), /selected model|forbidden tool/);
  }
});

const largePacket = 'START\n' + '原文🔒\t"quoted" \\ data\n'.repeat(24000) + 'END';
test('large Antigravity packets preserve every byte and retain per-turn raw acknowledgements', async t => {
  const f = await fixture(t);
  const result = await f.invoke(largePacket);
  const native = JSON.parse(result.raw);
  assert.equal(native.sha256, sha(largePacket));
  assert.equal(native.bytes, Buffer.byteLength(largePacket));
  assert.ok(native.fragments > 2);
  const manifest = JSON.parse(await fs.readFile(path.join(f.output, 'inline-transport.json'), 'utf8'));
  assert.equal(manifest.promptSha256, native.sha256);
  assert.equal(manifest.fragments.length, native.fragments);
  for (let i = 1; i <= native.fragments; i++) {
    const name = String(i).padStart(4, '0');
    const request = await fs.readFile(path.join(f.output, 'transport', name + '-request.txt'), 'utf8');
    const response = await fs.readFile(path.join(f.output, 'transport', name + '-response.raw'), 'utf8');
    assert.ok(Buffer.byteLength(request) <= manifest.maxMessageBytes);
    assert.equal(response, request.slice(request.lastIndexOf('Acknowledgement: ') + 17));
  }
  assert.equal(await fs.readFile(path.join(f.output, 'agent-response.raw'), 'utf8'), result.raw);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'inline-progress.json'), 'utf8')).stage, 'done');
});

test('fragment clipping, missing usage, compaction, capacity and tool violations stop before adjudication', async t => {
  for (const [mode, error] of [
    ['packet-bad-ack', /not acknowledged exactly/], ['packet-no-usage', /no context usage/],
    ['packet-reset', /context usage decreased/], ['packet-full', /capacity exhausted/],
    ['packet-tool', /forbidden tool/],
  ]) {
    const f = await fixture(t, mode);
    await assert.rejects(f.invoke(largePacket), error);
    const diagnostics = await fs.readFile(path.join(f.output, 'agent-stderr.raw'), 'utf8');
    assert.doesNotMatch(diagnostics, /PACKET_COMPLETE/, mode);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'inline-progress.json'), 'utf8')).stage, 'error');
  }
});

test('one total deadline and caller cancellation cover a partly delivered native packet', async t => {
  const timed = await fixture(t, 'packet-pause');
  timed.config.timeoutMs = 2500;
  await assert.rejects(timed.invoke(largePacket), /timed out/);
  assert.match(await fs.readFile(path.join(timed.output, 'agent-stderr.raw'), 'utf8'), /PACKET_FRAGMENT:2/);
  const cancelled = await fixture(t, 'packet-pause'), controller = new AbortController();
  const pending = cancelled.invoke(largePacket, { signal: controller.signal });
  pending.catch(() => {});
  try {
    let started = false;
    for (let i = 0; i < 200 && !started; i++) {
      started = /PACKET_FRAGMENT:2/.test(await fs.readFile(path.join(cancelled.output, 'agent-stderr.raw'), 'utf8').catch(() => ''));
      if (!started) await delay(25);
    }
    assert.equal(started, true);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  } finally { controller.abort(); await pending.catch(() => {}); }
});
