// GET    /api/suppliers                     → liste (mots de passe jamais renvoyés)
// POST   /api/suppliers  {name, password}    → créer un fournisseur + son accès
// PATCH  /api/suppliers  {supplierId, ...}   → modifier (dont le mot de passe)
// DELETE /api/suppliers?supplierId=…         → supprimer, ou désactiver s'il est utilisé
import { getDb, COL, cors, requireAuth, requireTenant, audit, passwordInUse } from '../lib/mongo.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u = await requireAuth(req, res);
  if (!u) return;
  const tenantId = requireTenant(u, res);
  if (!tenantId) return;

  const db = await getDb(tenantId);
  const col = db.collection(COL.suppliers);

  if (req.method === 'GET') {
    const rows = await col.find({}, { projection: { _id: 0, password: 0 } }).sort({ name: 1 }).toArray();
    const skus = db.collection(COL.skus);
    for (const s of rows) s.skuCount = await skus.countDocuments({ supplierId: s.supplierId });
    return res.status(200).json({ rows });
  }

  if (req.method === 'POST') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const name = (b?.name || '').trim();
    const password = (b?.password || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    if (password.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
    // unicité globale : un mot de passe n'ouvre qu'une porte dans toute la base
    if (await passwordInUse(password)) return res.status(409).json({ error: 'Mot de passe déjà utilisé' });
    const doc = {
      supplierId: 'SUP-' + Date.now().toString(36).toUpperCase(),
      name,
      phone: (b.phone || '').trim(),
      email: (b.email || '').trim(),
      password,
      active: 1,
      createdAt: new Date().toISOString(),
    };
    await col.insertOne(doc);
    await audit(db, u, 'fournisseur.création', name);
    const { password: _p, _id, ...safe } = doc;
    return res.status(200).json({ ok: true, row: { ...safe, skuCount: 0 } });
  }

  if (req.method === 'PATCH') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const supplierId = (b?.supplierId || '').trim();
    if (!supplierId) return res.status(400).json({ error: 'supplierId requis' });
    if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: 'Nom requis' });

    const set = { updatedAt: new Date().toISOString() };
    for (const f of ['name', 'phone', 'email']) if (b[f] !== undefined) set[f] = String(b[f]).trim();
    if (b.active !== undefined) set.active = b.active ? 1 : 0;
    if (b.password !== undefined && String(b.password).trim()) {
      const p = String(b.password).trim();
      if (p.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
      // le mot de passe EST l'identifiant de connexion : unicité sur toute la base
      if (await passwordInUse(p, { exceptSupplierId: supplierId })) {
        return res.status(409).json({ error: 'Mot de passe déjà utilisé' });
      }
      set.password = p;
    }

    const r = await col.updateOne({ supplierId }, { $set: set });
    if (!r.matchedCount) return res.status(404).json({ error: 'Fournisseur introuvable' });
    const row = await col.findOne({ supplierId }, { projection: { _id: 0, password: 0 } });
    await audit(db, u, 'fournisseur.modification', row.name, set.password ? { motDePasseChangé: true } : null);
    return res.status(200).json({ ok: true, row });
  }

  if (req.method === 'DELETE') {
    const supplierId = String(req.query?.supplierId || '').trim();
    if (!supplierId) return res.status(400).json({ error: 'supplierId requis' });
    if (!(await col.findOne({ supplierId }))) return res.status(404).json({ error: 'Fournisseur introuvable' });

    // Supprimer un fournisseur encore rattaché à des produits laisserait ces
    // produits sans destinataire : les commandes partiraient dans le vide.
    const skus = await db.collection(COL.skus).countDocuments({ supplierId });
    const orders = await db.collection(COL.orders).countDocuments({ 'lines.supplierId': supplierId });
    if (skus + orders > 0) {
      await col.updateOne({ supplierId }, { $set: { active: 0, updatedAt: new Date().toISOString() } });
      const parts = [skus && `${skus} produit(s)`, orders && `${orders} commande(s)`].filter(Boolean);
      await audit(db, u, 'fournisseur.désactivation', supplierId);
      return res.status(200).json({
        ok: true, deactivated: true,
        reason: `Fournisseur rattaché à ${parts.join(' et ')} — désactivé (il ne peut plus se connecter) au lieu d'être supprimé.`,
      });
    }
    await col.deleteOne({ supplierId });
    await audit(db, u, 'fournisseur.suppression', supplierId);
    return res.status(200).json({ ok: true, deleted: true });
  }

  return res.status(405).json({ error: 'GET/POST/PATCH/DELETE only' });
}
