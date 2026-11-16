import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { evidenceText, preferredEvidenceEncoding } from './evidence-text.mjs';
import { conservativeCandidates, referenceDetection } from './deletion-candidates.mjs';

export class AuditError extends Error {
  constructor(message, status = 'ERROR', details) {
    super(message); this.status = status; this.details = details;
  }
}
export const EXIT = { PASS: 0, FAIL: 1, INSUFFICIENT_EVIDENCE: 2, ERROR: 3 };
export const sha = value => createHash('sha256').update(value).digest('hex');
export const citationId = (sourceNumber, line) => 'C' + sourceNumber + '.' + line;
export const canonical = value => JSON.stringify(value);
export const lf = text => text.replace(/\r\n?/g, '\n');
export const DEFAULT_SCOPE = Object.freeze({ excludeDirs: [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next',
  '.nuxt', 'dist', 'build', 'target', 'coverage',
] });
export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'uv.lock', 'poetry.lock',
  'Pipfile.lock', 'composer.lock', 'Gemfile.lock', 'packages.lock.json']);

export async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
export async function removeTemporary(directory) {
  const actual = await fs.realpath(directory), temp = await fs.realpath(os.tmpdir());
  if (!inside(temp, actual) || !path.basename(actual).startsWith('acceptance-'))
    throw new AuditError('Refusing cleanup outside the allocated acceptance temporary directory.');
  await fs.rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
export function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options });
    const out = [], err = [];
    child.stdout?.on('data', chunk => out.push(chunk));
    child.stderr?.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal,
      stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}
