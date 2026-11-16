import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture, collect, fingerprint, scopeOf, git, exists, validateBundle, removeTemporary, citationId,
  run, reviewerEvidence, sha, canonical } from '../scripts/lib/core.mjs';
import { evidenceText, decodeLineTable, LINE_TABLE } from '../scripts/lib/evidence-text.mjs';
import { review, isolatedEnvironment, latestDeepSeekModel, resolveAgent } from '../scripts/lib/agent.mjs';
import { parseVerdict, reviewPrompt } from '../scripts/lib/verdict.mjs';

const mock = fileURLToPath(new URL('./mock-agent.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-test-'));
  t.after(() => removeTemporary(root));
  await git(root, ['init', '-q']);
  await fs.writeFile(path.join(root, '.gitignore'), '/artifacts/\n/node_modules/\n');
  await fs.writeFile(path.join(root, 'plan.md'), 'R1: sum(2, 3) must equal 5; invalid input must throw TypeError.\n');
  await fs.writeFile(path.join(root, 'api.mjs'), 'export function sum(a, b) { return a + b; }\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  const base = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
  const write = async (name, value) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), value); };
  await write('api.mjs', "export function sum(a, b) { if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('numbers required'); return a + b; }\n");
  await write('behavior.test.mjs', "import assert from 'node:assert/strict'; import {sum} from './api.mjs';\nassert.equal(sum(2,3),5); assert.throws(()=>sum('2',3),TypeError); console.log('ASSERT sum(2,3)=5; ASSERT invalid input throws TypeError');\n");
  const options = { repo: root, base, plan: 'plan.md', planRef: base };
  const record = async (name = 'run') => capture({ repo: root, out: path.join(root, 'artifacts', name), command: [process.execPath, 'behavior.test.mjs'] });
  const bundle = async (name = 'bundle', runs = []) => collect({ ...options, runs, out: path.join(root, 'artifacts', name) });
  return { root, base, write, options, record, bundle };
}
async function agentConfig(root, mode = 'normal', changes = {}) {
  const file = path.join(root, 'artifacts', `agent-${mode}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, adapter: 'custom', transport: mode === 'command' ? 'command' : 'acp',
    command: process.execPath, args: [mock, mode], timeoutMs: 15000,
    isolation: { toolsDisabled: true, instructionsDisabled: true, memoryDisabled: true }, ...changes }));
  return file;
}

test('capture permits existing changes, binds outputs, and rejects dirty/stale records', async t => {
  const f = await fixture(t);
  const clean = await f.record(); assert.equal(clean.validity, 'CLEAN'); assert.equal(clean.exitCode, 0);
  const bundle = await f.bundle('fresh', [path.join(f.root, 'artifacts/run/run.json')]); validateBundle(bundle);
  await f.write('extra.txt', 'new untracked source');
  await assert.rejects(f.bundle('stale', [path.join(f.root, 'artifacts/run/run.json')]), error => error.status === 'INSUFFICIENT_EVIDENCE');
  const dirty = await capture({ repo: f.root, out: path.join(f.root, 'artifacts/dirty'), command: [process.execPath, '-e', "require('fs').writeFileSync('extra.txt','changed during execution')"] });
  assert.equal(dirty.validity, 'DIRTY');
  await assert.rejects(f.bundle('dirty-bundle', [path.join(f.root, 'artifacts/dirty/run.json')]), error => error.status === 'INSUFFICIENT_EVIDENCE');
  const text = await fs.readFile(path.join(f.root, 'artifacts/run/stdout.raw'), 'utf8');
  assert.match(text, /ASSERT invalid input/);
});

test('fingerprint binds HEAD, index, raw tracked/untracked bytes, locks and binaries', async t => {
  const f = await fixture(t); const snapshots = [];
  snapshots.push((await fingerprint(f.root)).digest);
  await git(f.root, ['add', 'api.mjs']); snapshots.push((await fingerprint(f.root)).digest);
  await f.write('package-lock.json', '{"lockfileVersion":3}'); snapshots.push((await fingerprint(f.root)).digest);
  await f.write('image.bin', Buffer.from([0, 1, 2])); snapshots.push((await fingerprint(f.root)).digest);
  await git(f.root, ['add', '.']);
  await git(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'change']);
  snapshots.push((await fingerprint(f.root)).digest);
  assert.equal(new Set(snapshots).size, snapshots.length);
  await f.write('artifacts/ignored.log', 'output');
  assert.equal((await fingerprint(f.root)).digest, snapshots.at(-1));
  await fs.mkdir(path.join(f.root, 'uninitialized-module'));
  const commit = (await git(f.root, ['rev-parse', 'HEAD'])).toString().trim();
  await git(f.root, ['update-index', '--add', '--cacheinfo', `160000,${commit},uninitialized-module`]);
  const linked = await fingerprint(f.root);
  assert.notEqual(linked.digest, snapshots.at(-1));
  assert.equal((await fingerprint(f.root)).digest, linked.digest);
});

test('deletion scans include cross-language consumers, hidden configs and docs, excluding dependencies', async t => {
  const f = await fixture(t);
  await f.write('legacy.py', 'def legacy_api(): return 1\n');
  await f.write('consumer.ts', 'const call = legacy_api();\n');
  await f.write('.github/settings.yml', 'entry: legacy.py\n');
  await f.write('package-lock.json', '{"localEntry":"legacy.py"}\n');
  await f.write('guide.md', 'Call legacy_api through legacy.py.\n');
  await git(f.root, ['add', '.']);
  await git(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'legacy']);
  f.options.base = (await git(f.root, ['rev-parse', 'HEAD'])).toString().trim();
  await fs.unlink(path.join(f.root, 'legacy.py'));
  await f.write('node_modules/noise.txt', 'legacy_api');
  const bundle = await f.bundle();
  const logs = bundle.sources.filter(item => item.label.startsWith('reference-search/') && item.label.endsWith('/stdout')).map(item => item.text).join('\n');
  assert.match(logs, /consumer.ts/); assert.match(logs, /\.github[\\/]settings.yml/); assert.match(logs, /guide.md/);
  assert.match(logs, /package-lock.json/);
  assert.doesNotMatch(logs, /node_modules/);
  assert.ok(bundle.sources.some(item => item.label.endsWith('/command') && /"exitCode": 0/.test(item.text)));
});

test('declaration-based collection preserves real export references without searching removed body boilerplate', async t => {
  const f = await fixture(t);
  await f.write('Contract.cs', 'public class Contract {\n  public void RemovedApi() {}\n  public void Keep() {\n    var connection = new NpgsqlConnection(ConnectionString);\n    connection.OpenAsync();\n  }\n}\n');
  await f.write('openapi.json', JSON.stringify({ openapi: '3.1.0', info: { title: 'Old API' }, paths: {} }));
  await f.write('verify.ps1', '$connection = New-Connection\n$connection.OpenAsync()\n');
  await f.write('consumer.ts', 'invoke("RemovedApi");\n');
  await f.write('.github/settings.yml', 'entry: RemovedApi\n');
  await f.write('guide.md', 'Use RemovedApi.\n');
  await git(f.root, ['add', '.']);
  await git(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'contract']);
  f.options.base = (await git(f.root, ['rev-parse', 'HEAD'])).toString().trim();
  await f.write('Contract.cs', 'public class Contract {\n  public void Keep() {\n    OpenReplacement();\n  }\n}\n');
  await f.write('openapi.json', JSON.stringify({ openapi: '3.1.0', info: { title: 'New API' }, paths: {} }));
  await f.write('verify.ps1', '$other = Get-Replacement\n');
  const bundle = await f.bundle();
  validateBundle(bundle);
  const scope = JSON.parse(bundle.sources.find(item => item.label === 'reference-search/scope').text);
  assert.deepEqual(scope.terms, ['RemovedApi']);
  const metadata = bundle.files.find(file => file.path === 'Contract.cs').referenceDetection;
  assert.equal(metadata.rule, 'csharp-declarations-v1');
  assert.deepEqual(metadata.terms, ['RemovedApi']);
  const logs = bundle.sources.filter(item => /reference-search\/\d+\/stdout/.test(item.label)).map(item => item.text).join('\n');
  for (const name of ['consumer.ts', '.github/settings.yml', 'guide.md']) assert.ok(logs.includes(name), name);
  assert.match(bundle.sources.find(item => item.label === 'unstaged/Contract.cs').text, /NpgsqlConnection/);
});

test('lock/binary diffs are metadata only; oversize and modified bundles fail explicitly', async t => {
  const f = await fixture(t);
  await f.write('package-lock.json', '{"secretNoise":"LOCK_CONTENT_MUST_NOT_APPEAR"}\n');
  await f.write('asset.bin', Buffer.from([0, 42, 255]));
  const bundle = await f.bundle();
  const lock = bundle.files.find(item => item.path === 'package-lock.json');
  const binary = bundle.files.find(item => item.path === 'asset.bin');
  assert.equal(lock.classification, 'lock'); assert.equal(binary.classification, 'binary');
  assert.match(lock.afterSha256, /^[a-f0-9]{64}$/); assert.equal(binary.beforeSha256, null);
  assert.doesNotMatch(JSON.stringify(reviewerEvidence(bundle)), /LOCK_CONTENT_MUST_NOT_APPEAR/);
  await assert.rejects(collect({ ...f.options, maxEvidenceBytes: 100, out: path.join(f.root, 'artifacts/oversize') }), error => error.status === 'ERROR' && error.details.totalBytes > 100);
  assert.equal(await exists(path.join(f.root, 'artifacts/oversize/bundle.json')), false);
  const changed = structuredClone(bundle); changed.sources[0].text = 'tampered';
  assert.throws(() => validateBundle(changed), /integrity/);
});

test('ACP collects chunked responses, inherits/sets models, and isolates cwd/environment', async t => {
  const f = await fixture(t); await f.record();
  await f.bundle('bundle', [path.join(f.root, 'artifacts/run/run.json')]);
  process.env.ACCEPTANCE_TEST_SECRET = 'must-not-be-passed';
  t.after(() => { delete process.env.ACCEPTANCE_TEST_SECRET; });
  const configFile = await agentConfig(f.root);
  const result = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: path.join(f.root, 'artifacts/review'), configFile });
  assert.equal(result.verdict, 'PASS', result.error); assert.equal(result.agent.model, 'fixture/current');
  const report = await fs.readFile(path.join(f.root, 'artifacts/review/verdict.md'), 'utf8');
  assert.match(report, /# 验收裁决：PASS/);
  assert.ok(report.includes(result.fingerprint)); assert.ok(report.includes(result.bundleSha256));
  assert.match(report, /裁决退出码：0/);
  const overridden = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: path.join(f.root, 'artifacts/override'), configFile, model: 'fixture/new' });
  assert.equal(overridden.verdict, 'PASS', overridden.error); assert.equal(overridden.agent.model, 'fixture/new');
  const selectorConfig = await agentConfig(f.root, 'selectors');
  const selected = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: path.join(f.root, 'artifacts/selectors'), configFile: selectorConfig });
  assert.equal(selected.verdict, 'PASS', selected.error);
  const frozen = JSON.parse(await fs.readFile(path.join(f.root, 'artifacts/bundle/bundle.json'), 'utf8'));
  const reference = selected.checks.requirements.citations[0];
  assert.equal(reference.quote, frozen.sources.find(item => item.id === reference.sourceId).text.split('\n')[reference.startLine - 1]);
  assert.equal(reference.citationId, citationId(frozen.sources.findIndex(item => item.id === reference.sourceId) + 1, reference.startLine));
  const stringConfig = await agentConfig(f.root, 'selector-strings');
  const strings = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: path.join(f.root, 'artifacts/selector-strings'), configFile: stringConfig });
  assert.equal(strings.verdict, 'PASS', strings.error);
  assert.deepEqual(strings.checks.requirements.citations, selected.checks.requirements.citations);
  const rawStrings = JSON.parse(await fs.readFile(path.join(f.root, 'artifacts/selector-strings/agent-response.raw'), 'utf8'));
  assert.equal(typeof rawStrings.checks.requirements.citations[0], 'string');
  const packet = await fs.readFile(path.join(f.root, 'artifacts/review/request.txt'), 'utf8');
  assert.doesNotMatch(packet, /must-not-be-passed/);
});

test('fabricated citations and incomplete responses are ERROR, never accepted verdicts', async t => {
  const f = await fixture(t); await f.record(); await f.bundle('bundle', [path.join(f.root, 'artifacts/run/run.json')]);
  for (const mode of ['bad-id', 'bad-lines', 'bad-quote', 'bad-kind', 'missing-check', 'bad-selector', 'bad-selector-string', 'blank-selector', 'blank-selector-string', 'selector-conflict']) {
    const configFile = await agentConfig(f.root, mode);
    const result = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: path.join(f.root, `artifacts/${mode}`), configFile });
    assert.equal(result.verdict, 'ERROR', `${mode}: ${result.error}`);
    if (['blank-selector', 'blank-selector-string', 'bad-selector-string'].includes(mode)) assert.match(result.error, /Citation ID does not exist/);
    assert.ok((await fs.readFile(path.join(f.root, `artifacts/${mode}/agent-response.raw`), 'utf8')).length);
  }
});

test('forbidden tool/permission requests, absent guard, timeout and abnormal exit fail closed', async t => {
  const f = await fixture(t); await f.record(); await f.bundle('bundle', [path.join(f.root, 'artifacts/run/run.json')]);
  for (const mode of ['tool', 'permission', 'client-fs', 'no-guard', 'timeout', 'exit']) {
    const configFile = await agentConfig(f.root, mode, mode === 'timeout' ? { timeoutMs: 400 } : {});
    const result = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: path.join(f.root, `artifacts/${mode}`), configFile });
    assert.equal(result.verdict, 'ERROR', mode);
  }
});

test('command adapters use the same evidence/verdict contract; review refuses drift before launch', async t => {
  const f = await fixture(t); await f.record(); await f.bundle('bundle', [path.join(f.root, 'artifacts/run/run.json')]);
  const configFile = await agentConfig(f.root, 'command');
  const result = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: path.join(f.root, 'artifacts/command'), configFile });
  assert.equal(result.verdict, 'PASS', result.error);
  const deniedOut = path.join(f.root, 'artifacts/command-no-guard');
  const unguardedConfig = await agentConfig(f.root, 'command-no-guard', { transport: 'command', timeoutMs: 3500 });
  const denied = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: deniedOut, configFile: unguardedConfig });
  assert.equal(denied.verdict, 'ERROR');
  assert.match(denied.error, /did not acknowledge.*isolation before prompting/);
  assert.doesNotMatch(await fs.readFile(path.join(deniedOut, 'agent-stderr.raw'), 'utf8'), /COMMAND_INPUT_READ/);
  await f.write('new.txt', 'drift');
  const stale = await review({ repo: f.root, bundleFile: path.join(f.root, 'artifacts/bundle/bundle.json'), out: path.join(f.root, 'artifacts/stale'), configFile });
  assert.equal(stale.verdict, 'INSUFFICIENT_EVIDENCE');
  assert.equal(await exists(path.join(f.root, 'artifacts/stale/request.txt')), false);
});

test('environment whitelist and latest-model resolution do not infer ordering from ACP IDs', async () => {
  const env = isolatedEnvironment('/isolated', 'nonce', ['HTTP_PROXY', 'NODE_OPTIONS'], { PATH: '/bin', SECRET: 'hidden', HTTP_PROXY: 'proxy', NODE_OPTIONS: 'bad' });
  assert.equal(env.SECRET, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.HTTP_PROXY, 'proxy');
  const html = '<table><tr><th>MODEL</th><td>deepseek-old</td><td>deepseek-new</td></tr><tr><td>MODEL VERSION</td><td>DeepSeek-V4-Pro-0813</td><td>DeepSeek-V4.1-Flash-1017</td></tr></table>';
  const fetcher = async () => ({ ok: true, text: async () => html });
  const selected = await latestDeepSeekModel([{ value: 'opaque-z', name: 'deepseek-old' }, { value: 'opaque-a', name: 'deepseek-new' }], fetcher);
  assert.equal(selected.value, 'opaque-a');
  await assert.rejects(latestDeepSeekModel([{ value: 'old', name: 'deepseek-old' }], fetcher), /no downgrade/);
  const route = await latestDeepSeekModel([
    { value: '["api","deepseek-new"]', name: 'deepseek-new' },
    { value: '["account","deepseek-new"]', name: 'deepseek-new' },
  ], fetcher, 'api');
  assert.equal(route.value, '["api","deepseek-new"]');
});

test('numbered evidence preserves exact source lines and excludes implementer narratives', async t => {
  const f = await fixture(t); await f.record();
  await f.write('artifacts/implementation-summary.txt', 'UNTRUSTED_IMPLEMENTER_NARRATIVE_MUST_NOT_ENTER_PROMPT');
  const bundle = await f.bundle('bundle', [path.join(f.root, 'artifacts/run/run.json')]);
  const visible = reviewerEvidence(bundle);
  const ids = visible.sources.flatMap(item => item.lines.filter(line => line.citationId).map(line => line.citationId));
  assert.equal(new Set(ids).size, ids.length);
  for (const [sourceIndex, item] of visible.sources.entries()) {
    const original = bundle.sources.find(row => row.id === item.id);
    assert.equal(item.text, undefined);
    assert.deepEqual(item.lines.map(line => line.number), item.lines.map((_, index) => index + 1));
    assert.equal(item.lines.map(line => line.text).join('\n'), original.text);
    assert.equal(item.sha256, original.sha256);
    assert.deepEqual(item.lines.map(line => line.citationId),
      item.lines.map(line => line.text.trim() ? citationId(sourceIndex + 1, line.number) : undefined));
  }
  const prompt = reviewPrompt(bundle);
  assert.doesNotMatch(prompt, /UNTRUSTED_IMPLEMENTER_NARRATIVE_MUST_NOT_ENTER_PROMPT/);
  assert.deepEqual([...new Set(visible.sources.map(item => item.kind))].sort(), ['diff', 'execution', 'plan']);
  const config = await agentConfig(f.root, 'normal', { summary: 'UNTRUSTED_IMPLEMENTER_NARRATIVE_MUST_NOT_ENTER_PROMPT' });
  await assert.rejects(resolveAgent(f.root, { configFile: config }), /Unknown agent configuration field/);
  const cli = fileURLToPath(new URL('../scripts/adjudicate.mjs', import.meta.url));
  const rejected = await run(process.execPath, [cli, 'collect', '--summary', 'UNTRUSTED_IMPLEMENTER_NARRATIVE_MUST_NOT_ENTER_PROMPT']);
  assert.equal(rejected.code, 3); assert.match(rejected.stdout.toString(), /Unknown option/);
});

test('collection rejects a concurrent source change after snapshot creation', { timeout: 15000 }, async t => {
  const f = await fixture(t); let changed;
  const observed = new Promise(resolve => {
    const watcher = watch(os.tmpdir(), (_, filename) => {
      if (String(filename).startsWith('acceptance-scan-') && !changed) {
        changed = f.write('drift.txt', 'changed during collection'); changed.then(resolve);
      }
    });
    t.after(() => watcher.close());
  });
  const collection = f.bundle();
  await assert.rejects(collection, error => error.status === 'INSUFFICIENT_EVIDENCE');
  await observed;
  assert.equal(await exists(path.join(f.root, 'artifacts/bundle/bundle.json')), false);
});

test('review cancellation and mid-review drift never accept the completed PASS response', async t => {
  const f = await fixture(t); await f.record(); await f.bundle('bundle', [path.join(f.root, 'artifacts/run/run.json')]);
  const bundleFile = path.join(f.root, 'artifacts/bundle/bundle.json');
  const configFile = await agentConfig(f.root, 'pause');
  const out = path.join(f.root, 'artifacts/during-review');
  const pending = review({ repo: f.root, bundleFile, out, configFile });
  for (let i = 0; i < 300; i++) {
    const log = await fs.readFile(path.join(out, 'agent-stderr.raw'), 'utf8').catch(() => '');
    if (log.includes('PROMPT_RECEIVED')) { await f.write('drift.txt', 'changed while agent runs'); break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const stale = await pending; assert.equal(stale.verdict, 'INSUFFICIENT_EVIDENCE', stale.error);
  assert.equal(stale.agent.model, 'fixture/current');
  await fs.unlink(path.join(f.root, 'drift.txt'));
  const controller = new AbortController();
  const cancelConfig = await agentConfig(f.root, 'timeout');
  const cancelled = review({ repo: f.root, bundleFile, out: path.join(f.root, 'artifacts/cancelled'), configFile: cancelConfig, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const result = await cancelled; assert.equal(result.verdict, 'ERROR'); assert.match(result.error, /cancel/i);
});

test('rename and unsupported-language export removals generate reference evidence', async t => {
  const f = await fixture(t);
  await f.write('old-route.ex', 'def removed_entry_unique(value), do: value\ndef keep_entry(value), do: value\n');
  await f.write('retained.ex', 'def exported_unique(value), do: value\ndef x(v), do: v\ndef keep(value), do: value\n');
  await f.write('consumer.yml', 'entry: old-route.ex\nsymbol: exported_unique\nshort_symbol: x\n');
  await git(f.root, ['add', '.']);
  await git(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'exports']);
  f.options.base = (await git(f.root, ['rev-parse', 'HEAD'])).toString().trim();
  await fs.rename(path.join(f.root, 'old-route.ex'), path.join(f.root, 'new-route.ex'));
  await git(f.root, ['add', 'old-route.ex', 'new-route.ex']);
  await f.write('retained.ex', 'def keep(value), do: value\n');
  const bundle = await f.bundle();
  assert.ok(bundle.files.some(file => file.status.startsWith('R') && file.oldPath === 'old-route.ex'));
  const logs = bundle.sources.filter(item => item.label.endsWith('/stdout')).map(item => item.text).join('\n');
  assert.match(logs, /entry: old-route.ex/); assert.match(logs, /symbol: exported_unique/); assert.match(logs, /short_symbol: x/);
});

test('no reference hits is recorded distinctly from an unavailable rg command', async t => {
  const f = await fixture(t);
  await f.write('orphan-unique.py', 'def totally_orphaned_unique(): return 42\n');
  await git(f.root, ['add', '.']);
  await git(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'orphan']);
  f.options.base = (await git(f.root, ['rev-parse', 'HEAD'])).toString().trim();
  await fs.unlink(path.join(f.root, 'orphan-unique.py'));
  const bundle = await f.bundle();
  assert.ok(bundle.sources.some(item => item.label.startsWith('reference-search/') && item.label.endsWith('/command') && /"exitCode": 1/.test(item.text)));
  const locator = await run(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'where.exe') : 'which', ['git']);
  assert.equal(locator.code, 0);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = path.dirname(locator.stdout.toString().trim().split(/\r?\n/)[0]);
    await assert.rejects(f.bundle('missing-rg'), error => error.status === 'ERROR' && /search could not start/.test(error.message));
  } finally { process.env.PATH = originalPath; }
});

test('collect preserves committed, staged and unstaged versions even when index and worktree cancel', async t => {
  const f = await fixture(t);
  await git(f.root, ['add', '.']);
  await git(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'implemented behavior']);
  const committed = await fs.readFile(path.join(f.root, 'api.mjs'), 'utf8');
  await f.write('api.mjs', 'export const INDEX_ONLY_CHANGE = true;\n');
  await git(f.root, ['add', 'api.mjs']);
  await f.write('api.mjs', committed);
  const all = await f.bundle('all-layers');
  const layers = all.files.filter(file => file.path === 'api.mjs').map(file => file.layer);
  assert.deepEqual(layers, ['committed', 'staged', 'unstaged']);
  f.options.base = (await git(f.root, ['rev-parse', 'HEAD'])).toString().trim();
  const cancelled = await f.bundle('cancelled-layers');
  const entries = cancelled.files.filter(file => file.path === 'api.mjs');
  assert.deepEqual(entries.map(file => file.layer), ['staged', 'unstaged']);
  assert.equal(entries[0].beforeSha256, entries[1].afterSha256);
  assert.equal(entries[0].afterSha256, entries[1].beforeSha256);
  assert.match(cancelled.sources.find(source => source.id === entries[0].diffId).text, /\+export const INDEX_ONLY_CHANGE/);
  assert.match(cancelled.sources.find(source => source.id === entries[1].diffId).text, /-export const INDEX_ONLY_CHANGE/);
  assert.equal((await git(f.root, ['diff', f.options.base, '--', 'api.mjs'])).length, 0);
});

test('collect binds lossless wire encoding and byte budget while validating legacy JSON bundles', async t => {
  const f = await fixture(t);
  await f.write('large.txt', '原文🔒\t"quoted"\\data\n'.repeat(8000));
  const bundle = await f.bundle('large');
  assert.equal(bundle.evidenceEncoding, LINE_TABLE);
  const view = reviewerEvidence(bundle), encoded = evidenceText(view, bundle.evidenceEncoding);
  assert.equal(bundle.coreBytes, Buffer.byteLength(encoded));
  assert.deepEqual(decodeLineTable(encoded), view);
  validateBundle(bundle);
  await assert.rejects(collect({ ...f.options, maxEvidenceBytes: bundle.coreBytes - 1,
    out: path.join(f.root, 'artifacts/too-large') }), error => error.status === 'ERROR' &&
      error.details.totalBytes === bundle.coreBytes);
  assert.equal(await exists(path.join(f.root, 'artifacts/too-large/bundle.json')), false);
  const legacy = structuredClone(bundle);
  delete legacy.evidenceEncoding;
  legacy.coreBytes = Buffer.byteLength(canonical(reviewerEvidence(legacy)));
  const { sha256, ...unsigned } = legacy; legacy.sha256 = sha(canonical(unsigned));
  validateBundle(legacy);
  const unknown = structuredClone(bundle); unknown.evidenceEncoding = 'not-an-encoding';
  const { sha256: ignored, ...altered } = unknown; unknown.sha256 = sha(canonical(altered));
  assert.throws(() => validateBundle(unknown), /Unknown frozen evidence encoding/);
});
