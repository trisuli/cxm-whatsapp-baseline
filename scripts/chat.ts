/**
 * Chat with the bot in your terminal, no WhatsApp needed (uses the same engine and database).
 *   npm run chat
 * Type a message, or a number to tap that button/list option. "/reset" continues as a brand-new patient.
 */
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { pool, q } from '../src/db.js';
import { handleInbound } from '../src/engine/engine.js';
import type { OutMsg } from '../src/whatsapp/messages.js';

let waId = process.env.CHAT_WA_ID ?? `9198${Date.now().toString().slice(-8)}`;
let options: { id: string; title: string }[] = [];

function show(m: OutMsg) {
  const opts: { id: string; title: string }[] = [];
  if (m.kind === 'text') console.log(`\n🏥 ${m.text}`);
  else if (m.kind === 'buttons') { console.log(`\n🏥 ${m.header ? `[${m.header}] ` : ''}${m.text}${m.footer ? `\n   (${m.footer})` : ''}`); opts.push(...m.buttons); }
  else if (m.kind === 'list') { console.log(`\n🏥 ${m.text}  [${m.button}]`); m.sections.forEach((s) => { console.log(`   ${s.title}`); opts.push(...s.rows); }); }
  else if (m.kind === 'location') console.log(`\n📍 ${m.name}, ${m.address}`);
  else if (m.kind === 'flow') console.log(`\n🏥 ${m.text}  [Flow: ${m.cta}]`);
  else if (m.kind === 'template') console.log(`\n🏥 (template ${m.name}) ${m.bodyParams.join(' | ')}`);
  opts.forEach((o) => { options.push(o); console.log(`   ${options.length}. ${o.title}`); });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('Chatting as', waId, '— type "hi" to start, "/reset" to start over, Ctrl+C to quit.');
for (;;) {
  const line = (await rl.question('\n🙂 ')).trim();
  if (line === '/reset') {
    waId = `9198${Date.now().toString().slice(-8)}`;
    console.log('New patient', waId);
    continue;
  }
  const pick = /^\d+$/.test(line) ? options[Number(line) - 1] : undefined;
  options = [];
  const since = new Date();
  await handleInbound({ waId, profileName: 'Terminal Tester', waMessageId: `cli_${randomUUID()}`,
    ...(pick ? { kind: 'reply' as const, replyId: pick.id, replyTitle: pick.title } : { kind: 'text' as const, text: line }) });
  const out = await q<{ body: OutMsg }>(`select body from messages m join conversations c on c.id = m.conversation_id join patients p on p.id = c.patient_id
    where p.wa_id = $1 and m.direction = 'out' and m.created_at >= $2 order by m.created_at`, [waId, since]);
  out.forEach((r) => show(r.body));
}
process.on('exit', () => pool.end());
