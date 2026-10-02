// GET    /api/clients?q=&page=1&limit=50   → { rows, total, page, pages }
// POST   /api/clients  { name, phone, ... } → créer
// PATCH  /api/clients  { clientId, ... }    → modifier
// DELETE /api/clients?clientId=…            → supprimer, ou désactiver s'il a un historique
import { getDb, COL, cors, requireAuth, requireTenant, audit } from '../lib/mongo.js';

const FIELDS = ['name','contact','phone','email','address','city','area','ice','priceTier','businessType'];

/** Position GPS du magasin, capturée par l'équipe quand elle est sur place.
 *  Sert au livreur : un bouton ouvre l'app Maps avec l'itinéraire. */
function parseGeo(g) {
  if (!g || typeof g !== 'object') return null;
  const lat = Number(g.lat), lng = Number(g.lng);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const out = {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    at: new Date().toISOString(),
  };
  const acc = Number(g.accuracy);
  if (isFinite(acc) && acc >= 0) {
    // Une « position » à ±1 km est un fix WiFi/IP de bureau, pas un magasin :
    // l'accepter enverrait le livreur à des kilomètres du client.
    if (acc > 1000) return null;
    out.accuracy = Math.round(acc);
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u = await requireAuth(req, res);
  if (!u) return;
  const tenantId = requireTenant(u, res);
  if (!tenantId) return;

  const db = await getDb(tenantId);
  const col = db.collection(COL.clients);

  if (req.method === 'GET') {
    const q = String(req.query?.q || '').trim();
    const page = Math.max(1, parseInt(req.query?.page || '1') || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit || '50') || 50));
    const filter = {};
    if (q) filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { clientId: { $regex: q, $options: 'i' } },
      { phone: { $regex: q, $options: 'i' } },
      { city: { $regex: q, $options: 'i' } },
      { ice: { $regex: q, $options: 'i' } },
    ];
    const total = await col.countDocuments(filter);
    const rows = await col.find(filter, { projection: { _id: 0 } })
      .sort({ name: 1 }).skip((page - 1) * limit).limit(limit).toArray();
    return res.status(200).json({ rows, total, page, pages: Math.ceil(total / limit) });
  }

  if (req.method === 'POST') {
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const name = (body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    const doc = {
      clientId: (body.clientId || 'DF-' + Date.now()).toString().trim(),
      name,
      contact: (body.contact || '').trim(),
      phone: (body.phone || '').trim(),
      email: (body.email || '').trim(),
      address: (body.address || '').trim(),
      city: (body.city || '').trim(),
      area: (body.area || '').trim(),
      ice: (body.ice || '').trim(),
      creditLimit: Number(body.creditLimit) || 0,
      creditDays: Number(body.creditDays) || 0,
      priceTier: (body.priceTier || 'RC').trim(),
      businessType: (body.businessType || '').trim(),
      active: 1,
      custom: true,
      createdAt: new Date().toISOString(),
    };
    if (body.geo !== undefined && body.geo !== null) {
      const geo = parseGeo(body.geo);
      if (!geo) return res.status(400).json({ error: 'Position invalide ou trop imprécise' });
      doc.geo = geo;
    }
    await col.updateOne({ clientId: doc.clientId }, { $set: doc }, { upsert: true });
    await audit(db, u, 'client.création', doc.name, doc.geo ? { position: 'capturée' } : null);
    return res.status(200).json({ ok: true, row: doc });
  }

  if (req.method === 'PATCH') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const clientId = (b?.clientId || '').trim();
    if (!clientId) return res.status(400).json({ error: 'clientId requis' });
    if (b.name !== undefined && !String(b.name).trim()) return res.status(400).json({ error: 'Nom requis' });

    const set = { updatedAt: new Date().toISOString() };
    for (const f of FIELDS) if (b[f] !== undefined) set[f] = String(b[f]).trim();
    for (const f of ['creditLimit', 'creditDays']) if (b[f] !== undefined) set[f] = Number(b[f]) || 0;
    if (b.active !== undefined) set.active = b.active ? 1 : 0;

    const update = { $set: set };
    if (b.geo !== undefined) {
      if (b.geo === null) update.$unset = { geo: '' };        // retirer la position
      else {
        const geo = parseGeo(b.geo);
        if (!geo) return res.status(400).json({ error: 'Position invalide ou trop imprécise' });
        // Même position re-envoyée (formulaire d'édition qui renvoie tout) :
        // on garde la capture d'origine, avec son horodatage. `at` doit rester
        // « quand quelqu'un était devant le magasin », pas « dernier clic ».
        const existing = await col.findOne({ clientId });
        if (!existing) return res.status(404).json({ error: 'Client introuvable' });
        set.geo = (existing.geo && existing.geo.lat === geo.lat && existing.geo.lng === geo.lng)
          ? existing.geo
          : geo;
      }
    }

    const r = await col.updateOne({ clientId }, update);
    if (!r.matchedCount) return res.status(404).json({ error: 'Client introuvable' });
    const row = await col.findOne({ clientId }, { projection: { _id: 0 } });
    await audit(db, u, 'client.modification', row.name,
      b.geo !== undefined ? { position: b.geo === null ? 'retirée' : 'capturée' } : null);
    return res.status(200).json({ ok: true, row });
  }

  if (req.method === 'DELETE') {
    const clientId = String(req.query?.clientId || '').trim();
    if (!clientId) return res.status(400).json({ error: 'clientId requis' });
    if (!(await col.findOne({ clientId }))) return res.status(404).json({ error: 'Client introuvable' });

    // Un client qui a un historique n'est jamais supprimé : les commandes et
    // factures resteraient, mais on ne pourrait plus rouvrir sa fiche depuis
    // la liste. On le désactive — il disparaît des choix de vente et garde
    // son passé intact.
    const [orders, invoices] = await Promise.all([
      db.collection(COL.orders).countDocuments({ 'client.clientId': clientId }),
      db.collection(COL.invoices).countDocuments({ 'client.clientId': clientId }),
    ]);
    if (orders + invoices > 0) {
      await col.updateOne({ clientId }, { $set: { active: 0, updatedAt: new Date().toISOString() } });
      const parts = [orders && `${orders} commande(s)`, invoices && `${invoices} facture(s)`].filter(Boolean);
      await audit(db, u, 'client.désactivation', clientId);
      return res.status(200).json({
        ok: true, deactivated: true,
        reason: `Client rattaché à ${parts.join(' et ')} — désactivé au lieu d'être supprimé, son historique est conservé.`,
      });
    }
    await col.deleteOne({ clientId });
    await audit(db, u, 'client.suppression', clientId);
    return res.status(200).json({ ok: true, deleted: true });
  }

  return res.status(405).json({ error: 'GET/POST/PATCH/DELETE only' });
}
