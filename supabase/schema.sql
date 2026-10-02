-- ─────────────────────────────────────────────────────────────────────────────
-- Dima Fresh — schéma Supabase / PostgreSQL
--
-- NOTE: date-ish projections are TEXT, not date/timestamptz — those casts are
-- STABLE (DateStyle/TimeZone dependent) and Postgres rejects them in generated
-- columns. ISO-8601 text sorts and range-compares identically, which is exactly
-- how the adapter queries them.
--
-- Design note (deliberate): each entity is stored as `doc jsonb` with GENERATED
-- columns projecting the hot fields. Rationale:
--   • the application + the tested PO engine already speak a document API, so
--     this keeps 27 passing tests and every API handler unchanged;
--   • generated columns give real indexes, real types and a readable table in
--     the Supabase editor — you are not stuck reading raw JSON;
--   • promoting any field to a first-class column later is a migration, not a
--     rewrite, because the adapter only ever reads/writes `doc`.
-- What we give up vs. a fully normalised schema: foreign keys between entities.
-- Accepted for now; the invariants that actually matter (unique invoice number,
-- gapless counters) are enforced below.
--
-- Run this once in Supabase → SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Produits ────────────────────────────────────────────────────────────────
create table if not exists dima_skus (
  id            text primary key,                                   -- = itemId
  doc           jsonb not null,
  name          text        generated always as (doc->>'name') stored,
  category      text        generated always as (doc->>'category') stored,
  sub_category  text        generated always as (doc->>'subCategory') stored,
  uom           text        generated always as (doc->>'uom') stored,
  active        int         generated always as (nullif(doc->>'active','')::int) stored,
  price         numeric     generated always as (nullif(doc->>'price','')::numeric) stored,
  supplier_id   text        generated always as (doc->>'supplierId') stored,
  updated_at    timestamptz not null default now()
);
create index if not exists dima_skus_name_idx     on dima_skus using gin (to_tsvector('simple', coalesce(name,'')));
create index if not exists dima_skus_name_trgm    on dima_skus (lower(name) text_pattern_ops);
create index if not exists dima_skus_active_idx   on dima_skus (active, name);
create index if not exists dima_skus_supplier_idx on dima_skus (supplier_id);

-- ── Clients ─────────────────────────────────────────────────────────────────
create table if not exists dima_clients (
  id          text primary key,                                     -- = clientId
  doc         jsonb not null,
  name        text        generated always as (doc->>'name') stored,
  phone       text        generated always as (doc->>'phone') stored,
  city        text        generated always as (doc->>'city') stored,
  ice         text        generated always as (doc->>'ice') stored,
  updated_at  timestamptz not null default now()
);
create index if not exists dima_clients_name_idx  on dima_clients (lower(name) text_pattern_ops);
create index if not exists dima_clients_phone_idx on dima_clients (phone);

-- ── Fournisseurs ────────────────────────────────────────────────────────────
create table if not exists dima_suppliers (
  id          text primary key,                                     -- = supplierId
  doc         jsonb not null,
  name        text        generated always as (doc->>'name') stored,
  active      int         generated always as (nullif(doc->>'active','')::int) stored,
  updated_at  timestamptz not null default now()
);
-- a supplier password must be unique: it is the login credential
create unique index if not exists dima_suppliers_pwd_uniq
  on dima_suppliers ((doc->>'password')) where doc->>'password' is not null;

-- ── Commandes clients ───────────────────────────────────────────────────────
create table if not exists dima_orders (
  id           text primary key,                                    -- = orderId
  doc          jsonb not null,
  order_date   text        generated always as (doc->>'date') stored,
  created_at   text        generated always as (doc->>'createdAt') stored,
  client_name  text        generated always as (doc->'client'->>'name') stored,
  invoice_no   text        generated always as (doc->>'invoiceNo') stored,
  updated_at   timestamptz not null default now()
);
create index if not exists dima_orders_date_idx    on dima_orders (order_date);
create index if not exists dima_orders_created_idx on dima_orders (created_at desc);
create index if not exists dima_orders_client_idx  on dima_orders (lower(client_name) text_pattern_ops);
-- the PO engine filters order lines by supplier — index the array
create index if not exists dima_orders_lines_gin   on dima_orders using gin ((doc->'lines'));

-- ── Factures ────────────────────────────────────────────────────────────────
create table if not exists dima_invoices (
  id           text primary key,                                    -- = numero
  doc          jsonb not null,
  invoice_date text        generated always as (doc->>'date') stored,
  created_at   text        generated always as (doc->>'createdAt') stored,
  client_name  text        generated always as (doc->'client'->>'name') stored,
  net          numeric     generated always as (nullif(doc->>'net','')::numeric) stored,
  updated_at   timestamptz not null default now()
);
create index if not exists dima_invoices_created_idx on dima_invoices (created_at desc);
create index if not exists dima_invoices_client_idx  on dima_invoices (lower(client_name) text_pattern_ops);

-- ── Bons d'achat (PO) ───────────────────────────────────────────────────────
create table if not exists dima_po (
  id             text primary key,                                  -- = poId  (PO-YYYY-MM-DD)
  doc            jsonb not null,
  business_date  text        generated always as (doc->>'businessDate') stored,
  window_to      text        generated always as (doc->'window'->>'toISO') stored,
  status         text        generated always as (doc->>'status') stored,
  updated_at     timestamptz not null default now()
);
create index if not exists dima_po_window_idx on dima_po (window_to desc);
create index if not exists dima_po_date_idx   on dima_po (business_date desc);

-- ── Réglages + compteurs ────────────────────────────────────────────────────
create table if not exists dima_settings (
  id          text primary key,                                     -- 'app'
  doc         jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Gapless invoice/order numbering. Postgres does this correctly under
-- concurrency; the Mongo version relied on findOneAndUpdate semantics.
create table if not exists dima_counters (
  id          text primary key,
  value       bigint not null default 0,
  doc         jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create or replace function dima_next_seq(counter_id text)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into dima_counters (id, value) values (counter_id, 1)
    on conflict (id) do update set value = dima_counters.value + 1
    returning value into v;
  return v;
end $$;

-- ── Sécurité ────────────────────────────────────────────────────────────────
-- The app connects with the service role from server-side code only; the
-- anon/public key is never shipped to the browser. RLS is enabled with no
-- permissive policy so that a leaked anon key grants nothing.
alter table dima_skus      enable row level security;
alter table dima_clients   enable row level security;
alter table dima_suppliers enable row level security;
alter table dima_orders    enable row level security;
alter table dima_invoices  enable row level security;
alter table dima_po        enable row level security;
alter table dima_settings  enable row level security;
alter table dima_counters  enable row level security;
