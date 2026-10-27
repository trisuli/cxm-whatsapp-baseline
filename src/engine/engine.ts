import { config } from '../config.js';
import { q } from '../db.js';
import { openHandoff, touchHandoff } from '../services/handoffs.js';
import {
  getConversation, hasConsent, recordConsent, recordInbound, saveConversation, saveProfile, setOptOut, upsertPatient,
  type Conversation, type Patient,
} from '../services/patients.js';
import {
  createRequest, getRequest, patientAcceptOffer, patientCancel, patientConfirmAttendance, patientRequests, patientReschedule, RequestError,
} from '../services/requests.js';
import { dayLabel, nextOpdDates, t12, windowLabel, WINDOWS } from '../time.js';
import { markRead, sendMessage } from '../whatsapp/client.js';
import { buttons, list, text, type OutMsg } from '../whatsapp/messages.js';
import type { Inbound } from '../whatsapp/webhook.js';
import { content, describeWindows, matchKeywords, rupee, service, serviceIdOf, type Content, type Service } from './content.js';
import { EMERGENCY, GREETING, MEDICAL_ADVICE, MY_APPOINTMENTS, SOURCE_TAG, START, STOP, WANTS_BOOKING, WANTS_HUMAN } from './intents.js';

/** What the bot is waiting for, kept in conversations.context between messages. */
type Draft = {
  svc: string; date?: string; win?: string; forOther?: boolean;
  name?: string; age?: number; gender?: string; reason?: string; rescheduleRef?: string;
};
type Ctx = {
  expect?: 'docname' | 'symptom' | 'name' | 'age' | 'reason';
  pending?: string;        // first message, answered after consent
  afterConsent?: string;   // action id to resume after consent
  draft?: Draft;
};

const DESK = { appointments: 'Appointments desk', insurance: 'Insurance desk', emergency: 'Emergency desk' };
const GENDERS: Record<string, string> = { F: 'Female', M: 'Male', O: 'Other' };

/** Entry point for every patient message coming from the webhook (or the simulator). */
export async function handleInbound(ev: Inbound): Promise<OutMsg[]> {
  const patient = await upsertPatient(ev.waId, ev.profileName);
  const conv = await getConversation(patient.id);
  if (!(await recordInbound(conv, ev))) return []; // duplicate delivery from Meta
  void markRead(ev.waMessageId);

  const turn = new Turn(patient, conv, await content());
  await turn.run(ev);
  conv.context = turn.ctx;
  await saveConversation(conv);
  for (const m of turn.out) {
  try {
    await sendMessage(patient.wa_id, conv.id, m);
  } catch (err) {
    console.error('CXM outgoing message failed:', {
      kind: m.kind,
      message: err instanceof Error ? err.message : String(err),
      listSections: m.kind === 'list'
        ? m.sections.map((s) => ({
            title: s.title,
            rowCount: s.rows.length,
          }))
        : undefined,
    });
    throw err;
  }
}
  return turn.out;
}

class Turn {
  out: OutMsg[] = [];
  ctx: Ctx;
  constructor(private patient: Patient, private conv: Conversation, private c: Content) {
    this.ctx = { ...(conv.context ?? {}) };
  }

  say(...m: OutMsg[]) { this.out.push(...m); }

  async run(ev: Inbound) {
    if (!this.conv.source) this.conv.source = sourceOf(ev);
    const raw = ev.kind === 'text' ? (ev.text ?? '').trim() : '';

    if (ev.kind === 'text' && STOP.test(raw)) {
      await setOptOut(this.patient.id, true);
      return this.say(text('You won’t get any more messages from us. Send *START* if you change your mind.'));
    }
    if (this.patient.opted_out) {
      if (ev.kind === 'text' && START.test(raw)) {
        await setOptOut(this.patient.id, false);
        return this.say(text('Welcome back. Messages are on again.'), this.mainMenu());
      }
      return; // opted out: stay silent
    }

    if (ev.kind === 'text') return this.understand(raw);
    if (ev.kind === 'reply' && ev.replyId) return this.route(ev.replyId);
    if (ev.kind === 'flow' && ev.flowData) return this.flowSubmitted(ev.flowData);
    this.say(text('I can read text messages and button taps. Type *menu* to see what I can help with, or *person* to reach our team.'));
  }

