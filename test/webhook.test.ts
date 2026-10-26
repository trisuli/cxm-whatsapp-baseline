import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseWebhook, verifySignature } from '../src/whatsapp/webhook.js';
import { toPayload, validate } from '../src/whatsapp/messages.js';

test('signature check', () => {
  const body = '{"a":1}';
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.ok(verifySignature(body, sig, 's3cret'));
  assert.ok(!verifySignature(body, sig, 'other'));
  assert.ok(!verifySignature(body, undefined, 's3cret'));
});

test('parses text, button, list, template quick reply, flow and status events', () => {
  const value = {
    contacts: [{ wa_id: '911', profile: { name: 'Asha' } }],
    messages: [
      { from: '911', id: 'm1', type: 'text', text: { body: 'hi' } },
      { from: '911', id: 'm2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'consent:yes', title: 'I agree' } } },
      { from: '911', id: 'm3', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'find', title: 'Find a doctor' } } },
      { from: '911', id: 'm4', type: 'button', button: { payload: 'rconf:SNR-1', text: 'Yes' } },
      { from: '911', id: 'm5', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"flow_token":"book:x:d.d1","date":"2026-10-14"}' } } },
      { from: '911', id: 'm6', type: 'image', image: {} },
    ],
    statuses: [{ id: 'out1', status: 'delivered' }],
  };
  const { inbound, statuses } = parseWebhook({ entry: [{ changes: [{ value }] }] });
  assert.deepEqual(inbound.map((e) => e.kind), ['text', 'reply', 'reply', 'reply', 'flow', 'unsupported']);
  assert.equal(inbound[0].profileName, 'Asha');
  assert.equal(inbound[3].replyId, 'rconf:SNR-1');
  assert.equal(inbound[4].flowData?.date, '2026-10-14');
  assert.deepEqual(statuses, [{ id: 'out1', status: 'delivered', error: undefined }]);
});

test('message limits are enforced', () => {
  assert.throws(() => validate({ kind: 'buttons', text: 'x', buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: 'ok' })) }));
  assert.throws(() => validate({ kind: 'buttons', text: 'x', buttons: [{ id: 'a', title: 'This title is far too long' }] }));
  assert.throws(() => validate({ kind: 'list', text: 'x', button: 'go', sections: [{ title: 's', rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: 'r' })) }] }));
  const p: any = toPayload('911', { kind: 'template', name: 't', language: 'en', bodyParams: ['A'], buttonPayloads: ['x'] });
  assert.equal(p.template.components[1].parameters[0].payload, 'x');
});
