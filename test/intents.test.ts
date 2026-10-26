import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMERGENCY, GREETING, MEDICAL_ADVICE } from '../src/engine/intents.js';
import { matchKeywords } from '../src/engine/content.js';

// Add every real emergency phrase the hospital reports to this list.
const emergencies = ['chest pain since morning', 'my father is unconscious', 'road accident near gate', 'she cant breathe', 'I think it is a stroke',
  'baby having fits', 'heavy bleeding after delivery', 'he fainted', 'seene me dard ho raha hai', 'want to kill myself', 'EMERGENCY'];
const notEmergencies = ['knee pain', 'book appointment', 'chest x-ray report', 'what are opd timings', 'heart check package'];

test('emergency phrases are caught', () => {
  for (const t of emergencies) assert.ok(EMERGENCY.test(t), t);
  for (const t of notEmergencies) assert.ok(!EMERGENCY.test(t), t);
});

test('medical advice questions are caught', () => {
  for (const t of ['which tablet for fever', 'what is the dose of paracetamol', 'can i take crocin', 'is it serious?', 'konsi dawai lu']) assert.ok(MEDICAL_ADVICE.test(t), t);
  for (const t of ['book with dr rao', 'pharmacy timings']) assert.ok(!MEDICAL_ADVICE.test(t), t);
});

test('greetings', () => {
  for (const t of ['hi', 'Hii', 'hello!', 'Namaste', 'menu']) assert.ok(GREETING.test(t), t);
  assert.ok(!GREETING.test('hi, I want to book with Dr. Rao'));
});

test('keyword matching respects word boundaries and stems', () => {
  assert.equal(matchKeywords('my knee hurts', 'knee,joint'), 'knee');
  assert.equal(matchKeywords('I am pregnant', 'pregnan*'), 'pregnan*');
  assert.equal(matchKeywords('appointment early', 'ear,ears'), null);
  assert.equal(matchKeywords('patient', 'ent'), null);
  assert.equal(matchKeywords('ear pain', 'ear,ears'), 'ear');
});
