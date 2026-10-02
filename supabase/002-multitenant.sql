-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002 — multi-tenant
--
-- Chaque client (Salim, etc.) est un "tenant" : son catalogue, ses clients, ses
-- commandes, ses factures, ses fournisseurs, ses réglages et son logo. Aucun
-- tenant ne voit les données d'un autre.
--
-- Isolation : tenant_id sur chaque table + clé primaire composite
-- (tenant_id, id). Le scoping est appliqué CENTRALEMENT dans lib/db.js — un
-- handler ne peut pas l'oublier — et RLS reste active en seconde barrière.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Les clients de la plateforme ────────────────────────────────────────────
create table if not exists dima_tenants (
  id          text primary key,                 -- ex: 'salim'
  doc         jsonb not null,                   -- { name, password, logo, active, ... }
  name        text generated always as (doc->>'name') stored,
  active      int  generated always as (nullif(doc->>'active','')::int) stored,
  created_at  timestamptz not null default now()
);
-- le mot de passe d'un tenant est sa clé de connexion : il doit être unique
create unique index if not exists dima_tenants_pwd_uniq
  on dima_tenants ((doc->>'password')) where doc->>'password' is not null;

-- ── Bibliothèque produits partagée (modèle, pas de tenant) ──────────────────
-- Sert à pré-remplir le catalogue d'un nouveau client. Chacun peut ensuite
-- renommer, supprimer, retarifer librement — principe « aucune standardisation
-- imposée ».
create table if not exists dima_library (
  id           text primary key,
  doc          jsonb not null,
  name         text generated always as (doc->>'name') stored,
  category     text generated always as (doc->>'category') stored,
  active       int  generated always as (nullif(doc->>'active','')::int) stored
);

-- ── Ajout de tenant_id + clé primaire composite ─────────────────────────────
do $$
declare
  t text;
  tables text[] := array['dima_skus','dima_clients','dima_suppliers','dima_orders',
                         'dima_invoices','dima_po','dima_settings','dima_counters'];
begin
  foreach t in array tables loop
    -- 1. colonne
    execute format('alter table %I add column if not exists tenant_id text', t);
    execute format('update %I set tenant_id = ''__legacy'' where tenant_id is null', t);
    execute format('alter table %I alter column tenant_id set not null', t);

    -- 2. clé primaire composite (id seul n'est plus unique : CMD-00001 existe
    --    chez chaque client)
    execute format('alter table %I drop constraint if exists %I', t, t || '_pkey');
    execute format('alter table %I add primary key (tenant_id, id)', t);

    -- 3. index menant par tenant_id
    execute format('create index if not exists %I on %I (tenant_id)', t || '_tenant_idx', t);
  end loop;
end $$;

-- l'unicité du mot de passe fournisseur est désormais PAR tenant
drop index if exists dima_suppliers_pwd_uniq;
create unique index if not exists dima_suppliers_pwd_uniq
  on dima_suppliers (tenant_id, (doc->>'password')) where doc->>'password' is not null;

-- ── Numérotation : compteurs par tenant ─────────────────────────────────────
drop function if exists dima_next_seq(text);
create or replace function dima_next_seq(p_tenant text, p_counter text)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into dima_counters (tenant_id, id, doc, value)
    values (p_tenant, p_counter, '{}'::jsonb, 1)
  on conflict (tenant_id, id) do update set value = dima_counters.value + 1
  returning value into v;
  return v;
end $$;

-- dima_counters a besoin d'une colonne doc (les autres tables l'ont déjà)
alter table dima_counters add column if not exists doc jsonb not null default '{}'::jsonb;

alter table dima_tenants enable row level security;
alter table dima_library enable row level security;
