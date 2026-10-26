import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { q } from '../db.js';
import { OutMsg, toPayload, validate } from './messages.js';

const graph = (path: string) => `https://graph.facebook.com/${config.WA_API_VERSION}/${path}`;

async function callGraph(path: string, body: unknown): Promise<any> {
  const res = await fetch(graph(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error;
    throw new Error(`Graph API ${res.status}: ${e?.message ?? 'unknown error'} (code ${e?.code ?? '?'}${e?.error_data?.details ? `, ${e.error_data.details}` : ''})`);
  }
  return json;
}

/**
 * Sends one message and stores it in `messages`.
 * With WA_DRY_RUN=true nothing goes to Meta: the message is stored with status "simulated".
 */
export async function sendMessage(waId: string, conversationId: string | null, msg: OutMsg): Promise<void> {
  validate(msg);
  const template = msg.kind === 'template' ? msg.name : null;
  if (config.WA_DRY_RUN) {
    await q(`insert into messages (conversation_id, direction, wa_message_id, type, body, status, template_name)
             values ($1, 'out', $2, $3, $4, 'simulated', $5)`, [conversationId, `dry_${randomUUID()}`, msg.kind, msg, template]);
    return;
  }
  try {
    const res = await callGraph(`${config.WA_PHONE_NUMBER_ID}/messages`, toPayload(waId, msg));
    await q(`insert into messages (conversation_id, direction, wa_message_id, type, body, status, template_name)
             values ($1, 'out', $2, $3, $4, 'sent', $5)`, [conversationId, res.messages?.[0]?.id ?? null, msg.kind, msg, template]);
  } catch (err) {
    await q(`insert into messages (conversation_id, direction, type, body, status, template_name, error)
             values ($1, 'out', $2, $3, 'failed', $4, $5)`, [conversationId, msg.kind, msg, template, String(err)]);
    throw err;
  }
}

/** Blue ticks for the patient. Errors are ignored: this is cosmetic. */
export async function markRead(waMessageId: string): Promise<void> {
  if (config.WA_DRY_RUN) return;
  await callGraph(`${config.WA_PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId }).catch(() => {});
}

export { callGraph };
