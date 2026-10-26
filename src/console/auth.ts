import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one } from '../db.js';

export type Staff = { id: string; name: string; email: string; role: 'agent' | 'supervisor' | 'admin' };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split(':');
  const given = crypto.scryptSync(password, salt, 64);
  return given.length === Buffer.from(hash, 'hex').length && crypto.timingSafeEqual(given, Buffer.from(hash, 'hex'));
}

const sign = (v: string) => crypto.createHmac('sha256', config.SESSION_SECRET).update(v).digest('base64url');
const TTL_MS = 12 * 3600e3;

export function sessionToken(staffId: string): string {
  const v = `${staffId}.${Date.now() + TTL_MS}`;
  return `${v}.${sign(v)}`;
}

export async function staffFromRequest(req: FastifyRequest): Promise<Staff | undefined> {
  const token = req.cookies?.cxm_session;
  if (!token) return undefined;
  const [id, exp, sig] = token.split('.');
  const v = `${id}.${exp}`;
  if (!sig || sig.length !== sign(v).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(v))) || Number(exp) < Date.now()) return undefined;
  return one<Staff>('select id, name, email, role from staff_users where id = $1', [id]);
}

/** Fastify preHandler: 401 unless signed in with one of the roles. */
export const requireStaff = (...roles: Staff['role'][]) => async (req: FastifyRequest, reply: FastifyReply) => {
  const staff = await staffFromRequest(req);
  if (!staff) return reply.code(401).send({ error: 'Please sign in' });
  if (roles.length && !roles.includes(staff.role)) return reply.code(403).send({ error: 'Your role cannot do this' });
  (req as any).staff = staff;
};
