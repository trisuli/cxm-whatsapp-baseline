# CXM WhatsApp Concierge — baseline

A working starter for the **Discover** and **Access (L0)** phases of a hospital's patient journey on WhatsApp, built on Meta's **WhatsApp Cloud API** (no BSP).

It already does the whole prototype journey end to end, with tests. Your job is to **connect the dots**: Meta accounts, real hospital content, hosting, and the hospital's sign-off. See [Connect the dots](#connect-the-dots).

- Clickable prototype (the spec): https://claude.ai/artifact/93oYn9MbQLyssLVNrtbj9T
- Developer guide (background and WhatsApp rules): https://claude.ai/code/artifact/732d6ff1-86f4-46aa-8090-e50b8fb8c244

## What's already built

| Area | What works |
| --- | --- |
| WhatsApp | Webhook verify (GET) and events (POST) with `X-Hub-Signature-256` check, duplicate-delivery protection, read receipts, delivery status updates, text / buttons / lists / location / Flow / template sending, Meta size limits checked before every send |
| Discover | Consent first (DPDP), main menu, find a doctor by speciality, name or symptom, doctor cards, packages, insurance, locations, FAQs, "talk to a person", source tracking (Click-to-WhatsApp ads and `(ref: CODE)` tags) |
| Safety | Emergency phrases checked first on every message (alert in the console), medical-advice refusal, unknown questions logged rather than guessed, STOP / START opt-out |
| Access (L0) | Booking request inside the chat (date list → time window → patient details → review), optional WhatsApp Flow instead, staff confirm or offer another time, confirmation + preparation message, reminders 24 h and 3 h before, patient confirm / reschedule / cancel, no-show rebooking |
| 24-hour rule | Every business-started message checks the window: free interactive message inside it, approved template outside it |
| Staff console | Login, request queue with SLA timer, request detail with slots, all staff actions, live chats with reply / resolve, emergency alerts, metrics, and a **Simulator** to chat as a patient without WhatsApp |
| Ops | Postgres schema + migrations, content seeding from JSON, template submission script, Dockerfile, 15 automated tests |

## Run it locally (about 10 minutes)

Needs Node 22+ and Docker (or any Postgres 16).