export async function git(root, args, accepted = [0]) {
  const result = await run('git', ['--no-optional-locks', '--literal-pathspecs', ...args], { cwd: root });
  if (!accepted.includes(result.code)) throw new AuditError(`git ${args[0]} failed: ${result.stderr.toString('utf8')}`);
  return result.stdout;
}
export async function repoRoot(directory) {
  return fs.realpath((await git(path.resolve(directory), ['rev-parse', '--show-toplevel'])).toString('utf8').trim());
}
const nul = bytes => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0').filter(Boolean); }
  catch { throw new AuditError('Git paths are not valid UTF-8; no lossy path conversion is permitted.'); }
};
const sorted = values => [...new Set(values)].sort();
const inScope = (name, scope) => !name.split('/').some(part => scope.excludeDirs.includes(part));
export function scopeOf(extra = []) {
  for (const name of extra) if (!name || name.includes('/') || name.includes('\\') || name === '..')
    throw new AuditError('Excluded directories must be single directory names.');
  return { excludeDirs: sorted([...DEFAULT_SCOPE.excludeDirs, ...extra]) };
}
export async function repositoryFiles(root, scope) {
  const tracked = sorted(nul(await git(root, ['ls-files', '-z'])));
  const untracked = sorted(nul(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])))
    .filter(name => inScope(name, scope));
  return { tracked, untracked };
}
async function fileState(root, name) {
  const file = path.join(root, name);
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return [name, 'deleted'];
    throw error;
  }
  if (stat.isSymbolicLink()) return [name, 'symlink', sha(await fs.readlink(file))];
  if (stat.isDirectory()) {
    // A tracked directory is a gitlink. Bind both its commit and dirty contents.
    const actualRoot = await repoRoot(file);
    if (actualRoot !== await fs.realpath(file)) return [name, 'gitlink', 'uninitialized'];
    const sub = await fingerprint(file, DEFAULT_SCOPE);
    return [name, 'gitlink', sub.digest];
  }
  if (!stat.isFile()) throw new AuditError(`Unsupported file type: ${name}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return [name, 'file', stat.mode & 0o111, hash.digest('hex')];
}
export async function fingerprint(root, scope = scopeOf()) {
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'], [0, 128])).toString('utf8').trim() || 'UNBORN';
  const index = await git(root, ['ls-files', '--stage', '-z']);
  if ((await git(root, ['ls-files', '--unmerged', '-z'])).length)
    throw new AuditError('Unmerged paths cannot be adjudicated.');
  const { tracked, untracked } = await repositoryFiles(root, scope);
  const trackedState = [], untrackedState = [];
  for (const name of tracked) trackedState.push(await fileState(root, name));
  for (const name of untracked) untrackedState.push(await fileState(root, name));
  const parts = { version: 1, head, scope, indexHash: sha(index),
    trackedHash: sha(canonical(trackedState)), untrackedHash: sha(canonical(untrackedState)) };
  return { ...parts, digest: sha(canonical(parts)) };
}
export async function assertOutputLocation(root, output) {
  let ancestor = path.resolve(output), suffix = [];
  while (!await exists(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const resolved = path.join(await fs.realpath(ancestor), ...suffix);
  if (!inside(root, resolved)) return resolved;
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  const files = await repositoryFiles(root, scopeOf());
  if (files.tracked.some(name => name === relative || name.startsWith(`${relative}/`)))
    throw new AuditError('Evidence output must not contain tracked files.');
  const result = await run('git', ['check-ignore', '-q', '--', `${relative}/.acceptance-output`], { cwd: root });
  if (result.code !== 0) throw new AuditError('Evidence output must be outside the repository or inside a Git-ignored directory.');
  return resolved;
}
export async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
export async function readJSON(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function capture({ repo, out, command, scope = scopeOf() }) {
  if (!command?.length) throw new AuditError('capture requires a command after --.');
  const root = await repoRoot(repo);
  out = await assertOutputLocation(root, out);
  if (await exists(out)) throw new AuditError('Use a new output directory for each capture.');
  await fs.mkdir(out, { recursive: true });
  const before = await fingerprint(root, scope), startedAt = new Date().toISOString();
  const stdoutPath = path.join(out, 'stdout.raw'), stderrPath = path.join(out, 'stderr.raw');
  const stdout = await fs.open(stdoutPath, 'wx'), stderr = await fs.open(stderrPath, 'wx');
  let outcome;
  try {
    outcome = await new Promise(resolve => {
      const child = spawn(command[0], command.slice(1), { cwd: root, shell: false, windowsHide: true,
        stdio: ['ignore', stdout.fd, stderr.fd] });
      child.on('error', error => resolve({ exitCode: null, signal: null, error: error.message }));
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
  } finally { await stdout.close(); await stderr.close(); }
  const after = await fingerprint(root, scope);
  const record = { version: 1, kind: 'test-run', repositoryId: sha(root), scope,
    command, startedAt, endedAt: new Date().toISOString(), ...outcome, before, after,
    validity: before.digest === after.digest ? 'CLEAN' : 'DIRTY',
    stdout: { file: 'stdout.raw', sha256: sha(await fs.readFile(stdoutPath)) },
    stderr: { file: 'stderr.raw', sha256: sha(await fs.readFile(stderrPath)) } };
  record.sha256 = sha(canonical(record));
  await writeJSON(path.join(out, 'run.json'), record);
  return record;
}
export function source(kind, label, bytes) {
  const raw = Buffer.from(bytes);
  let text;
  try { text = lf(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new AuditError(`Evidence is not valid UTF-8: ${label}`); }
  return { id: `${kind[0].toUpperCase()}-${sha(`${kind}\0${label}\0${sha(raw)}`).slice(0, 20)}`,
    kind, label, sha256: sha(raw), rawBase64: raw.toString('base64'), text };
}
async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new AuditError(`Plan package cannot contain symlinks: ${name}`);
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}
async function planSources(root, plan, planRef, origin) {
  const sources = [];
  if (planRef) {
    const ref = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${planRef}^{commit}`])).toString().trim();
    const relative = path.relative(root, path.resolve(root, plan)).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new AuditError('Git plan path must be inside the repository.');
    const rows = nul(await git(root, ['ls-tree', '-r', '-z', ref, '--', relative]));
    for (const row of rows) {
      const [meta, name] = row.split('\t');
      if (!meta.startsWith('100')) throw new AuditError(`Plan entry is not a regular file: ${name}`);
      sources.push(source('plan', name, await git(root, ['show', `${ref}:${name}`])));
    }
    origin = { type: 'git', commit: ref, path: relative };
  } else {
    if (!origin) throw new AuditError('Local original plans require --plan-origin describing their authoritative source.');
    const directory = path.resolve(root, plan);
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink()) throw new AuditError('Plan input cannot be a symlink.');
    for (const name of stat.isDirectory() ? await walk(directory) : [path.basename(directory)]) {
      const file = stat.isDirectory() ? path.join(directory, name) : directory;
      sources.push(source('plan', name, await fs.readFile(file)));
    }
    origin = { type: 'user-original', authority: origin };
  }
  if (!sources.length || sources.every(item => !item.text.trim())) throw new AuditError('Original plan package is empty.');
  return { sources, origin };
}
async function versionContent(root, tree, name) {
  if (tree === 'worktree') {
    const file = path.join(root, name), stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      const actualRoot = await repoRoot(file);
      const state = actualRoot === await fs.realpath(file) ? (await fingerprint(file)).digest : 'uninitialized';
      return { bytes: Buffer.from(state), gitlink: true };
    }
    return { bytes: stat.isSymbolicLink() ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file) };
  }
  const listing = tree === 'index'
    ? await git(root, ['ls-files', '--stage', '-z', '--', name])
    : await git(root, ['ls-tree', '-z', tree, '--', name]);
  const row = nul(listing)[0];
  if (!row) throw new AuditError('Git diff refers to a missing version: ' + tree + ':' + name);
  const metadata = row.split('\t')[0].split(' ');
  if (metadata[0] === '160000') return { bytes: Buffer.from(metadata[tree === 'index' ? 1 : 2]), gitlink: true };
  return { bytes: await git(root, ['show', (tree === 'index' ? '' : tree) + ':' + name]) };
}
async function changes(root, base, scope, includeLocks) {
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
  const layers = [
    { name: 'committed', revisions: [base, head], before: base, after: head },
    { name: 'staged', revisions: ['--cached', head], before: head, after: 'index' },
    { name: 'unstaged', revisions: [], before: 'index', after: 'worktree' },
  ];
  const files = [], sources = [];
  for (const layer of layers) {
    const entries = nul(await git(root, ['diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', ...layer.revisions, '--']));
    for (let i = 0; i < entries.length;) {
      const status = entries[i++], first = entries[i++];
      files.push({ layer: layer.name, status, oldPath: status[0] === 'A' ? null : first,
        path: /^[RC]/.test(status) ? entries[i++] : first });
    }
  }
  for (const name of (await repositoryFiles(root, scope)).untracked)
    files.push({ layer: 'untracked', status: 'A', oldPath: null, path: name, untracked: true });
  for (const entry of files) {
    const layer = layers.find(layer => layer.name === entry.layer);
    const before = entry.oldPath ? await versionContent(root, layer.before, entry.oldPath) : null;
    const after = entry.status[0] === 'D' ? null : await versionContent(root, entry.untracked ? 'worktree' : layer.after, entry.path);
    entry.beforeSha256 = before === null ? null : sha(before.bytes);
    entry.afterSha256 = after === null ? null : sha(after.bytes);
    const paths = [entry.path, ...(entry.oldPath && entry.oldPath !== entry.path ? [entry.oldPath] : [])];
    const numstat = entry.untracked ? '' : (await git(root, ['diff', '--numstat', '--no-ext-diff', '--no-textconv', ...layer.revisions, '--', ...paths])).toString();
    const binary = [before, after].some(value => value?.bytes.subarray(0, 8192).includes(0)) || numstat.startsWith('-\t-\t');
    const lock = LOCKS.has(path.posix.basename(entry.path));
    entry.classification = before?.gitlink || after?.gitlink ? 'gitlink' : binary ? 'binary' : lock && !includeLocks ? 'lock' : 'text';
    if (!['text', 'gitlink'].includes(entry.classification)) continue;
    let patch;
    if (entry.untracked) patch = await git(root, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', '/dev/null', entry.path], [0, 1]);
    else patch = await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', ...layer.revisions, '--', ...paths]);
    if (patch.length) {
      const item = source('diff', entry.layer + '/' + entry.path, patch);
      entry.referenceDetection = referenceDetection(entry.oldPath || entry.path, before?.bytes, after?.bytes, item.text);
      entry.diffId = item.id; sources.push(item);
    }
  }
  return { files, sources };
}
export function deletionCandidates(files, sources) {
  const terms = new Set();
  for (const file of files) {
    if (/^[DR]/.test(file.status)) {
      const old = file.oldPath;
      terms.add(old); terms.add(old.replace(/\.[^/.]+$/, '')); terms.add(path.posix.basename(old));
    }
    if (file.referenceDetection) {
      for (const term of file.referenceDetection.terms) terms.add(term);
    } else {
      const patch = sources.find(item => item.id === file.diffId)?.text || '';
      const removed = patch.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).map(line => line.slice(1));
      if (!/\.(md|txt|rst|adoc|css|svg)$/i.test(file.path))
        for (const term of conservativeCandidates(removed)) terms.add(term);
    }
  }
  return sorted([...terms].filter(Boolean));
}
async function scanReferences(root, scope, terms, scratch) {
  if (!terms.length) return [];
  const patternFile = path.join(scratch, 'patterns.txt');
  await fs.writeFile(patternFile, `${terms.join('\n')}\n`);
  const all = await repositoryFiles(root, scope);
  const files = [];
  for (const name of sorted([...all.tracked, ...all.untracked]).filter(name => inScope(name, scope))) {
    const stat = await fs.lstat(path.join(root, name)).catch(() => null);
    if (stat?.isFile()) files.push(name);
  }
  const sources = [source('execution', 'reference-search/scope', Buffer.from(JSON.stringify({
    kind: 'reference-search', terms, scope, files, ignoredUntracked: true, followSymlinks: false,
  }, null, 2)))];
  const chunks = []; let chunk = [], length = 0;
  for (const name of files) {
    if (length + name.length > 6000 && chunk.length) { chunks.push(chunk); chunk = []; length = 0; }
    chunk.push(name); length += name.length + 3;
  }
  if (chunk.length) chunks.push(chunk);
  for (let i = 0; i < chunks.length; i++) {
    const args = ['--fixed-strings', '--file', patternFile, '--line-number', '--with-filename', '--no-heading', '--color', 'never', '--hidden', '--no-ignore', '--', ...chunks[i]];
    let result;
    try { result = await run('rg', args, { cwd: root }); }
    catch (error) { throw new AuditError(`Reference search could not start: ${error.message}`); }
    sources.push(source('execution', `reference-search/${i}/command`, Buffer.from(JSON.stringify({
      command: ['rg', ...args], exitCode: result.code, scope,
    }, null, 2))));
    sources.push(source('execution', `reference-search/${i}/stdout`, result.stdout));
    sources.push(source('execution', `reference-search/${i}/stderr`, result.stderr));
    if (![0, 1].includes(result.code)) throw new AuditError(`Reference search failed (${result.code}): ${result.stderr.toString('utf8')}`);
  }
  return sources;
}
export function reviewerEvidence(bundle) {
  return { version: bundle.version, base: bundle.base, fingerprint: bundle.fingerprint,
    planOrigin: bundle.planOrigin, files: bundle.files, executions: bundle.executions,
    sources: bundle.sources.map(({ rawBase64, text, ...item }, sourceIndex) => ({
      ...item, lines: text.split('\n').map((text, index) => ({
        ...(text.trim() ? { citationId: citationId(sourceIndex + 1, index + 1) } : {}), number: index + 1, text,
      })),
    })) };
}
export async function collect({ repo, out, plan, planRef, planOrigin, base, runs = [], scope = scopeOf(),
  includeLocks = false, maxEvidenceBytes = MAX_EVIDENCE_BYTES }) {
  if (!base || !plan) throw new AuditError('collect requires --base and --plan.');
  if (!Number.isSafeInteger(maxEvidenceBytes) || maxEvidenceBytes <= 0) throw new AuditError('Evidence limit must be a positive integer.');
  const root = await repoRoot(repo);
  out = await assertOutputLocation(root, out);
  if (await exists(out)) throw new AuditError('Use a new output directory for each collection.');
  const snapshot = await fingerprint(root, scope);
  base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).toString().trim();
  const originals = await planSources(root, plan, planRef, planOrigin);
  const diff = await changes(root, base, scope, includeLocks);
  const sources = [...originals.sources, ...diff.sources,
    source('diff', 'git-file-manifest', Buffer.from(JSON.stringify(diff.files, null, 2)))], executions = [];
  for (let i = 0; i < runs.length; i++) {
    const file = path.resolve(runs[i]), record = await readJSON(file);
    const { sha256, ...unsigned } = record;
    if (sha(canonical(unsigned)) !== sha256 || record.version !== 1 || record.kind !== 'test-run') throw new AuditError('Execution record is invalid or modified.');
    if (record.repositoryId !== sha(root) || record.validity !== 'CLEAN' || record.before.digest !== record.after.digest || record.after.digest !== snapshot.digest)
      throw new AuditError(`Execution record is dirty, stale or from another workspace: ${file}`, 'INSUFFICIENT_EVIDENCE');
    if (record.error || record.signal || !Number.isInteger(record.exitCode)) throw new AuditError('Execution did not finish normally.', 'INSUFFICIENT_EVIDENCE');
    const streams = {};
    for (const stream of ['stdout', 'stderr']) {
      if (path.basename(record[stream].file) !== record[stream].file) throw new AuditError('Invalid execution stream path.');
      const bytes = await fs.readFile(path.join(path.dirname(file), record[stream].file));
      if (sha(bytes) !== record[stream].sha256) throw new AuditError('Execution output was modified.');
      const item = source('execution', `test/${i}/${stream}`, bytes); sources.push(item); streams[stream] = item.id;
    }
    const metadata = { command: record.command, exitCode: record.exitCode, startedAt: record.startedAt,
      endedAt: record.endedAt, fingerprint: record.after.digest, streams };
    const item = source('execution', `test/${i}/command`, Buffer.from(JSON.stringify(metadata, null, 2)));
    sources.push(item); executions.push({ ...metadata, evidenceId: item.id });
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-scan-'));
  try { sources.push(...await scanReferences(root, scope, deletionCandidates(diff.files, diff.sources), scratch)); }
  finally { await removeTemporary(scratch); }
  const after = await fingerprint(root, scope);
  if (snapshot.digest !== after.digest) throw new AuditError('Workspace drifted during collection.', 'INSUFFICIENT_EVIDENCE');
  const bundle = { version: 1, createdAt: new Date().toISOString(), repositoryId: sha(root),
    base, fingerprint: snapshot, planOrigin: originals.origin, files: diff.files, executions, sources };
  const view = reviewerEvidence(bundle);
  bundle.evidenceEncoding = preferredEvidenceEncoding(view);
  const bytes = Buffer.byteLength(evidenceText(view, bundle.evidenceEncoding));
  if (bytes > maxEvidenceBytes) throw new AuditError(`Core evidence exceeds limit: ${bytes} > ${maxEvidenceBytes} bytes.`, 'ERROR', {
    totalBytes: bytes, maxEvidenceBytes, sources: sources.map(item => ({ id: item.id, label: item.label, bytes: Buffer.byteLength(item.text) })) });
  bundle.coreBytes = bytes; bundle.maxEvidenceBytes = maxEvidenceBytes;
  bundle.sha256 = sha(canonical(bundle));
  await writeJSON(path.join(out, 'bundle.json'), bundle);
  return bundle;
}
export function validateBundle(bundle) {
  const { sha256, ...unsigned } = bundle;
  if (sha(canonical(unsigned)) !== sha256 || bundle.version !== 1) throw new AuditError('Frozen bundle integrity check failed.');
  if (!Array.isArray(bundle.sources) || !bundle.sources.some(item => item.kind === 'plan')) throw new AuditError('Bundle lacks original plan sources.');
  const ids = new Set();
  for (const item of bundle.sources) {
    if (!['plan', 'diff', 'execution'].includes(item.kind) || ids.has(item.id)) throw new AuditError('Invalid or duplicate evidence source.');
    ids.add(item.id);
    const reconstructed = source(item.kind, item.label, Buffer.from(item.rawBase64, 'base64'));
    if (canonical(reconstructed) !== canonical(item)) throw new AuditError(`Evidence integrity check failed: ${item.id}`);
  }
  const bytes = Buffer.byteLength(bundle.evidenceEncoding
    ? evidenceText(reviewerEvidence(bundle), bundle.evidenceEncoding) : canonical(reviewerEvidence(bundle)));
  if (bytes !== bundle.coreBytes || bytes > bundle.maxEvidenceBytes) throw new AuditError('Evidence size check failed.');
  return bundle;
}
