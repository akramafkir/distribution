// POST /api/invoices  { client, lines[], paymentMode, discount, notes, createdBy }
//       → creates invoice with un numéro séquentiel + server-computed totals
// GET    /api/invoices?id=DF-000123        → single invoice
// GET    /api/invoices?q=&page=1&limit=30  → list (history)
// PATCH  /api/invoices { numero, notes?, paymentMode? } → corriger une facture émise
// DELETE /api/invoices?numero=…&reason=…   → ANNULER (jamais supprimer)
//
// Une facture n'est jamais effacée : le Code de Commerce marocain impose de
// conserver les pièces comptables 10 ans, et un numéro qui disparaît d'une
// séquence est le premier signal d'alerte d'un contrôle fiscal. « Supprimer »
// pose donc status='cancelled', garde la ligne, et libère la commande d'origine
// pour qu'elle puisse être refacturée sous un nouveau numéro.
import { getDb, COL, cors, requireAuth, nextSeq, requireTenant, casaDate, audit, actorOf } from '../lib/mongo.js';

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u = await requireAuth(req, res);
  if (!u) return;
  const tenantId = requireTenant(u, res);
  if (!tenantId) return;
  const db = await getDb(tenantId);
  const col = db.collection(COL.invoices);

  if (req.method === 'GET') {
    const id = String(req.query?.id || '').trim();
    if (id) {
      const inv = await col.findOne({ numero: id }, { projection: { _id: 0 } });
      if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
      return res.status(200).json({ invoice: inv });
    }
    const q = String(req.query?.q || '').trim();
    const page = Math.max(1, parseInt(req.query?.page || '1') || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit || '30') || 30));
    const filter = {};
    if (q) filter.$or = [
      { numero: { $regex: q, $options: 'i' } },
      { 'client.name': { $regex: q, $options: 'i' } },
    ];
    const total = await col.countDocuments(filter);
    const rows = await col.find(filter, { projection: { _id: 0, lines: 0 } })
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    return res.status(200).json({ rows, total, page, pages: Math.ceil(total / limit) });
  }

  if (req.method === 'POST') {
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const client = body?.client;
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    if (!client || !client.name) return res.status(400).json({ error: 'Client requis' });
    if (!lines.length) return res.status(400).json({ error: 'Au moins une ligne requise' });

    const settings = (await db.collection(COL.settings).findOne({ _id: 'app' })) || {};
    const tvaRate = Number(settings.tvaRate) || 0;
    const timbreRate = Number(settings.timbreRate) || 0;
    const timbreOnCashOnly = settings.timbreOnCashOnly !== false;
    const prefix = settings.invoicePrefix || 'DF';

    // Re-compute every line + totals server-side (never trust client math).
    const cleanLines = lines.map(l => {
      const qty = round2(l.qty);
      const unitPrice = round2(l.unitPrice);
      return {
        itemId: (l.itemId || '').toString(),
        name: (l.name || '').toString(),
        uom: (l.uom || 'KG').toString(),
        qty, unitPrice,
        total: round2(qty * unitPrice),
      };
    }).filter(l => l.qty > 0);
    if (!cleanLines.length) return res.status(400).json({ error: 'Quantités invalides' });

    const subtotal = round2(cleanLines.reduce((s, l) => s + l.total, 0));
    const discount = round2(body.discount || 0);
    const base = round2(subtotal - discount);
    const tva = round2(base * tvaRate / 100);
    const paymentMode = (body.paymentMode || 'espece').toString();
    const applyTimbre = timbreRate > 0 && (!timbreOnCashOnly || ['espece', 'cash', 'cod'].includes(paymentMode.toLowerCase()));
    const timbre = applyTimbre ? round2((base + tva) * timbreRate / 100) : 0;
    const net = round2(base + tva + timbre);

    const seq = await nextSeq(db, 'invoice');
    const numero = `${prefix}-${String(seq).padStart(6, '0')}`;
    const now = new Date();
    const actor = await actorOf(db, u, body.createdBy);

    const invoice = {
      numero,
      date: (body.date || now.toISOString().slice(0, 10)),
      createdAt: now.toISOString(),
      createdBy: actor,
      paymentMode,
      client: {
        clientId: client.clientId || '',
        name: client.name || '',
        address: client.address || '',
        city: client.city || '',
        phone: client.phone || '',
        ice: client.ice || '',
      },
      lines: cleanLines,
      subtotal, discount, tvaRate, tva, timbreRate: applyTimbre ? timbreRate : 0, timbre, net,
      notes: (body.notes || '').toString(),
      status: 'issued',
    };
    await col.insertOne(invoice);
    await audit(db, u, 'facture.émission', numero, { client: invoice.client?.name, net }, actor);
    delete invoice._id;
    return res.status(200).json({ ok: true, invoice });
  }

  if (req.method === 'PATCH') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const numero = (b?.numero || '').trim();
    if (!numero) return res.status(400).json({ error: 'numero requis' });
    const inv = await col.findOne({ numero });
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    if (inv.status === 'cancelled') return res.status(409).json({ error: 'Facture annulée — elle ne peut plus être modifiée' });

    const set = { updatedAt: new Date().toISOString() };
    if (b.notes !== undefined) set.notes = String(b.notes);

    // Changer le mode de paiement change le droit de timbre (dû sur les
    // espèces), donc le net à payer : on le recalcule au lieu de le croire.
    if (b.paymentMode !== undefined) {
      const pay = String(b.paymentMode).toLowerCase();
      const s = (await db.collection(COL.settings).findOne({ _id: 'app' })) || {};
      const timbreRate = Number(s.timbreRate) || 0;
      const onCashOnly = s.timbreOnCashOnly !== false;
      const base = round2(inv.subtotal - (inv.discount || 0));
      const tva = round2(inv.tva || 0);
      const apply = timbreRate > 0 && (!onCashOnly || ['espece', 'cash', 'cod'].includes(pay));
      const timbre = apply ? round2((base + tva) * timbreRate / 100) : 0;
      set.paymentMode = pay;
      set.timbreRate = apply ? timbreRate : 0;
      set.timbre = timbre;
      set.net = round2(base + tva + timbre);
    }

    await col.updateOne({ numero }, { $set: set });
    await audit(db, u, 'facture.modification', numero,
      { champs: Object.keys(set).filter(k => k !== 'updatedAt') });
    const row = await col.findOne({ numero }, { projection: { _id: 0 } });
    return res.status(200).json({ ok: true, invoice: row });
  }

  if (req.method === 'DELETE') {
    const numero = String(req.query?.numero || '').trim();
    const reason = String(req.query?.reason || '').trim();
    if (!numero) return res.status(400).json({ error: 'numero requis' });
    if (reason.length < 3) return res.status(400).json({ error: "Indique le motif de l'annulation" });
    const inv = await col.findOne({ numero });
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    if (inv.status === 'cancelled') return res.status(409).json({ error: 'Facture déjà annulée' });

    await col.updateOne({ numero }, { $set: {
      status: 'cancelled', cancelledAt: new Date().toISOString(),
      cancelledOn: casaDate(), cancelReason: reason,
    } });

    // la commande d'origine redevient facturable
    let released = null;
    if (inv.fromOrder) {
      const r = await db.collection(COL.orders).updateOne({ orderId: inv.fromOrder }, { $set: { invoiceNo: null } });
      if (r.matchedCount) released = inv.fromOrder;
    }
    await audit(db, u, 'facture.annulation', numero,
      { motif: reason, client: inv.client?.name, net: inv.net, commandeLibérée: released || undefined });
    return res.status(200).json({ ok: true, cancelled: numero, releasedOrder: released });
  }

  return res.status(405).json({ error: 'GET/POST/PATCH/DELETE only' });
}
