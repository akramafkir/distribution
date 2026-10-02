// Facade kept at its original path so every api/*.js import stays unchanged.
// The storage engine now lives in lib/db.js (Supabase / PostgreSQL); this file
// owns collection names, auth and date helpers.
import { createHmac, timingSafeEqual } from 'node:crypto';
export { getDb, nextSeq, passwordInUse, tenantActive } from './db.js';

export const COL = {
  skus: 'dima_skus',
  clients: 'dima_clients',
  invoices: 'dima_invoices',
  settings: 'dima_settings',
  counters: 'dima_counters',
  suppliers: 'dima_suppliers',
  orders: 'dima_orders',
  po: 'dima_po',
  tenants: 'dima_tenants',
  library: 'dima_library',
  platform: 'dima_platform',
  users: 'dima_users',
  logs: 'dima_logs',
};

/**
 * Mot de passe du compte plateforme (super-admin).
 * Deux sources, dans cet ordre :
 *   1. celui que le propriétaire a choisi dans l'application (base) ;
 *   2. sinon celui livré à l'installation (APP_PASSWORD, variable Vercel).
 * `chosen` distingue les deux : tant qu'il est faux, l'application invite à
 * choisir un mot de passe personnel.
 */
export async function platformPassword() {
  const fallback = process.env.APP_PASSWORD || '';
  try {
    const { getDb } = await import('./db.js');
    const db = await getDb(null);
    const rec = await db.collection('dima_platform').findOne({ _id: 'admin' });
    if (rec?.password) return { password: rec.password, chosen: true };
  } catch {
    // base injoignable : on retombe sur APP_PASSWORD, seule voie de secours
  }
  return { password: fallback, chosen: false };
}

// Business day in Casablanca. Morocco moves between UTC+0 and UTC+1 (Ramadan),
// so the offset is never hardcoded — the IANA zone resolves it. en-CA formats
// as YYYY-MM-DD.
export function casaDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(d);
}

/** Shift a 'YYYY-MM-DD' by n days (calendar arithmetic, no timezone involved). */
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token');
}

// ── Stateless auth ───────────────────────────────────────────────────────────
// Three kinds of principal, all verifiable without server state — serverless runs
// many instances and an in-memory session map would 401 at random.
//   admin    → the APP_TOKEN secret itself (plateforme : crée les clients)
//   team     → "t.<tenantId>.<hmac>"            (l'équipe d'un client)
//   supplier → "sup.<tenantId>.<supplierId>.<hmac>"
//
// The tenant is carried IN the token and signed, so it cannot be swapped by the
// caller — sending someone else's tenantId simply fails the HMAC.
function sign(payload) {
  return createHmac('sha256', process.env.APP_TOKEN || '').update(payload).digest('hex').slice(0, 32);
}
export function teamToken(tenantId) {
  return `t.${tenantId}.${sign('team:' + tenantId)}`;
}
export function supplierToken(tenantId, supplierId) {
  return `sup.${tenantId}.${supplierId}.${sign('sup:' + tenantId + ':' + supplierId)}`;
}
/** Membre nommé de l'équipe : l'identité voyage DANS le jeton, signée — c'est
 *  elle qui alimente le journal, pas un nom tapé librement à la connexion. */
export function userToken(tenantId, userId) {
  return `u.${tenantId}.${userId}.${sign('user:' + tenantId + ':' + userId)}`;
}

function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

/** Returns the principal, or null after having already sent 401.
 *  Usage: `const u = await requireAuth(req, res); if (!u) return;`
 *  Principals: { role:'admin' } | { role:'team', tenantId } | { role:'supplier', tenantId, supplierId } */