  // ---------------------------------------------------------------- free text

  async understand(raw: string) {
    const low = raw.toLowerCase();

    // 1. Safety first, in every mode.
    if (EMERGENCY.test(low)) return this.emergency(raw);

    // 2. A person is handling this chat.
// Allow appointment-status requests without ending the staff hand-off.
if (this.conv.mode === 'human') {
  const cleanMessage = raw.toLowerCase().replace(SOURCE_TAG, ' ').trim();

  if (MY_APPOINTMENTS.test(cleanMessage)) {
    return this.myAppointments();
  }

  if (!GREETING.test(raw)) {
    await touchHandoff(this.conv.id);
    return;
  }

  this.conv.mode = 'bot';
  await q(
    `UPDATE handoffs
     SET status = 'resolved', updated_at = now()
     WHERE conversation_id = $1 AND status <> 'resolved'`,
    [this.conv.id]
  );
}

    // 3. First contact: welcome + consent. Answer the first message after consent.
    if (!(await this.consented()) && !this.ctx.afterConsent && !this.ctx.pending && (await this.isFirstMessage())) {
      this.ctx.pending = GREETING.test(raw) ? undefined : raw.replace(SOURCE_TAG, '').trim();
      return this.welcome();
    }

    // 4. Steps of the booking conversation that expect typed answers.
    const expect = this.ctx.expect;
    this.ctx.expect = undefined;
    if (expect === 'name') return this.gotName(raw);
    if (expect === 'age') return this.gotAge(raw);
    if (expect === 'reason') { this.ctx.draft = { ...this.ctx.draft!, reason: raw.slice(0, 200) }; return this.review(); }

    if (MEDICAL_ADVICE.test(low)) {
      return this.say(buttons('I can’t give medical advice or suggest medicines. A doctor can help you with that safely. Would you like to book a consultation or speak to our team?',
        [{ id: 'find', title: 'Find a doctor' }, { id: 'human', title: 'Talk to our team' }]));
    }
    if (GREETING.test(raw)) return this.say(this.mainMenu());

    const clean = low.replace(SOURCE_TAG, ' ');
    const named = this.c.doctors.find((d) => matchKeywords(clean, `${d.name.split(' ').at(-1)},${d.name.split(' ')[1]}`));
    if (named) {
      const s = service(this.c, `d.${named.id}`)!;
      if (WANTS_BOOKING.test(clean)) return this.say(this.doctorCard(named.id), ...(await this.bookingStart(s.id)));
      return this.say(this.doctorCard(named.id));
    }
    if (expect === 'docname') {
      return this.say(buttons(`I couldn’t find a doctor called “${raw.slice(0, 40)}”. You can browse by speciality instead.`,
        [{ id: 'fspec', title: 'Browse specialities' }, { id: 'human', title: 'Talk to our team' }]));
    }

    const pkg = this.c.packages.find((p) => matchKeywords(clean, p.name.split(' ')[0]) && /package|check|offer/.test(clean));
    if (pkg) return this.route(`pkg:${pkg.id}`);
    if (/package|health ?check|full body|master check/.test(clean)) return this.route('pkgs');

    const insurer = this.c.insurers.find((i) => matchKeywords(clean, i.aliases || i.name));
    if (insurer) {
      return this.say(buttons(`Yes, we offer cashless treatment with *${insurer.name}* at all our locations. For a planned admission our Insurance desk arranges pre-authorisation. Please bring your policy card and photo ID.`,
        [{ id: 'human:ins', title: 'Insurance desk' }, { id: 'book', title: 'Book appointment' }]));
    }
    if (/insur|cashless|tpa|mediclaim|policy/.test(clean)) {
      return this.say(buttons('I couldn’t find that insurer on our cashless list. Our Insurance desk can check your policy for you.',
        [{ id: 'human:ins', title: 'Insurance desk' }, { id: 'ins', title: 'Accepted insurers' }]));
    }
    if (MY_APPOINTMENTS.test(clean)) return this.myAppointments();

    const faq = this.c.faqs.find((f) => matchKeywords(clean, f.keywords));
    if (faq) return this.say(buttons(faq.answer, [{ id: 'book', title: 'Book appointment' }, { id: 'menu', title: 'Main menu' }]));
    if (/\b(where|address|location|direction|directions|how to reach)\b/.test(clean)) return this.route('loc');

    const spec = this.c.specialties.find((s) => matchKeywords(clean, s.keywords))
      ?? this.c.specialties.find((s) => matchKeywords(clean, `${s.name.split(' ')[0].toLowerCase().slice(0, 6)}*`));
    if (spec) {
      const viaSymptom = !!matchKeywords(clean, spec.keywords);
      return this.showSpecialty(spec.id, viaSymptom ? `For this, a *${spec.name}* specialist is usually the right first visit. This is a suggestion, not a diagnosis.` : undefined);
    }
    if (WANTS_BOOKING.test(clean)) return this.route('book');
    if (WANTS_HUMAN.test(clean)) return this.route('human');

    await q('insert into unanswered_questions (conversation_id, text) values ($1, $2)', [this.conv.id, raw.slice(0, 500)]);
    this.say(buttons('I don’t have an approved answer for that yet, so I won’t guess. I can connect you to our team, who will reply here.',
      [{ id: 'human', title: 'Talk to our team' }, { id: 'menu', title: 'Main menu' }], { footer: 'Logged so our team can add an answer' }));
  }

