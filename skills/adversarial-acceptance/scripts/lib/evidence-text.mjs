import { isDeepStrictEqual } from 'node:util';

export const JSON_LINES = 'json-lines-v1';
export const LINE_TABLE = 'line-table-v1';
const COLUMNS = ['numberAndCitationId', 'text'];
const validCount = value => Number.isSafeInteger(value) && value >= 0;
export const NATIVE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const jsonText = value => JSON.stringify(value).replace(/[\u007f-\u009f]/g,
  character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));

export function decodeLineTable(text) {
  const rows = text.split('\n');
  const { lineColumns, sourceCount, ...evidence } = JSON.parse(rows[0]);
  if (!isDeepStrictEqual(lineColumns, COLUMNS) || !validCount(sourceCount) || sourceCount > rows.length - 1)
    throw new Error('Invalid line-table header.');
  let offset = 1;
  evidence.sources = [];
  for (let i = 0; i < sourceCount; i++) {
    const { source, lineCount } = JSON.parse(rows[offset++]);
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
      !validCount(lineCount) || lineCount > rows.length - offset) throw new Error('Invalid line-table source.');
    const lines = [];
    for (let line = 1; line <= lineCount; line++) {
      const row = rows[offset++], tab = row.indexOf('\t');
      if (tab < 0) throw new Error('Incomplete line-table row.');
      const locator = row.slice(0, tab), original = row.slice(tab + 1);
      const citationId = locator === 'C' + (i + 1) + '.' + line ? locator : undefined;
      if ((!citationId && locator !== String(line)) || (citationId && !original.trim()))
        throw new Error('Invalid line-table locator.');
      lines.push({ ...(citationId ? { citationId } : {}), number: line, text: original });
    }
    evidence.sources.push({ ...source, lines });
  }
  if (offset !== rows.length) throw new Error('Unexpected line-table rows.');
  return evidence;
}

export function encodeLineTable(evidence) {
  const { sources, ...metadata } = evidence;
  const rows = [jsonText({ ...metadata, lineColumns: COLUMNS, sourceCount: sources.length })];
  for (const { lines, ...source } of sources) {
    rows.push(jsonText({ source, lineCount: lines.length }));
    for (const line of lines) {
      if (typeof line.text !== 'string' || line.text.includes('\n') || NATIVE_CONTROL_CHARACTERS.test(line.text))
        throw new Error('Original line requires lossless JSON escaping.');
      rows.push((line.citationId ?? line.number) + '\t' + line.text);
    }
  }
  const text = rows.join('\n');
  if (!isDeepStrictEqual(decodeLineTable(text), evidence)) throw new Error('Lossless evidence encoding check failed.');
  return text;
}

export function evidenceText(evidence, encoding = JSON_LINES) {
  if (encoding === JSON_LINES) return jsonText(evidence);
  if (encoding === LINE_TABLE) return encodeLineTable(evidence);
  throw new Error('Unknown frozen evidence encoding: ' + encoding);
}

export function preferredEvidenceEncoding(evidence) {
  const json = evidenceText(evidence);
  if (Buffer.byteLength(json) <= 256 * 1024) return JSON_LINES;
  if (evidence.sources.some(source => source.lines.some(line => NATIVE_CONTROL_CHARACTERS.test(line.text)))) return JSON_LINES;
  return Buffer.byteLength(encodeLineTable(evidence)) < Buffer.byteLength(json) ? LINE_TABLE : JSON_LINES;
}
