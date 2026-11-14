import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { AuditError, exists, run, readJSON, writeJSON, sha, fingerprint, repoRoot,
  assertOutputLocation, validateBundle, removeTemporary } from './core.mjs';
import { reviewPrompt, parseVerdict, renderReport } from './verdict.mjs';

export const SKILL_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// lib/ -> scripts/ -> skill/. Resolve explicitly to avoid package-manager cwd assumptions.
const GUARD = fileURLToPath(new URL('../dsh-guard.mjs', import.meta.url));
const SYSTEM_ENV = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
const INJECTION_ENV = new Set(['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'BASH_ENV', 'ENV', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT']);
export function isolatedEnvironment(home, nonce, allow = [], parent = process.env) {
  const result = {};
  for (const requested of [...SYSTEM_ENV, ...allow]) {
    if (INJECTION_ENV.has(requested.toUpperCase())) continue;
    const key = Object.keys(parent).find(name => name.toUpperCase() === requested.toUpperCase());
    if (key) result[key] = parent[key];
  }
  return { ...result, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'),
    ACCEPTANCE_GUARD_NONCE: nonce };
}
async function findExecutable(name) {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter))
    for (const suffix of suffixes) {
      const file = path.join(directory, name + suffix);
      if (await exists(file)) return file;
    }
  return null;
}
async function desktopDeepSeek() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const install = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness');
  const command = path.join(install, 'DeepSeek Harness.exe');
  if (!await exists(command)) return null;
  const entry = path.join(install, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  return { command, args: ['--expose-internals', entry], electron: true, installedProfile: 'desktop' };
}
async function nodeNpm() {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const npm = await findExecutable('npm');
  if (npm) candidates.push(path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const file of candidates) if (await exists(file)) return { command: process.execPath, args: [file] };
  throw new AuditError('npm CLI was not found. Install Node.js/npm or configure an existing review agent.');
}
async function normalizeLauncher(config, directory) {
  const value = { ...config };
  if (typeof value.command !== 'string' || !Array.isArray(value.args || []) || (value.args || []).some(arg => typeof arg !== 'string'))
    throw new AuditError('Agent command must be an executable plus an argument array.');
  if (value.command.includes('/') || value.command.includes('\\')) value.command = path.resolve(directory, value.command);
  else value.command = await findExecutable(value.command) || value.command;
  if (/\.(cmd|bat|ps1)$/i.test(value.command))
    throw new AuditError('Use an explicit native interpreter executable and argument array for .cmd/.bat/.ps1 launchers.');
  value.args ||= [];
  value.args = value.args.map(arg => /^\.{1,2}[\\/]/.test(arg) ? path.resolve(directory, arg) : arg);
  value.envAllowlist ||= [];
  if (!Array.isArray(value.envAllowlist) || value.envAllowlist.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new AuditError('envAllowlist must contain environment variable names, never secret values.');
  if (value.credentialsFile) value.credentialsFile = path.resolve(directory, value.credentialsFile);
  return value;
}
async function savedDeepSeekSelection(profile) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(home, 'profiles', profile || 'acp', 'cordis.patch.yml');
  if (!await exists(file)) return undefined;
  let rows;
  try { rows = parseYAML(await fs.readFile(file, 'utf8')); }
  catch { throw new AuditError('Installed DeepSeek model settings could not be parsed; specify an agent configuration.'); }
  if (!Array.isArray(rows)) throw new AuditError('Installed DeepSeek profile patch is not a row list.');
  const row = [...rows].reverse().find(row => row.id === (profile === 'desktop' ? 'agent-default-model' : 'acp'));
  if (!row) return undefined;
  const { provider, model } = row.config || {};
  if (typeof provider !== 'string' || typeof model !== 'string') throw new AuditError('Installed DeepSeek model selection is incomplete.');
  return { provider, model, source: `${profile || 'acp'}/cordis.patch.yml:${row.id}` };
}
export async function resolveAgent(root, { configFile, model, timeoutMs } = {}) {
  const project = path.join(root, '.codex', 'adversarial-acceptance', 'agent.json');
  const local = path.join(SKILL_ROOT, 'config.local.json');
  const selected = configFile ? path.resolve(configFile) : await exists(project) ? project : await exists(local) ? local : null;
  let config;
  if (selected) {
    config = await readJSON(selected);
    const allowed = new Set(['version', 'adapter', 'transport', 'command', 'args', 'model', 'timeoutMs',
      'envAllowlist', 'credentialsFile', 'provider', 'isolation']);
    if (Object.keys(config).some(key => !allowed.has(key))) throw new AuditError('Unknown agent configuration field (prompts and summaries are not accepted).');
    if (config.version !== 1 || !['deepseek', 'custom'].includes(config.adapter)) throw new AuditError('Unsupported agent configuration version/adapter.');
    config = await normalizeLauncher(config, path.dirname(selected));
    config.selection = 'configured';
  } else {
    const installed = await findExecutable('dsh');
    const desktop = await desktopDeepSeek();
    if (installed && !/\.(cmd|bat)$/i.test(installed)) config = { command: installed, args: [], selection: 'installed' };
    else if (desktop) config = { ...desktop, selection: 'installed' };
    else if (installed) {
      // npm's Windows shim contains no unique runtime; use the adjacent JS entry.
      const entry = path.join(path.dirname(installed), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!await exists(entry)) throw new AuditError('Installed dsh shim needs an explicit native launcher configuration.');
      config = { command: process.execPath, args: [entry], selection: 'installed' };
    } else {
      const npm = await nodeNpm();
      const result = await run(npm.command, [...npm.args, 'view', '@deepseek-ai/dsh@latest', 'version', '--json'],
        { signal: AbortSignal.timeout(Math.min(15000, timeoutMs ?? 600000)) });
      if (result.code !== 0) throw new AuditError(`Could not resolve DeepSeek latest: ${result.stderr.toString()}`);
      let version; try { version = JSON.parse(result.stdout.toString()); } catch { /* checked below */ }
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new AuditError('Registry did not return an exact latest DeepSeek version.');
      config = { command: npm.command, args: [...npm.args, 'exec', '--yes', '--package', `@deepseek-ai/dsh@${version}`, '--', 'dsh'],
        selection: 'download-latest', packageVersion: version };
    }
    config.adapter = 'deepseek'; config.transport = 'acp';
    if (config.selection === 'installed') config.initialSelection = await savedDeepSeekSelection(config.installedProfile);
  }
  config.transport ||= 'acp';
  if (!['acp', 'command'].includes(config.transport)) throw new AuditError('Unsupported agent transport.');
  if (config.adapter === 'deepseek' && config.transport !== 'acp') throw new AuditError('The built-in DeepSeek adapter uses ACP.');
  config.model = model || config.model;
  config.timeoutMs = timeoutMs ?? config.timeoutMs ?? 600000;
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) throw new AuditError('timeoutMs must be a positive integer.');
  if (config.adapter === 'custom' && !['toolsDisabled', 'instructionsDisabled', 'memoryDisabled'].every(key => config.isolation?.[key] === true))
    throw new AuditError('Custom launchers must explicitly implement the packet-only isolation contract.');
  return config;
}
async function prepareDeepSeek(config, support, env) {
  const profileHome = path.join(support, 'dsh');
  await fs.mkdir(profileHome, { recursive: true });
  env.DSH_HOME = profileHome; env.DSH_TELEMETRY_DISABLED = '1'; env.DSH_PERMISSION_MODE = 'read-only';
  if (config.electron) env.ELECTRON_RUN_AS_NODE = '1';
  if (path.basename(config.command).toLowerCase() === 'deepseek harness.exe') env.ELECTRON_RUN_AS_NODE = '1';
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'])
    if (process.env[name] && !Object.hasOwn(env, name)) env[name] = process.env[name];
  const credentialsFile = config.credentialsFile || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
  const patch = [
    ...['agent-instructions', 'skill-filesystem', 'tool-skill', 'session-title-llm'].map(id => ({ id, disabled: true })),
    { insert: [{ id: 'acceptance-guard', name: pathToFileURL(GUARD).href }] },
  ];
  if (await exists(credentialsFile)) patch.push({ id: 'credentials', config: { path: credentialsFile, watch: false } });
  if (config.electron) patch.push({ id: 'deepseek-account', config: { desktopPlatform: process.platform } });
  // Only authentication is referenced from the original home. No user patch, skill,
  // settings document, session, or memory is copied into this fresh profile.
  if (config.provider) {
    if (!config.model) throw new AuditError('An explicit provider requires an explicit model.');
    patch.push({ id: 'acp', config: { provider: config.provider, model: config.model } });
  } else if (config.initialSelection) patch.push({ id: 'acp', config: {
    provider: config.initialSelection.provider, model: config.initialSelection.model } });
  const file = path.join(support, 'review.patch.yml');
  await fs.writeFile(file, stringifyYAML(patch));
  return { ...config, args: [...(config.args || []), '--profile', 'acp', '--patch', file] };
}
function flattenOptions(options = []) {
  return options.flatMap(option => Array.isArray(option.options) ? flattenOptions(option.options) : [option]);
}
export async function latestDeepSeekModel(options, fetcher = fetch, provider, signal) {
  const url = 'https://api-docs.deepseek.com/quick_start/pricing/';
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw new AuditError('Official DeepSeek model metadata could not be verified.');
  const html = await response.text();
  const clean = value => value.replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').trim();
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => clean(cell[1])));
  const names = rows.find(row => row[0] === 'MODEL');
  const versions = rows.find(row => row[0] === 'MODEL VERSION');
  if (!names || !versions || names.length !== versions.length) throw new AuditError('Official latest-model table is ambiguous; configure a model explicitly.');
  const candidates = names.slice(1).map((name, index) => {
    const model = name.match(/deepseek-[a-z0-9.-]+/i)?.[0];
    const version = versions[index + 1], match = version.match(/V(\d+)(?:\.(\d+))?.*?-(\d{4})(?:\D|$)/i);
    return { model, version, rank: match ? [Number(match[1]), Number(match[2] || 0), Number(match[3])] : null };
  });
  if (candidates.some(item => !item.model || !item.rank)) throw new AuditError('Official model release ordering could not be verified; configure a model explicitly.');
  candidates.sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || b.rank[2] - a.rank[2]);
  const latest = candidates[0];
  const available = flattenOptions(options).filter(option => {
    if (typeof option.value !== 'string' || ![option.value, option.name].some(text => typeof text === 'string' && text.includes(latest.model))) return false;
    if (!provider) return true;
    try { const route = JSON.parse(option.value); return Array.isArray(route) && route[0] === provider; }
    catch { return false; }
  });
  if (available.length !== 1) throw new AuditError('Latest official DeepSeek model is unavailable or ambiguous in the live ACP catalog; no downgrade attempted.');
  return { value: available[0].value, officialModel: latest.model, release: latest.version, source: url, metadataSha256: sha(html) };
}
async function terminate(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.stdin?.end();
  const ended = new Promise(resolve => child.once('close', resolve));
  let timer;
  await Promise.race([ended, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); clearTimeout(timer);
  if (child.exitCode === null && !child.signalCode) {
    if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGKILL');
    await ended;
  }
}
export async function invokeAgent(config, prompt, { work, home, support, output, signal } = {}) {
  const started = Date.now();
  const nonce = randomUUID();
  const env = isolatedEnvironment(home, nonce, config.envAllowlist || []);
  await fs.mkdir(env.TEMP, { recursive: true });
  if (config.adapter === 'deepseek') {
    const versionEnv = { ...env };
    if (config.electron || path.basename(config.command).toLowerCase() === 'deepseek harness.exe') versionEnv.ELECTRON_RUN_AS_NODE = '1';
    const version = await run(config.command, [...config.args, '--version'], { cwd: work, env: versionEnv, signal: AbortSignal.timeout(Math.min(15000, config.timeoutMs)) });
    const matched = version.stdout.toString('utf8').match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/);
    if (version.code !== 0 || !matched) throw new AuditError('DeepSeek Harness runtime version could not be verified.');
    config.packageVersion = matched[0];
    config = await prepareDeepSeek(config, support, env);
  }
  const remaining = config.timeoutMs - (Date.now() - started);
  if (remaining <= 0 || signal?.aborted) throw new AuditError(signal?.aborted ? 'Review cancelled.' : 'Review agent timed out.');
  const child = spawn(config.command, config.args, { cwd: work, env, shell: false, windowsHide: true, stdio: 'pipe' });
  let raw = '', guardLine = '', violation, metadata, connection, ctx, sessionId, acknowledgeGuard;
  const guardAcknowledged = new Promise(resolve => { acknowledgeGuard = resolve; });
  const wire = [], stdoutFile = await fs.open(path.join(output, 'agent-stdout.raw'), 'wx');
  const stderrFile = await fs.open(path.join(output, 'agent-stderr.raw'), 'wx');
  let stdoutWrite = Promise.resolve(), stderrWrite = Promise.resolve();
  child.stdout.on('data', bytes => { wire.push(bytes); stdoutWrite = stdoutWrite.then(() => stdoutFile.write(bytes)); });
  child.stderr.on('data', bytes => {
    stderrWrite = stderrWrite.then(() => stderrFile.write(bytes)); guardLine += bytes.toString('utf8');
    const lines = guardLine.split(/\r?\n/); guardLine = lines.pop();
    for (const line of lines) {
      try { const value = JSON.parse(line);
        if (value.acceptanceGuard === 1 && value.nonce === nonce && value.tools === 0 && value.instructions === false && value.memory === false) acknowledgeGuard();
      } catch { /* ordinary agent diagnostics */ }
    }
  });
  const failed = new Promise((_, reject) => child.once('error', reject));
  // Install a rejection consumer even while startup/session setup is in progress.
  failed.catch(() => {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AuditError('Review agent timed out.')), remaining);
  const onAbort = () => controller.abort(new AuditError('Review cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const requestOptions = { cancellationSignal: controller.signal, stopWaitingOnCancel: true };
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  aborted.catch(() => {});
  const exitedBeforeGuard = new Promise((_, reject) => child.once('close', () => reject(new AuditError('Agent exited before packet-only isolation was acknowledged.'))));
  exitedBeforeGuard.catch(() => {});
  const waitForGuard = async () => {
    let guardTimer;
    try {
      await Promise.race([guardAcknowledged, failed, aborted, exitedBeforeGuard,
        new Promise((_, reject) => { guardTimer = setTimeout(() => reject(new AuditError('Agent did not acknowledge tool/instruction/memory isolation before prompting.')), 2000); })]);
    } finally { clearTimeout(guardTimer); }
  };
  try {
    if (config.transport === 'command') {
      const done = new Promise((resolve, reject) => child.once('close', code => code === 0 ? resolve() : reject(new AuditError(`Command agent exited ${code}.`))));
      done.catch(() => {});
      await waitForGuard();
      child.stdin.end(JSON.stringify({ version: 1, prompt }));
      await Promise.race([done, failed, aborted]);
      const text = Buffer.concat(wire).toString('utf8');
      let envelope; try { envelope = JSON.parse(text); } catch { throw new AuditError('Command agent response is not valid JSON.'); }
      if (!envelope.agent?.name || !envelope.agent?.version || !envelope.agent?.model || !envelope.response)
        throw new AuditError('Command agent must return actual agent/version/model and a verdict response.');
      metadata = envelope.agent; raw = JSON.stringify(envelope.response);
    } else {
      const app = client({ name: 'adversarial-acceptance' })
        .onRequest(methods.client.session.requestPermission, () => {
          violation = new AuditError('Review agent requested a forbidden tool permission.');
          return { outcome: { outcome: 'cancelled' } };
        })
        .onRequest('*', ({ method }) => {
          violation = new AuditError('Review agent requested a forbidden client capability: ' + method + '.');
          throw new RequestError(-32601, 'Packet-only client exposes no filesystem, terminal or other tools.');
        })
        .onNotification(methods.client.session.update, ({ params }) => {
          if (params.sessionId !== sessionId) return;
          const update = params.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') raw += update.content.text;
          if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
            violation = new AuditError('Review agent attempted a forbidden tool call.');
            controller.abort(violation);
          }
        });
      const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: Math.max(16 * 1024 * 1024, Buffer.byteLength(prompt) * 2) });
      connection = app.connect(stream); ctx = connection.agent;
      const workflow = async () => {
        const initialized = await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'adversarial-acceptance', version: '1.0.0' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, requestOptions);
        if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new AuditError('ACP v1 protocol mismatch.');
        metadata = { ...initialized.agentInfo, protocolVersion: initialized.protocolVersion, selection: config.selection,
          packageVersion: config.packageVersion, inheritedSelection: config.initialSelection };
        const session = await ctx.request(methods.agent.session.new, { cwd: work, mcpServers: [] }, requestOptions);
        sessionId = session.sessionId;
        await waitForGuard();
        let modelOption = session.configOptions?.find(option => option.category === 'model' || option.id === 'model');
        let selected = config.provider ? modelOption?.currentValue : config.model;
        if (config.selection === 'download-latest' && !config.model) {
          if (!modelOption) throw new AuditError('Default DeepSeek agent did not advertise a model catalog.');
          let currentProvider;
          try { currentProvider = JSON.parse(modelOption.currentValue)[0]; } catch { /* resolution below refuses ambiguous candidates */ }
          metadata.latestResolution = await latestDeepSeekModel(modelOption.options, fetch, currentProvider, controller.signal);
          selected = metadata.latestResolution.value;
        }
        if (selected && selected !== modelOption?.currentValue) {
          if (!modelOption || !flattenOptions(modelOption.options).some(option => option.value === selected))
            throw new AuditError('Configured model is not in the advertised catalog; no fallback attempted.');
          const changed = await ctx.request(methods.agent.session.setConfigOption, { sessionId, configId: modelOption.id, value: selected }, requestOptions);
          modelOption = changed.configOptions?.find(option => option.id === modelOption.id);
          if (modelOption?.currentValue !== selected) throw new AuditError('Agent did not select the requested model.');
        }
        metadata.model = modelOption?.currentValue;
        if (!metadata.name || !metadata.version || !metadata.model) throw new AuditError('Agent failed to identify its actual version/current model.');
        const response = await ctx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: prompt }] }, requestOptions);
        if (violation) throw violation;
        if (response.stopReason !== 'end_turn') throw new AuditError(`Agent did not complete review: ${response.stopReason}.`);
        // Session close is optional in ACP v1. Connection teardown is mandatory.
        try { await ctx.request(methods.agent.session.close, { sessionId }, { cancellationSignal: AbortSignal.timeout(2000), stopWaitingOnCancel: true }); }
        catch (error) { if (error.code !== -32601 && error.code !== -32002) throw error; }
      };
      await Promise.race([workflow(), failed, aborted]);
    }
    if (violation) throw violation;
    return { raw, agent: metadata };
  } catch (error) {
    if (ctx && sessionId) await ctx.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
    error.agent = metadata; error.raw = raw;
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    connection?.close();
    await terminate(child);
    await Promise.all([stdoutWrite, stderrWrite]); await stdoutFile.close(); await stderrFile.close();
    await fs.writeFile(path.join(output, 'agent-response.raw'), raw, { flag: 'wx' });
  }
}
export async function review({ repo, bundleFile, out, configFile, model, timeoutMs, signal }) {
  const started = Date.now();
  const root = await repoRoot(repo);
  out = await assertOutputLocation(root, out);
  if (await exists(out)) throw new AuditError('Use a new output directory for each review.');
  await fs.mkdir(out, { recursive: true });
  let bundle, result, temporary, metadata;
  try {
    bundle = validateBundle(await readJSON(bundleFile));
    if (bundle.repositoryId !== sha(root) || (await fingerprint(root, bundle.fingerprint.scope)).digest !== bundle.fingerprint.digest)
      throw new AuditError('Workspace no longer matches frozen evidence.', 'INSUFFICIENT_EVIDENCE');
    const config = await resolveAgent(root, { configFile, model, timeoutMs });
    config.timeoutMs -= Date.now() - started;
    if (config.timeoutMs <= 0 || signal?.aborted) throw new AuditError(signal?.aborted ? 'Review cancelled.' : 'Review agent timed out.');
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-review-'));
    const work = path.join(temporary, 'cwd'), home = path.join(temporary, 'home'), support = path.join(temporary, 'support');
    await Promise.all([work, home, support].map(directory => fs.mkdir(directory)));
    const prompt = reviewPrompt(bundle);
    await fs.writeFile(path.join(out, 'request.txt'), prompt, { flag: 'wx' });
    const response = await invokeAgent(config, prompt, { work, home, support, output: out, signal });
    metadata = response.agent;
    const verdict = parseVerdict(response.raw, bundle);
    if ((await fingerprint(root, bundle.fingerprint.scope)).digest !== bundle.fingerprint.digest)
      throw new AuditError('Workspace drifted during review; verdict is stale.', 'INSUFFICIENT_EVIDENCE');
    result = { ...verdict, agent: response.agent };
  } catch (error) {
    result = { verdict: error.status || 'ERROR', error: error.message, details: error.details, agent: error.agent || metadata };
  } finally { if (temporary) await removeTemporary(temporary); }
  result.fingerprint = bundle?.fingerprint?.digest; result.bundleSha256 = bundle?.sha256;
  await writeJSON(path.join(out, 'verdict.json'), result);
  await fs.writeFile(path.join(out, 'verdict.md'), renderReport(result), { flag: 'wx' });
  return result;
}
