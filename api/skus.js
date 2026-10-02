// GET    /api/skus?q=&active=all|1|0&page=1&limit=50  → { rows, total, page, pages }
// POST   /api/skus  { name, uom, category, ... }       → créer un produit
// PATCH  /api/skus  { itemId, price?, active?, ... }   → modifier
// DELETE /api/skus?itemId=...                          → supprimer
import { getDb, COL, cors, requireAuth, requireTenant, audit } from '../lib/mongo.js';

const UOM = new Set(['KG','CAISSE','BOTTE','BARQUETTE','PIECE','BOITE','SAC']);
const normUom = u => { const s = String(u||'KG').toUpperCase().trim(); return UOM.has(s) ? s : 'KG'; };

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u = await requireAuth(req, res);
  if (!u) return;
  const tenantId = requireTenant(u, res);
  if (!tenantId) return;

  const db = await getDb(tenantId);
  const col = db.collection(COL.skus);

  if (req.method === 'GET') {
    const q = String(req.query?.q || '').trim();
    const active = String(req.query?.active || 'all');
    const page = Math.max(1, parseInt(req.query?.page || '1') || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit || '50') || 50));

    const filter = {};
    if (active === '1') filter.active = 1;
    else if (active === '0') filter.active = 0;
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { itemId: { $regex: q, $options: 'i' } },
        { category: { $regex: q, $options: 'i' } },
        { subCategory: { $regex: q, $options: 'i' } },
      ];
    }
    const total = await col.countDocuments(filter);
    const rows = await col.find(filter, { projection: { _id: 0 } })
      .sort({ active: -1, name: 1 })
      .skip((page - 1) * limit).limit(limit).toArray();
    return res.status(200).json({ rows, total, page, pages: Math.ceil(total / limit) });
  }

  if (req.method === 'POST') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const name = (b?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom du produit requis' });
    const uom = normUom(b.uom);
    const itemId = (b.itemId || '').trim() || 'P-' + Date.now().toString(36).toUpperCase();
    if (await col.findOne({ itemId })) return res.status(409).json({ error: 'Cette référence existe déjà' });
    const doc = {
      itemId, name,
      nomFr: (b.nomFr || '').trim(), nomAr: (b.nomAr || '').trim(),
      category: (b.category || '').trim(), subCategory: (b.subCategory || '').trim(),
      uom,
      active: b.active === undefined ? 1 : (b.active ? 1 : 0),
      price: Math.max(0, Number(b.price) || 0),
      margin: Math.min(2, Math.max(1, Number(b.margin) || 1.5)),
      supplierId: (b.supplierId || '').trim(),
      createdAt: new Date().toISOString(),
    };
    if (b.purchaseUom) {
      doc.purchase = {
        uom: normUom(b.purchaseUom),
        qtyPerUnit: Math.max(1, Number(b.qtyPerUnit) || 1),
        moq: Math.max(1, Number(b.moq) || 1),
      };
      doc.uomFactors = { [uom]: 1, [normUom(b.purchaseUom)]: Math.max(1, Number(b.qtyPerUnit) || 1) };
    }
    await col.insertOne(doc);
    await audit(db, u, 'produit.création', doc.name);
    return res.status(200).json({ ok: true, row: doc });
  }

  if (req.method === 'DELETE') {
    const itemId = String(req.query?.itemId || '').trim();
    if (!itemId) return res.status(400).json({ error: 'itemId requis' });
    const existing = await col.findOne({ itemId });
    if (!existing) return res.status(404).json({ error: 'Produit introuvable' });
    // Un produit déjà commandé n'est pas supprimé mais désactivé : sinon les
    // commandes et factures passées perdraient leur référence.
    const used = await db.collection(COL.orders).countDocuments({ 'lines.itemId': itemId });
    if (used > 0) {
      await col.updateOne({ itemId }, { $set: { active: 0 } });
      await audit(db, u, 'produit.désactivation', existing.name);
      return res.status(200).json({ ok: true, deactivated: true, reason: `Produit utilisé dans ${used} commande(s) — désactivé au lieu d'être supprimé` });
    }
    await db.collection(COL.skus).deleteOne({ itemId });
    await audit(db, u, 'produit.suppression', existing.name);
    return res.status(200).json({ ok: true, deleted: true });
  }

  if (req.method === 'PATCH') {
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const itemId = (body?.itemId || '').trim();
    if (!itemId) return res.status(400).json({ error: 'itemId requis' });
    const set = { updatedAt: new Date().toISOString() };
    if (body.price !== undefined && body.price !== null && body.price !== '') {
      const p = Number(body.price);
      if (isNaN(p) || p < 0) return res.status(400).json({ error: 'prix invalide' });
      set.price = p;
    }
    for (const f of ['name','nomFr','nomAr','category','subCategory']) {
      if (body[f] !== undefined) set[f] = String(body[f]).trim();
    }
    if (body.uom !== undefined) set.uom = normUom(body.uom);
    if (body.active !== undefined) set.active = body.active ? 1 : 0;
    if (body.supplierId !== undefined) set.supplierId = String(body.supplierId).trim();
    if (body.margin !== undefined && body.margin !== '') {
      set.margin = Math.min(2, Math.max(1, Number(body.margin) || 1.5));
    }
    // unité d'achat : ce qu'on commande au grossiste (une caisse de 10 kg pour
    // un produit vendu au kg). Elle pilote l'arrondi du bon d'achat.
    const unset = {};
    if (body.purchaseUom !== undefined) {
      if (!String(body.purchaseUom).trim()) {
        // « identique à la vente » : on efface le bloc d'achat au lieu de le
        // remplir de KG par défaut, ce qui fausserait l'arrondi du bon d'achat.
        unset.purchase = ''; unset.uomFactors = '';
      } else {
        const current = await col.findOne({ itemId });
        if (!current) return res.status(404).json({ error: 'SKU introuvable' });
        const sellUom = set.uom || current.uom || 'KG';   // jamais deviné : celui du produit
        const pu = normUom(body.purchaseUom);
        const per = Math.max(1, Number(body.qtyPerUnit) || 1);
        set.purchase = { uom: pu, qtyPerUnit: per, moq: Math.max(1, Number(body.moq) || 1) };
        set.uomFactors = { [sellUom]: 1, [pu]: per };
      }
    }
    const update = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;
    const r = await col.updateOne({ itemId }, update);
    if (!r.matchedCount) return res.status(404).json({ error: 'SKU introuvable' });
    const row = await col.findOne({ itemId }, { projection: { _id: 0 } });
    await audit(db, u, 'produit.modification', row.name,
      { champs: Object.keys(set).filter(k => k !== 'updatedAt') });
    return res.status(200).json({ ok: true, row });
  }

  return res.status(405).json({ error: 'GET/POST/PATCH/DELETE only' });
}
