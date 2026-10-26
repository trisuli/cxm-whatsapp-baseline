import { one, q } from '../db.js';
import { sendMessage } from '../whatsapp/client.js';
import { text } from '../whatsapp/messages.js';
import { template } from '../templates.js';
import { notifyPatient } from './notify.js';
import type { Conversation } from './patients.js';

export type Handoff = { id: string; conversation_id: string; queue: string; status: 'waiting' | 'replied' | 'resolved'; alert_type: string | null; alert_text: string | null; created_at: string; updated_at: string };

/** Opens (or re-opens) the live chat for a conversation and switches it to human mode. */
export async function openHandoff(conv: Conversation, queue: string, alert?: { type: string; text: string }): Promise<Handoff> {
  conv.mode = 'human';
  const existing = await one<Handoff>(`select * from handoffs where conversation_id = $1 and status <> 'resolved' order by created_at desc limit 1`, [conv.id]);
  if (existing) {
    return (await one<Handoff>(`update handoffs set queue = $2, status = 'waiting', alert_type = coalesce($3, alert_type), alert_text = coalesce($4, alert_text), updated_at = now() where id = $1 returning *`,
      [existing.id, queue, alert?.type ?? null, alert?.text ?? null]))!;
  }
  return (await one<Handoff>(`insert into handoffs (conversation_id, queue, alert_type, alert_text) values ($1, $2, $3, $4) returning *`,
    [conv.id, queue, alert?.type ?? null, alert?.text ?? null]))!;
}

export async function touchHandoff(conversationId: string) {
  await q(`update handoffs set status = 'waiting', updated_at = now() where conversation_id = $1 and status <> 'resolved'`, [conversationId]);
}

export const listHandoffs = () => q(
  `select h.*, coalesce(p.name, p.profile_name, p.wa_id) as patient_name, p.wa_id,
     (select body from messages m where m.conversation_id = h.conversation_id order by created_at desc limit 1) as last_message
   from handoffs h
   join conversations c on c.id = h.conversation_id
   join patients p on p.id = c.patient_id
   where h.id = (
     select h2.id
     from handoffs h2
     where h2.conversation_id = h.conversation_id
     order by h2.updated_at desc, h2.created_at desc
     limit 1
   )
   order by (h.status = 'resolved'), (h.alert_type is null), h.updated_at desc
   limit 100`);
export async function getHandoff(id: string) {
  const h = await one(`select h.*, c.patient_id, coalesce(p.name, p.profile_name, p.wa_id) as patient_name, p.wa_id from handoffs h
    join conversations c on c.id = h.conversation_id join patients p on p.id = c.patient_id where h.id = $1`, [id]);
  if (!h) return undefined;
  const messages = await q(`select direction, type, body, status, template_name, created_at from messages where conversation_id = $1 order by created_at desc limit 40`, [h.conversation_id]);
  return { ...h, messages: messages.reverse() };
}

export async function staffReply(id: string, staffName: string, body: string) {
  const h = await getHandoff(id);
  if (!h) throw new Error('Chat not found');
  const delivery = await notifyPatient(h.patient_id, [text(`*${staffName} (care team):* ${body}`)], [template('care_team_reply', [h.queue.toLowerCase()], ['human'])]);
  await q(`update handoffs set status = 'replied', updated_at = now() where id = $1`, [id]);
  await q(`update conversations set mode = 'human' where id = $1`, [h.conversation_id]);
  return delivery;
}

export async function resolveHandoff(id: string, staffName: string) {
  const h = await getHandoff(id);
  if (!h) throw new Error('Chat not found');
  await q(`update handoffs set status = 'resolved', updated_at = now() where id = $1`, [id]);
  await q(`update conversations set mode = 'bot' where id = $1`, [h.conversation_id]);
  await notifyPatient(h.patient_id, [text(`${staffName} has closed this chat. The assistant is back: type *menu* anytime.`)], []);
}

export { sendMessage };
