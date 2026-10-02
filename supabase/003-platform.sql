-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003 — le compte plateforme possède son propre mot de passe
--
-- Jusqu'ici le super-admin se connectait avec APP_PASSWORD, une variable
-- d'environnement Vercel : impossible à changer depuis l'application, et le
-- mot de passe livré à l'installation restait valable pour toujours.
--
-- Désormais le mot de passe choisi par le propriétaire vit ici. Dès qu'il en
-- choisit un, celui livré à l'installation CESSE d'être accepté (voir
-- api/login.js) — un mot de passe transmis une fois ne doit pas rester une
-- porte ouverte.
--
-- Table plateforme : aucun tenant_id, elle est hors du périmètre des clients.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists dima_platform (
  id          text primary key,          -- 'admin'
  doc         jsonb not null,            -- { _id:'admin', password, updatedAt }
  updated_at  timestamptz not null default now()
);

alter table dima_platform enable row level security;
