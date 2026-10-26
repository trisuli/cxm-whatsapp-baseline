-- Content (edited by admins; loaded from db/seed/content.json by `npm run seed`)
create table specialties (
  id text primary key,
  name text not null,
  description text not null default '',
  keywords text not null default '',      -- comma separated; "pregnan*" = prefix match
  prep text not null default '',          -- visit preparation text sent after confirmation
  sort int not null default 0,
  active boolean not null default true
);

create table locations (
  id text primary key,
  name text not null,
  short_name text not null,
  address text not null,
  opd_hours text not null,
  where_to_go text not null,
  parking text not null,
  has_emergency boolean not null default false,
  lat double precision not null,
  lng double precision not null
);

create table doctors (
  id text primary key,
  name text not null,
  specialty_id text not null references specialties(id),
  qualifications text not null,
  experience_years int not null,
  location_id text not null references locations(id),
  opd_days int[] not null,                -- 0 = Sunday ... 6 = Saturday
  time_windows text[] not null,           -- m = morning, a = afternoon, e = evening
  fee int not null,
  languages text not null,
  active boolean not null default true
);

create table packages (
  id text primary key,
  name text not null,
  price int not null,
  tests text not null,
  duration text not null,
  prep text not null,
  location_id text not null references locations(id),
  active boolean not null default true
);

create table faqs (
  id text primary key,
  title text not null,                    -- max 24 characters (WhatsApp list row)
  answer text not null,
  keywords text not null default '',
  sort int not null default 0,
  active boolean not null default true
);

create table insurers (
  name text primary key,
  aliases text not null default ''        -- comma separated words patients type
);

-- Patients and conversations
create table patients (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique,
  profile_name text,
  name text,
  age int,
  gender text,
  uhid text,
  opted_out boolean not null default false,
  created_at timestamptz not null default now(),
  erased_at timestamptz
);

create table consents (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id),
  type text not null,                     -- service | offers
  given boolean not null,
  notice_version text not null,
  at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null unique references patients(id),
  mode text not null default 'bot',       -- bot | human
  context jsonb not null default '{}',
  source text,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id),
  direction text not null,                -- in | out
  wa_message_id text unique,
  type text not null,
  body jsonb not null,
  status text not null,
  template_name text,
  error text,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on messages(conversation_id, created_at);

-- Appointments (L0: request + staff confirmation)
create sequence request_ref_seq start 1001;

create table appointment_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  patient_id uuid not null references patients(id),
  doctor_id text references doctors(id),
  package_id text references packages(id),
  preferred_date date not null,
  time_window text not null,
  slot_time text,                          -- HH:MM once confirmed
  appointment_at timestamptz,
  offered_slot text,
  status text not null default 'new',      -- new | awaiting_patient | reschedule_requested | confirmed | arrived | no_show | cancelled
  patient_confirmed boolean not null default false,
  patient_name text not null,
  patient_age int,
  patient_gender text,
  for_other boolean not null default false,
  visit_type text not null default 'new',  -- new | existing
  uhid text,
  reason text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (doctor_id is not null or package_id is not null)
);
create index appointment_requests_status_idx on appointment_requests(status, created_at);

create table request_events (
  id bigserial primary key,
  request_id uuid not null references appointment_requests(id),
  actor text not null,                     -- patient | staff:<name> | system
  action text not null,
  details text,
  at timestamptz not null default now()
);

create table scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references appointment_requests(id),
  kind text not null,                      -- reminder_24h | reminder_3h
  send_at timestamptz not null,
  status text not null default 'pending',  -- pending | sent | cancelled | failed
  created_at timestamptz not null default now()
);
create index scheduled_messages_due_idx on scheduled_messages(status, send_at);

-- Live chat hand-offs
create table handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id),
  queue text not null,
  status text not null default 'waiting',  -- waiting | replied | resolved
  alert_type text,                         -- emergency
  alert_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table unanswered_questions (
  id bigserial primary key,
  conversation_id uuid references conversations(id),
  text text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

create table staff_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  role text not null default 'agent',      -- agent | supervisor | admin
  password_hash text not null,
  created_at timestamptz not null default now()
);