  // ---------------------------------------------------------------- button / list taps

  async route(id: string): Promise<void> {
    const [a, b, c] = id.split(':');
    const c_ = this.c;
    switch (a) {
      case 'consent': {
        const yes = b === 'yes';
        await recordConsent(this.patient.id, 'service', yes);
        const next = this.ctx.afterConsent; const pending = this.ctx.pending;
        this.ctx.afterConsent = undefined; this.ctx.pending = undefined;
        this.say(text(yes ? 'Thank you. Your consent is recorded.' : 'No problem. You can still browse doctors, packages and timings. I’ll only ask again if you want to book.'));
        if (yes && next) return this.route(next);
        if (pending) return this.understand(pending);
        return this.say(this.mainMenu());
      }
      case 'menu': return this.say(this.mainMenu());
      case 'find':
        return this.say(buttons('How would you like to find a doctor?', [
          { id: 'fspec', title: 'By speciality' }, { id: 'fname', title: 'By doctor’s name' }, { id: 'fsym', title: 'Describe problem' }]));
      case 'fspec': return this.say(this.specialtyList());
      case 'fname': this.ctx.expect = 'docname'; return this.say(text('Type the doctor’s name, for example *Rao* or *Iyer*.'));
      case 'fsym':
        this.ctx.expect = 'symptom';
        return this.say(text('Tell me in a few words what you need help with, for example *knee pain* or *my child has a cough*. I’ll suggest the right speciality. This is not a diagnosis.'));
      case 'spec': return this.showSpecialty(b);
      case 'prof': {
        const s = service(c_, `d.${b}`); if (!s) return this.say(this.mainMenu());
        const d = c_.doctors.find((x) => x.id === b)!;
        return this.say(buttons(`*${d.name}* is a ${s.specialty!.name} consultant with ${d.experience_years} years of experience (${d.qualifications}). Consults at ${s.location.name} on ${dayNames(d.opd_days)}, ${describeWindows(s)}. Consultation fee ${rupee(d.fee)}. Speaks ${d.languages}.`,
          [{ id: `book:${s.id}`, title: 'Book appointment' }, { id: `spec:${d.specialty_id}`, title: 'Other doctors' }]));
      }
      case 'pkgs':
        return this.say(list('Our health check packages. Results come here on WhatsApp.', 'See packages',
          [{ title: 'Health checks', rows: c_.packages.map((p) => ({ id: `pkg:${p.id}`, title: p.name, description: rupee(p.price) })) }]));
      case 'pkg': {
        const p = c_.packages.find((x) => x.id === b); if (!p) return this.route('pkgs');
        return this.say(buttons(`*${p.name}* · ${rupee(p.price)}\n${p.tests}.\n\nTime needed: ${p.duration}\nPreparation: ${p.prep}`,
          [{ id: `book:p.${p.id}`, title: 'Book this check' }, { id: 'pkgs', title: 'Other packages' }, { id: 'human', title: 'Ask a question' }]));
      }
      case 'ins':
        return this.say(buttons(`We offer cashless treatment with:\n${c_.insurers.map((i) => i.name).join(', ')}.\n\nFor a planned admission, our Insurance desk handles pre-authorisation. Bring your policy card and photo ID.`,
          [{ id: 'human:ins', title: 'Insurance desk' }, { id: 'menu', title: 'Main menu' }]));
      case 'loc': {
        const msgs: OutMsg[] = [];
        for (const L of c_.locations) msgs.push({ kind: 'location', lat: L.lat, lng: L.lng, name: L.name, address: L.address }, text(`*${L.short_name}*: ${L.opd_hours} Parking: ${L.parking}.`));
        return this.say(...msgs, buttons('Anything else?', [{ id: 'book', title: 'Book appointment' }, { id: 'menu', title: 'Main menu' }]));
      }
      case 'dir': {
        const L = c_.locations.find((x) => x.id === b); if (!L) return this.route('loc');
        return this.say({ kind: 'location', lat: L.lat, lng: L.lng, name: L.name, address: L.address });
      }
      case 'faq':
        return this.say(list('Common questions', 'See questions', [{ title: 'Questions', rows: c_.faqs.slice(0, 10).map((f) => ({ id: `faqa:${f.id}`, title: f.title })) }]));
      case 'faqa': {
        const f = c_.faqs.find((x) => x.id === b); if (!f) return this.route('faq');
        return this.say(buttons(f.answer, [{ id: 'faq', title: 'Another question' }, { id: 'menu', title: 'Main menu' }]));
      }
      case 'human': return this.handoff(b === 'ins' ? DESK.insurance : DESK.appointments);
      case 'emerg': return this.emergency('Patient chose Emergency');
      case 'notemerg':
        this.conv.mode = 'bot';
        await q(`update handoffs set status = 'resolved', updated_at = now() where conversation_id = $1 and alert_type = 'emergency' and status <> 'resolved'`, [this.conv.id]);
        return this.say(text('Thanks for letting me know.'), this.mainMenu());
      case 'mine': return this.myAppointments();
      case 'later': return this.say(text('No problem. Type *book* whenever you’re ready.'));

      // ----- booking (in-chat steps; see flowSubmitted() for the WhatsApp Flow version)
      case 'book': {
        const svcId = b ? `${b}${c ? ':' + c : ''}` : undefined;
        if (!svcId) return this.say(text('Which doctor would you like to see? Pick a speciality and tap *Book appointment* on a doctor.'), this.specialtyList());
        return this.say(...(await this.bookingStart(svcId)));
      }
      case 'bd': { // bd:<svc>:<date>
        const s = service(c_, b); if (!s) return this.say(this.mainMenu());
        this.ctx.draft = { ...(this.ctx.draft?.svc === b ? this.ctx.draft : { svc: b }), date: c };
        if (s.windows.length === 1) return this.gotWindow(s.windows[0]);
        return this.say(buttons(`What time of day suits you on *${dayLabel(c)}*?`, s.windows.map((w) => ({ id: `bw:${w}`, title: WINDOWS[w].name }))));
      }
      case 'bw': return this.gotWindow(b);
      case 'bwho': {
        if (!this.ctx.draft) return this.route('book');
        this.ctx.draft.forOther = b === 'other';
        if (b === 'me' && this.patient.name && this.patient.age && this.patient.gender) {
          Object.assign(this.ctx.draft, { name: this.patient.name, age: this.patient.age, gender: this.patient.gender });
          return this.askReason();
        }
        this.ctx.expect = 'name';
        return this.say(text(b === 'other' ? 'What is the patient’s full name?' : 'What is your full name?'));
      }
      case 'bg': {
        if (!this.ctx.draft) return this.route('book');
        this.ctx.draft.gender = GENDERS[b] ?? 'Other';
        if (!this.ctx.draft.forOther) await saveProfile(this.patient.id, { name: this.ctx.draft.name!, age: this.ctx.draft.age!, gender: this.ctx.draft.gender });
        return this.askReason();
      }
      case 'brs': return this.review();
      case 'bok': return this.submitDraft();
      case 'bchg': {
        const svc = this.ctx.draft?.svc; if (!svc) return this.route('book');
        return this.say(this.dateList(service(c_, svc)!));
      }
      case 'bx': this.ctx.draft = undefined; this.ctx.expect = undefined; return this.say(text('Okay, I’ve discarded that request.'), this.mainMenu());

      // ----- after booking
      case 'rconf': await this.guard(() => patientConfirmAttendance(b)); return this.say(text('Thank you for confirming. See you then!'));
      case 'altok': await this.guard(() => patientAcceptOffer(b)); return; // confirmation is sent by patientAcceptOffer
      case 'resched': {
        const r = await getRequest(b);
        if (!r || ['cancelled', 'arrived', 'no_show'].includes(r.status)) return this.say(text('That appointment can no longer be changed. Type *book* to make a new one.'));
        const s = service(c_, serviceIdOf(r))!;
        this.ctx.draft = { svc: s.id, rescheduleRef: r.ref };
        return this.say(this.dateList(s, `Pick a new date for *${r.ref}*.`));
      }
      case 'cancel': {
        const r = await getRequest(b);
        if (!r || r.status === 'cancelled') return this.say(text('That appointment is already cancelled.'));
        return this.say(buttons(`Cancel *${r.ref}*? Please tell us why.`, [
          { id: `cx:${b}:better`, title: 'Feeling better' }, { id: `cx:${b}:cant`, title: 'Can’t make it' }, { id: `cx:${b}:other`, title: 'Other reason' }]));
      }
      case 'cx': {
        const ok = await this.guard(() => patientCancel(b, c));
        if (!ok) return;
        return this.say(buttons(`Your appointment *${b}* is cancelled and the slot has been released for other patients.`,
          [{ id: 'book', title: 'Book another time' }, { id: 'menu', title: 'Main menu' }]));
      }
      default:
        return this.say(this.mainMenu('Sorry, that option has expired. How can I help?'));
    }
  }

