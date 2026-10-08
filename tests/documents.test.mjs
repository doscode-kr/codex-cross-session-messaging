import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDocuments } from '../scripts/documents.mjs';

function fixture(t) {
  const parent = resolve(tmpdir());
  const root = mkdtempSync(join(parent, 'cross-session-documents-'));
  t.after(() => {
    if (dirname(resolve(root)) !== parent || !resolve(root).startsWith(join(parent, 'cross-session-documents-'))) throw new Error('Unsafe test path.');
    rmSync(root, { recursive: true, force: true });
  });
  const pairs = ['README', 'SECURITY', 'CONTRIBUTING', 'CHANGELOG', 'docs/README', 'docs/MANUAL', 'docs/OPERATIONS'];
  for (const name of pairs) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    const base = name.split('/').at(-1);
    writeFileSync(join(root, `${name}.md`), `# English\n\n[한국어](${base}.ko.md)\n`);
    writeFileSync(join(root, `${name}.ko.md`), `# 한국어\n\n[English](${base}.md)\n`);
  }
  for (const suffix of ['.md', '.ko.md']) {
    const file = join(root, `README${suffix}`);
    writeFileSync(file, readFileSync(file, 'utf8') + `\n[Manual](docs/MANUAL${suffix})\n[Documents](docs/README${suffix})\n`);
  }
  return root;
}

test('all guides have both languages and language switches', t => {
  const root = fixture(t);
  const file = join(root, 'README.ko.md');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n[설명서](docs/MANUAL.ko.md)\n');
  const result = checkDocuments(root);
  assert.equal(result.passed, true, result.errors.join('\n'));
  assert.equal(result.pairs, 7);
});

test('a missing Korean manual fails even when the English manual exists', t => {
  const root = fixture(t);
  rmSync(join(root, 'docs/MANUAL.ko.md'));
  const result = checkDocuments(root);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(error => error.includes('Missing Korean document: docs/MANUAL.ko.md')));
});

test('Korean navigation cannot send readers to a different English guide', t => {
  const root = fixture(t);
  const file = join(root, 'README.ko.md');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n[운영](docs/OPERATIONS.md)\n');
  const result = checkDocuments(root);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(error => error.includes('Korean guide links to English content')));
});

test('a complete translation without a language switch fails', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'docs/MANUAL.ko.md'), '# 한국어 설명서\n\n내용입니다.\n');
  assert.ok(checkDocuments(root).errors.some(error => error === 'Missing language switch in docs/MANUAL.ko.md'));
});

test('orphan Korean documents and broken local links fail', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'docs/EXTRA.ko.md'), '# 한국어\n');
  const file = join(root, 'README.md');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n[Guide](docs/MISSING.md)\n');
  const result = checkDocuments(root);
  assert.ok(result.errors.some(error => error.includes('Missing English document: docs/EXTRA.md')));
  assert.ok(result.errors.some(error => error.includes('Broken link')));
});

test('reference links must follow the same language rules', t => {
  const root = fixture(t);
  const file = join(root, 'README.ko.md');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n[운영][ops]\n\n[ops]: docs/OPERATIONS.md\n');
  assert.ok(checkDocuments(root).errors.some(error => error.includes('Korean guide links to English content')));
});

test('Windows case differences cannot bypass language checks', { skip: process.platform !== 'win32' }, t => {
  const root = fixture(t);
  const file = join(root, 'README.ko.md');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n[운영](docs/operations.md)\n');
  assert.ok(checkDocuments(root).errors.some(error => error.includes('Korean guide links to English content')));
});

test('code examples and comments cannot supply the language switch', t => {
  const root = fixture(t);
  for (const example of ['```text\n[English](MANUAL.md)\n```', '~~~markdown\n[English](MANUAL.md)\n~~~', '`[English](MANUAL.md)`', '    [English](MANUAL.md)', '<!-- [English](MANUAL.md) -->']) {
    writeFileSync(join(root, 'docs/MANUAL.ko.md'), `# 한국어\n\n${example}\n`);
    assert.ok(checkDocuments(root).errors.some(error => error === 'Missing language switch in docs/MANUAL.ko.md'), example);
  }
});

test('root README must expose the manual and document catalog', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'README.ko.md'), '# 한국어\n\n[English](README.md)\n');
  const errors = checkDocuments(root).errors;
  assert.ok(errors.includes('Missing entry link in README.ko.md: docs/MANUAL.ko.md'));
  assert.ok(errors.includes('Missing entry link in README.ko.md: docs/README.ko.md'));
});

test('images cannot supply language switches or entry links', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'docs/MANUAL.ko.md'), '# 한국어\n\n![English](MANUAL.md)\n');
  writeFileSync(join(root, 'README.ko.md'), '# 한국어\n\n[English](README.md)\n![Manual](docs/MANUAL.ko.md)\n![Documents](docs/README.ko.md)\n![Missing](docs/MISSING.png)\n');
  const errors = checkDocuments(root).errors;
  assert.ok(errors.includes('Missing language switch in docs/MANUAL.ko.md'));
  assert.ok(errors.includes('Missing entry link in README.ko.md: docs/MANUAL.ko.md'));
  assert.ok(errors.includes('Missing entry link in README.ko.md: docs/README.ko.md'));
  assert.ok(errors.includes('Broken link in README.ko.md: docs/MISSING.png'));
});
