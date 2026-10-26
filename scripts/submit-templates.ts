/**
 * Creates every template in src/templates.ts in your WhatsApp Business Account for Meta review.
 * Needs WA_ACCESS_TOKEN and WA_BUSINESS_ACCOUNT_ID. Already existing names are reported and skipped.
 */
import { config } from '../src/config.js';
import { TEMPLATES } from '../src/templates.js';

if (!config.WA_ACCESS_TOKEN || !config.WA_BUSINESS_ACCOUNT_ID) {
  console.error('Set WA_ACCESS_TOKEN and WA_BUSINESS_ACCOUNT_ID in .env first.');
  process.exit(1);
}

for (const [name, t] of Object.entries(TEMPLATES)) {
  const components: unknown[] = [{ type: 'BODY', text: t.body, example: { body_text: [t.example] } }];
  if (t.buttons.length) components.push({ type: 'BUTTONS', buttons: t.buttons.map((b) => ({ type: 'QUICK_REPLY', text: b })) });
  const res = await fetch(`https://graph.facebook.com/${config.WA_API_VERSION}/${config.WA_BUSINESS_ACCOUNT_ID}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language: config.WA_TEMPLATE_LANGUAGE, category: t.category, components }),
  });
  const json: any = await res.json();
  console.log(res.ok ? `✓ ${name}: ${json.status ?? 'submitted'}` : `✗ ${name}: ${json.error?.error_user_msg ?? json.error?.message}`);
}
