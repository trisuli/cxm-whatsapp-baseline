import { q } from '../db.js';
import { windowLabel } from '../time.js';

export type Location = { id: string; name: string; short_name: string; address: string; opd_hours: string; where_to_go: string; parking: string; has_emergency: boolean; lat: number; lng: number };
export type Specialty = { id: string; name: string; description: string; keywords: string; prep: string };
export type Doctor = { id: string; name: string; specialty_id: string; qualifications: string; experience_years: number; location_id: string; opd_days: number[]; time_windows: string[]; fee: number; languages: string };
export type Package = { id: string; name: string; price: number; tests: string; duration: string; prep: string; location_id: string };
export type Faq = { id: string; title: string; answer: string; keywords: string };
export type Insurer = { name: string; aliases: string };
export type Content = { locations: Location[]; specialties: Specialty[]; doctors: Doctor[]; packages: Package[]; faqs: Faq[]; insurers: Insurer[] };

/** A bookable thing: a doctor ("d.<id>") or a health check package ("p.<id>"). */
export type Service = {
  id: string; kind: 'doctor' | 'package'; name: string; label: string; specialty?: Specialty;
  location: Location; days: number[]; windows: string[]; fee: number; prep: string;
};

let cache: { at: number; data: Content } | null = null;
const TTL_MS = 60_000;

export async function content(): Promise<Content> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const [locations, specialties, doctors, packages, faqs, insurers] = await Promise.all([
    q<Location>('select * from locations order by id'),
    q<Specialty>('select * from specialties where active order by sort, name'),
    q<Doctor>('select * from doctors where active order by name'),
    q<Package>('select * from packages where active order by price desc'),
    q<Faq>('select * from faqs where active order by sort, id'),
    q<Insurer>('select * from insurers order by name'),
  ]);
  cache = { at: Date.now(), data: { locations, specialties, doctors, packages, faqs, insurers } };
  return cache.data;
}

export const invalidateContent = () => { cache = null; };

export const rupee = (n: number) => '₹' + n.toLocaleString('en-IN');

export function service(c: Content, id: string | null | undefined): Service | undefined {
  if (!id) return undefined;
  const [kind, key] = id.split('.');
  if (kind === 'd') {
    const d = c.doctors.find((x) => x.id === key);
    if (!d) return undefined;
    const sp = c.specialties.find((s) => s.id === d.specialty_id)!;
    return { id, kind: 'doctor', name: d.name, label: `${d.name}, ${sp.name}`, specialty: sp, location: c.locations.find((l) => l.id === d.location_id)!,
      days: d.opd_days, windows: d.time_windows, fee: d.fee, prep: sp.prep };
  }
  if (kind === 'p') {
    const p = c.packages.find((x) => x.id === key);
    if (!p) return undefined;
    return { id, kind: 'package', name: p.name, label: `${p.name} (health check)`, location: c.locations.find((l) => l.id === p.location_id)!,
      days: [1, 2, 3, 4, 5, 6], windows: ['m'], fee: p.price, prep: p.prep };
  }
  return undefined;
}

export const serviceIdOf = (r: { doctor_id: string | null; package_id: string | null }) => (r.doctor_id ? `d.${r.doctor_id}` : `p.${r.package_id}`);

export function describeWindows(s: Service) { return s.windows.map(windowLabel).join(' and '); }

/**
 * Comma-separated keywords, whole-word match; a trailing * makes it a prefix ("pregnan*").
 * Returns the first keyword that matched, or null.
 */
export function matchKeywords(text: string, csv: string): string | null {
  const t = ` ${text.toLowerCase()} `;
  for (const raw of csv.split(',')) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const stem = k.endsWith('*');
    const word = (stem ? k.slice(0, -1) : k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`[^a-z0-9]${word}${stem ? '' : '(?=[^a-z0-9])'}`).test(t)) return k;
  }
  return null;
}
