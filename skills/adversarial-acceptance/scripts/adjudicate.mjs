#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { capture, collect, scopeOf, EXIT, AuditError } from './lib/core.mjs';

const help = `adversarial-acceptance (Node >=24.9, git; rg for deletion checks)
  capture --repo DIR --out DIR [--exclude-dir NAME] -- EXECUTABLE [ARG...]
  collect --repo DIR --base REF --plan PATH [--plan-ref REF | --plan-origin SOURCE]
          [--run PATH/run.json ...] --out DIR [--max-evidence-bytes N]
          [--exclude-dir NAME ...] [--include-lockfiles]
  review  --repo DIR --bundle PATH/bundle.json --out DIR
          [--config PATH] [--model ADVERTISED_ID] [--timeout-ms N]
Outputs must be outside the repository or in a Git-ignored directory.
Exit codes: 0 PASS/clean capture, 1 FAIL/test failure, 2 evidence gap/dirty run, 3 ERROR.
For command scripts use an explicit native interpreter (node, python, pwsh -File).
`;
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) { process.stdout.write(help); }
  else {
    const common = { repo: { type: 'string' }, out: { type: 'string' } };
    const options = {
      capture: { ...common, 'exclude-dir': { type: 'string', multiple: true } },
      collect: { ...common, base: { type: 'string' }, plan: { type: 'string' }, 'plan-ref': { type: 'string' },
        'plan-origin': { type: 'string' }, run: { type: 'string', multiple: true }, 'exclude-dir': { type: 'string', multiple: true },
        'max-evidence-bytes': { type: 'string' }, 'include-lockfiles': { type: 'boolean' } },
      review: { ...common, bundle: { type: 'string' }, config: { type: 'string' }, model: { type: 'string' }, 'timeout-ms': { type: 'string' } },
    }[command];
    if (!options) throw new AuditError(`Unknown command: ${command}`);
    const { values: v, positionals } = parseArgs({ args, options, allowPositionals: command === 'capture', strict: true });
    if (!v.repo || !v.out) throw new AuditError('--repo and --out are required.');
    let result;
    if (command === 'capture') {
      result = await capture({ repo: v.repo, out: v.out, command: positionals, scope: scopeOf(v['exclude-dir']) });
      process.exitCode = result.error ? 3 : result.validity === 'DIRTY' ? 2 : result.exitCode === 0 ? 0 : 1;
    } else if (command === 'collect') {
      if (v['plan-ref'] && v['plan-origin']) throw new AuditError('Choose --plan-ref or --plan-origin.');
      result = await collect({ repo: v.repo, out: v.out, base: v.base, plan: v.plan,
        planRef: v['plan-ref'], planOrigin: v['plan-origin'], runs: v.run,
        scope: scopeOf(v['exclude-dir']), includeLocks: v['include-lockfiles'],
        ...(v['max-evidence-bytes'] ? { maxEvidenceBytes: Number(v['max-evidence-bytes']) } : {}) });
    } else {
      if (!v.bundle) throw new AuditError('--bundle is required.');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const { review } = await import('./lib/agent.mjs');
        result = await review({ repo: v.repo, bundleFile: v.bundle, out: v.out, configFile: v.config,
          model: v.model, ...(v['timeout-ms'] ? { timeoutMs: Number(v['timeout-ms']) } : {}), signal: controller.signal });
        process.exitCode = EXIT[result.verdict];
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
    process.stdout.write(`${JSON.stringify(command === 'collect' ? { bundleSha256: result.sha256, coreBytes: result.coreBytes, sources: result.sources.length } : command === 'capture' ? { validity: result.validity, exitCode: result.exitCode, fingerprint: result.after.digest } : result, null, 2)}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ verdict: error.status || 'ERROR', error: error.message, details: error.details }, null, 2)}\n`);
  process.exitCode = EXIT[error.status] ?? 3;
}
