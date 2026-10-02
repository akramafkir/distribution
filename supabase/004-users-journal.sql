-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004 — utilisateurs nommés + journal d'activité
--
-- Jusqu'ici toute l'équipe d'un client partageait UN mot de passe et le nom
-- affiché était du texte libre tapé à la connexion : impossible de savoir qui
-- a réellement fait quoi. Désormais :
--   · dima_users : chaque membre a son propre mot de passe ; le serveur sait
--     qui agit (l'identité voyage dans le jeton signé, pas dans le formulaire).
--   · dima_logs  : chaque action d'écriture est journalisée côté serveur —
--     qui, quand, quoi, sur quel objet.
-- Les deux tables sont PAR CLIENT (tenant), comme le reste du métier.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists dima_users (
  tenant_id   text not null,
  id          text not null,
  doc         jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists dima_users_tenant_idx on dima_users (tenant_id);
-- Le mot de passe EST l'identifiant de connexion : il doit être unique dans
-- TOUTE la base (deux clients ne peuvent pas avoir le même), sinon la
-- connexion ouvrirait l'espace du mauvais client.
create unique index if not exists dima_users_pwd_uniq
  on dima_users ((doc->>'password')) where doc->>'password' is not null;

create table if not exists dima_logs (
  tenant_id   text not null,
  id          text not null,
  doc         jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists dima_logs_tenant_idx on dima_logs (tenant_id);

alter table dima_users enable row level security;
alter table dima_logs  enable row level security;
