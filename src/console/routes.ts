import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { content, service, serviceIdOf } from '../engine/content.js';
import { getHandoff, listHandoffs, resolveHandoff, staffReply } from '../services/handoffs.js';
import { erasePatient } from '../services/patients.js';
import {
  cancelByStaff, confirm, getRequest, markArrived, markNoShow, offer, RequestError, sendReminder, slotOptions,
} from '../services/requests.js';
import { checkPassword, requireStaff, sessionToken, type Staff } from './auth.js';

const staffOf = (req: FastifyRequest) => (req as any).staff as Staff;

const DELIVERY_NOTE: Record<string, string> = {
  sent: 'Sent to the patient on WhatsApp.',
  template: 'The patient’s 24-hour window was closed, so the approved template was sent instead.',
  skipped_window: 'Not sent: the patient’s 24-hour window is closed and there is no template for this. Call the patient.',
  skipped_opt_out: 'Not sent: the patient has opted out of WhatsApp messages. Call the patient.',
  none: 'Saved.',
  skipped: 'Nothing to send.',
};

export function registerConsole(app: FastifyInstance) {
  // 10 attempts per IP per 15 minutes slows down password guessing.
  app.post('/api/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const row = await one<Staff & { password_hash: string }>('select * from staff_users where lower(email) = lower($1)', [email ?? '']);
    if (!row || !password || !checkPassword(password, row.password_hash)) return reply.code(401).send({ error: 'Email or password is wrong' });
    reply.setCookie('cxm_session', sessionToken(row.id), { path: '/', httpOnly: true, sameSite: 'strict', secure: !config.DEV_SIMULATOR, maxAge: 12 * 3600 });
    return { name: row.name, role: row.role };
  });

  app.post('/api/logout', async (_req, reply) => { reply.clearCookie('cxm_session', { path: '/' }); return { ok: true }; });

  app.register(async (api) => {
    api.addHook('preHandler', requireStaff());

    api.get('/api/me', async (req) => ({ ...staffOf(req), simulator: config.DEV_SIMULATOR, dryRun: config.WA_DRY_RUN, slaMinutes: config.CONFIRM_SLA_MINUTES }));

    // ----- appointment requests
    api.get('/api/requests', async (req) => {
      const { status } = req.query as { status?: string };
      const where = status === 'open' ? `where status in ('new','reschedule_requested','awaiting_patient')` : status ? `where status = $1` : '';
      const rows = await q(`select r.*, p.wa_id from appointment_requests r join patients p on p.id = r.patient_id ${where}
        order by (status in ('new','reschedule_requested')) desc, created_at desc limit 200`, status && status !== 'open' ? [status] : []);
      const c = await content();
      return rows.map((r: any) => ({ ...r, service: service(c, serviceIdOf(r))?.label ?? '?', wa_id: mask(r.wa_id) }));
    });

    api.get('/api/requests/:ref', async (req, reply) => {
      const r = await getRequest((req.params as any).ref);
      if (!r) return reply.code(404).send({ error: 'Not found' });
      const s = service(await content(), serviceIdOf(r));
      const [p] = await q('select wa_id from patients where id = $1', [r.patient_id]);
      const events = await q('select actor, action, details, at from request_events where request_id = $1 order by at', [r.id]);
      const reminders = await q('select kind, send_at, status from scheduled_messages where request_id = $1 order by send_at', [r.id]);
      return { ...r, wa_id: p.wa_id, service: s, slots: s ? slotOptions(r, s) : null, events, reminders };
    });

    const action = (path: string, fn: (ref: string, body: any, staff: Staff) => Promise<{ delivery: string }>) =>
      api.post(`/api/requests/:ref/${path}`, async (req, reply) => {
        try {
          const result = await fn((req.params as any).ref, req.body ?? {}, staffOf(req));
          return { ...result, note: DELIVERY_NOTE[result.delivery] ?? result.delivery };
        } catch (err) {
          if (err instanceof RequestError) return reply.code(409).send({ error: err.message });
          throw err;
        }
      });
    action('confirm', (ref, b, s) => confirm(ref, String(b.slot), s.name));
    action('offer', (ref, b, s) => offer(ref, String(b.slot), s.name));
    action('cancel', (ref, b, s) => cancelByStaff(ref, s.name, b.reason || undefined));
    action('arrived', (ref, _b, s) => markArrived(ref, s.name));
    action('no-show', (ref, _b, s) => markNoShow(ref, s.name));
    // Sends a reminder now. Useful for testing and when a patient asks "when is my appointment?"
    action('remind', async (ref, b) => {
      const r = await getRequest(ref);
      if (!r) throw new RequestError('Not found');
      return { delivery: await sendReminder(r, b.kind === 'reminder_3h' ? 'reminder_3h' : 'reminder_24h') };
    });

    // ----- live chats
    api.get('/api/chats', async () => (await listHandoffs()).map((h: any) => ({ ...h, wa_id: mask(h.wa_id) })));
    api.get('/api/chats/:id', async (req, reply) => (await getHandoff((req.params as any).id)) ?? reply.code(404).send({ error: 'Not found' }));
    api.post('/api/chats/:id/reply', async (req) => {
      const delivery = await staffReply((req.params as any).id, staffOf(req).name, String((req.body as any)?.text ?? '').slice(0, 1000));
      return { delivery, note: delivery === 'template' ? 'The patient’s 24-hour window was closed, so we sent a nudge template. Send your reply again when they answer.' : DELIVERY_NOTE[delivery] };
    });
    api.post('/api/chats/:id/resolve', async (req) => { await resolveHandoff((req.params as any).id, staffOf(req).name); return { ok: true }; });

    // ----- metrics
    api.get('/api/metrics', async () => {
      const days = 30;
      const [totals] = await q(`select
          (select count(*) from conversations where created_at > now() - interval '${days} days') as conversations,
          (select count(*) from appointment_requests where created_at > now() - interval '${days} days') as requests,
          (select count(*) from appointment_requests where status in ('confirmed','arrived','no_show') and created_at > now() - interval '${days} days') as confirmed,
          (select count(*) from appointment_requests where status = 'arrived' and created_at > now() - interval '${days} days') as arrived,
          (select count(*) from appointment_requests where status = 'no_show' and created_at > now() - interval '${days} days') as no_show,
          (select count(*) from handoffs where created_at > now() - interval '${days} days') as handoffs,
          (select percentile_cont(0.5) within group (order by extract(epoch from e.at - r.created_at) / 60)
             from request_events e join appointment_requests r on r.id = e.request_id where e.action = 'confirmed' and e.at > now() - interval '${days} days') as median_confirm_minutes`);
      const sources = await q(`select coalesce(source, 'Direct') as source, count(*)::int as n from conversations where created_at > now() - interval '${days} days' group by 1 order by 2 desc`);
      const unanswered = await q(`select text, count(*)::int as n from unanswered_questions where not resolved group by text order by 2 desc limit 20`);
      return { days, totals, sources, unanswered };
    });

    // ----- DPDP erasure (admins only)
    api.post('/api/patients/erase', { preHandler: requireStaff('admin') }, async (req, reply) => {
      const waId = String((req.body as any)?.wa_id ?? '');
      const p = await one<{ id: string }>('select id from patients where wa_id = $1', [waId]);
      if (!p) return reply.code(404).send({ error: 'No patient with that WhatsApp number' });
      await erasePatient(p.id);
      return { ok: true };
    });
  });
}

/** Phone numbers are masked in lists; the full number shows only on the open request. */
const mask = (waId: string) => (waId?.length > 6 ? `${waId.slice(0, 4)}•••••${waId.slice(-2)}` : waId);
