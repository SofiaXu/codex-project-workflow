// Native ACP transport fixture; never selected as a production fallback.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { parse } from 'yaml';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const mode = process.argv[2] || 'normal';
if (process.argv.includes('--version')) {
  console.log(mode === 'old-version' ? '1.5.8' : '1.5.9');
  process.exit(0);
}
assert.equal((await fs.readdir(process.cwd())).length, 0);
assert.equal(process.env.ACCEPTANCE_TEST_SECRET, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.ok(process.argv.includes('acp'));
assert.ok(process.argv.includes('--include-default-customizations=false'));
assert.ok(process.argv.includes('--disable-telemetry'));
const gemini = process.argv[process.argv.indexOf('--gemini-dir') + 1];
assert.equal(gemini, path.join(process.env.USERPROFILE, '.gemini'));
const file = path.join(gemini, 'config', 'agents', 'acceptance-packet.md');
const body = await fs.readFile(file, 'utf8');
const profile = parse(body.match(/^---\n([\s\S]*?)\n---/)[1]);
for (const key of ['tools', 'skills', 'plugins', 'mcpServers']) assert.deepEqual(profile[key], []);
for (const key of ['subagent', 'inheritCustomizations', 'inheritMcp']) assert.equal(profile[key], false);
assert.equal(profile.excludeDefaultComponents, true);
const settings = JSON.parse(await fs.readFile(path.join(gemini, 'antigravity-cli', 'settings.json'), 'utf8'));
assert.equal(settings.toolPermission, 'strict');
assert.equal(settings.allowNonWorkspaceAccess, false);
let model = 'gemini-4-carbon', thought = 'medium';
const fragments = [];
const options = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [{ value: 'gemini-4-carbon', name: 'Carbon' }, { value: 'gemini-4-argon', name: 'Argon' }] },
  { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: thought,
    options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
];
const app = agent({ name: 'antigravity-fixture' })
  .onRequest(methods.agent.initialize, ({ params }) => {
    assert.equal(params.clientCapabilities.fs.readTextFile, false);
    assert.equal(params.clientCapabilities.fs.writeTextFile, false);
    assert.equal(params.clientCapabilities.terminal, false);
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {},
      agentInfo: { name: mode === 'wrong-identity' ? 'Other Agent' : 'Antigravity ACP Server', version: '1.5.9' }, authMethods: [] };
  })
  .onRequest(methods.agent.session.new, async ({ params }) => {
    assert.equal(params.cwd, process.cwd());
    assert.deepEqual(params.mcpServers, []);
    assert.deepEqual(params._meta.agy.enabledTools, []);
    if (mode === 'profile-drift') await fs.appendFile(file, '\nUNEXPECTED_CHANGE\n');
    return { sessionId: 'new-native-session', configOptions: options(), models: {
      currentModelId: model + '-' + thought,
      availableModels: [
        ...(mode === 'missing-model' ? [] : [{ modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' }]),
        { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
        { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
      ],
    } };
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    if (params.configId === 'model') model = params.value;
    if (params.configId === 'thought_level' && mode !== 'ignore-thinking') thought = params.value;
    return { configOptions: options() };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    process.stderr.write('NATIVE_PROMPT_RECEIVED\n');
    async function reply(text) {
      for (const part of [text.slice(0, 5), text.slice(5)]) await client.notify(methods.client.session.update, {
        sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } },
      });
      return { stopReason: 'end_turn' };
    }
    const text = params.prompt[0].text;
    if (text.startsWith('RAW PACKET TRANSPORT COMPLETE.')) {
      process.stderr.write('PACKET_COMPLETE\n');
      const packet = fragments.join('');
      return reply(JSON.stringify({ sha256: createHash('sha256').update(packet).digest('hex'),
        bytes: Buffer.byteLength(packet), fragments: fragments.length }));
    }
    if (text.startsWith('RAW PACKET TRANSPORT ')) {
      assert.ok(Buffer.byteLength(text) <= 144 * 1024);
      const begin = '\n<raw-packet-fragment>\n', end = '\n</raw-packet-fragment>\n';
      fragments.push(text.slice(text.indexOf(begin) + begin.length, text.lastIndexOf(end)));
      process.stderr.write('PACKET_FRAGMENT:' + fragments.length + '\n');
      if (mode === 'packet-pause' && fragments.length === 2) await new Promise(resolve => setTimeout(resolve, 60000));
      const used = mode === 'packet-full' ? 1048576 : mode === 'packet-reset'
        ? (fragments.length === 1 ? 200000 : 8002) : Math.ceil(Buffer.byteLength(fragments.join('')) / 4);
      if (mode !== 'packet-no-usage') await client.notify(methods.client.session.update, {
        sessionId: params.sessionId, update: { sessionUpdate: 'usage_update', used, size: 1048576 },
      });
      if (mode === 'packet-tool') await client.notify(methods.client.session.update, { sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'forbidden', title: 'Read file', kind: 'read', status: 'pending' } });
      return reply(mode === 'packet-bad-ack' ? 'RECEIVED' : text.slice(text.lastIndexOf('Acknowledgement: ') + 17));
    }
    if (mode === 'model-drift') {
      thought = 'medium';
      await client.notify(methods.client.session.update, { sessionId: params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: options() } });
    }
    if (mode === 'tool') await client.notify(methods.client.session.update, { sessionId: params.sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'forbidden', title: 'Read file', kind: 'read', status: 'pending' } });
    for (const text of ['NATIVE_', 'RESPONSE']) await client.notify(methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, () => {})
  .onRequest(methods.agent.session.close, () => ({}));
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
