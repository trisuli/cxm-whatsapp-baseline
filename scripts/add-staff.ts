/**
 * Adds a staff user or resets their password.
 *   npm run add-staff -- "Priya Nair" priya@hospital.in agent 'a-strong-password'
 * Roles: agent (requests + chats), supervisor (same, for now), admin (also patient erasure).
 */
import { pool, q } from '../src/db.js';
import { hashPassword } from '../src/console/auth.js';

const [name, email, role, password] = process.argv.slice(2);
if (!name || !email || !['agent', 'supervisor', 'admin'].includes(role) || !password || password.length < 10) {
  console.error('Usage: npm run add-staff -- "<name>" <email> <agent|supervisor|admin> <password of 10+ characters>');
  process.exit(1);
}
await q(`insert into staff_users (name, email, role, password_hash) values ($1, $2, $3, $4)
  on conflict (email) do update set name = excluded.name, role = excluded.role, password_hash = excluded.password_hash`, [name, email.toLowerCase(), role, hashPassword(password)]);
console.log(`Saved ${email} as ${role}`);
await pool.end();
