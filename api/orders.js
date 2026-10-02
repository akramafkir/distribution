// Commandes clients (le signal de demande qui alimente le calcul d'achat).
// GET  /api/orders?id=CMD-00001   → one order
// GET  /api/orders?q=&page=&limit= → list
// POST /api/orders  { client, lines[] }         → create (routes lines to suppliers)
// POST /api/orders?action=invoice { orderId }   → turn a fully-priced order into an invoice
// PATCH /api/orders  { orderId, client?, lines? } → modifier tant qu'elle n'est pas facturée
// DELETE /api/orders?orderId=…                  → supprimer (ni facturée ni achetée)
import { getDb, COL, cors, requireAuth, nextSeq, casaDate, requireTenant, audit, actorOf } from '../lib/mongo.js';

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const clampMargin = m => Math.min(2, Math.max(1, Number(m) || 1.5));

/**
 * Cycle de vie d'une commande :
 *   pending  — passée, on ne sait pas encore ce que la marchandise coûtera
 *   bought   — l'équipe achat a saisi le prix payé au marché (coût connu)
 *   priced   — le prix client est fixé sur chaque ligne (coût + marge)
 *   invoiced — facturée
 * Le coût vient de l'achat réel, plus d'un devis fournisseur.
 */
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
  const tenantId = requireTenant(u, res);
  if (!tenantId) return;

  const db = await getDb(tenantId);
  const col = db.collection(COL.orders);

  if (req.method === 'GET') {
    const id = String(req.query?.id || '').trim();
    if (id) {
      const o = await col.findOne({ orderId: id }, { projection: { _id: 0 } });
      if (!o) return res.status(404).json({ error: 'Commande introuvable' });
      return res.status(200).json({ order: { ...o, status: orderStatus(o) } });
    }
    const q = String(req.query?.q || '').trim();
    const page = Math.max(1, parseInt(req.query?.page || '1') || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit || '30') || 30));
    const filter = {};
    if (q) filter.$or = [
      { orderId: { $regex: q, $options: 'i' } },
      { 'client.name': { $regex: q, $options: 'i' } },
    ];
    const total = await col.countDocuments(filter);
    const docs = await col.find(filter, { projection: { _id: 0 } })
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    const rows = docs.map(o => ({
      orderId: o.orderId, client: o.client, createdAt: o.createdAt, createdBy: o.createdBy,
      date: o.date, status: orderStatus(o), lineCount: (o.lines || []).length, invoiceNo: o.invoiceNo || null,
    }));
    return res.status(200).json({ rows, total, page, pages: Math.ceil(total / limit) });
  }

  if (req.method === 'POST') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const action = String(req.query?.action || '');

    // ---- turn a priced order into an invoice ----
    if (action === 'invoice') {
      const o = await col.findOne({ orderId: b?.orderId });
      if (!o) return res.status(404).json({ error: 'Commande introuvable' });
      if (o.invoiceNo) return res.status(409).json({ error: 'Commande déjà facturée : ' + o.invoiceNo });
      const st = orderStatus(o);
      if (st !== 'priced') {
        return res.status(400).json({ error: st === 'bought'
          ? 'Fixe le prix de vente de chaque ligne avant de facturer'
          : "L'équipe achat n'a pas encore saisi le prix payé au marché" });
      }

      const s = (await db.collection(COL.settings).findOne({ _id: 'app' })) || {};
      const lines = o.lines.filter(l => l.status !== 'refused' && l.clientPrice != null).map(l => ({
        itemId: l.itemId, name: l.name, uom: l.uom, qty: l.qty,
        unitPrice: l.clientPrice, total: r2(l.qty * l.clientPrice),
      }));
      const subtotal = r2(lines.reduce((a, l) => a + l.total, 0));
      const tvaRate = Number(s.tvaRate) || 0;
      const tva = r2(subtotal * tvaRate / 100);
      const pay = (b.paymentMode || 'espece').toLowerCase();
      const timbreRate = Number(s.timbreRate) || 0;
      const applyTimbre = timbreRate > 0 && (s.timbreOnCashOnly === false || ['espece', 'cash', 'cod'].includes(pay));
      const timbre = applyTimbre ? r2((subtotal + tva) * timbreRate / 100) : 0;
      const net = r2(subtotal + tva + timbre);
      const numero = `${s.invoicePrefix || 'DF'}-${String(await nextSeq(db, 'invoice')).padStart(6, '0')}`;
      // l'identité vient du jeton signé, pas du formulaire
      const actor = await actorOf(db, u, b.createdBy);
      const inv = {
        numero, date: casaDate(), createdAt: new Date().toISOString(), createdBy: actor,
        paymentMode: pay, client: o.client, lines, subtotal, discount: 0,
        tvaRate, tva, timbreRate: applyTimbre ? timbreRate : 0, timbre, net,
        notes: 'Commande ' + o.orderId, status: 'issued', fromOrder: o.orderId,
      };
      await db.collection(COL.invoices).insertOne(inv);
      await col.updateOne({ orderId: o.orderId }, { $set: { invoiceNo: numero } });
      await audit(db, u, 'facture.émission', numero,
        { commande: o.orderId, client: o.client?.name, net }, actor);
      delete inv._id;
      return res.status(200).json({ ok: true, invoice: inv });
    }

    // ---- create an order ----
    if (!b?.client?.name) return res.status(400).json({ error: 'Client requis' });
    const raw = Array.isArray(b.lines) ? b.lines.filter(l => Number(l.qty) > 0) : [];
    if (!raw.length) return res.status(400).json({ error: 'Au moins une ligne requise' });

    const ids = raw.map(l => l.itemId);
    const skus = await db.collection(COL.skus).find({ itemId: { $in: ids } }).toArray();
    const skuBy = Object.fromEntries(skus.map(s => [s.itemId, s]));
    const sups = await db.collection(COL.suppliers).find({}).toArray();
    const supBy = Object.fromEntries(sups.map(s => [s.supplierId, s]));

    const lines = raw.map(l => {
      const sku = skuBy[l.itemId] || {};
      const supplierId = sku.supplierId || '';
      return {
        itemId: l.itemId,
        name: l.name || sku.name || '',
        uom: l.uom || sku.uom || 'KG',
        qty: r2(l.qty),
        supplierId,
        supplierName: (supBy[supplierId] || {}).name || 'Non assigné',
        margin: clampMargin(sku.margin),
        cost: null, clientPrice: null, status: 'pending',
      };
    });

    const seq = await nextSeq(db, 'order');
    const actor = await actorOf(db, u, b.createdBy);
    const order = {
      orderId: 'CMD-' + String(seq).padStart(5, '0'),
      date: casaDate(),
      client: b.client,
      createdBy: actor,
      createdAt: new Date().toISOString(),
      lines, invoiceNo: null,
    };
    await col.insertOne(order);
    await audit(db, u, 'commande.création', order.orderId,
      { client: b.client?.name, lignes: lines.length }, actor);
    delete order._id;
    return res.status(200).json({ ok: true, order: { ...order, status: 'pending' } });
  }

  // ---- modifier une commande ----
  if (req.method === 'PATCH') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const orderId = (b?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId requis' });
    const o = await col.findOne({ orderId });
    if (!o) return res.status(404).json({ error: 'Commande introuvable' });
    if (o.invoiceNo) return res.status(409).json({ error: `Commande déjà facturée (${o.invoiceNo}) — annule la facture avant de la modifier` });

    // ── prix de vente, fixés par la personne qui facture ─────────────────────
    // Le coût vient de l'achat ; ici on pose ce que paie le client. Un prix
    // sous le coût est accepté mais signalé — c'est parfois voulu (geste
    // commercial), jamais par accident.
    if (Array.isArray(b.prices)) {
      const by = Object.fromEntries(b.prices
        .filter(p => p && p.itemId != null)
        .map(p => [String(p.itemId), p.clientPrice === '' || p.clientPrice == null ? null : Number(p.clientPrice)]));
      const belowCost = [];
      const lines = (o.lines || []).map(l => {
        if (!(l.itemId in by)) return l;
        const cp = by[l.itemId];
        if (cp != null && (isNaN(cp) || cp < 0)) return l;
        if (cp != null && l.cost != null && cp < l.cost) belowCost.push(l.name);
        return { ...l, clientPrice: cp,
                 status: l.status === 'refused' ? 'refused' : (cp != null ? 'priced' : (l.cost != null ? 'bought' : 'pending')) };
      });
      await col.updateOne({ orderId }, { $set: { lines, updatedAt: new Date().toISOString() } });
      await audit(db, u, 'commande.prix-client', orderId,
        { lignesTarifées: Object.keys(by).length, sousLeCoût: belowCost.length || undefined });
      const row = await col.findOne({ orderId }, { projection: { _id: 0 } });
      return res.status(200).json({ ok: true, order: { ...row, status: orderStatus(row) }, belowCost });
    }

    const set = { updatedAt: new Date().toISOString() };
    if (b.client) {
      if (!b.client.name) return res.status(400).json({ error: 'Client requis' });
      set.client = b.client;
    }

    if (Array.isArray(b.lines)) {
      const wanted = b.lines.filter(l => Number(l.qty) > 0);
      if (!wanted.length) return res.status(400).json({ error: 'Au moins une ligne requise' });

      // Une ligne déjà achetée (marquée par un bon d'achat) ne peut plus être
      // retirée : la marchandise est commandée chez le fournisseur.
      const keptIds = new Set(wanted.map(l => l.itemId));
      const lost = (o.lines || []).filter(l => l.poRef && !keptIds.has(l.itemId));
      if (lost.length) {
        return res.status(409).json({
          error: `Déjà acheté, impossible à retirer : ${lost.map(l => l.name).join(', ')}`,
        });
      }

      const prev = Object.fromEntries((o.lines || []).map(l => [l.itemId, l]));
      const fresh = wanted.filter(l => !prev[l.itemId]).map(l => l.itemId);
      const skuBy = {}, supBy = {};
      if (fresh.length) {
        for (const s of await db.collection(COL.skus).find({ itemId: { $in: fresh } }).toArray()) skuBy[s.itemId] = s;
        for (const s of await db.collection(COL.suppliers).find({}).toArray()) supBy[s.supplierId] = s;
      }

      set.lines = wanted.map(l => {
        const old = prev[l.itemId];
        // ligne existante : on ne touche qu'à la quantité, le prix fournisseur
        // déjà obtenu reste valable (c'est un prix unitaire)
        if (old) return { ...old, qty: r2(l.qty) };
        const sku = skuBy[l.itemId] || {};
        const supplierId = sku.supplierId || '';
        return {
          itemId: l.itemId,
          name: l.name || sku.name || '',
          uom: l.uom || sku.uom || 'KG',
          qty: r2(l.qty),
          supplierId,
          supplierName: (supBy[supplierId] || {}).name || 'Non assigné',
          margin: clampMargin(sku.margin),
          cost: null, clientPrice: null, status: 'pending',
        };
      });
    }

    await col.updateOne({ orderId }, { $set: set });
    await audit(db, u, 'commande.modification', orderId);
    const row = await col.findOne({ orderId }, { projection: { _id: 0 } });
    return res.status(200).json({ ok: true, order: { ...row, status: orderStatus(row) } });
  }

  // ---- supprimer une commande ----
  if (req.method === 'DELETE') {
    const orderId = String(req.query?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId requis' });
    const o = await col.findOne({ orderId });
    if (!o) return res.status(404).json({ error: 'Commande introuvable' });
    if (o.invoiceNo) {
      return res.status(409).json({ error: `Commande facturée (${o.invoiceNo}) — annule d'abord la facture` });
    }
    const bought = (o.lines || []).filter(l => l.poRef);
    if (bought.length) {
      return res.status(409).json({
        error: `Marchandise déjà achetée sur le bon ${bought[0].poRef} — la commande ne peut plus être supprimée`,
      });
    }
    await col.deleteOne({ orderId });
    await audit(db, u, 'commande.suppression', orderId, { client: o.client?.name });
    return res.status(200).json({ ok: true, deleted: true });
  }

  return res.status(405).json({ error: 'GET/POST/PATCH/DELETE only' });
}
