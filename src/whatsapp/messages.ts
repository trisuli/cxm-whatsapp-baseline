/**
 * Outgoing message shapes, their WhatsApp Cloud API payloads, and Meta's size limits.
 * validate() runs before every send: Meta rejects messages that break these limits.
 */
export type Button = { id: string; title: string };
export type ListRow = { id: string; title: string; description?: string };
export type ListSection = { title: string; rows: ListRow[] };

export type OutMsg =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: Button[]; header?: string; footer?: string }
  | { kind: 'list'; text: string; button: string; sections: ListSection[]; header?: string; footer?: string }
  | { kind: 'location'; lat: number; lng: number; name: string; address: string }
  | { kind: 'flow'; text: string; cta: string; flowId: string; flowToken: string; screen: string; data: Record<string, unknown> }
  | { kind: 'template'; name: string; language: string; bodyParams: string[]; buttonPayloads?: string[] };

export const LIMITS = {
  body: 1024, header: 60, footer: 60, buttons: 3, buttonTitle: 20, buttonId: 256,
  listButton: 20, listRows: 10, sectionTitle: 24, rowTitle: 24, rowDescription: 72, text: 4096,
};

export const text = (t: string): OutMsg => ({ kind: 'text', text: t });
export const buttons = (t: string, b: Button[], extra: { header?: string; footer?: string } = {}): OutMsg => ({ kind: 'buttons', text: t, buttons: b, ...extra });
export const list = (t: string, button: string, sections: ListSection[], extra: { header?: string; footer?: string } = {}): OutMsg => ({ kind: 'list', text: t, button, sections, ...extra });

export function validate(m: OutMsg): void {
  const fail = (what: string, value: string | number, max: number) => {
    throw new Error(`WhatsApp limit: ${what} is ${typeof value === 'string' ? value.length : value} (max ${max}): ${typeof value === 'string' ? JSON.stringify(value) : ''}`);
  };
  const len = (what: string, s: string | undefined, max: number) => { if (s && s.length > max) fail(what, s, max); };
  switch (m.kind) {
    case 'text': len('text', m.text, LIMITS.text); break;
    case 'buttons':
      len('body', m.text, LIMITS.body); len('header', m.header, LIMITS.header); len('footer', m.footer, LIMITS.footer);
      if (m.buttons.length < 1 || m.buttons.length > LIMITS.buttons) fail('button count', m.buttons.length, LIMITS.buttons);
      m.buttons.forEach((b) => { len('button title', b.title, LIMITS.buttonTitle); len('button id', b.id, LIMITS.buttonId); });
      if (new Set(m.buttons.map((b) => b.id)).size !== m.buttons.length) throw new Error('WhatsApp limit: button ids must be unique');
      break;
    case 'list': {
      len('body', m.text, LIMITS.body); len('header', m.header, LIMITS.header); len('footer', m.footer, LIMITS.footer);
      len('list button', m.button, LIMITS.listButton);
      const rows = m.sections.flatMap((s) => s.rows);
      if (rows.length < 1 || rows.length > LIMITS.listRows) fail('list rows', rows.length, LIMITS.listRows);
      m.sections.forEach((s) => len('section title', s.title, LIMITS.sectionTitle));
      rows.forEach((r) => { len('row title', r.title, LIMITS.rowTitle); len('row description', r.description, LIMITS.rowDescription); });
      break;
    }
    case 'flow': len('body', m.text, LIMITS.body); len('flow cta', m.cta, LIMITS.buttonTitle); break;
    default: break;
  }
}

/** Graph API request body for POST /{phone-number-id}/messages */
export function toPayload(to: string, m: OutMsg): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  const hdr = (h?: string) => (h ? { header: { type: 'text', text: h } } : {});
  const ftr = (f?: string) => (f ? { footer: { text: f } } : {});
  switch (m.kind) {
    case 'text':
      return { ...base, type: 'text', text: { body: m.text, preview_url: false } };
    case 'buttons':
      return { ...base, type: 'interactive', interactive: { type: 'button', ...hdr(m.header), body: { text: m.text }, ...ftr(m.footer),
        action: { buttons: m.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } };
    case 'list':
      return { ...base, type: 'interactive', interactive: { type: 'list', ...hdr(m.header), body: { text: m.text }, ...ftr(m.footer),
        action: { button: m.button, sections: m.sections } } };
    case 'location':
      return { ...base, type: 'location', location: { latitude: m.lat, longitude: m.lng, name: m.name, address: m.address } };
    case 'flow':
      return { ...base, type: 'interactive', interactive: { type: 'flow', body: { text: m.text }, action: { name: 'flow', parameters: {
        flow_message_version: '3', flow_id: m.flowId, flow_token: m.flowToken, flow_cta: m.cta, flow_action: 'navigate',
        flow_action_payload: { screen: m.screen, data: m.data } } } } };
    case 'template': {
      const components: unknown[] = [];
      if (m.bodyParams.length) components.push({ type: 'body', parameters: m.bodyParams.map((t) => ({ type: 'text', text: t })) });
      (m.buttonPayloads ?? []).forEach((payload, index) =>
        components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] }));
      return { ...base, type: 'template', template: { name: m.name, language: { code: m.language }, components } };
    }
  }
}
