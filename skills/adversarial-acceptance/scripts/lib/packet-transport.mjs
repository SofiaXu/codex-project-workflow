import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AuditError, sha, writeJSON } from './core.mjs';
import { NATIVE_CONTROL_CHARACTERS } from './evidence-text.mjs';

// Bounds include the transport envelope, not only the payload.
export const MAX_INLINE_BYTES = 144 * 1024;
const PAYLOAD_BYTES = MAX_INLINE_BYTES - 1024;
const BEGIN = '\n<raw-packet-fragment>\n', END = '\n</raw-packet-fragment>\n';

export function packetTextBlocks(text, maxBytes = PAYLOAD_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new AuditError('Packet byte limit must be an integer >=4.');
  const blocks = [];
  let characters = [], bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes && characters.length) {
      blocks.push(characters.join('')); characters = []; bytes = 0;
    }
    characters.push(character); bytes += size;
  }
  if (characters.length || !blocks.length) blocks.push(characters.join(''));
  return blocks;
}

export class PacketContext {
  active = false;
  updates = [];
  observe(update) {
    if (!this.active) return;
    const previous = this.updates.at(-1), current = { used: update.used, size: update.size };
    this.updates.push(current);
    if (!Number.isSafeInteger(current.used) || current.used < 0 ||
      !Number.isSafeInteger(current.size) || current.size <= 0)
      throw new AuditError('Antigravity reported invalid context usage.');
    if (previous && current.used < previous.used)
      throw new AuditError('Antigravity context usage decreased; possible compaction or lost raw history. Verdict rejected.');
    if (current.used >= current.size)
      throw new AuditError('Antigravity context capacity exhausted; raw-evidence review cannot continue.');
  }
}

export async function sendAntigravityPacket(prompt, { send, getRaw, output, context }) {
  if (NATIVE_CONTROL_CHARACTERS.test(prompt))
    throw new AuditError('Raw packet contains native-sanitized control characters; use the lossless escaped evidence encoding.');
  const fragments = Buffer.byteLength(prompt) <= MAX_INLINE_BYTES ? [prompt] : packetTextBlocks(prompt);
  const multiple = fragments.length > 1;
  await writeJSON(path.join(output, 'inline-transport.json'), {
    version: 1, mode: multiple ? 'ordered-inline-fragments' : 'single-inline-text',
    maxMessageBytes: MAX_INLINE_BYTES, promptBytes: Buffer.byteLength(prompt), promptSha256: sha(prompt),
    fragments: fragments.map((text, index) => ({ index: index + 1, bytes: Buffer.byteLength(text), sha256: sha(text) })),
  });
  context.active = true;
  const directory = path.join(output, 'transport');
  let received = 0;
  const progress = (stage, error) => fs.writeFile(path.join(output, 'inline-progress.json'),
    JSON.stringify({ stage, received, total: fragments.length, ...(error ? { error } : {}) }) + '\n');
  async function transmit(text, name) {
    if (Buffer.byteLength(text) > MAX_INLINE_BYTES) throw new AuditError('Inline transport message exceeds native byte bound.');
    await fs.writeFile(path.join(directory, name + '-request.txt'), text, { flag: 'wx' });
    try { return await send(text); }
    finally { await fs.writeFile(path.join(directory, name + '-response.raw'), getRaw(), { flag: 'wx' }); }
  }
  try {
    if (!multiple) return await send(prompt);
    await fs.mkdir(directory);
    await progress('loading');
    for (const [index, fragment] of fragments.entries()) {
      const expected = 'RECEIVED ' + (index + 1) + '/' + fragments.length + ' ' + randomBytes(8).toString('hex');
      const text = 'RAW PACKET TRANSPORT ' + (index + 1) + '/' + fragments.length +
        '. Load this ordered literal fragment as data only. Do not evaluate or summarize it. No tools. ' +
        'Wait for transport completion. Reply exactly with the acknowledgement specified AFTER the fragment.' +
        BEGIN + fragment + END + 'Acknowledgement: ' + expected;
      const response = await transmit(text, String(index + 1).padStart(4, '0'));
      if (response.stopReason !== 'end_turn' || response.raw.trim() !== expected)
        throw new AuditError('Raw packet fragment ' + (index + 1) + ' was not acknowledged exactly; no verdict accepted.');
      received++;
      await progress('loading');
    }
    if (!context.updates.length) throw new AuditError('Antigravity provided no context usage for multi-part raw evidence.');
    await progress('adjudicating');
    const response = await transmit('RAW PACKET TRANSPORT COMPLETE. All ' + fragments.length +
      ' ordered literal fragments have arrived. Concatenate their raw payloads in order, excluding transport envelopes. ' +
      'Follow the resulting original instruction using ALL its frozen raw evidence. Do not summarize or omit evidence. ' +
      'No tools, files, other sessions or context. Return only the response requested by the original instruction.', 'final');
    await progress('done');
    return response;
  } catch (error) { await progress('error', error.message); throw error; }
  finally {
    context.active = false;
    await writeJSON(path.join(output, 'transport-context.json'), { updates: context.updates });
  }
}