```bash
cp .env.example .env            # then set SESSION_SECRET to 32+ random characters and ADMIN_PASSWORD
docker compose up -d db         # Postgres on localhost:5432
npm install
npm run seed                    # creates tables, loads sample content, creates the admin user
npm test                        # 15 tests should pass
npm run dev                     # http://localhost:3000
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, open the **Simulator** tab and type `hi`. Book an appointment, then confirm it under **Appointment requests** and watch what the patient receives. `npm run chat` does the same in the terminal.

`WA_DRY_RUN=true` (the default) means nothing is sent to Meta. Outgoing messages are only stored and shown in the simulator.

## Connect the dots

Work through these in order. Hands-on time is about **10–12 working days**. The calendar time depends mostly on Meta's verification and the hospital's content and sign-off, so start steps 1 and 3 on day 1.

- [ ] **1. Meta setup (1 day + Meta's review time).** Create a Meta Business portfolio and start business verification. Create a developer app, add WhatsApp, and note the test number's **Phone number ID** and **WhatsApp Business Account ID**. Create a **System User** with a permanent token (`whatsapp_business_messaging`, `whatsapp_business_management`). Copy the **App secret**. Put all four in `.env`.
- [ ] **2. Webhook on your laptop (½ day).** Expose port 3000 (for example `ngrok http 3000`). In the app's WhatsApp > Configuration, set the callback URL to `https://<your-tunnel>/webhook` and the verify token to `WA_VERIFY_TOKEN`, then subscribe to the **messages** field. Set `WA_DRY_RUN=false`, add your phone as a test recipient, and send "hi" to the test number.
- [ ] **3. Hospital content (1–2 days of your time, plus the hospital's).** Copy `db/seed/content.json`, replace every sample entry with approved content (doctors, OPD days, fees, FAQs, packages, preparation text, insurers, locations with real coordinates, `has_emergency` on the ER site). Run `npm run seed -- path/to/hospital.json`. The seed refuses titles longer than WhatsApp allows.
- [ ] **4. Hospital settings (1 hour).** Set `HOSPITAL_NAME`, `HOSPITAL_SHORT_NAME`, `EMERGENCY_PHONE`, `PRIVACY_URL` (a real, published privacy notice), `REF_PREFIX`, `CONSENT_NOTICE_VERSION`.
- [ ] **5. Templates (½ day + up to 24 h review).** `npm run templates:submit`. Check their status in WhatsApp Manager. If one is rejected, reword it in `src/templates.ts` (keep the variable order) and submit again.
- [ ] **6. Deploy (2–3 days).** Build the Docker image and run it in an India region (for example AWS Mumbai: ECS or one EC2, plus RDS Postgres with encryption and daily backups). Put it behind HTTPS on a domain. Store secrets in the cloud's secrets manager. In production set `WA_DRY_RUN=false` and **`DEV_SIMULATOR=false`**. Point the Meta webhook at `https://<domain>/webhook`.
- [ ] **7. Production number (½ day + Meta).** Add the hospital's number in WhatsApp Manager, set the display name, set a two-step verification PIN, then switch `WA_PHONE_NUMBER_ID` to it.
- [ ] **8. Staff (½ day).** `npm run add-staff -- "Name" email agent 'password'` for each person. Agree who watches the Emergency and Insurance queues.
- [ ] **9. Monitoring (1 day).** Add error tracking (for example Sentry) and alerts on failed sends (`messages.status = 'failed'`), failed reminders (`scheduled_messages.status = 'failed'`), and the `/health` endpoint.
- [ ] **10. UAT and go-live (3–5 days).** Run the hospital through the prototype's flows on the test number, fix wording, then put the production `wa.me` link on the website, Google listing and QR codes. Use `(ref: CODE)` at the end of each prefilled message to track the source, for example `https://wa.me/91XXXXXXXXXX?text=Hi%2C%20I%27d%20like%20to%20book%20with%20Dr.%20Rao%20(ref%3A%20WEB-D1)`.

**Optional: WhatsApp Flow booking form (1–2 days).** Upload `flows/booking-flow.json` in WhatsApp Manager > Flows, fix anything the Flow Builder flags for its current JSON version, publish it, and set `WA_BOOKING_FLOW_ID`. Booking then opens the form instead of the in-chat steps. The response is handled by `flowSubmitted()` in `src/engine/engine.ts`.

### Not built yet (deliberately)

- A content admin screen: content is edited in JSON and loaded with `npm run seed`.
- 2FA for staff logins (login is rate-limited and cookies are signed and HTTP-only).
- Live slots (L1) or writing bookings into the HIS (L2): staff book in the HIS by hand, then confirm here.
- Multiple hospitals in one install, multiple languages, payments, ABHA.

## Revised timeline

| | Without this baseline | With this baseline |
| --- | --- | --- |
| One new developer | ~12 weeks | **~3–4 weeks** (10–12 days hands-on; the rest is waiting on Meta and the hospital) |
| Experienced WhatsApp developer | ~6 weeks | ~2 weeks |

## Project map

```
src/
  server.ts              Fastify app: webhook, console API, static console, reminder loop
  config.ts              all settings, from .env
  db.ts                  Postgres pool + migration runner
  time.ts                IST dates, OPD days, slots
  templates.ts           Meta message templates (names, text, buttons) + builder
  whatsapp/
    webhook.ts           verify, signature check, payload parsing
    client.ts            Graph API sends (or dry run), stores every message
    messages.ts          message shapes, Graph payloads, Meta size limits
  engine/
    engine.ts            the conversation: Discover, booking, guardrails, hand-off
    intents.ts           emergency / medical-advice / greeting patterns
    content.ts           doctors, specialities, FAQs... cached from the database
  services/
    requests.ts          appointment requests: staff + patient actions, confirmations, reminders
    notify.ts            24-hour window: interactive inside, template outside
    handoffs.ts          live chats
    patients.ts          patients, consent, opt-out, DPDP erasure
    scheduler.ts         sends due reminders every 30 s
  console/
    routes.ts            staff API
    auth.ts              staff login (scrypt passwords, signed cookie)
    dev.ts               simulator routes (DEV_SIMULATOR only)
public/console.html      staff console (no build step)
db/migrations/           SQL migrations, applied on start and by npm run migrate
db/seed/content.json     SAMPLE hospital content (replace before go-live)
flows/booking-flow.json  optional WhatsApp Flow for booking
scripts/                 seed, add-staff, submit templates, terminal chat
test/                    intents, webhook parsing, full patient journeys
```

## How a message flows

1. Meta calls `POST /webhook`. The signature is checked and Meta gets `200` at once.
2. `parseWebhook()` turns the payload into an `Inbound` event. Status updates go straight to the `messages` table.
3. `handleInbound()` saves the message (a repeat `wa_message_id` is ignored), loads the patient's conversation state, and runs one `Turn`.
4. The turn checks emergency first, then human mode, consent, booking steps, and finally intent matching. It collects replies.
5. Replies are sent in order with `sendMessage()`, which validates them against Meta's limits and stores them.
6. Staff actions in the console call `services/requests.ts`, which uses `notifyPatient()` to pick an interactive message or a template depending on the 24-hour window.

## Safety rules for anyone changing the bot

- Never move the emergency check below anything else in `understand()`.
- Every answer must come from the content tables. If there is no approved answer, log it and offer a person.
- Never put diagnoses, test results or other clinical details in a template.
- Add every new emergency or medical-advice phrase to `test/intents.test.ts`.
- Logs must not contain message text, names or phone numbers.
