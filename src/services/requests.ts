import { config } from '../config.js';
import { one, q } from '../db.js';
import { content, rupee, service, serviceIdOf, type Service } from '../engine/content.js';
import { template } from '../templates.js';
import { appointmentAt, dayLabel, slotsFor, t12, windowLabel, WINDOWS } from '../time.js';
import { buttons, text, type OutMsg } from '../whatsapp/messages.js';
import { notifyPatient } from './notify.js';

export type Request = {
  id: string; ref: string; patient_id: string; doctor_id: string | null; package_id: string | null;
  preferred_date: string; time_window: string; slot_time: string | null; appointment_at: string | null; offered_slot: string | null;
  status: 'new' | 'awaiting_patient' | 'reschedule_requested' | 'confirmed' | 'arrived' | 'no_show' | 'cancelled';
  patient_confirmed: boolean; patient_name: string; patient_age: number | null; patient_gender: string | null;
  for_other: boolean; visit_type: string; uhid: string | null; reason: string | null; source: string | null;
  created_at: string; updated_at: string;
};

export class RequestError extends Error {}

export async function nextRef(): Promise<string> {
  const r = await one<{ n: string }>(`select nextval('request_ref_seq') as n`);
  return `${config.REF_PREFIX}-${r!.n}`;
}

export async function logEvent(requestId: string, actor: string, action: string, details?: string) {
  await q('insert into request_events (request_id, actor, action, details) values ($1, $2, $3, $4)', [requestId, actor, action, details ?? null]);
}

