/** Dates and slots in hospital local time (IST, UTC+05:30). */
const OFFSET_MIN = 330;
const OFFSET = '+05:30';

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const WINDOWS: Record<string, { name: string; range: string; from: number; to: number }> = {
  m: { name: 'Morning', range: '9 am–12 pm', from: 9, to: 12 },
  a: { name: 'Afternoon', range: '12–4 pm', from: 12, to: 16 },
  e: { name: 'Evening', range: '4–8 pm', from: 16, to: 20 },
};
export const windowLabel = (w: string) => `${WINDOWS[w].name} (${WINDOWS[w].range})`;

/** Today's date in IST as YYYY-MM-DD. */
export function todayIso(now = Date.now()): string {
  return new Date(now + OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** The next `n` dates (from tomorrow) on which the doctor holds OPD. */
export function nextOpdDates(days: number[], n = 8, now = Date.now()): string[] {
  const out: string[] = [];
  const today = todayIso(now);
  for (let i = 1; out.length < n && i <= 60; i++) {
    const d = addDays(today, i);
    if (days.includes(weekday(d))) out.push(d);
  }
  return out;
}

/** 15-minute slots for the given windows, as HH:MM. */
export function slotsFor(windows: string[]): string[] {
  const out: string[] = [];
  for (const w of windows) {
    for (let h = WINDOWS[w].from; h < WINDOWS[w].to; h++) {
      for (let m = 0; m < 60; m += 15) out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return out;
}

export function t12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

export const appointmentAt = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00${OFFSET}`);
