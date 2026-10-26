import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { q } from '../db.js';

/** A patient message, normalised from the webhook payload. */
export type Inbound = {
  waId: string;
  profileName: string | null;
  waMessageId: string;
  kind: 'text' | 'reply' | 'flow' | 'unsupported';
  text?: string;          // kind=text
  replyId?: string;       // kind=reply: button, list row or template quick-reply payload
  replyTitle?: string;
  flowData?: Record<string, any>; // kind=flow: the Flow's response_json
  referral?: { headline?: string; source_url?: string; source_type?: string; source_id?: string };
};

export function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function parseWebhook(body: any): { inbound: Inbound[]; statuses: { id: string; status: string; error?: string }[] } {
  const inbound: Inbound[] = [];
  const statuses: { id: string; status: string; error?: string }[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        const ev: Inbound = { waId: m.from, profileName: names.get(m.from) ?? null, waMessageId: m.id, kind: 'unsupported', referral: m.referral };
        if (m.type === 'text') Object.assign(ev, { kind: 'text', text: m.text?.body ?? '' });
        else if (m.type === 'button') Object.assign(ev, { kind: 'reply', replyId: m.button?.payload, replyTitle: m.button?.text });
        else if (m.type === 'interactive') {
          const i = m.interactive ?? {};
          if (i.type === 'button_reply') Object.assign(ev, { kind: 'reply', replyId: i.button_reply.id, replyTitle: i.button_reply.title });
          else if (i.type === 'list_reply') Object.assign(ev, { kind: 'reply', replyId: i.list_reply.id, replyTitle: i.list_reply.title });
          else if (i.type === 'nfm_reply') {
            let data: Record<string, any> = {};
            try { data = JSON.parse(i.nfm_reply?.response_json ?? '{}'); } catch { /* keep empty */ }
            Object.assign(ev, { kind: 'flow', flowData: data });
          }
        }
        inbound.push(ev);
      }
      for (const s of v.statuses ?? []) statuses.push({ id: s.id, status: s.status, error: s.errors?.[0]?.title });
    }
  }
  return { inbound, statuses };
}

export function registerWebhook(app: FastifyInstance, onInbound: (ev: Inbound) => Promise<void>) {
  // Meta calls this once when you save the webhook URL in the app dashboard.
  app.get('/webhook', async (req, reply) => {
    const qs = req.query as Record<string, string>;
    if (qs['hub.mode'] === 'subscribe' && qs['hub.verify_token'] === config.WA_VERIFY_TOKEN) return reply.type('text/plain').send(qs['hub.challenge']);
    return reply.code(403).send('Verification failed');
  });

  app.post('/webhook', async (req, reply) => {
    const raw = (req as any).rawBody as string;
    if (
  !config.WA_APP_SECRET ||
  !verifySignature(
    raw,
    req.headers['x-hub-signature-256'] as string | undefined,
    config.WA_APP_SECRET
  )
) {
  req.log.warn('webhook signature missing, invalid, or secret not configured');
  return reply.code(401).send();
}
    // Answer Meta at once; handle the events after. Meta retries slow or failed webhooks.
    reply.code(200).send();
    const { inbound, statuses } = parseWebhook(req.body);
    for (const s of statuses) {
      await q('update messages set status = $2, error = coalesce($3, error) where wa_message_id = $1', [s.id, s.status, s.error ?? null]).catch((e) => req.log.error(e));
    }
    for (const ev of inbound) {
      // One patient at a time in order. For high volume, move this into a job queue.
      await onInbound(ev).catch((err) => req.log.error({ err, wa: ev.waMessageId }, 'inbound handling failed'));
    }
  });
}
