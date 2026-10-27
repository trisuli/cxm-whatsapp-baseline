import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
 ANTHROPIC_API_KEY: z.string().default(''),
  WA_PHONE_NUMBER_ID: z.string().default(''),
  WA_BUSINESS_ACCOUNT_ID: z.string().default(''),
  WA_ACCESS_TOKEN: z.string().default(''),
  WA_APP_SECRET: z.string().default(''),
  WA_VERIFY_TOKEN: z.string().default('change-me'),
  WA_API_VERSION: z.string().default('v23.0'),
  WA_DRY_RUN: bool.default('true'),
  WA_BOOKING_FLOW_ID: z.string().default(''),
  WA_TEMPLATE_LANGUAGE: z.string().default('en'),

  HOSPITAL_NAME: z.string().default('Sunrise Multispeciality Hospital'),
  HOSPITAL_SHORT_NAME: z.string().default('Sunrise Hospital'),
  EMERGENCY_PHONE: z.string().default('040 4000 0000'),
  PRIVACY_URL: z.string().default('https://example.com/privacy'),
  CONSENT_NOTICE_VERSION: z.string().default('2026-10'),
  REF_PREFIX: z.string().default('SNR'),
  CONFIRM_SLA_MINUTES: z.coerce.number().default(30),

  ADMIN_EMAIL: z.string().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().default(''),
  DEV_SIMULATOR: bool.default('false'),
});

export const config = schema.parse(process.env);

if (!config.WA_DRY_RUN) {
  for (const key of ['WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'WA_APP_SECRET'] as const) {
    if (!config[key]) throw new Error(`${key} is required when WA_DRY_RUN=false`);
  }
}
