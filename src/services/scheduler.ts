import { q } from '../db.js';
import { sendReminder, type Request } from './requests.js';

/**
 * Sends due reminders. Runs every 30 seconds inside the web process.
 * `for update skip locked` makes it safe to run more than one server.
 */
export async function runDueReminders(log: (msg: string, err?: unknown) => void = console.log): Promise<number> {
  const due = await q<{ id: string; kind: 'reminder_24h' | 'reminder_3h'; request_id: string }>(
    `update scheduled_messages set status = 'sending'
     where id in (select id from scheduled_messages where status = 'pending' and send_at <= now() order by send_at limit 25 for update skip locked)
     returning id, kind, request_id`);
  for (const job of due) {
    try {
      const [r] = await q<Request>('select * from appointment_requests where id = $1', [job.request_id]);
      const result = await sendReminder(r, job.kind);
      await q(`update scheduled_messages set status = 'sent' where id = $1`, [job.id]);
      await q(`insert into request_events (request_id, actor, action, details) values ($1, 'system', $2, $3)`, [job.request_id, job.kind, String(result)]);
    } catch (err) {
      await q(`update scheduled_messages set status = 'failed' where id = $1`, [job.id]);
      log(`reminder ${job.id} failed`, err);
    }
  }
  return due.length;
}

export function startScheduler(log: (msg: string, err?: unknown) => void, everyMs = 30_000) {
  const timer = setInterval(() => { runDueReminders(log).catch((err) => log('scheduler error', err)); }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
