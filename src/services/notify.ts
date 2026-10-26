import { one } from '../db.js';
import { sendMessage } from '../whatsapp/client.js';
import type { OutMsg } from '../whatsapp/messages.js';
import { windowOpen, type Conversation, type Patient } from './patients.js';

/**
 * Sends business-started messages (confirmations, reminders, staff replies).
 * Inside the 24-hour window the free interactive versions go out. Outside it only the approved template can.
 * Returns what happened so the caller can tell staff.
 */
export async function notifyPatient(patientId: string, interactive: OutMsg[], templates: OutMsg[]): Promise<'sent' | 'template' | 'skipped_opt_out' | 'skipped_window'> {
  const p = (await one<Patient & Conversation & { conversation_id: string }>(
    `select p.*, c.id as conversation_id, c.last_inbound_at from patients p join conversations c on c.patient_id = p.id where p.id = $1`, [patientId]))!;
  if (p.opted_out) return 'skipped_opt_out';
  if (windowOpen(p)) {
    for (const m of interactive) await sendMessage(p.wa_id, p.conversation_id, m);
    return 'sent';
  }
  if (!templates.length) return 'skipped_window';
  for (const t of templates) await sendMessage(p.wa_id, p.conversation_id, t);
  return 'template';
}
