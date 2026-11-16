import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceDetection } from '../scripts/lib/deletion-candidates.mjs';

function detect(name, before, removed, after = '') {
  const rows = before.split('\n');
  const patch = '@@ -1,' + rows.length + ' +1,0 @@\n' +
    rows.map((line, i) => (removed.includes(i + 1) ? '-' : ' ') + line).join('\n');
  return referenceDetection(name, Buffer.from(before), Buffer.from(after), patch);
}

test('C# body changes do not turn locals, called types, literals or comments into removed exports', () => {
  const before = [
    'namespace Example;',
    'public class Api {',
    '  public async Task ExecuteAsync() {',
    '    var connection = new NpgsqlConnection(ConnectionString);',
    '    await connection.OpenAsync();',
    '    var query = """public class Fake { }""";',
    '    // public void Misleading() {}',
    '  }',
    '}',
  ].join('\n');
  const result = detect('api.cs', before, [4, 5, 6, 7]);
  assert.equal(result.rule, 'csharp-declarations-v1');
  assert.deepEqual(result.terms, []);
  assert.deepEqual(detect('api.cs', before, [3]).terms, ['ExecuteAsync']);
});

test('C# declaration selection retains multiline/overload, implicit interface, enum and record contracts', () => {
  const before = [
    'public interface IApi {',
    '  Task<bool> x(',
    '    int number);',
    '}',
    'public class Api {',
    '  [Authorize("read")]',
    '  public Result<T> Find<T>(',
    '    string key) where T : class { return default; }',
    '  public int Find(int key) => key;',
    '  public string OldProperty { get; set; }',
    '  protected Api() {}',
    '}',
    'public enum Kind { x, Kept }',
    'public record Entry(string Name, int Count);',
  ].join('\n');
  assert.deepEqual(detect('api.cs', before, [3]).terms, ['x']);
  assert.deepEqual(detect('api.cs', before, [8]).terms, ['Find']);
  assert.deepEqual(detect('api.cs', before, [9, 10, 11]).terms, ['Api', 'Find', 'OldProperty']);
  assert.deepEqual(detect('api.cs', before, [13]).terms, ['Kept', 'Kind', 'x']);
  assert.deepEqual(detect('api.cs', before, [14]).terms, ['Count', 'Entry', 'Name']);
});

test('ambiguous C# and unknown languages retain the conservative fallback, including short exports', () => {
  const broken = detect('api.cs', 'public class Api {\n  public void x() {}', [2]);
  assert.equal(broken.rule, 'conservative-fallback');
  assert.equal(broken.reason, 'unsupported-or-invalid-syntax');
  assert.ok(broken.terms.includes('x'));
  assert.equal(detect('api.cs', 'public class Api {\n  public static bool operator ==(Api a, Api b) => true;\n}\n', [2]).rule, 'conservative-fallback');
  const tuple = detect('api.cs', 'public class Api {\n  public (int x, int y) Coordinates() => (1,2);\n}\n', [2]);
  assert.equal(tuple.rule, 'conservative-fallback');
  assert.ok(tuple.terms.includes('Coordinates'));
  assert.ok(!tuple.terms.includes('public'));
  const unknown = detect('api.ex', 'def x(v), do: v\n', [1]);
  assert.equal(unknown.rule, 'conservative-fallback');
  assert.ok(unknown.terms.includes('x'));
});

test('C# initialized fields retain declared names rather than initializer calls, including short and multiple names', () => {
  const before = 'public class Api {\n  public Factory Exported = BuildFactory();\n  public Func<int> x = () => 42;\n  public Dictionary<string, int> a = New(1, 2), b = New(3, 4);\n}\n';
  assert.deepEqual(detect('api.cs', before, [2, 3, 4]).terms, ['Exported', 'a', 'b', 'x']);
  const ambiguous = detect('api.cs', 'public class Api {\n  public Factory x = new() { Name = "old" }, y = new();\n}\n', [2]);
  assert.equal(ambiguous.rule, 'conservative-fallback');
  for (const name of ['x', 'y']) assert.ok(ambiguous.terms.includes(name));
});

test('OpenAPI metadata edits avoid generic search terms while removed contract names remain searchable', () => {
  const old = { openapi: '3.1.0', info: { title: 'Old API' },
    paths: { '/old': { get: { operationId: 'GetOld' } }, '/retained': { get: { operationId: 'GetPrevious' } } },
    components: { schemas: { OldSchema: { type: 'object' }, Kept: {
      description: 'Before', type: 'object', properties: { type: { type: 'string' }, Name: { type: 'string' } },
    } } } };
  const next = structuredClone(old);
  next.info.title = 'New API';
  next.components.schemas.Kept.description = 'After';
  next.components.schemas.Kept.properties.Name.type = ['string', 'null'];
  const before = JSON.stringify(old, null, 2);
  const removed = before.split('\n').map((_, i) => i + 1);
  assert.deepEqual(detect('api.json', before, removed, JSON.stringify(next)).terms, []);
  delete next.paths['/old'];
  next.paths['/retained'].get.operationId = 'GetCurrent';
  delete next.components.schemas.OldSchema;
  delete next.components.schemas.Kept.properties.type;
  const result = detect('api.json', before, removed, JSON.stringify(next));
  assert.equal(result.rule, 'json-contract-keys-v1');
  assert.deepEqual(result.terms, ['/old', 'GetOld', 'GetPrevious', 'OldSchema', 'type']);
});

test('JSON configuration/package removals retain keys, qualified keys and removed export targets', () => {
  const before = JSON.stringify({ Storage: { Bucket: 'data' }, exports: { './old': './old.js' }, bin: { cli: './cli.js' } });
  const result = detect('package.json', before, [1], JSON.stringify({ Storage: {}, exports: {}, bin: {} }));
  for (const term of ['Bucket', 'Storage:Bucket', './old', './old.js', 'cli', './cli.js'])
    assert.ok(result.terms.includes(term), term);
  assert.equal(detect('invalid.json', '{"broken":', [1], '{}').rule, 'conservative-fallback');
});

test('PowerShell command declarations are candidates; local variables and invocation bodies are not', () => {
  const before = 'function Get-Old {\n  $connection = New-Connection\n  $connection.OpenAsync()\n}\n';
  assert.deepEqual(detect('verify.ps1', before, [2, 3]).terms, []);
  assert.deepEqual(detect('verify.ps1', before, [1]).terms, ['Get-Old']);
  const module = "Export-ModuleMember -Function @(\n  'x',\n  'Get-Old'\n) -Alias 'y'\n";
  assert.deepEqual(detect('api.psm1', module, [2]).terms, ['Get-Old', 'x', 'y']);
  assert.equal(detect('api.psm1', 'Export-ModuleMember -Function $dynamic\n', [1]).rule, 'conservative-fallback');
});
