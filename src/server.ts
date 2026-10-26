import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { handleInbound } from './engine/engine.js';
import { registerConsole } from './console/routes.js';
import { registerDev } from './console/dev.js';
import { startScheduler } from './services/scheduler.js';
import { registerWebhook } from './whatsapp/webhook.js';

export async function buildApp() {
  // Logs never include request bodies: they contain patient messages.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } });

  // Keep the raw body: the webhook signature is computed over the exact bytes Meta sent.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (err) { done(err as Error, undefined); }
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(fastifyStatic, { root: path.resolve('public'), index: ['console.html'] });

  app.get('/health', async () => { await pool.query('select 1'); return { ok: true }; });
  registerWebhook(app, async (ev) => { await handleInbound(ev); });
  registerConsole(app);
  if (config.DEV_SIMULATOR) registerDev(app);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.ts')) {
  const app = await buildApp();
  await migrate();
  startScheduler((msg, err) => app.log.error({ err }, msg));
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`CXM WhatsApp running. Console: http://localhost:${config.PORT}  Dry run: ${config.WA_DRY_RUN}  Simulator: ${config.DEV_SIMULATOR}`);
}
