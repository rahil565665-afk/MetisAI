import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentMessage, parseClientMessage } from './voiceProtocol.js';

test('client messages: only approval responses and end are accepted', () => {
  assert.deepEqual(parseClientMessage('{"type":"end"}'), { type: 'end' });
  assert.deepEqual(parseClientMessage('{"type":"approval_response","approvalId":"a1","approved":true}'), { type: 'approval_response', approvalId: 'a1', approved: true });
  assert.equal(parseClientMessage('{"type":"approval_response","approvalId":"a1","approved":"yes"}'), null);
  assert.equal(parseClientMessage('{"type":"approval_response","approved":true}'), null);
  assert.equal(parseClientMessage(`{"type":"approval_response","approvalId":"${'x'.repeat(200)}","approved":true}`), null);
  assert.equal(parseClientMessage('{"type":"anything-else"}'), null);
  assert.equal(parseClientMessage('[1,2]'), null);
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage(`{"type":"end","pad":"${'x'.repeat(70_000)}"}`), null);
});

test('agent messages are validated field by field', () => {
  assert.deepEqual(parseAgentMessage('{"type":"ready"}'), { type: 'ready' });
  assert.deepEqual(parseAgentMessage('{"type":"transcript","role":"user","text":"hi","final":false}'), { type: 'transcript', role: 'user', text: 'hi', final: false });
  assert.equal(parseAgentMessage('{"type":"transcript","role":"system","text":"hi","final":false}'), null);
  assert.equal(parseAgentMessage('{"type":"transcript","role":"user","text":"hi"}'), null);
  assert.deepEqual(parseAgentMessage('{"type":"ended","reason":"idle"}'), { type: 'ended', reason: 'idle' });
  assert.equal(parseAgentMessage('{"type":"ended","reason":"because"}'), null);
  assert.deepEqual(parseAgentMessage('{"type":"error","message":"boom"}'), { type: 'error', message: 'boom' });
  assert.equal(parseAgentMessage('{"type":"error"}'), null);
});

test('approval requests stringify summary values and reject unknown operations', () => {
  const parsed = parseAgentMessage('{"type":"approval_request","approvalId":"a","operation":"cancel_booking","summary":{"n":5,"s":"x"},"expiresInSeconds":60}');
  assert.deepEqual(parsed, { type: 'approval_request', approvalId: 'a', operation: 'cancel_booking', summary: { n: '5', s: 'x' }, expiresInSeconds: 60 });
  assert.equal(parseAgentMessage('{"type":"approval_request","approvalId":"a","operation":"drop_tables","summary":{},"expiresInSeconds":60}'), null);
  assert.equal(parseAgentMessage('{"type":"approval_request","approvalId":"a","operation":"cancel_booking","summary":null}'), null);
});
