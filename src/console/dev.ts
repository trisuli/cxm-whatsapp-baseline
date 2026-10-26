import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { q } from '../db.js';
import { handleInbound } from '../engine/engine.js';
import { runDueReminders } from '../services/scheduler.js';

/**
 * Local simulator (DEV_SIMULATOR=true only): chat as a patient without WhatsApp.
 * It feeds the same handleInbound() the real webhook uses.
 */
export function registerDev(app: FastifyInstance) {
  app.post('/dev/inbound', async (req) => {
    const b = (req.body ?? {}) as { wa_id?: string; name?: string; text?: string; reply_id?: string; reply_title?: string; flow?: Record<string, unknown>; referral?: any };
    const waId = b.wa_id || '919800000001';
    await handleInbound({
      waId, profileName: b.name || 'Test Patient', waMessageId: `sim_${randomUUID()}`, referral: b.referral,
      ...(b.flow ? { kind: 'flow' as const, flowData: b.flow } : b.reply_id ? { kind: 'reply' as const, replyId: b.reply_id, replyTitle: b.reply_title } : { kind: 'text' as const, text: b.text ?? '' }),
    });
    return { ok: true };
  });

  app.get('/dev/messages', async (req) => {
    const { wa_id } = req.query as { wa_id?: string };
    return q(`select m.direction, m.type, m.body, m.status, m.template_name, m.created_at from messages m
      join conversations c on c.id = m.conversation_id join patients p on p.id = c.patient_id
      where p.wa_id = $1 order by m.created_at, m.id limit 300`, [wa_id || '919800000001']);
  });

 app.post('/dev/reset-patient', async (req) => {
    const waId = String((req.body as any)?.wa_id || '919800000001');

    const [p] = await q<{ id: string }>(
      'select id from patients where wa_id = $1',
      [waId]
    );

    if (!p) return { ok: true };

    // Preserve appointment requests and their related records.
    // Delete only conversation-related data.
    

    await q(
      `delete from unanswered_questions
       where conversation_id in (
         select id from conversations where patient_id = $1
       )`,
      [p.id]
    );

    await q(
      `delete from messages
       where conversation_id in (
         select id from conversations where patient_id = $1
       )`,
      [p.id]
    );

    await q(
      'delete from conversations where patient_id = $1',
      [p.id]
    );

    await q(
      'delete from consents where patient_id = $1',
      [p.id]
    );

    return { ok: true };
  });

  app.post('/dev/run-reminders', async () => ({ sent: await runDueReminders() }));
}
