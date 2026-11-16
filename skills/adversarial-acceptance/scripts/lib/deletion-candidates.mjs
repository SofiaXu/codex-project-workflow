import path from 'node:path';

const ID = /^@?[\p{L}_][\p{L}\p{N}_]*$/u;
const WORDS = new Set('const let var function class def return from import export default public private protected internal static async await null none true false self this new void string int if else for while try catch throw throws extends implements package using namespace module require exports as use'.split(' '));
const sorted = values => [...new Set(values)].filter(Boolean).sort();
const lf = text => text.replace(/\r\n?/g, '\n');

// Retained for unsupported/ambiguous syntax. A lack of a language rule must not
// turn a removed export into "nothing to check".
export function conservativeCandidates(lines) {
  const terms = [];
  for (const line of lines) {
    const tokens = new Set(line.match(/[\p{L}_$][\p{L}\p{N}_$]{2,}/gu) || []);
    for (const match of line.matchAll(/\b(?:function|class|def|func|fn|type|interface|enum|struct|record|const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu)) tokens.add(match[1]);
    for (const match of line.matchAll(/([\p{L}_$][\p{L}\p{N}_$]*)\s*\(/gu)) tokens.add(match[1]);
    for (const match of line.matchAll(/["']([\p{L}_$][\p{L}\p{N}_$]*)["']\s*:/gu)) tokens.add(match[1]);
    for (const match of line.matchAll(/(?<![\p{L}\p{N}_$])([\p{L}_$][\p{L}\p{N}_$]*)\s*=(?!=)/gu)) tokens.add(match[1]);
    if (/\bexport\s*(?:type\s*)?\{|\bexports\s*[.[=]|\b__all__\b|\bpub\s+use\b/.test(line))
      for (const token of line.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) || []) tokens.add(token);
    for (const token of tokens) if (!WORDS.has(token.toLowerCase())) terms.push(token);
  }
  return sorted(terms);
}

function removedLines(patch) {
  const lines = new Set(), text = [];
  let oldLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); continue; }
    if (!oldLine || line.startsWith('\\')) continue;
    if (line.startsWith('-')) { lines.add(oldLine++); text.push(line.slice(1)); }
    else if (line.startsWith(' ')) oldLine++;
  }
  return { lines, text };
}

function fieldNames(values) {
  const fields = []; let start = 0, parens = 0, angles = 0;
  const emit = end => {
    const field = values.slice(start, end), assignment = field.indexOf('=');
    const declaration = assignment < 0 ? field : field.slice(0, assignment);
    const name = declaration.filter(value => ID.test(value)).at(-1);
    if (name) fields.push(name.replace(/^@/, ''));
  };
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '(') parens++;
    if (values[i] === ')') parens--;
    if (values[i] === '<') angles++;
    if (values[i] === '>') angles--;
    if (values[i] === ',' && !parens && !angles) { emit(i); start = i + 1; }
  }
  if (angles) throw new Error('Ambiguous field initializer');
  emit(values.length);
  return fields;
}

function csharpDeclarations(before, removed) {
  // Lex declarations, not method bodies. Keep literals opaque so SQL, strings
  // and comments cannot contribute keywords, braces or "public" declarations.
  const lexical = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?:\$+)?("{3,})[\s\S]*?\1|(?:\$?@|@\$)"(?:[^"]|"")*"|\$?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@?[\p{L}_][\p{L}\p{N}_]*|=>|[^\s]/gu;
  const tokens = [];
  let line = 1, offset = 0;
  for (const match of before.matchAll(lexical)) {
    line += before.slice(offset, match.index).split('\n').length - 1;
    const start = line;
    line += match[0].split('\n').length - 1; offset = match.index + match[0].length;
    if (!match[0].startsWith('//') && !match[0].startsWith('/*'))
      tokens.push({ value: match[0], start, end: line });
  }
  const stack = [{ kind: 'root', header: [], parens: 0, brackets: 0 }];
  const terms = [];
  const emit = header => {
    const frame = stack.at(-1);
    if (!['root', 'namespace', 'type', 'interface', 'enum'].includes(frame.kind)) return;
    if (!header.length || !header.some(token => {
      for (let row = token.start; row <= token.end; row++) if (removed.has(row)) return true;
      return false;
    })) return;
    // Attributes are not the member name; parentheses inside them are skipped.
    let depth = 0;
    const values = header.filter(token => {
      if (token.value === '[') { depth++; return false; }
      if (token.value === ']') { depth--; return false; }
      return !depth;
    }).map(token => token.value);
    const type = values.findIndex((v, i) => /^(class|struct|interface|enum|record)$/.test(v) && ID.test(values[i + 1] || ''));
    if (type >= 0) {
      let index = type + 1;
      if (values[type] === 'record' && /^(class|struct)$/.test(values[index])) index++;
      terms.push(values[index].replace(/^@/, ''));
      // Positional record parameters are also generated public properties.
      if (values[type] === 'record' && values.includes('(')) {
        const parameters = values.slice(values.indexOf('(') + 1, values.lastIndexOf(')'));
        for (const part of parameters.join(' ').split(',')) {
          const ids = part.split('=')[0].match(/@?[\p{L}_][\p{L}\p{N}_]*/gu);
          if (ids?.length > 1) terms.push(ids.at(-1).replace(/^@/, ''));
        }
      }
      return;
    }
    if (frame.kind === 'namespace' || frame.kind === 'root') {
      if (values[0] === 'namespace') terms.push(values.slice(1).join(''));
      return;
    }
    if (!['type', 'interface', 'enum'].includes(frame.kind)) return;
    if (frame.kind !== 'interface' && frame.kind !== 'enum' && !values.some(v => /^(public|protected|internal)$/.test(v))) return;
    if (values.includes('operator')) throw new Error('Unsupported operator declaration');
    const paren = values.indexOf('(');
    const assignment = values.indexOf('=');
    if (paren >= 0 && (assignment < 0 || paren < assignment)) {
      let index = paren - 1;
      if (values[index] === '>') {
        let angle = 0;
        do {
          if (values[index] === '>') angle++;
          if (values[index] === '<') angle--;
          index--;
        } while (index >= 0 && angle);
      }
      if (WORDS.has(values[index]?.toLowerCase())) throw new Error('Unsupported callable declaration');
      if (ID.test(values[index] || '')) terms.push(values[index].replace(/^@/, ''));
      else terms.push(...conservativeCandidates([values.join(' ')]));
    } else {
      terms.push(...fieldNames(values));
    }
  };
  for (const token of tokens) {
    const frame = stack.at(-1), value = token.value;
    if (value === '(') frame.parens++;
    if (value === ')') frame.parens--;
    if (value === '[') frame.brackets++;
    if (value === ']') frame.brackets--;
    if (frame.parens < 0 || frame.brackets < 0) throw new Error('Unbalanced declaration');
    if (frame.parens || frame.brackets) { frame.header.push(token); continue; }
    if (value === '{') {
      const header = frame.header.map(row => row.value), assignment = header.indexOf('='), paren = header.indexOf('(');
      if (['type', 'interface'].includes(frame.kind) && assignment >= 0 && (paren < 0 || assignment < paren) &&
        header.some(v => /^(public|protected|internal)$/.test(v)))
        throw new Error('Unsupported braced field initializer');
      emit(frame.header);
      const values = frame.header.map(row => row.value);
      const type = values.find((v, i) => /^(class|struct|interface|enum|record)$/.test(v) && ID.test(values[i + 1] || ''));
      const kind = ['root', 'namespace', 'type', 'interface'].includes(frame.kind)
        ? values[0] === 'namespace' ? 'namespace' : type === 'interface' ? 'interface' : type === 'enum' ? 'enum' : type ? 'type' : 'block'
        : 'block';
      frame.header = []; stack.push({ kind, header: [], parens: 0, brackets: 0 });
    } else if (value === '}') {
      if (frame.kind === 'enum') emit(frame.header);
      if (stack.length === 1) throw new Error('Unbalanced declaration');
      stack.pop(); stack.at(-1).header = [];
    } else if (value === ';' || value === '=>' || (value === ',' && frame.kind === 'enum')) {
      emit(frame.header); frame.header = [];
    } else frame.header.push(token);
  }
  if (stack.length !== 1 || stack[0].parens || stack[0].brackets) throw new Error('Unbalanced declaration');
  return terms;
}

function jsonRemovals(before, after) {
  const old = JSON.parse(before), current = after ? JSON.parse(after) : {};
  const terms = [];
  const walk = (left, right, prefix = []) => {
    if (!left || typeof left !== 'object' || Array.isArray(left)) return;
    for (const [key, value] of Object.entries(left)) {
      const next = right && typeof right === 'object' && Object.hasOwn(right, key) ? right[key] : undefined;
      if (next === undefined) {
        terms.push(key);
        if (prefix.length) terms.push([...prefix, key].join(':'));
      }
      walk(value, next, [...prefix, key]);
    }
  };
  if (old?.openapi || old?.swagger) {
    for (const [route, operations] of Object.entries(old.paths || {})) {
      if (!Object.hasOwn(current.paths || {}, route)) terms.push(route);
      for (const [method, operation] of Object.entries(operations)) {
        if (!/^(get|put|post|delete|options|head|patch|trace)$/.test(method)) continue;
        if (operation?.operationId && operation.operationId !== current.paths?.[route]?.[method]?.operationId)
          terms.push(operation.operationId);
        if (!current.paths?.[route]?.[method]) {
          terms.push(route);
          if (operation?.operationId) terms.push(operation.operationId);
        }
      }
    }
    // OpenAPI metadata such as type/format/description is not an exported name.
    // Property names (including a real property named "type") remain candidates.
    const schemaWalk = (left, right) => {
      if (!left || typeof left !== 'object') return;
      for (const [key, value] of Object.entries(left)) {
        if (key === 'properties' && value && typeof value === 'object')
          for (const name of Object.keys(value)) if (!Object.hasOwn(right?.properties || {}, name)) terms.push(name);
        schemaWalk(value, right?.[key]);
      }
    };
    for (const category of ['schemas', 'parameters', 'responses', 'requestBodies', 'headers', 'securitySchemes', 'examples', 'links', 'callbacks']) {
      for (const name of Object.keys(old.components?.[category] || {}))
        if (!Object.hasOwn(current.components?.[category] || {}, name)) terms.push(name);
    }
    for (const name of Object.keys(old.definitions || {}))
      if (!Object.hasOwn(current.definitions || {}, name)) terms.push(name);
    schemaWalk(old, current);
    return terms;
  }
  walk(old, current);
  // Node package subpath exports can be string/array values instead of keys.
  const targets = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
  for (const key of ['exports', 'bin', 'main', 'module', 'types'])
    for (const target of targets(old?.[key])) if (!targets(current?.[key]).includes(target)) terms.push(target);
  return terms;
}

function powershellDeclarations(before, removed) {
  const rows = before.split('\n'), terms = [];
  for (let i = 0; i < rows.length; i++) {
    const declaration = /^\s*(?:function|filter|workflow)\s+(?:(?:global|script|local):)?([\p{L}_][\p{L}\p{N}_-]*)/iu.exec(rows[i]);
    if (declaration && removed.has(i + 1)) terms.push(declaration[1]);
    if (!/^\s*Export-ModuleMember\b/i.test(rows[i])) continue;
    const start = i, command = [];
    let balance = 0, continued;
    do {
      const line = rows[i];
      command.push(line);
      const unquoted = line.replace(/'[^']*'|"[^"]*"/g, '');
      balance += (unquoted.match(/\(/g) || []).length - (unquoted.match(/\)/g) || []).length;
      continued = balance > 0 || /`\s*$|,\s*$/.test(line);
      if (continued) i++;
    } while (continued && i < rows.length);
    if (continued || balance < 0) throw new Error('Unbalanced module export');
    if (!Array.from({ length: i - start + 1 }, (_, index) => start + index + 1).some(line => removed.has(line))) continue;
    const text = command.join('\n').replace(/^\s*Export-ModuleMember\b/i, '');
    if (/[$*]/.test(text)) throw new Error('Dynamic module export');
    const sections = [...text.matchAll(/-(?:Function|Cmdlet|Variable|Alias)\s+([\s\S]*?)(?=\s+-[\p{L}]+\b|$)/giu)];
    for (const section of sections.length ? sections.map(match => match[1]) : [text])
      terms.push(...section.match(/[\p{L}_][\p{L}\p{N}_-]*/gu) || []);
  }
  return terms;
}

// Rules are intentionally local and extensible. They select search terms, never
// replace the original diff or establish that a dynamic contract is safe.
export function referenceDetection(name, beforeBytes, afterBytes, patch) {
  const removed = removedLines(patch);
  if (!removed.text.length) return { rule: 'no-removed-lines', terms: [] };
  const ext = path.posix.extname(name).toLowerCase();
  if (/\.(md|txt|rst|adoc|css|svg)$/i.test(name)) return { rule: 'prose-or-style', terms: [] };
  const before = lf(beforeBytes?.toString('utf8') || ''), after = lf(afterBytes?.toString('utf8') || '');
  try {
    if (ext === '.cs') return { rule: 'csharp-declarations-v1', terms: sorted(csharpDeclarations(before, removed.lines)) };
    if (ext === '.json') return { rule: 'json-contract-keys-v1', terms: sorted(jsonRemovals(before, after)) };
    if (['.ps1', '.psm1'].includes(ext)) {
      return { rule: 'powershell-declarations-v1', terms: sorted(powershellDeclarations(before, removed.lines)) };
    }
  } catch {
    return { rule: 'conservative-fallback', reason: 'unsupported-or-invalid-syntax', terms: conservativeCandidates(removed.text) };
  }
  return { rule: 'conservative-fallback', reason: 'unrecognized-language', terms: conservativeCandidates(removed.text) };
}
