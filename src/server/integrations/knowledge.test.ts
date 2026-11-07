import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanKnowledgeFile, cleanKnowledgeText, KNOWLEDGE_MAX_CHARS } from './knowledge.js';

test('text from a PDF is tidied, not rejected', () => {
  assert.equal(cleanKnowledgeText('  Hours: 8-5\r\n\r\n\r\n\r\nClosed Sunday  \n'), 'Hours: 8-5\n\nClosed Sunday');
  assert.equal(cleanKnowledgeText('Fees\u0000 start\u0008at\u001f $80\u2028ok'), 'Fees  start at  $80 ok');
  assert.equal(cleanKnowledgeText('Tab\tkept and\nnewline kept'), 'Tab\tkept and\nnewline kept');
});

test('anything that is not text becomes an empty knowledge base', () => {
  for (const value of [undefined, null, 42, {}, ['a']]) assert.equal(cleanKnowledgeText(value), '');
});

test('long text is cut to the limit instead of refused', () => {
  assert.equal(cleanKnowledgeText('a'.repeat(KNOWLEDGE_MAX_CHARS + 500)).length, KNOWLEDGE_MAX_CHARS);
  assert.equal(cleanKnowledgeText('abcdef', 3), 'abc');
});

test('file details keep only a safe name, a page count and the stored length', () => {
  assert.deepEqual(cleanKnowledgeFile({ name: 'Price list\u0000.pdf', pages: 4.9 }, 1200), { name: 'Price list .pdf', pages: 4, characters: 1200 });
  assert.equal(cleanKnowledgeFile({ name: 'x'.repeat(500), pages: 1 }, 1)?.name.length, 200);
  assert.equal(cleanKnowledgeFile({ name: 'a.pdf', pages: -5 }, 1)?.pages, 0);
  assert.equal(cleanKnowledgeFile({ name: 'a.pdf', pages: 'many' }, 1)?.pages, 0);
  for (const value of [null, undefined, 'a.pdf', [], { pages: 2 }, { name: '   ' }]) assert.equal(cleanKnowledgeFile(value, 10), null);
});
