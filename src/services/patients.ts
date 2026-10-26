import { config } from '../config.js';
import { one, q } from '../db.js';
import type { Inbound } from '../whatsapp/webhook.js';

export type Patient = { id: string; wa_id: string; profile_name: string | null; name: string | null; age: number | null; gender: string | null; uhid: string | null; opted_out: boolean };
export type Conversation = { id: string; patient_id: string; mode: 'bot' | 'human'; context: any; source: string | null; last_inbound_at: string | null };

export async function upsertPatient(waId: string, profileName: string | null): Promise<Patient> {
  return (await one<Patient>(
    `insert into patients (wa_id, profile_name) values ($1, $2)
     on conflict (wa_id) do update set profile_name = coalesce(excluded.profile_name, patients.profile_name)
     returning *`, [waId, profileName]))!;
}

export async function getConversation(patientId: string): Promise<Conversation> {
  return (await one<Conversation>(
    `insert into conversations (patient_id) values ($1)
     on conflict (patient_id) do update set updated_at = conversations.updated_at
     returning *`, [patientId]))!;
}

/** Stores the inbound message. Returns false when Meta re-delivered a message we already have. */
export async function recordInbound(conv: Conversation, ev: Inbound): Promise<boolean> {
  const row = await one(
    `insert into messages (conversation_id, direction, wa_message_id, type, body, status)
     values ($1, 'in', $2, $3, $4, 'received') on conflict (wa_message_id) do nothing returning id`,
    [conv.id, ev.waMessageId, ev.kind, ev]);
  if (!row) return false;
  await q('update conversations set last_inbound_at = now(), updated_at = now() where id = $1', [conv.id]);
  return true;
}

export async function saveConversation(conv: Conversation): Promise<void> {
  await q('update conversations set context = $2, mode = $3, source = $4, updated_at = now() where id = $1', [conv.id, conv.context, conv.mode, conv.source]);
}

export async function recordConsent(patientId: string, type: 'service' | 'offers', given: boolean): Promise<void> {
  await q('insert into consents (patient_id, type, given, notice_version) values ($1, $2, $3, $4)', [patientId, type, given, config.CONSENT_NOTICE_VERSION]);
}

export async function hasConsent(patientId: string, type: 'service' | 'offers' = 'service'): Promise<boolean> {
  const row = await one<{ given: boolean }>('select given from consents where patient_id = $1 and type = $2 order by at desc limit 1', [patientId, type]);
  return !!row?.given;
}

export async function setOptOut(patientId: string, optedOut: boolean): Promise<void> {
  await q('update patients set opted_out = $2 where id = $1', [patientId, optedOut]);
}

export async function saveProfile(patientId: string, p: { name: string; age: number; gender: string }): Promise<void> {
  await q('update patients set name = $2, age = $3, gender = $4 where id = $1', [patientId, p.name, p.age, p.gender]);
}

/** DPDP erasure: removes personal details and message bodies, keeps anonymous counts. */
export async function erasePatient(patientId: string): Promise<void> {
  await q(`update patients set wa_id = 'erased-' || id, profile_name = null, name = null, age = null, gender = null, uhid = null, opted_out = true, erased_at = now() where id = $1`, [patientId]);
  await q(`update messages set body = '{}'::jsonb where conversation_id in (select id from conversations where patient_id = $1)`, [patientId]);
  await q(`update appointment_requests set patient_name = 'Erased', patient_age = null, patient_gender = null, uhid = null, reason = null where patient_id = $1`, [patientId]);
  await q(`update conversations set context = '{}'::jsonb where patient_id = $1`, [patientId]);
}

export const windowOpen = (conv: Pick<Conversation, 'last_inbound_at'>) =>
  !!conv.last_inbound_at && Date.now() - new Date(conv.last_inbound_at).getTime() < 24 * 3600 * 1000 - 60_000;
