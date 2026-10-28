/**
 * Safety-critical patterns. These run before anything else on every text message.
 * Extend the lists with phrases the hospital sees (including Hinglish), and add each one to test/intents.test.ts.
 */
export const EMERGENCY = /chest pain|seene (me|mein) dard|can'?t breathe|cannot breathe|breathless|not breathing|saans nahi|unconscious|behosh|accident|bleeding heavily|heavy bleeding|stroke|paralys|fainted|seizure|fits|suicid|kill myself|poison|severe burn|emergency/i;
export const MEDICAL_ADVICE = /\b(dose|dosage|should i take|which (tablet|medicine|syrup)|what (tablet|medicine)|can i take|is it serious|how many tablets|antibiotic|konsi dawai|kaunsi dawa)\b/i;
export const GENERAL_HEALTH_INFO =
  /^\s*(what is|what are|explain|define|tell me about|what causes|why does|how does)\b/i;
export const GREETING = /^(hi+|hello|hey|hai|namaste|namaskar|start|menu|main menu)[\s!.]*$/i;
export const STOP = /^(stop|unsubscribe)[\s!.]*$/i;
export const START = /^(start|subscribe)[\s!.]*$/i;
export const WANTS_HUMAN = /\b(human|person|agent|call me|talk to (someone|somebody|staff))\b/i;
export const WANTS_BOOKING = /\b(book|booking|appointment|consult(ation)?)\b/i;
export const MY_APPOINTMENTS = /\b(my appointments?|reschedul\w*|cancel)\b/i;

/** "(ref: WEB-D1)" at the end of a prefilled website / QR message identifies where the chat started. */
export const SOURCE_TAG = /\(ref:\s*([A-Za-z0-9_-]{2,40})\)/;