  // ---------------------------------------------------------------- pieces

  async consented() { return hasConsent(this.patient.id); }

  async isFirstMessage() {
    const r = await q<{ n: string }>(`select count(*) as n from messages where conversation_id = $1 and direction = 'in'`, [this.conv.id]);
    return Number(r[0].n) <= 1;
  }

  welcome() {
    this.say(
      text(`Welcome to *${config.HOSPITAL_NAME}*. I’m the hospital’s WhatsApp assistant. I can help you find a doctor, book an appointment and answer common questions. I can’t give medical advice.\n\nIn an emergency, call *108* or our 24×7 Emergency line *${config.EMERGENCY_PHONE}*.`),
      this.consentAsk());
  }

  consentAsk(): OutMsg {
    return buttons(`To help you, we store your name, phone number and the details you share, only to arrange your care at ${config.HOSPITAL_SHORT_NAME}. You can ask us to delete them at any time. Privacy notice: ${config.PRIVACY_URL}`,
      [{ id: 'consent:yes', title: 'I agree' }, { id: 'consent:no', title: 'Not now' }], { header: 'Your consent', footer: 'Required under the DPDP Act, 2023' });
  }

  mainMenu(prompt = 'How can I help you today?'): OutMsg {
    return list(prompt, 'Choose an option', [
      { title: 'Find care', rows: [
        { id: 'find', title: 'Find a doctor', description: 'By speciality, name or problem' },
        { id: 'pkgs', title: 'Health check packages', description: 'Prices and what’s included' },
        { id: 'ins', title: 'Insurance & cashless', description: 'Accepted insurers and TPAs' },
        { id: 'loc', title: 'Locations & timings', description: 'Directions, OPD hours, parking' },
        { id: 'faq', title: 'Common questions', description: 'Visiting hours, reports, refunds' }] },
      { title: 'Appointments', rows: [
        { id: 'book', title: 'Book an appointment', description: 'Request a time with a doctor' },
        { id: 'mine', title: 'My appointments', description: 'Status, reschedule or cancel' }] },
      { title: 'Help', rows: [
        { id: 'human', title: 'Talk to our team', description: '8 am–8 pm, usually within 5 minutes' },
        { id: 'emerg', title: 'Emergency', description: 'Ambulance and 24×7 emergency' }] },
    ], { footer: 'You can also just type your question' });
  }

