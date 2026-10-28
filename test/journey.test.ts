import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, q } from '../src/db.js';
import { confirm, getRequest, markNoShow, offer } from '../src/services/requests.js';
import { runDueReminders } from '../src/services/scheduler.js';
import { allText, consentedPatient, newWaId, optionIds, outbox, say, tap } from './helpers.js';

after(() => pool.end());

test('first message gets welcome + consent, then the original question is answered', async () => {
  const waId = newWaId();
  const first = await say(waId, 'Hi, what are your OPD timings? (ref: GBP)');
  assert.match(allText(first), /Welcome to/);
  assert.deepEqual(optionIds(first), ['consent:yes', 'consent:no']);
  const after = await tap(waId, 'consent:yes');
  assert.match(allText(after), /Mon–Sat, 8 am–8 pm/);
  const [conv] = await q(`select c.source from conversations c join patients p on p.id = c.patient_id where p.wa_id = $1`, [waId]);
  assert.equal(conv.source, 'GBP');
});

test('symptom → speciality → doctor cards', async () => {
  const waId = await consentedPatient();
  const out = await say(waId, 'I have knee pain');
  assert.match(allText(out), /Orthopaedics/);
  assert.ok(optionIds(out).includes('book:d.d1'));
});

test('guardrails: emergency opens an alert, medical advice is refused, unknown is logged', async () => {
  const waId = await consentedPatient();
  const e = await say(waId, 'my father has chest pain');
  assert.match(allText(e), /call 108/);
  const [h] = await q(`select h.alert_type from handoffs h join conversations c on c.id = h.conversation_id join patients p on p.id = c.patient_id where p.wa_id = $1`, [waId]);
  assert.equal(h.alert_type, 'emergency');
  await tap(waId, 'notemerg');
  assert.match(allText(await say(waId, 'which tablet for fever')), /can’t give medical advice/);
  assert.match(allText(await say(waId, 'robotic surgery cost')), /approved answer/);
});

test('full L0 journey: book in chat, staff offer + confirm, reminders, no-show rebook', async () => {
  const waId = await consentedPatient();
  let out = await tap(waId, 'book:d.d1');
  const dateId = optionIds(out)[0];
  assert.match(dateId, /^bd:d\.d1:\d{4}-\d\d-\d\d$/);
  out = await tap(waId, dateId);                     // Dr. Rao has one window, so we go straight to "who"
  assert.deepEqual(optionIds(out), ['bwho:me', 'bwho:other']);
  await tap(waId, 'bwho:me');
  out = await say(waId, 'Ravi Kumar');
  assert.match(allText(out), /age/);
  out = await say(waId, '42');
  await tap(waId, 'bg:M');
  out = await say(waId, 'Knee pain for 2 weeks');
  assert.match(allText(out), /Please check your request[\s\S]*Ravi Kumar, 42, Male/);
  out = await tap(waId, 'bok');
  const ref = allText(out).match(/SNR-\d+/)![0];
  let r = (await getRequest(ref))!;
  assert.equal(r.status, 'new');
  assert.equal(r.reason, 'Knee pain for 2 weeks');

  // Staff offer another time, patient accepts
  let since = new Date();
  const offered = await offer(ref, '11:30', 'Priya');
  assert.equal(offered.delivery, 'sent');
  assert.ok(optionIds(await outbox(waId, since)).includes(`altok:${ref}`));
  since = new Date();
  await tap(waId, `altok:${ref}`);
  r = (await getRequest(ref))!;
  assert.equal(r.status, 'confirmed');
  assert.equal(r.slot_time, '11:30');
  assert.match(allText(await outbox(waId, since)), /Appointment confirmed[\s\S]*11:30 am[\s\S]*Before your visit/);

  // Reminders were scheduled; force them due and run the scheduler
  const reminders = await q(`select kind from scheduled_messages where request_id = $1 and status = 'pending' order by send_at`, [r.id]);
  assert.ok(reminders.length >= 1);
  await q(`update scheduled_messages set send_at = now() - interval '1 minute' where request_id = $1 and status = 'pending'`, [r.id]);
  since = new Date();
  assert.ok((await runDueReminders(() => {})) >= 1);
  assert.match(allText(await outbox(waId, since)), /Reminder|See you today/);

  // Patient confirms, then does not turn up
  await tap(waId, `rconf:${ref}`);
  assert.equal((await getRequest(ref))!.patient_confirmed, true);
  since = new Date();
  await markNoShow(ref, 'Priya');
  assert.ok(optionIds(await outbox(waId, since)).includes('book:d.d1'));
});

test('outside the 24-hour window, staff confirmation goes out as a template', async () => {
  const waId = await consentedPatient();
  await tap(waId, optionIds(await tap(waId, 'book:d.d3'))[0]);
  await tap(waId, 'bwho:other');
  await say(waId, 'Meena Sharma'); await say(waId, '54'); await tap(waId, 'bg:F'); await tap(waId, 'brs');
  const ref = allText(await tap(waId, 'bok')).match(/SNR-\d+/)![0];
 await q(
  `update conversations
   set last_inbound_at = now() - interval '25 hours'
   where patient_id = (select id from patients where wa_id = $1)
   returning id, last_inbound_at`,
  [waId]
);
  const since = new Date();
  const res = await confirm(ref, '09:30', 'Priya');
  assert.equal(res.delivery, 'template');
  const sent = await outbox(waId, since);
  assert.deepEqual(sent.map((m) => (m.kind === 'template' ? m.name : m.kind)), ['appointment_confirmation', 'visit_preparation']);
});

test('reschedule and cancel from WhatsApp', async () => {
  const waId = await consentedPatient();
  const dates = optionIds(await tap(waId, 'book:p.p2'));
  await tap(waId, dates[0]); await tap(waId, 'bwho:me'); await say(waId, 'Suresh Babu'); await say(waId, '62'); await tap(waId, 'bg:M'); await tap(waId, 'brs');
  const ref = allText(await tap(waId, 'bok')).match(/SNR-\d+/)![0];
  await confirm(ref, '09:00', 'Priya');
  const newDates = optionIds(await tap(waId, `resched:${ref}`));
  await tap(waId, newDates[1]);
  assert.match(allText(await tap(waId, 'bok')), /move/);
  assert.equal((await getRequest(ref))!.status, 'reschedule_requested');
  assert.equal((await q(`select count(*)::int as n from scheduled_messages where request_id = (select id from appointment_requests where ref = $1) and status = 'pending'`, [ref]))[0].n, 0);
  await tap(waId, `cancel:${ref}`);
  assert.match(allText(await tap(waId, `cx:${ref}:better`)), /cancelled/);
  assert.equal((await getRequest(ref))!.status, 'cancelled');
});

test('every message the bot sends passes WhatsApp limits', async () => {
  // sendMessage() validates before storing, so a stored message is a valid one. Walk the main menu to exercise each branch.
  const waId = await consentedPatient();
  for (const id of ['menu', 'find', 'fspec', 'spec:obg', 'prof:d5', 'pkgs', 'pkg:p1', 'ins', 'loc', 'faq', 'faqa:f7', 'mine', 'human']) await tap(waId, id);
  const [{ n }] = await q(`select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id join patients p on p.id = c.patient_id where p.wa_id = $1 and direction = 'out'`, [waId]);
  assert.ok(n > 20);
});

test('STOP silences the bot until START', async () => {
  const waId = await consentedPatient();
  assert.match(allText(await say(waId, 'STOP')), /won’t get any more messages/);
  assert.equal((await say(waId, 'hi')).length, 0);
  assert.match(allText(await say(waId, 'START')), /Welcome back/);
});
