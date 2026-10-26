import { randomUUID } from 'node:crypto';
import { q } from '../src/db.js';
import { handleInbound } from '../src/engine/engine.js';
import type { OutMsg } from '../src/whatsapp/messages.js';

export const newWaId = () => `9177${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;

export const say = (waId: string, text: string) =>
  handleInbound({ waId, profileName: 'Test Patient', waMessageId: `t_${randomUUID()}`, kind: 'text', text });

export const tap = (waId: string, replyId: string) =>
  handleInbound({ waId, profileName: 'Test Patient', waMessageId: `t_${randomUUID()}`, kind: 'reply', replyId });

/** All option ids offered in a set of messages (buttons and list rows). */
export const optionIds = (msgs: OutMsg[]) => msgs.flatMap((m) => (m.kind === 'buttons' ? m.buttons.map((b) => b.id) : m.kind === 'list' ? m.sections.flatMap((s) => s.rows.map((r) => r.id)) : []));

export const allText = (msgs: OutMsg[]) => msgs.map((m) => ('text' in m ? m.text : m.kind === 'template' ? `${m.name} ${m.bodyParams.join(' ')}` : '')).join('\n');

export async function outbox(waId: string, since: Date): Promise<OutMsg[]> {
  const rows = await q<{ body: OutMsg }>(`select m.body from messages m join conversations c on c.id = m.conversation_id join patients p on p.id = c.patient_id
    where p.wa_id = $1 and m.direction = 'out' and m.created_at >= $2 order by m.created_at`, [waId, since]);
  return rows.map((r) => r.body);
}

export async function consentedPatient(): Promise<string> {
  const waId = newWaId();
  await say(waId, 'hi');
  await tap(waId, 'consent:yes');
  return waId;
}