  specialtyList(): OutMsg {
    return list('Which speciality are you looking for?', 'Choose speciality',
      [{ title: 'Specialities', rows: this.c.specialties.slice(0, 10).map((s) => ({ id: `spec:${s.id}`, title: s.name, description: s.description.slice(0, 72) })) }]);
  }

  doctorCard(doctorId: string): OutMsg {
    const s = service(this.c, `d.${doctorId}`)!;
    const d = this.c.doctors.find((x) => x.id === doctorId)!;
    return buttons(`*${d.name}*\n${s.specialty!.name} · ${d.qualifications} · ${d.experience_years} yrs\nOPD: ${dayNames(d.opd_days)}, ${s.windows.map((w) => WINDOWS[w].name.toLowerCase()).join(' and ')}\nWhere: ${s.location.short_name}\nFee: ${rupee(d.fee)}\nSpeaks: ${d.languages}`,
      [{ id: `book:${s.id}`, title: 'Book appointment' }, { id: `prof:${d.id}`, title: 'More about doctor' }]);
  }

  showSpecialty(specId: string, intro?: string) {
    const sp = this.c.specialties.find((s) => s.id === specId);
    if (!sp) return this.say(this.specialtyList());

    const docs = this.c.doctors.filter((d) => d.specialty_id === specId);

    if (docs.length === 0) {
      return this.say(
        text(`I couldn't find any listed doctors for ${sp.name}. Please choose another speciality or contact our team.`),
        buttons('How would you like to continue?', [
          { id: 'fspec', title: 'Other specialities' },
          { id: 'human', title: 'Talk to our team' },
        ])
      );
    }

    this.say(
      text(intro ?? `Here are our *${sp.name}* doctors:`),
      ...docs.map((d) => this.doctorCard(d.id)),
      buttons('Not sure who to see? Our team can help you choose.', [
        { id: 'human', title: 'Help me choose' },
        { id: 'menu', title: 'Main menu' },
      ])
    );
  }

