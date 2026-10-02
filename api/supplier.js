// Espace fournisseur (rôle 'supplier' uniquement) — OPTIONNEL depuis août 2026.
// GET  /api/supplier?action=requests  → mes demandes d'achat en attente
// POST /api/supplier?action=price { orderId, itemId, cost }    → j'annonce mon prix
// POST /api/supplier?action=price { orderId, itemId, refuse:1} → je refuse
//
// Le circuit normal n'attend plus le fournisseur : le coût vient de ce que
// l'équipe achat paie réellement au marché (PO Calculation → « Retour du
// marché »). Ce portail ne sert plus qu'à annoncer un prix à l'avance, et il
// ne fixe PLUS le prix client — une seule personne décide de ce que paie le
// client, celle qui facture. Deux formules de marge concurrentes, c'est deux
// prix différents pour la même marchandise.
import { getDb, COL, cors, requireAuth, audit } from '../lib/mongo.js';

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function orderStatus(o) {
  if (o.invoiceNo) return 'invoiced';
  const active = (o.lines || []).filter(l => l.status !== 'refused');
  if (!active.length) return 'pending';
  if (active.every(l => l.clientPrice != null)) return 'priced';
  if (active.every(l => l.cost != null)) return 'bought';
  return 'pending';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u = await requireAuth(req, res);
  if (!u) return;
  if (u.role !== 'supplier') return res.status(403).json({ error: 'Réservé aux fournisseurs' });

  const db = await getDb(u.tenantId);
  const col = db.collection(COL.orders);
  const action = String(req.query?.action || '');

  if (req.method === 'GET' && action === 'requests') {
    const docs = await col.find(
      { 'lines.supplierId': u.supplierId },
      { projection: { _id: 0 } }
    ).sort({ createdAt: -1 }).limit(60).toArray();

    const requests = [];
    let pendingCount = 0;
    for (const o of docs) {
      const mine = (o.lines || []).filter(l => l.supplierId === u.supplierId);
      if (!mine.length) continue;
      pendingCount += mine.filter(l => l.status === 'pending').length;
      requests.push({
        orderId: o.orderId, client: o.client?.name || '', createdAt: o.createdAt,
        status: orderStatus(o),
        lines: mine.map(l => ({
          itemId: l.itemId, name: l.name, uom: l.uom, qty: l.qty,
          cost: l.cost, clientPrice: l.clientPrice, status: l.status,
        })),
      });
    }
    requests.sort((a, b) =>
      (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) ||
      String(b.createdAt).localeCompare(String(a.createdAt)));
    return res.status(200).json({ requests, pendingCount });
  }

  if (req.method === 'POST' && action === 'price') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const o = await col.findOne({ orderId: b?.orderId });
    if (!o) return res.status(404).json({ error: 'Commande introuvable' });
    const line = (o.lines || []).find(l => l.itemId === b?.itemId && l.supplierId === u.supplierId);
    if (!line) return res.status(404).json({ error: 'Ligne introuvable' });
    if (o.invoiceNo) return res.status(409).json({ error: 'Commande déjà facturée' });

    if (b.refuse) {
      await col.updateOne(
        { orderId: o.orderId, 'lines.itemId': line.itemId, 'lines.supplierId': u.supplierId },
        { $set: { 'lines.$.status': 'refused', 'lines.$.refusedAt': new Date().toISOString() } });
      await audit(db, u, 'fournisseur.refus', `${o.orderId} · ${line.name}`);
      return res.status(200).json({ ok: true, status: 'refused' });
    }

    const cost = Number(b.cost);
    if (!(cost >= 0)) return res.status(400).json({ error: 'Prix invalide' });
    // On enregistre SON prix comme coût, rien d'autre. Le prix client reste la
    // décision de la personne qui facture, à partir du coût réellement payé.
    await col.updateOne(
      { orderId: o.orderId, 'lines.itemId': line.itemId, 'lines.supplierId': u.supplierId },
      { $set: {
        'lines.$.cost': r2(cost),
        'lines.$.costSource': 'devis_fournisseur',
        'lines.$.status': line.clientPrice != null ? 'priced' : 'bought',
        'lines.$.pricedAt': new Date().toISOString(),
      } });
    await audit(db, u, 'fournisseur.prix', `${o.orderId} · ${line.name}`, { coût: r2(cost) });
    return res.status(200).json({ ok: true, status: 'bought', cost: r2(cost) });
  }

  return res.status(400).json({ error: 'action inconnue' });
}