export async function createRequest(input: {
  patientId: string; serviceId: string; date: string; window: string; name: string; age: number | null; gender: string | null;
  forOther: boolean; visitType?: string; uhid?: string | null; reason?: string | null; source?: string | null;
}): Promise<Request> {
  const [kind, key] = input.serviceId.split('.');
  const r = (await one<Request>(
    `insert into appointment_requests (ref, patient_id, doctor_id, package_id, preferred_date, time_window, patient_name, patient_age, patient_gender, for_other, visit_type, uhid, reason, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [await nextRef(), input.patientId, kind === 'd' ? key : null, kind === 'p' ? key : null, input.date, input.window, input.name, input.age, input.gender,
      input.forOther, input.visitType ?? 'new', input.uhid ?? null, input.reason ?? null, input.source ?? null]))!;
  await logEvent(r.id, 'patient', 'requested', `${dayLabel(input.date)}, ${WINDOWS[input.window].name.toLowerCase()}`);
  return r;
}

export const getRequest = (ref: string) => one<Request>('select * from appointment_requests where ref = $1', [ref]);

async function mustGet(ref: string): Promise<{ r: Request; s: Service }> {
  const r = await getRequest(ref);
  if (!r) throw new RequestError(`No request ${ref}`);
  const s = service(await content(), serviceIdOf(r));
  if (!s) throw new RequestError(`Service for ${ref} no longer exists`);
  return { r, s };
}

async function update(r: Request, fields: Partial<Request>): Promise<Request> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  return (await one<Request>(`update appointment_requests set ${sets}, updated_at = now() where id = $1 returning *`, [r.id, ...keys.map((k) => (fields as any)[k])]))!;
}

const when = (r: Request) => `${dayLabel(r.preferred_date)}, ${t12(r.slot_time!)}`;
const OPEN: Request['status'][] = ['new', 'awaiting_patient', 'reschedule_requested'];

export function slotOptions(r: Request, s: Service) {
  return { preferred: slotsFor([r.time_window]), all: slotsFor(s.windows) };
}

// ---------- staff actions ----------

export async function confirm(ref: string, slot: string, staff: string) {
  const { r, s } = await mustGet(ref);
  if (!OPEN.includes(r.status)) throw new RequestError(`${ref} is ${r.status}; only open requests can be confirmed`);
  if (!slotsFor(s.windows).includes(slot)) throw new RequestError(`${slot} is outside ${s.name}'s OPD hours`);
  const updated = await update(r, { status: 'confirmed', slot_time: slot, appointment_at: appointmentAt(r.preferred_date, slot).toISOString(), offered_slot: null });
  await logEvent(r.id, `staff:${staff}`, 'confirmed', t12(slot));
  await scheduleReminders(updated);
  return { request: updated, delivery: await sendConfirmation(updated, s) };
}

export async function offer(ref: string, slot: string, staff: string) {
  const { r, s } = await mustGet(ref);
  if (!OPEN.includes(r.status)) throw new RequestError(`${ref} is ${r.status}`);
  const updated = await update(r, { status: 'awaiting_patient', offered_slot: slot });
  await logEvent(r.id, `staff:${staff}`, 'offered', t12(slot));
  const whenOffered = `${dayLabel(r.preferred_date)}, ${t12(slot)}`;
  const msg = buttons(
    `Sorry, ${s.name} has no free slot in the ${WINDOWS[r.time_window].name.toLowerCase()} on ${dayLabel(r.preferred_date)}. The nearest available time is *${whenOffered}*. Would that work for you?`,
    [{ id: `altok:${r.ref}`, title: `Accept ${t12(slot)}` }, { id: `resched:${r.ref}`, title: 'Choose another time' }, { id: 'human', title: 'Talk to our team' }]);
  const delivery = await notifyPatient(r.patient_id, [msg],
    [template('slot_alternative', [s.name, dayLabel(r.preferred_date), whenOffered], [`altok:${r.ref}`, `resched:${r.ref}`, 'human'])]);
  return { request: updated, delivery };
}

export async function cancelByStaff(ref: string, staff: string, reason = 'we could not find a suitable time. Our team will call you to help.') {
  const { r } = await mustGet(ref);
  if (['cancelled', 'arrived'].includes(r.status)) throw new RequestError(`${ref} is already ${r.status}`);
  const updated = await update(r, { status: 'cancelled' });
  await cancelReminders(r.id);
  await logEvent(r.id, `staff:${staff}`, 'cancelled', reason);
  const delivery = await notifyPatient(r.patient_id,
    [buttons(`Update on *${r.ref}*: ${reason}`, [{ id: 'find', title: 'Find a doctor' }, { id: 'human', title: 'Talk to our team' }])],
    [template('request_update', [r.ref, reason], ['human'])]);
  return { request: updated, delivery };
}

export async function markArrived(ref: string, staff: string) {
  const { r } = await mustGet(ref);
  if (r.status !== 'confirmed') throw new RequestError(`${ref} is not confirmed`);
  await cancelReminders(r.id);
  await logEvent(r.id, `staff:${staff}`, 'arrived');
  return { request: await update(r, { status: 'arrived' }), delivery: 'none' as const };
}

export async function markNoShow(ref: string, staff: string) {
  const { r, s } = await mustGet(ref);
  if (r.status !== 'confirmed') throw new RequestError(`${ref} is not confirmed`);
  const updated = await update(r, { status: 'no_show' });
  await cancelReminders(r.id);
  await logEvent(r.id, `staff:${staff}`, 'no_show');
  const delivery = await notifyPatient(r.patient_id,
    [buttons(`We missed you today for your appointment with *${s.label}*. Would you like to book another time?`, [{ id: `book:${s.id}`, title: 'Book again' }, { id: 'later', title: 'Not now' }])],
    [template('missed_appointment_rebook', [s.label], [`book:${s.id}`, 'later'])]);
  return { request: updated, delivery };
}

// ---------- patient actions (called by the conversation engine) ----------

export async function patientConfirmAttendance(ref: string) {
  const { r } = await mustGet(ref);
  await update(r, { patient_confirmed: true });
  await logEvent(r.id, 'patient', 'confirmed_attendance');
}

export async function patientCancel(ref: string, reason: string) {
  const { r } = await mustGet(ref);
  if (['cancelled', 'arrived', 'no_show'].includes(r.status)) throw new RequestError(`${ref} can no longer be cancelled`);
  await update(r, { status: 'cancelled' });
  await cancelReminders(r.id);
  await logEvent(r.id, 'patient', 'cancelled', reason);
}

export async function patientReschedule(ref: string, date: string, window: string) {
  const { r } = await mustGet(ref);
  if (['cancelled', 'arrived', 'no_show'].includes(r.status)) throw new RequestError(`${ref} can no longer be changed`);
  await update(r, { status: 'reschedule_requested', preferred_date: date, time_window: window, slot_time: null, appointment_at: null, offered_slot: null, patient_confirmed: false });
  await cancelReminders(r.id);
  await logEvent(r.id, 'patient', 'reschedule_requested', `${dayLabel(date)}, ${WINDOWS[window].name.toLowerCase()}`);
}

export async function patientAcceptOffer(ref: string) {
  const { r, s } = await mustGet(ref);
  if (r.status !== 'awaiting_patient' || !r.offered_slot) throw new RequestError(`${ref} has no open offer`);
  const updated = await update(r, { status: 'confirmed', slot_time: r.offered_slot, appointment_at: appointmentAt(r.preferred_date, r.offered_slot).toISOString(), offered_slot: null });
  await logEvent(r.id, 'patient', 'accepted_offer', t12(r.offered_slot));
  await scheduleReminders(updated);
  await sendConfirmation(updated, s);
  return updated;
}

export const patientRequests = (patientId: string) =>
  q<Request>(`select * from appointment_requests where patient_id = $1 and status not in ('cancelled','arrived','no_show') order by preferred_date`, [patientId]);

// ---------- messages ----------

export async function sendConfirmation(r: Request, s: Service) {
  const L = s.location;
  const fee = `${rupee(s.fee)}, pay at the counter`;
  const interactive: OutMsg[] = [
    buttons(`*Appointment confirmed*\nPatient: ${r.patient_name}\n${s.kind === 'package' ? 'Check' : 'Doctor'}: ${s.label}\nWhen: ${when(r)}\nWhere: ${L.name}, ${L.where_to_go}\nConsultation fee: ${fee}\nRef: ${r.ref}\n\nPlease arrive 15 minutes early with a photo ID.`,
      [{ id: `dir:${L.id}`, title: 'Get directions' }, { id: `resched:${r.ref}`, title: 'Reschedule' }, { id: `cancel:${r.ref}`, title: 'Cancel' }]),
    text(`*Before your visit:* ${s.prep}`),
  ];
  return notifyPatient(r.patient_id, interactive, [
    template('appointment_confirmation', [r.patient_name, s.label, when(r), `${L.short_name}, ${L.where_to_go}`, fee, r.ref], [`dir:${L.id}`, `resched:${r.ref}`, `cancel:${r.ref}`]),
    template('visit_preparation', [s.name, s.prep]),
  ]);
}

export async function sendReminder(r: Request, kind: 'reminder_24h' | 'reminder_3h') {
  const s = service(await content(), serviceIdOf(r));
  if (!s || r.status !== 'confirmed' || !r.slot_time) return 'skipped' as const;
  const L = s.location;
  if (kind === 'reminder_24h') {
    return notifyPatient(r.patient_id,
      [buttons(`Reminder: your appointment with *${s.label}* is tomorrow, *${dayLabel(r.preferred_date)} at ${t12(r.slot_time)}* at ${L.name}. Will you be able to make it?`,
        [{ id: `rconf:${r.ref}`, title: 'Yes, I’ll be there' }, { id: `resched:${r.ref}`, title: 'Reschedule' }, { id: `cancel:${r.ref}`, title: 'Cancel' }])],
      [template('appointment_reminder_24h', [s.label, dayLabel(r.preferred_date), t12(r.slot_time), L.short_name], [`rconf:${r.ref}`, `resched:${r.ref}`, `cancel:${r.ref}`])]);
  }
  return notifyPatient(r.patient_id,
    [text(`See you today at *${t12(r.slot_time)}*. Please go to ${L.name}, ${L.where_to_go}. Parking: ${L.parking}. Show ref *${r.ref}* at the registration counter.`),
      { kind: 'location', lat: L.lat, lng: L.lng, name: L.name, address: L.address }],
    [template('appointment_reminder_3h', [t12(r.slot_time), L.short_name, L.where_to_go, L.parking, r.ref], [`dir:${L.id}`])]);
}

// ---------- reminders ----------

export async function scheduleReminders(r: Request) {
  await cancelReminders(r.id);
  if (!r.appointment_at) return;
  const at = new Date(r.appointment_at).getTime();
  const plan: [string, number][] = [['reminder_24h', at - 24 * 3600e3], ['reminder_3h', at - 3 * 3600e3]];
  for (const [kind, sendAt] of plan) {
    if (sendAt > Date.now()) await q('insert into scheduled_messages (request_id, kind, send_at) values ($1, $2, $3)', [r.id, kind, new Date(sendAt)]);
  }
}

export async function cancelReminders(requestId: string) {
  await q(`update scheduled_messages set status = 'cancelled' where request_id = $1 and status = 'pending'`, [requestId]);
}

export { windowLabel };