  async bookingStart(svcId: string): Promise<OutMsg[]> {
    const s = service(this.c, svcId);
    if (!s) return [this.mainMenu('Sorry, I couldn’t find that doctor. How can I help?')];
    if (!(await this.consented())) {
      this.ctx.afterConsent = `book:${svcId}`;
      return [text('Before I take details for a booking, I need your consent.'), this.consentAsk()];
    }
    this.ctx.draft = { svc: s.id };
    if (config.WA_BOOKING_FLOW_ID) {
      return [{
        kind: 'flow', text: `Let’s book *${s.label}*. Tap below to pick a date and time. It takes about a minute.`, cta: 'Book appointment',
        flowId: config.WA_BOOKING_FLOW_ID, flowToken: `book:${this.conv.id}:${s.id}`, screen: 'BOOKING',
        data: {
          service_label: s.label,
          dates: nextOpdDates(s.days).map((d) => ({ id: d, title: dayLabel(d) })),
          windows: s.windows.map((w) => ({ id: w, title: windowLabel(w) })),
          default_name: this.patient.name ?? this.patient.profile_name ?? '',
        },
      }];
    }
    return [this.dateList(s, `Let’s book *${s.label}* at ${s.location.short_name}. Which date suits you?`)];
  }

  dateList(s: Service, prompt = 'Which date suits you?'): OutMsg {
    return list(prompt, 'Choose a date', [{ title: 'OPD dates', rows: nextOpdDates(s.days, 8).map((d) => ({ id: `bd:${s.id}:${d}`, title: dayLabel(d) })) }],
      { footer: 'This is a request. We confirm the exact time.' });
  }

