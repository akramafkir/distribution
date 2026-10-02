// Gestion des clients de la plateforme (rôle 'admin' uniquement).
// GET   /api/tenants                 → liste (sans mots de passe)
// POST  /api/tenants { name, password, logo?, seedCatalogue? }  → créer un client
// PATCH /api/tenants { tenantId, logo?, name?, color?, active?, password? }
//
// Créer un client copie la bibliothèque produits partagée dans SON catalogue :
// il peut ensuite renommer, supprimer et retarifer librement sans impacter
// les autres — « aucune standardisation imposée ».
import { getDb, COL, cors, requireAuth, passwordInUse } from '../lib/mongo.js';
import { copyLibraryToTenant, purgeTenant } from '../lib/db.js';

const slug = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 32);

const DEFAULT_SETTINGS = {
  _id: 'app',
  sellerName: '', sellerLegalForm: '', sellerAddress: '', sellerCity: 'Casablanca',
  sellerPhone: '', sellerEmail: '', ice: '', ifNo: '', rc: '', patente: '', rib: '', bank: '',
  tvaRate: 0, timbreRate: 0.25, timbreOnCashOnly: true, invoicePrefix: 'FA',
  footerNote: 'Merci de votre confiance',
  po: { maxBacklogDays: 3, wastageDefaultPct: 0, wastageCapPct: 25, kgStep: 1, costMaxAgeDays: 14 },
};

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u = await requireAuth(req, res);
  if (!u) return;
  if (u.role !== 'admin') return res.status(403).json({ error: 'Réservé au compte plateforme' });

  const platform = await getDb(null);
  const col = platform.collection(COL.tenants);

  if (req.method === 'GET') {
    const rows = await col.find({}, { projection: { password: 0 } }).sort({ name: 1 }).toArray();
    for (const t of rows) {
      const db = await getDb(t.tenantId);
      t.skuCount = await db.collection(COL.skus).countDocuments({});
      t.clientCount = await db.collection(COL.clients).countDocuments({});
      t.invoiceCount = await db.collection(COL.invoices).countDocuments({});
    }
    return res.status(200).json({ rows });
  }

  if (req.method === 'POST') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const name = (b?.name || '').trim();
    const password = (b?.password || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom du client requis' });
    if (password.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });

    const tenantId = slug(b.tenantId || name) || ('c' + Date.now().toString(36));
    if (await col.findOne({ tenantId })) return res.status(409).json({ error: `Le client "${tenantId}" existe déjà` });
    // unicité globale : plateforme, autres clients, membres, fournisseurs
    if (await passwordInUse(password)) return res.status(409).json({ error: 'Mot de passe déjà utilisé' });

    const doc = {
      tenantId, name,
      password,
      logo: (b.logo || '').slice(0, 400_000),      // data URI, ~300 KB max
      color: (b.color || '').trim(),
      active: 1,
      createdAt: new Date().toISOString(),
    };
    // Création en tout-ou-rien : si une étape échoue, on retire la fiche client
    // plutôt que de laisser un client à moitié créé qui bloque toute nouvelle
    // tentative avec un 409.
    let seeded = 0;
    try {
      await col.insertOne(doc);

      // réglages initiaux : le nom du client devient l'émetteur des factures
      const db = await getDb(tenantId);
      await db.collection(COL.settings).updateOne(
        { _id: 'app' }, { $set: { ...DEFAULT_SETTINGS, sellerName: name } }, { upsert: true });

      // copie de la bibliothèque produits
      if (b.seedCatalogue !== false) seeded = await copyLibraryToTenant(tenantId);
    } catch (e) {
      try { await purgeTenant(tenantId); } catch { /* rien de mieux à faire */ }
      return res.status(500).json({ error: 'Création interrompue : ' + e.message });
    }

    const { password: _p, ...safe } = doc;
    return res.status(200).json({ ok: true, tenant: { ...safe, skuCount: seeded } });
  }

  if (req.method === 'PATCH') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const tenantId = (b?.tenantId || '').trim();
    if (!tenantId) return res.status(400).json({ error: 'tenantId requis' });
    const set = {};
    if (b.name !== undefined) set.name = String(b.name).trim();
    if (b.logo !== undefined) set.logo = String(b.logo).slice(0, 400_000);
    if (b.color !== undefined) set.color = String(b.color).trim();
    if (b.active !== undefined) set.active = b.active ? 1 : 0;
    if (b.password !== undefined && String(b.password).trim().length >= 6) {
      const np = String(b.password).trim();
      if (await passwordInUse(np, { exceptTenantId: tenantId })) {
        return res.status(409).json({ error: 'Mot de passe déjà utilisé' });
      }
      set.password = np;
    }
    const r = await col.updateOne({ tenantId }, { $set: set });
    if (!r.matchedCount) return res.status(404).json({ error: 'Client introuvable' });
    const t = await col.findOne({ tenantId }, { projection: { password: 0 } });
    return res.status(200).json({ ok: true, tenant: t });
  }

  return res.status(405).json({ error: 'GET/POST/PATCH only' });
}
