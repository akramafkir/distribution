# Dima Fresh — mise en route Supabase (10 min)

Le code est prêt. Il reste 4 étapes, dont 2 que **toi seul** peux faire (elles impliquent un mot de passe).

---

## 1. Créer le projet Supabase — 3 min

1. **supabase.com/dashboard** → *New project*
2. Name : `dima-fresh`
3. **Region : `eu-west-3 (Paris)`** ou `eu-central-1 (Frankfurt)` — le plus proche du Maroc
4. **Database password** : génère-le et **garde-le** (Supabase ne le remontre pas)
5. Plan : **Free**

> ℹ️ Le plan gratuit met un projet en pause après ~7 jours **sans activité**. Le cron du bon d'achat tape la base chaque nuit, donc le projet reste actif. Pas de souci ici.

---

## 2. Créer les tables — 1 min

Supabase → **SQL Editor** → *New query* → colle tout le contenu de :

```
dima-fresh/supabase/schema.sql
```

→ **Run**. Tu dois voir `Success. No rows returned`.

Ça crée 8 tables (`dima_skus`, `dima_clients`, `dima_suppliers`, `dima_orders`, `dima_invoices`, `dima_po`, `dima_settings`, `dima_counters`), leurs index, la fonction de numérotation `dima_next_seq`, et active RLS.

---

## 3. Récupérer la chaîne de connexion — 1 min

Supabase → **Project Settings** → **Database** → *Connection string* → onglet **Transaction pooler**

⚠️ **Prends bien le "Transaction pooler" (port 6543), pas le port 5432.**
Les fonctions serverless ouvrent beaucoup de connexions courtes ; le port direct sature la limite et l'app tombera de façon aléatoire.

Ça ressemble à :
```
postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-eu-west-3.pooler.supabase.com:6543/postgres
```
Remplace `[YOUR-PASSWORD]` par le mot de passe de l'étape 1, et ajoute `?sslmode=require` à la fin.

### Mets-la dans un fichier local (jamais dans le chat)
Crée `dima-fresh/.env` (déjà dans `.gitignore`) :

```
DATABASE_URL="postgresql://...:6543/postgres?sslmode=require"
APP_PASSWORD="le-mot-de-passe-de-l-equipe"
APP_TOKEN="une-longue-chaine-aleatoire"
CRON_SECRET="une-autre-longue-chaine-aleatoire"
```

Pour générer les deux secrets :
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Charger le catalogue

```bash
cd "C:\Users\Yola fresh\Desktop\antigravity agent\dima-fresh"
npm run seed:demo
```

Charge **945 produits** (catalogue étendu, noms FR+AR, prix indicatifs) + les réglages + les compteurs + 3 fournisseurs de démo.
`npm run seed` sans `:demo` = sans les fournisseurs de démo.

**Les clients ne sont pas importés, volontairement** — chaque vendeur saisit les siens (loi 09-08 / CNDP). Voir `YolaFresh-Marketplace-DATA/LISEZ-MOI.md`.

---

## 5. Déploiement Vercel (je peux le faire)

Une fois `.env` en place, dis-le-moi et je m'occupe de :
- pousser les 4 variables sur Vercel (compte perso `akramafkir@gmail.com`)
- déployer
- vérifier le flux complet en production
- déclencher un premier bon d'achat pour contrôler le cron

Le cron est déjà configuré dans `vercel.json` : `0 0 * * *` UTC = **01:00 à Casablanca**.

---

## Vérifications utiles

```bash
npm test          # 27 tests du calcul d'achat + 14 tests de traduction SQL
npm run demo      # serveur local sur http://localhost:3050 (mémoire, sans base)
```

Après le seed, la base doit contenir :
| Table | Attendu |
|---|---|
| `dima_skus` | 945 |
| `dima_suppliers` | 3 (si `--demo`) |
| `dima_clients` | **0** — normal |
| `dima_settings` | 1 (`app`) |
| `dima_counters` | 2 (`invoice`, `order`) |

---

## Note d'architecture

Chaque entité est stockée en `doc jsonb` avec des **colonnes générées** qui projettent les champs chauds (`name`, `active`, `order_date`, `client_name`…). Raison : l'app et le moteur de calcul d'achat — 27 tests au vert — parlent déjà une API document ; ce choix évite de les réécrire tout en gardant de vrais index, de vrais types et des tables lisibles dans l'éditeur Supabase.

Ce qu'on perd par rapport à un schéma entièrement normalisé : les clés étrangères entre entités. Accepté pour l'instant. Les invariants qui comptent vraiment (numéro de facture unique, compteurs sans trou) sont, eux, garantis par Postgres — `dima_next_seq()` est atomique, ce que l'ancienne version Mongo ne garantissait pas aussi proprement.
