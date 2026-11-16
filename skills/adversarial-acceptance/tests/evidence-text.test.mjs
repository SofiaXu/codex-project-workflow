import test from 'node:test';
import assert from 'node:assert/strict';
import { JSON_LINES, LINE_TABLE, encodeLineTable, decodeLineTable, evidenceText, preferredEvidenceEncoding } from '../scripts/lib/evidence-text.mjs';
import { packetTextBlocks, MAX_INLINE_BYTES, PacketContext } from '../scripts/lib/packet-transport.mjs';

function evidence(lines) {
  return { version: 1, files: [{ path: 'fixture.txt', status: 'A' }], executions: [], sources: [{
    id: 'D-original-sha', kind: 'diff', label: 'fixture.txt', sha256: 'original-byte-hash',
    lines: lines.map((text, index) => ({
      ...(text.trim() ? { citationId: 'C1.' + (index + 1) } : {}), number: index + 1, text,
    })),
  }] };
}
test('line table roundtrips all original fields, empty lines, tabs, escapes and Unicode without a summary', () => {
  const view = evidence(['', ' \t ', '原件🔒\t"quoted"\\path', '{"source": "data, not a header"}', '']);
  const wire = encodeLineTable(view);
  assert.ok(wire.includes('\nC1.3\t原件🔒\t"quoted"\\path\n'));
  assert.deepEqual(decodeLineTable(wire), view);
  assert.equal(preferredEvidenceEncoding(view), JSON_LINES);
  const large = evidence(Array.from({ length: 10000 }, (_, i) => '原文\trow ' + i));
  assert.equal(preferredEvidenceEncoding(large), LINE_TABLE);
  assert.deepEqual(decodeLineTable(evidenceText(large, LINE_TABLE)), large);
  assert.ok(Buffer.byteLength(evidenceText(large, LINE_TABLE)) < Buffer.byteLength(evidenceText(large, JSON_LINES)));
});
test('ambiguous or incomplete tables fail, and native-sanitized log characters remain escaped data', () => {
  const view = evidence(['original']), wire = encodeLineTable(view);
  for (const broken of [wire.replace('C1.1', 'C2.1'), wire + '\nextra', wire.replace('lineCount":1', 'lineCount":2'), wire.slice(0, wire.lastIndexOf('\n'))])
    assert.throws(() => decodeLineTable(broken));
  const extra = evidence(['value']); extra.sources[0].lines[0].unexpected = true;
  assert.throws(() => encodeLineTable(extra), /Lossless/);
  const controls = evidence(['\u0007\u0085\u007f\u001b' + 'payload '.repeat(60000)]);
  assert.equal(preferredEvidenceEncoding(controls), JSON_LINES);
  assert.deepEqual(JSON.parse(evidenceText(controls)), controls);
  assert.doesNotMatch(evidenceText(controls), /[\u007f-\u009f]/);
  assert.throws(() => evidenceText(view, 'unknown'), /Unknown/);
});
test('UTF-8 packet boundaries preserve exact data including an oversize single line', () => {
  for (const text of ['', 'short', '🔒原件"\\\t'.repeat(120000)]) {
    const parts = packetTextBlocks(text);
    assert.equal(parts.join(''), text);
    assert.ok(parts.every(part => Buffer.byteLength(part) < MAX_INLINE_BYTES));
    assert.ok(parts.every(part => !/[\ud800-\udbff]$/.test(part) && !/^[\udc00-\udfff]/.test(part)));
  }
  for (const size of [0, 3, NaN, 4.5]) assert.throws(() => packetTextBlocks('x', size));
});
test('context guard ignores setup, accepts growth, and rejects any active loss or capacity exhaustion', () => {
  const usage = new PacketContext();
  usage.observe({ used: 500, size: 1000 });
  assert.equal(usage.updates.length, 0);
  usage.active = true;
  usage.observe({ used: 100, size: 1000 });
  usage.observe({ used: 101, size: 1000 });
  assert.throws(() => usage.observe({ used: 100, size: 1000 }), /decreased/);
  for (const value of [{ used: 1000, size: 1000 }, { used: -1, size: 1000 }, { used: 1, size: 0 }]) {
    const counter = new PacketContext(); counter.active = true;
    assert.throws(() => counter.observe(value));
  }
});