  async gotWindow(w: string) {
    const draft = this.ctx.draft;
    if (!draft?.date || !WINDOWS[w]) return this.route('book');
    draft.win = w;
    if (draft.rescheduleRef) return this.review();
    const who = this.patient.name ? `Is this appointment for you, ${this.patient.name.split(' ')[0]}?` : 'Who is the appointment for?';
    return this.say(buttons(who, [{ id: 'bwho:me', title: 'Myself' }, { id: 'bwho:other', title: 'Someone else' }]));
  }

  gotName(raw: string) {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!this.ctx.draft) return this.route('book');
    if (name.length < 2 || name.length > 60 || /\d/.test(name)) {
      this.ctx.expect = 'name';
      return this.say(text('Please type the full name, for example *Ravi Kumar*.'));
    }
    this.ctx.draft.name = name;
    this.ctx.expect = 'age';
    return this.say(text(`Thanks. What is ${this.ctx.draft.forOther ? 'the patient’s' : 'your'} age in years?`));
  }

  gotAge(raw: string) {
    const age = Number(raw.match(/\d{1,3}/)?.[0]);
    if (!this.ctx.draft) return this.route('book');
    if (!Number.isFinite(age) || age > 120) { this.ctx.expect = 'age'; return this.say(text('Please type the age as a number, for example *42*.')); }
    this.ctx.draft.age = age;
    return this.say(buttons('Gender?', [{ id: 'bg:F', title: 'Female' }, { id: 'bg:M', title: 'Male' }, { id: 'bg:O', title: 'Other' }]));
  }

  askReason() {
    this.ctx.expect = 'reason';
    return this.say(buttons('In a few words, what is the visit for? This helps the doctor prepare.', [{ id: 'brs', title: 'Skip' }]));
  }

  review() {
    const dr = this.ctx.draft;
    if (!dr?.date || !dr.win) return this.route('book');
    const s = service(this.c, dr.svc)!;
    const lines = dr.rescheduleRef
      ? [`*Move ${dr.rescheduleRef} to*`, `${s.label}`, `${dayLabel(dr.date)}, ${windowLabel(dr.win)}`]
      : ['*Please check your request*', `${s.kind === 'package' ? 'Check' : 'Doctor'}: ${s.label}`, `Where: ${s.location.name}`, `Date: ${dayLabel(dr.date)}`, `Time: ${windowLabel(dr.win)}`,
        `Patient: ${dr.name}, ${dr.age}, ${dr.gender}`, ...(dr.reason ? [`Reason: ${dr.reason}`] : []), `Fee: ${rupee(s.fee)}, pay at the counter`];
    return this.say(buttons(lines.join('\n'), [{ id: 'bok', title: dr.rescheduleRef ? 'Send new time' : 'Send request' }, { id: 'bchg', title: 'Change date' }, { id: 'bx', title: 'Cancel' }]));
  }

  async submitDraft() {
    const dr = this.ctx.draft;
    if (!dr?.date || !dr.win) return this.route('book');
    const s = service(this.c, dr.svc)!;
    this.ctx.draft = undefined;
    if (dr.rescheduleRef) {
      const ok = await this.guard(() => patientReschedule(dr.rescheduleRef!, dr.date!, dr.win!));
      if (!ok) return;
      return this.say(text(`Got it. We’ve asked our team to move *${dr.rescheduleRef}* to *${dayLabel(dr.date)}, ${WINDOWS[dr.win].name.toLowerCase()}*. You’ll get the new confirmation here.`));
    }
    if (!dr.name || !dr.age || !dr.gender) return this.route(`book:${dr.svc}`);
    const r = await createRequest({ patientId: this.patient.id, serviceId: s.id, date: dr.date, window: dr.win, name: dr.name, age: dr.age, gender: dr.gender,
      forOther: !!dr.forOther, reason: dr.reason ?? null, source: this.conv.source });
    this.say(buttons(`Thanks, ${dr.name.split(' ')[0]}. Your request *${r.ref}* for *${s.label}* on *${dayLabel(dr.date)}, ${WINDOWS[dr.win].name.toLowerCase()}* has reached our appointments team.\n\nYou’ll get a confirmation with the exact time here, usually within *${config.CONFIRM_SLA_MINUTES} minutes* (8 am–8 pm). Nothing to pay now.`,
      [{ id: 'mine', title: 'My appointments' }, { id: 'menu', title: 'Main menu' }]));
  }

  /** WhatsApp Flow submission (used when WA_BOOKING_FLOW_ID is set). See flows/booking-flow.json. */
  async flowSubmitted(data: Record<string, any>) {
    const [kind, convId, svcId] = String(data.flow_token ?? '').split(':');
    const s = service(this.c, svcId);
    if (kind !== 'book' || convId !== this.conv.id || !s || !data.date || !WINDOWS[data.window]) {
      return this.say(text('Sorry, that form has expired. Type *book* to start again.'));
    }
    this.ctx.draft = { svc: s.id, date: data.date, win: data.window, name: String(data.name ?? '').trim(), age: Number(data.age),
      gender: GENDERS[data.gender] ?? data.gender, forOther: data.for_other === 'other', reason: data.reason || undefined };
    if (!this.ctx.draft.forOther && this.ctx.draft.name && this.ctx.draft.age) await saveProfile(this.patient.id, { name: this.ctx.draft.name, age: this.ctx.draft.age, gender: this.ctx.draft.gender! });
    return this.submitDraft();
  }

  async myAppointments() {
    const mine = await patientRequests(this.patient.id);
    if (!mine.length) return this.say(buttons('You don’t have any upcoming appointments with us.', [{ id: 'book', title: 'Book appointment' }, { id: 'menu', title: 'Main menu' }]));
    const words: Record<string, string> = { new: 'Waiting for confirmation', reschedule_requested: 'New time requested', awaiting_patient: 'Please reply to our suggested time', confirmed: 'Confirmed' };
    const lines = mine.map((r) => {
      const s = service(this.c, serviceIdOf(r));
      const when = r.slot_time ? `${dayLabel(r.preferred_date)}, ${t12(r.slot_time)}` : `${dayLabel(r.preferred_date)}, ${WINDOWS[r.time_window].name.toLowerCase()} (requested)`;
      return `*${r.ref}* · ${s?.label ?? ''}\n${when} · ${words[r.status] ?? r.status}`;
    });
    const last = mine.at(-1)!;
    return this.say(buttons(lines.join('\n\n').slice(0, 1000), [{ id: `resched:${last.ref}`, title: 'Reschedule' }, { id: `cancel:${last.ref}`, title: 'Cancel' }, { id: 'menu', title: 'Main menu' }],
      { header: 'Your appointments', ...(mine.length > 1 ? { footer: `Buttons apply to ${last.ref}` } : {}) }));
  }

  async handoff(queue: string) {
    await openHandoff(this.conv, queue);
    this.say(text(`I’m connecting you to our *${queue}*. Someone usually replies within 5 minutes between 8 am and 8 pm. You can type your question now.`));
  }

  async emergency(raw: string) {
    await openHandoff(this.conv, DESK.emergency, { type: 'emergency', text: raw.slice(0, 200) });
    const er = this.c.locations.find((l) => l.has_emergency) ?? this.c.locations[0];
    this.say(
      text(`*If this is a medical emergency, call 108 now* or our 24×7 Emergency line *${config.EMERGENCY_PHONE}*.\n\nOur Emergency department is at ${er.name}, open 24×7.`),
      { kind: 'location', lat: er.lat, lng: er.lng, name: `${er.name} – Emergency`, address: er.address },
      buttons('I’ve alerted our emergency desk and they will call you on this number.', [{ id: 'notemerg', title: 'Not an emergency' }]));
  }

  /** Runs a request action; turns a RequestError into a polite message. */
  async guard(fn: () => Promise<unknown>): Promise<boolean> {
    try { await fn(); return true; } catch (err) {
      if (err instanceof RequestError) { this.say(text('Sorry, that appointment can’t be changed any more. Type *my appointments* to see the current status, or *person* to reach our team.')); return false; }
      throw err;
    }
  }
}

function sourceOf(ev: Inbound): string {
  if (ev.referral) return `Click-to-WhatsApp ad${ev.referral.headline ? `: ${ev.referral.headline}` : ''}`;
  const tag = ev.text?.match(SOURCE_TAG)?.[1];
  return tag ? tag.toUpperCase() : 'Direct';
}

const dayNames = (days: number[]) => days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ');
