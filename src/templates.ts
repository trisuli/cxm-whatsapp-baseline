import { config } from './config.js';
import type { OutMsg } from './whatsapp/messages.js';

/**
 * Message templates for business-started messages (sent outside the 24-hour window).
 * `npm run templates:submit` creates them in your WhatsApp Business Account for Meta's review.
 * Keep names, variable order and button order in sync with the code that sends them.
 */
export const TEMPLATES = {
  appointment_confirmation: {
    category: 'UTILITY',
    body: 'Your appointment is confirmed.\n\nPatient: {{1}}\nDoctor: {{2}}\nWhen: {{3}}\nWhere: {{4}}\nConsultation fee: {{5}}\nRef: {{6}}\n\nPlease arrive 15 minutes early with a photo ID.',
    example: ['Ravi Kumar', 'Dr. Anil Rao, Orthopaedics', 'Wed 14 Oct, 9:15 am', 'Main Campus, OPD Block B, 1st floor', '₹900, pay at the counter', 'SNR-1043'],
    buttons: ['Get directions', 'Reschedule', 'Cancel'],
  },
  visit_preparation: {
    category: 'UTILITY',
    body: 'Before your visit with {{1}}: {{2}}',
    example: ['Dr. Anil Rao', 'Bring any previous X-rays or MRI scans.'],
    buttons: [],
  },
  slot_alternative: {
    category: 'UTILITY',
    body: 'Sorry, {{1}} has no free slot at your preferred time on {{2}}. The nearest available time is {{3}}. Would that work for you?',
    example: ['Dr. Anil Rao', 'Wed 14 Oct', 'Wed 14 Oct, 11:30 am'],
    buttons: ['Accept', 'Choose another time', 'Talk to our team'],
  },
  appointment_reminder_24h: {
    category: 'UTILITY',
    body: 'Reminder: your appointment with {{1}} is tomorrow, {{2}} at {{3}}, {{4}}. Will you be able to make it?',
    example: ['Dr. Anil Rao', 'Wed 14 Oct', '9:15 am', 'Main Campus'],
    buttons: ['Yes, I will be there', 'Reschedule', 'Cancel'],
  },
  appointment_reminder_3h: {
    category: 'UTILITY',
    body: 'See you today at {{1}}. Please go to {{2}}, {{3}}. Parking: {{4}}. Show ref {{5}} at the registration counter.',
    example: ['9:15 am', 'Main Campus', 'OPD Block B, 1st floor', 'Basement 2', 'SNR-1043'],
    buttons: ['Get directions'],
  },
  missed_appointment_rebook: {
    category: 'UTILITY',
    body: 'We missed you today for your appointment with {{1}}. Would you like to book another time?',
    example: ['Dr. Anil Rao'],
    buttons: ['Book again', 'Not now'],
  },
  request_update: {
    category: 'UTILITY',
    body: 'Update on your appointment request {{1}}: {{2}}',
    example: ['SNR-1043', 'we could not find a suitable time. Our team will call you.'],
    buttons: ['Talk to our team'],
  },
  care_team_reply: {
    category: 'UTILITY',
    body: 'Our care team has replied to your message about {{1}}. Tap below to continue the chat.',
    example: ['your appointment'],
    buttons: ['Continue chat'],
  },
} as const;

export type TemplateName = keyof typeof TEMPLATES;

export function template(name: TemplateName, params: string[], payloads: string[] = []): OutMsg {
  const t = TEMPLATES[name];
  if (params.length !== t.example.length) throw new Error(`Template ${name} needs ${t.example.length} params, got ${params.length}`);
  if (payloads.length !== t.buttons.length) throw new Error(`Template ${name} needs ${t.buttons.length} button payloads, got ${payloads.length}`);
  // Meta rejects parameters with new lines, tabs or more than 4 spaces in a row.
  const clean = params.map((p) => p.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-');
  return { kind: 'template', name, language: config.WA_TEMPLATE_LANGUAGE, bodyParams: clean, buttonPayloads: payloads };
}
