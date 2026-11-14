#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AuditError, sha, inside, exists } from './lib/core.mjs';

export const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const ROOT_ENTRIES = new Set(['SKILL.md', 'LICENSE', 'package.json', 'package-lock.json',
  'agents', 'references', 'scripts', 'tests', 'assets']);
export const defaultDestination = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'adversarial-acceptance');
export async function distributionFiles(directory = SOURCE, prefix = '') {
  const files = [];
  for (const entry of (await fs.readdir(path.join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && !ROOT_ENTRIES.has(entry.name)) continue;
    const name = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new AuditError('Distribution resources cannot be symlinks: ' + name);
    if (entry.isDirectory()) files.push(...await distributionFiles(directory, name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}
async function resolvedDestination(directory) {
  let ancestor = path.resolve(directory); const suffix = [];
  while (!await exists(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(await fs.realpath(ancestor), ...suffix);
}
export async function installLocalSkill(destination = defaultDestination()) {
  const source = await fs.realpath(SOURCE), target = await resolvedDestination(destination);
  if (inside(source, target)) throw new AuditError('Install target must be outside the source Skill directory.');
  const files = await distributionFiles();
  await fs.mkdir(target, { recursive: true });
  const manifest = [];
  for (const name of files) {
    const output = path.join(target, name);
    await fs.mkdir(path.dirname(output), { recursive: true });
    if (!inside(target, await fs.realpath(path.dirname(output)))) throw new AuditError('Install parent escapes target: ' + name);
    const existing = await fs.lstat(output).catch(() => null);
    if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new AuditError('Refusing to overwrite a non-regular install resource: ' + name);
    const bytes = await fs.readFile(path.join(source, name));
    await fs.writeFile(output, bytes);
    const digest = sha(bytes);
    if (sha(await fs.readFile(output)) !== digest) throw new AuditError('Installed resource hash mismatch: ' + name);
    manifest.push({ path: name.split(path.sep).join('/'), sha256: digest });
  }
  return { target, fileCount: manifest.length, files: manifest, preserved: ['config.local.json', 'local/', 'other destination-only files'] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { target: { type: 'string' } }, strict: true });
    console.log(JSON.stringify(await installLocalSkill(values.target), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 3; }
}
