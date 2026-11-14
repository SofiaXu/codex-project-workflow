// Transport fixture only. Never installed or selected as a production fallback.
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
const mode = process.argv[2] || 'normal';
let currentModel = 'fixture/current';
const ready = () => process.stderr.write(`${JSON.stringify({ acceptanceGuard: 1,
  nonce: process.env.ACCEPTANCE_GUARD_NONCE, tools: 0, instructions: false, memory: false })}\n`);
const options = () => [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: currentModel,
  options: [{ value: 'fixture/current', name: 'Current' }, { value: 'fixture/new', name: 'New' }] }];
function verdict(prompt) {
  const start = prompt.lastIndexOf('<frozen-evidence>') + '<frozen-evidence>'.length;
  const bundle = JSON.parse(prompt.slice(start, prompt.lastIndexOf('</frozen-evidence>')));
  const cite = item => {
    const lines = item.lines.map(line => line.text); const index = lines.findIndex(line => line.trim());
    return { sourceId: item.id, kind: item.kind, startLine: index + 1, endLine: index + 1, quote: lines[index] };
  };
  const plan = cite(bundle.sources.find(item => item.kind === 'plan'));
  const diff = cite(bundle.sources.find(item => item.kind === 'diff'));
  const test = cite(bundle.sources.find(item => item.label === 'test/0/command'));
  const result = { verdict: 'PASS', checks: {
    requirements: { status: 'PASS', reason: '执行证据覆盖需求', citations: [plan, diff, test],
      items: [{ id: 'R1', description: '具体行为', status: 'PASS', citations: [plan, diff, test] }] },
    deletions: { status: 'NOT_APPLICABLE', reason: '无删除契约', citations: [diff], items: [] },
    assertions: { status: 'PASS', reason: '行为和边界测试已执行', citations: [test], items: [] },
  }, findings: [], gaps: [] };
  if (mode === 'bad-id') plan.sourceId = 'P-invented';
  if (mode === 'bad-lines') plan.endLine = 99999;
  if (mode === 'bad-quote') plan.quote = 'invented quote';
  if (mode === 'bad-kind') plan.kind = 'execution';
  if (mode === 'missing-check') delete result.checks.assertions;
  if (['selectors', 'selector-strings', 'bad-selector', 'bad-selector-string', 'blank-selector', 'blank-selector-string', 'selector-conflict'].includes(mode)) {
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.citations)) value.citations = value.citations.map(ref => {
        const item = bundle.sources.find(item => item.id === ref.sourceId);
        const id = item.lines[ref.startLine - 1].citationId;
        return mode === 'selector-strings' ? id : { citationId: id };
      });
      for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
    };
    visit(result);
    if (mode === 'bad-selector') result.checks.requirements.citations[0].citationId = 'L-invented';
    if (mode === 'bad-selector-string') result.checks.requirements.citations[0] = 'C999999.1';
    if (mode === 'blank-selector' || mode === 'blank-selector-string') {
      const index = bundle.sources.findIndex(item => item.kind === 'plan');
      const line = bundle.sources[index].lines.find(line => !line.text.trim());
      const id = 'C' + (index + 1) + '.' + line.number;
      result.checks.requirements.citations[0] = mode === 'blank-selector' ? { citationId: id } : id;
    }
    if (mode === 'selector-conflict') result.checks.requirements.citations[0].quote = 'conflicting explicit quote';
  }
  return result;
}
if ((await fs.readdir(process.cwd())).length || process.env.ACCEPTANCE_TEST_SECRET || process.env.NODE_OPTIONS)
  throw new Error('Workspace or environment isolation failed.');
if (mode === 'command' || mode === 'command-no-guard') {
  if (mode === 'command') ready();
  let input = ''; for await (const chunk of process.stdin) { input += chunk; process.stderr.write('COMMAND_INPUT_READ\n'); }
  process.stdout.write(JSON.stringify({ agent: { name: 'fixture-command', version: '1', model: currentModel }, response: verdict(JSON.parse(input).prompt) }));
} else {
  const app = agent({ name: 'fixture' })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {}, agentInfo: { name: 'fixture-agent', version: '1.2.3' }, authMethods: [] }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      if (params.cwd !== process.cwd() || params.mcpServers.length) throw new Error('Unexpected workspace/MCP capability.');
      if (mode !== 'no-guard') ready(); return { sessionId: 'fresh-fixture', configOptions: options() };
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => { currentModel = params.value; return { configOptions: options() }; })
    .onRequest(methods.agent.session.close, () => ({}))
    .onNotification(methods.agent.session.cancel, () => {})
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      process.stderr.write('PROMPT_RECEIVED\n');
      if (mode === 'exit') process.exit(7);
      if (mode === 'pause') await new Promise(resolve => setTimeout(resolve, 700));
      if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 60000));
      if (mode === 'permission') {
        const response = await client.request(methods.client.session.requestPermission, { sessionId: params.sessionId,
          toolCall: { toolCallId: 'forbidden', title: 'Forbidden', kind: 'read' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
        if (response.outcome.outcome !== 'cancelled') throw new Error('Permission was not refused.');
      }
      if (mode === 'tool') await client.notify(methods.client.session.update, { sessionId: params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'forbidden', title: 'Forbidden', kind: 'read', status: 'pending' } });
      if (mode === 'client-fs') {
        try { await client.request(methods.client.fs.readTextFile, { sessionId: params.sessionId, path: '/forbidden' }); }
        catch { /* Attempt to continue with a PASS after a rejected direct capability request. */ }
      }
      const raw = JSON.stringify(verdict(params.prompt[0].text));
      for (const text of [raw.slice(0, 30), raw.slice(30)]) await client.notify(methods.client.session.update,
        { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
      return { stopReason: 'end_turn' };
    });
  const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  await connection.closed;
}
