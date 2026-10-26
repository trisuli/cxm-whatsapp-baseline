/**
 * Loads hospital content from db/seed/content.json (or the file given) and creates the first admin.
 * Safe to run again: content rows are upserted, and anything no longer in the file is deactivated.
 *   npm run seed                      # sample content
 *   npm run seed -- path/to/real.json # the hospital's approved content
 */
import fs from 'node:fs';
import { config } from '../src/config.js';
import { migrate, pool, q } from '../src/db.js';
import { hashPassword } from '../src/console/auth.js';
import { validate } from '../src/whatsapp/messages.js';

const file = process.argv[2] ?? 'db/seed/content.json';
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
await migrate();

// WhatsApp list rows allow 24 characters: check titles before they reach patients.
for (const [what, rows, key] of [['specialty', c.specialties, 'name'], ['FAQ', c.faqs, 'title'], ['package', c.packages, 'name'], ['doctor', c.doctors, 'name']] as const) {
  for (const r of rows) validate({ kind: 'list', text: 'x', button: 'x', sections: [{ title: 'x', rows: [{ id: 'x', title: r[key] }] }] });
  void what;
}

async function upsert(table: string, rows: Record<string, unknown>[], pk = 'id') {
  for (const [i, row] of rows.entries()) {
    const r = { ...row, ...(table === 'specialties' || table === 'faqs' ? { sort: i } : {}) };
    const cols = Object.keys(r);
    const hasActive = ['specialties', 'doctors', 'packages', 'faqs'].includes(table);
    await q(`insert into ${table} (${cols.join(',')}${hasActive ? ',active' : ''}) values (${cols.map((_, j) => `$${j + 1}`).join(',')}${hasActive ? ',true' : ''})
      on conflict (${pk}) do update set ${cols.filter((k) => k !== pk).map((k) => `${k} = excluded.${k}`).join(', ')}${hasActive ? ', active = true' : ''}`, cols.map((k) => r[k]));
  }
  if (['specialties', 'doctors', 'packages', 'faqs'].includes(table)) {
    await q(`update ${table} set active = false where not (${pk} = any($1))`, [rows.map((r) => r[pk])]);
  }
}

await upsert('locations', c.locations);
await upsert('specialties', c.specialties);
await upsert('doctors', c.doctors);
await upsert('packages', c.packages);
await upsert('faqs', c.faqs);
await upsert('insurers', c.insurers, 'name');
console.log(`Content loaded from ${file}: ${c.doctors.length} doctors, ${c.specialties.length} specialities, ${c.faqs.length} FAQs, ${c.packages.length} packages`);

if (config.ADMIN_PASSWORD) {
  const res = await q(`insert into staff_users (name, email, role, password_hash) values ('Admin', $1, 'admin', $2) on conflict (email) do nothing returning id`,
    [config.ADMIN_EMAIL, hashPassword(config.ADMIN_PASSWORD)]);
  console.log(res.length ? `Admin created: ${config.ADMIN_EMAIL}` : `Admin ${config.ADMIN_EMAIL} already exists`);
}
await pool.end();
