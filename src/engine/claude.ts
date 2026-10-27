import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type { Content } from './content.js';

const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY || 'not-configured',
});

export async function askClaude(
  question: string,
  content: Content,
): Promise<string | null> {
  if (!config.ANTHROPIC_API_KEY) {
    console.error('Claude API key is not configured.');
    return null;
  }

  const hospitalInfo = {
    hospital: config.HOSPITAL_NAME,
    specialties: content.specialties.map((s) => ({
      name: s.name,
      description: s.description,
      keywords: s.keywords,
    })),
    doctors: content.doctors.map((d) => ({
      name: d.name,
      specialty_id: d.specialty_id,
      qualifications: d.qualifications,
      experience_years: d.experience_years,
      languages: d.languages,
    })),
    locations: content.locations.map((l) => ({
      name: l.name,
      address: l.address,
      opd_hours: l.opd_hours,
    })),
    packages: content.packages.map((p) => ({
      name: p.name,
      price: p.price,
      tests: p.tests,
      duration: p.duration,
      prep: p.prep,
    })),
    faqs: content.faqs.map((f) => ({
      question: f.title,
      answer: f.answer,
    })),
    insurers: content.insurers.map((i) => i.name),
  };

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: `You are the WhatsApp assistant for ${config.HOSPITAL_NAME}.

Answer general questions politely, naturally, and concisely.
Use only the hospital information supplied below for hospital-specific facts.
Never invent doctors, services, prices, opening hours, insurance coverage, or appointment availability.

You may explain general hospital services and help patients navigate the hospital.
Do not diagnose, prescribe medicines, recommend dosages, or claim certainty about symptoms.
For personal medical concerns, encourage the patient to consult a qualified clinician.
For emergency symptoms, tell the patient to call 108 or the hospital emergency number: ${config.EMERGENCY_PHONE}.

Never book, reschedule, cancel, or confirm an appointment yourself.
If the patient wants to book or change an appointment, explain that you can help them start the appointment process.
Never claim an appointment is confirmed.

Hospital information:
${JSON.stringify(hospitalInfo)}`,
      messages: [
        {
          role: 'user',
          content: question.slice(0, 2000),
        },
      ],
    });

    const answer = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return answer || null;
  } catch (error) {
    console.error(
      'Claude request failed:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    return null;
  }
}