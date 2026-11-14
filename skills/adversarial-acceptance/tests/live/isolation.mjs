// Uses the real installed DSH engine with a loopback Messages server.
// No real model request or user credential is sent to this server.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolveAgent, invokeAgent } from '../../scripts/lib/agent.mjs';
import { SOURCE } from '../../scripts/install.mjs';
import { repoRoot, removeTemporary } from '../../scripts/lib/core.mjs';

test('native DSH excludes seeded memory and instructions and rejects unknown required context before inference', { timeout: 45000 }, async t => {
  const selected = await resolveAgent(await repoRoot(SOURCE));
  assert.equal(selected.adapter, 'deepseek', 'This engine-specific test requires a DeepSeek launcher.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-profile-'));
  t.after(() => removeTemporary(root));
  const requests = [], key = 'sk-' + '0'.repeat(32);
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const bytes of request) raw += bytes;
    if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
    assert.equal(request.headers['x-api-key'], key);
    requests.push({ path: request.url, body: JSON.parse(raw) });
    const frames = [
      ['message_start', { type: 'message_start', message: { id: 'profile-probe', type: 'message', role: 'assistant',
        model: 'deepseek-v4-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'profile-probe-complete' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map(([event, data]) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n').join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const previous = process.env.DEEPSEEK_BASE_URL;
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:' + server.address().port + '/anthropic';
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_BASE_URL; else process.env.DEEPSEEK_BASE_URL = previous; });
  const credentials = path.join(root, 'test-credentials.yaml');
  await fs.writeFile(credentials, JSON.stringify({ version: 1, refs: { DEEPSEEK_API_KEY: key } }));
  const memory = 'PROFILE_MEMORY_MUST_NOT_REACH_MODEL', instruction = 'PROFILE_INSTRUCTION_MUST_NOT_REACH_MODEL';
  for (const required of [false, true]) {
    const directory = path.join(root, required ? 'required' : 'optional');
    const work = path.join(directory, 'cwd'), home = path.join(directory, 'home'), support = path.join(directory, 'support'), output = path.join(directory, 'output');
    for (const name of [work, home, support, output]) await fs.mkdir(name, { recursive: true });
    const plugin = path.join(support, 'seed-context.mjs');
    await fs.writeFile(plugin, [
      'export default {inject:["systemPrompt"],apply(ctx){',
      'ctx.systemPrompt.section({name:"probe:instruction",order:20,text:' + JSON.stringify(instruction) + '});',
      'ctx.systemPrompt.context({name:"probe:memory",order:100,required:' + required + ',text:' + JSON.stringify(memory) + '});',
      'ctx.on("agent/created",()=>{process.stderr.write("PROFILE_SEED_REGISTERED"+String.fromCharCode(10));});',
      '}};',
    ].join('\n'));
    const seededHome = path.join(support, 'dsh');
    await fs.mkdir(seededHome);
    const seed = path.join(seededHome, 'cordis.patch.yml');
    await fs.writeFile(seed, JSON.stringify([{ insert: [{ id: 'profile-test-seed', name: pathToFileURL(plugin).href }] }]));
    await fs.writeFile(path.join(home, 'AGENTS.md'), instruction);
    const config = { ...selected, provider: 'deepseek-official',
      model: 'deepseek-v4-flash', credentialsFile: credentials, timeoutMs: 15000 };
    assert.deepEqual(await fs.readdir(work), []);
    const before = requests.length;
    const response = invokeAgent(config, 'PROFILE_EVIDENCE_INPUT', { work, home, support, output }).catch(async error => {
      console.log(JSON.stringify({ required, diagnostics: await fs.readFile(path.join(output, 'agent-stderr.raw'), 'utf8').catch(() => '') }));
      throw error;
    });
    if (required) {
      await assert.rejects(response, /Unexpected runtime context/);
      assert.equal(requests.length, before, 'Rejected context must never reach inference.');
    } else {
      assert.equal((await response).raw, 'profile-probe-complete');
      assert.equal(requests.length, before + 1);
      const request = requests.at(-1);
      assert.equal(request.path, '/anthropic/v1/messages');
      const visible = JSON.stringify({ messages: request.body.messages, system: request.body.system, tools: request.body.tools });
      assert.ok(visible.includes('PROFILE_EVIDENCE_INPUT'));
      assert.ok(!visible.includes(memory)); assert.ok(!visible.includes(instruction));
      assert.equal(request.body.tools?.length || 0, 0);
    }
    assert.match(await fs.readFile(path.join(output, 'agent-stderr.raw'), 'utf8'), /PROFILE_SEED_REGISTERED/);
  }
  console.log('ASSERT real DSH request excludes active optional memory/static instruction seeds; unknown required context is rejected before inference; model-visible tools are empty.');
});
