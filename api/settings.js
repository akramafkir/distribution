// GET   /api/settings           → { settings }
// PATCH /api/settings  { ... }   → update seller info / tax params
//
// Gestion d'équipe (réservée au COMPTE PRINCIPAL — jeton sans userId) :
// GET    /api/settings?entity=users            → liste des membres
// POST   /api/settings?entity=users {name, password, phone?} → créer un membre
// PATCH  /api/settings?entity=users {userId, ...}            → modifier / désactiver
// DELETE /api/settings?entity=users&userId=…   → supprimer (ou désactiver s'il a agi)
// GET    /api/settings?entity=journal&page=&q= → journal « qui a fait quoi »
import { getDb, COL, cors, requireAuth, requireTenant, audit, passwordInUse } from '../lib/mongo.js';

const DEFAULTS = {
  _id: 'app',
  sellerName: 'Akram Distribution',
  sellerLegalForm: '',       // ex: SARL AU
  sellerAddress: '',
  sellerCity: 'Casablanca',
  sellerPhone: '',
  sellerEmail: '',
  ice: '',                   // Identifiant Commun de l'Entreprise
  rc: '',                    // Registre de Commerce
  ifNo: '',                  // Identifiant Fiscal
  patente: '',
  cnss: '',
  rib: '',
  bank: '',
  tvaRate: 0,                // produce is usually 0 / exempt
  timbreRate: 0.25,          // droit de timbre % (cash/COD)
  timbreOnCashOnly: true,
  invoicePrefix: 'DF',
  footerNote: 'Merci de votre confiance',
};

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u = await requireAuth(req, res);
  if (!u) return;
  const tenantId = requireTenant(u, res);
  if (!tenantId) return;
  const db = await getDb(tenantId);
  const col = db.collection(COL.settings);
  const entity = String(req.query?.entity || '');

  // ── membres de l'équipe + journal — compte principal uniquement ────────────
  // Un membre qui pourrait créer des membres ou lire le journal pourrait aussi
  // se fabriquer un alibi. Seul le détenteur du mot de passe principal gère.
  if (entity === 'users' || entity === 'journal') {
    if (u.userId) return res.status(403).json({ error: 'Réservé au compte principal' });
    const users = db.collection(COL.users);

    if (entity === 'journal' && req.method === 'GET') {
      const page = Math.max(1, parseInt(req.query?.page || '1') || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit || '50') || 50));
      const q = String(req.query?.q || '').trim();
      const filter = {};
      if (q) filter.$or = [
        { actor: { $regex: q, $options: 'i' } },
        { action: { $regex: q, $options: 'i' } },
        { target: { $regex: q, $options: 'i' } },
      ];
      const logs = db.collection(COL.logs);
      const total = await logs.countDocuments(filter);
      const rows = await logs.find(filter, { projection: { _id: 0 } })
        .sort({ at: -1 }).skip((page - 1) * limit).limit(limit).toArray();
      return res.status(200).json({ rows, total, page, pages: Math.ceil(total / limit) });
    }

    if (entity === 'users' && req.method === 'GET') {
      const rows = await users.find({}, { projection: { password: 0, _id: 0 } }).sort({ name: 1 }).toArray();
      return res.status(200).json({ rows });
    }

    if (entity === 'users' && req.method === 'POST') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      const name = (b?.name || '').trim();
      const password = (b?.password || '').trim();
      if (!name) return res.status(400).json({ error: 'Nom requis' });
      if (password.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });

      // Le mot de passe EST l'identifiant de connexion : il ne doit ouvrir
      // qu'une seule porte, dans TOUTE la base (pas juste ce client).
      if (await passwordInUse(password)) return res.status(409).json({ error: 'Mot de passe déjà utilisé' });

      const doc = {
        userId: 'U-' + Date.now().toString(36).toUpperCase(),
        name,
        phone: (b.phone || '').trim(),
        password,
        active: 1,
        createdAt: new Date().toISOString(),
      };
      try {
        await users.insertOne(doc);
      } catch (e) {
        // l'index unique global attrape les doublons entre clients de la plateforme
        if (/uniq|duplicate/i.test(e.message)) return res.status(409).json({ error: 'Mot de passe déjà utilisé' });
        throw e;
      }
      await audit(db, u, 'membre.création', name);
      const { password: _p, ...safe } = doc;
      return res.status(200).json({ ok: true, row: safe });
    }

    if (entity === 'users' && req.method === 'PATCH') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      const userId = (b?.userId || '').trim();
      if (!userId) return res.status(400).json({ error: 'userId requis' });
      const existing = await users.findOne({ userId });
      if (!existing) return res.status(404).json({ error: 'Membre introuvable' });

      const set = { updatedAt: new Date().toISOString() };
      if (b.name !== undefined) {
        if (!String(b.name).trim()) return res.status(400).json({ error: 'Nom requis' });
        set.name = String(b.name).trim();
      }
      if (b.phone !== undefined) set.phone = String(b.phone).trim();
      if (b.active !== undefined) set.active = b.active ? 1 : 0;
      if (b.password !== undefined && String(b.password).trim()) {
        const p = String(b.password).trim();
        if (p.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
        if (await passwordInUse(p, { exceptUserId: userId })) return res.status(409).json({ error: 'Mot de passe déjà utilisé' });
        set.password = p;
      }
      try {
        await users.updateOne({ userId }, { $set: set });
      } catch (e) {
        if (/uniq|duplicate/i.test(e.message)) return res.status(409).json({ error: 'Mot de passe déjà utilisé' });
        throw e;
      }
      await audit(db, u, b.active === false || b.active === 0 ? 'membre.désactivation' : 'membre.modification',
        set.name || existing.name, set.password ? { motDePasseChangé: true } : null);
      const row = await users.findOne({ userId }, { projection: { password: 0, _id: 0 } });
      return res.status(200).json({ ok: true, row });
    }

    if (entity === 'users' && req.method === 'DELETE') {
      const userId = String(req.query?.userId || '').trim();
      if (!userId) return res.status(400).json({ error: 'userId requis' });
      const existing = await users.findOne({ userId });
      if (!existing) return res.status(404).json({ error: 'Membre introuvable' });

      // S'il a déjà agi, son nom doit rester lisible dans l'historique : on le
      // désactive (il ne peut plus se connecter) au lieu de l'effacer.
      const acted = await db.collection(COL.logs).countDocuments({ userId });
      if (acted > 0) {
        await users.updateOne({ userId }, { $set: { active: 0, updatedAt: new Date().toISOString() } });
        await audit(db, u, 'membre.désactivation', existing.name, { actionsAuJournal: acted });
        return res.status(200).json({ ok: true, deactivated: true,
          reason: `${existing.name} a ${acted} action(s) au journal — accès coupé, historique conservé.` });
      }
      await users.deleteOne({ userId });
      await audit(db, u, 'membre.suppression', existing.name);
      return res.status(200).json({ ok: true, deleted: true });
    }

    return res.status(405).json({ error: 'méthode non supportée pour ' + entity });
  }

  if (req.method === 'GET') {
    const s = (await col.findOne({ _id: 'app' })) || {};
    return res.status(200).json({ settings: { ...DEFAULTS, ...s } });
  }

  if (req.method === 'PATCH') {
    // L'identité de facturation (dont le RIB) et les taxes n'appartiennent
    // qu'au compte principal : un membre qui pourrait changer le RIB pourrait
    // détourner les paiements sur toutes les factures suivantes.
    if (u.userId) return res.status(403).json({ error: 'Réservé au compte principal' });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const allowed = Object.keys(DEFAULTS).filter(k => k !== '_id');
    const set = {};
    for (const k of allowed) if (body[k] !== undefined) set[k] = body[k];
    set.tvaRate = Number(set.tvaRate ?? DEFAULTS.tvaRate) || 0;
    set.timbreRate = Number(set.timbreRate ?? DEFAULTS.timbreRate) || 0;
    set.updatedAt = new Date().toISOString();
    await col.updateOne({ _id: 'app' }, { $set: set }, { upsert: true });
    await audit(db, u, 'réglages.modification', '', { champs: Object.keys(set).filter(k => k !== 'updatedAt') });
    const s = await col.findOne({ _id: 'app' });
    return res.status(200).json({ ok: true, settings: { ...DEFAULTS, ...s } });
  }

  return res.status(405).json({ error: 'GET/PATCH only' });
}