export async function requireAuth(req, res) {
  const tok = String(req.headers['x-auth-token'] || '');
  const secret = process.env.APP_TOKEN || '';
  if (!secret) { res.status(500).json({ error: 'APP_TOKEN non configuré' }); return null; }

  if (tok && safeEq(tok, secret)) return { role: 'admin' };

  const p = tok.split('.');
  if (p[0] === 't' && p.length === 3 && safeEq(tok, teamToken(p[1]))) {
    return { role: 'team', tenantId: p[1] };            // compte principal (mot de passe du client)
  }
  if (p[0] === 'u' && p.length === 4 && safeEq(tok, userToken(p[1], p[2]))) {
    // Le jeton est sans état : sans cette vérification, désactiver un membre ne
    // couperait pas la session déjà ouverte sur son téléphone. Une requête de
    // plus par appel, mais « couper l'accès » veut dire tout de suite.
    try {
      const { getDb, tenantActive } = await import('./db.js');
      const db = await getDb(p[1]);
      const usr = await db.collection(COL.users).findOne({ userId: p[2] });
      // Le membre ET son client doivent être actifs : suspendre un client doit
      // couper toutes ses sessions tout de suite, pas seulement les nouvelles.
      if (usr && usr.active === 1 && await tenantActive(p[1])) {
        return { role: 'team', tenantId: p[1], userId: p[2], name: usr.name };
      }
    } catch { /* base injoignable → on refuse, comme un jeton invalide */ }
    res.status(401).json({ error: 'Accès désactivé' });
    return null;
  }
  if (p[0] === 'sup' && p.length === 4 && safeEq(tok, supplierToken(p[1], p[2]))) {
    // même règle de révocation immédiate que pour un membre
    try {
      const { getDb, tenantActive } = await import('./db.js');
      const db = await getDb(p[1]);
      const sup = await db.collection(COL.suppliers).findOne({ supplierId: p[2] });
      if (sup && sup.active === 1 && await tenantActive(p[1])) {
        return { role: 'supplier', tenantId: p[1], supplierId: p[2] };
      }
    } catch { /* base injoignable → refus */ }
    res.status(401).json({ error: 'Accès désactivé' });
    return null;
  }
  res.status(401).json({ error: 'Non autorisé' });
  return null;
}

// ── Journal d'activité ───────────────────────────────────────────────────────
// Chaque écriture métier passe par ici : QUI (résolu depuis le jeton signé,
// jamais depuis le formulaire), QUAND, QUOI, sur QUEL objet.

/** Nom affichable de celui qui agit. Le `fallback` ne sert qu'au compte
 *  principal partagé, où le serveur ne peut pas savoir qui tape. */
export async function actorOf(db, u, fallback = '') {
  try {
    if (!u) return 'Automatique';
    if (u.role === 'admin') return 'Plateforme';
    if (u.role === 'cron') return 'Automatique (1h)';
    if (u.role === 'supplier') {
      const s = await db.collection(COL.suppliers).findOne({ supplierId: u.supplierId });
      return (s?.name ? `${s.name} (fournisseur)` : u.supplierId);
    }
    if (u.userId) {
      if (u.name) return u.name;               // déjà résolu par requireAuth
      const usr = await db.collection(COL.users).findOne({ userId: u.userId });
      return usr?.name || u.userId;
    }
  } catch { /* un nom vaut moins que l'opération */ }
  const f = String(fallback || '').trim();
  return f ? `${f} (compte principal)` : 'Compte principal';
}

/** Écrit une ligne de journal. Ne lève JAMAIS : perdre une ligne de log est
 *  acceptable, faire échouer une facture parce que le log a échoué ne l'est pas. */
export async function audit(db, u, action, target = '', detail = null, actorName = null) {
  try {
    const actor = actorName ?? await actorOf(db, u);
    const doc = {
      _id: `LOG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      actor,
      userId: u?.userId || null,
      role: u?.role || 'cron',
      action,
      target: String(target || ''),
    };
    if (detail && Object.keys(detail).length) doc.detail = detail;
    await db.collection(COL.logs).insertOne(doc);
  } catch { /* silencieux, volontairement */ }
}

/** Guard for the business endpoints: team of a tenant (admin must pick one). */
export function requireTenant(u, res) {
  if (u.role === 'team') return u.tenantId;
  if (u.role === 'admin') {
    res.status(400).json({ error: 'Connecte-toi avec le mot de passe d\'un client (compte plateforme)' });
    return null;
  }
  res.status(403).json({ error: "Réservé à l'équipe" });
  return null;
}
