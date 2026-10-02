// Bon d'achat (PO)
// GET  /api/po                          → today's PO
// GET  /api/po?date=YYYY-MM-DD          → a given day's PO
// GET  /api/po?list=1                   → recent POs
// GET  /api/po?date=...&format=text     → WhatsApp-ready text
// POST /api/po?action=run[&date=][&dry=1] → compute now (cron or manual re-run)
// POST /api/po?action=buy { date, items:[{itemId, units, unitPrice}] }
//        → l'équipe achat saisit ce qu'elle a payé au marché. Le coût redescend
//          aussitôt sur toutes les lignes de commande concernées, et devient la
//          base du prix de vente côté facturation.
//
// The cron hits POST with the Vercel cron Authorization header; the team can
// also trigger it from the UI with the normal app token.
import { getDb, COL, cors, requireAuth, requireTenant, casaDate, audit, actorOf } from '../lib/mongo.js';
import { computePO, persistPO, poToText } from '../lib/po.js';

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function isCron(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  return (req.headers.authorization || '') === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const cron = isCron(req);
  // The cron has no session, so it must say which client it is running for.
  // Without a tenant there is nothing to compute — never fall back to "all".
  let tenantId = String(req.query?.tenant || '').trim();
  let principal = { role: 'cron' };
  if (!cron) {
    principal = await requireAuth(req, res);
    if (!principal) return;
    tenantId = requireTenant(principal, res);
    if (!tenantId) return;
  } else if (String(req.query?.all || '') === '1') {
    // Le cron nocturne tourne pour TOUS les clients actifs, un par un.
    const platform = await getDb(null);
    const tenants = await platform.collection(COL.tenants).find({ active: 1 }).toArray();
    const out = [];
    for (const t of tenants) {
      try {
        const tdb = await getDb(t.tenantId);
        const { doc, eligible } = await computePO(tdb, { businessDate: undefined, generatedBy: 'cron' });
        await persistPO(tdb, doc, eligible);
        await audit(tdb, { role: 'cron' }, 'po.génération', doc.poId,
          { produits: doc.totals.lineCount, coûtEstimé: doc.totals.estCost });
        out.push({ tenantId: t.tenantId, poId: doc.poId, lines: doc.totals.lineCount, estCost: doc.totals.estCost });
      } catch (e) {
        out.push({ tenantId: t.tenantId, error: e.message });
      }
    }
    return res.status(200).json({ ok: true, ran: out.length, results: out });
  } else if (!tenantId) {
    return res.status(400).json({ error: 'tenant requis pour le cron' });
  }

  const db = await getDb(tenantId);
  const col = db.collection(COL.po);

  if (req.method === 'GET') {
    if (String(req.query?.list || '') === '1') {
      const rows = await col.find({}, { projection: { _id: 0, bySupplier: 0 } })
        .sort({ businessDate: -1 }).limit(30).toArray();
      return res.status(200).json({ rows });
    }
    const date = String(req.query?.date || casaDate());
    const doc = await col.findOne({ poId: `PO-${date}` }, { projection: { _id: 0 } });
    if (!doc) return res.status(404).json({ error: 'Aucun bon d\'achat pour ' + date, date });
    if (String(req.query?.format || '') === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(poToText(doc));
    }
    return res.status(200).json({ po: doc });
  }

  if (req.method === 'POST') {
    const action = String(req.query?.action || '');

    // ── SAISIE DES ACHATS ────────────────────────────────────────────────────
    // L'équipe achat revient du marché et saisit ce qu'elle a réellement payé.
    // Ce prix devient le coût de TOUTES les lignes de commande du produit :
    // c'est lui, et non une estimation, qui sert de base au prix de vente.
    if (action === 'buy') {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      const date = String(b?.date || casaDate());
      const items = Array.isArray(b?.items) ? b.items : [];
      if (!items.length) return res.status(400).json({ error: 'Aucune ligne à enregistrer' });

      const poId = `PO-${date}`;
      const po = await col.findOne({ poId });
      if (!po) return res.status(404).json({ error: 'Aucun bon d\'achat pour ' + date });

      const now = new Date().toISOString();
      // l'identité vient du jeton signé, pas du champ « by » du formulaire
      const by = await actorOf(db, principal, b?.by);
      const wanted = new Map();
      for (const it of items) {
        const itemId = String(it.itemId || '').trim();
        if (!itemId) continue;
        const unitPrice = Number(it.unitPrice);
        if (!(unitPrice >= 0)) return res.status(400).json({ error: `Prix invalide pour ${itemId}` });
        wanted.set(itemId, { unitPrice: r2(unitPrice), units: it.units == null ? null : Number(it.units) });
      }

      // 1. on inscrit l'achat sur la ligne du bon
      const touched = [];
      for (const g of po.bySupplier || []) {
        for (const l of g.lines || []) {
          const w = wanted.get(l.itemId);
          if (!w) continue;
          const per = Number(l.purchase?.qtyPerUnit) > 0 ? Number(l.purchase.qtyPerUnit) : 1;
          const units = w.units != null && w.units >= 0 ? r2(w.units) : l.purchase.units;
          // le prix est saisi par unité d'achat (la caisse, le sac) ; le reste
          // du système raisonne en unité de base (le kg) — on convertit ici,
          // une seule fois, plutôt que dans chaque écran.
          const perBase = l.purchase?.uom === l.baseUom ? w.unitPrice : r2(w.unitPrice / per);
          const boughtBaseQty = l.purchase?.uom === l.baseUom ? units : r2(units * per);
          l.bought = {
            units, unitPrice: w.unitPrice, purchaseUom: l.purchase?.uom || l.baseUom,
            costPerBaseUnit: perBase, baseQty: boughtBaseQty,
            totalPaid: r2(units * w.unitPrice), at: now, by,
          };
          l.cost = { ...l.cost, perBaseUnit: perBase, source: 'achat_reel', asOf: date,
                     estTotal: r2(perBase * boughtBaseQty) };
          touched.push({ itemId: l.itemId, perBase, orderIds: l.demand?.orderIds || [] });
        }
      }
      if (!touched.length) return res.status(404).json({ error: 'Aucun de ces produits n\'est dans le bon d\'achat' });

      // 2. totaux du bon, recalculés sur le réel
      for (const g of po.bySupplier) {
        g.estCost = r2(g.lines.reduce((s, l) => s + (l.cost?.estTotal || 0), 0));
        g.estCostComplete = g.lines.every(l => l.cost?.estTotal != null);
      }
      const allLines = po.bySupplier.flatMap(g => g.lines);
      po.totals = {
        ...po.totals,
        estCost: r2(allLines.reduce((s, l) => s + (l.cost?.estTotal || 0), 0)),
        estCostComplete: allLines.every(l => l.cost?.estTotal != null),
        boughtLineCount: allLines.filter(l => l.bought).length,
        totalPaid: r2(allLines.reduce((s, l) => s + (l.bought?.totalPaid || 0), 0)),
      };
      po.updatedAt = now;
      await col.updateOne({ poId }, { $set: { bySupplier: po.bySupplier, totals: po.totals, updatedAt: now } });

      // 3. le coût redescend sur les commandes — c'est le cœur de la chaîne
      const orderIds = [...new Set(touched.flatMap(t => t.orderIds))];
      const costBy = Object.fromEntries(touched.map(t => [t.itemId, t.perBase]));
      const ordersCol = db.collection(COL.orders);
      let linesUpdated = 0;
      for (const orderId of orderIds) {
        const o = await ordersCol.findOne({ orderId });
        if (!o || o.invoiceNo) continue;                    // une facture émise ne bouge plus
        let dirty = false;
        const lines = (o.lines || []).map(l => {
          const c = costBy[l.itemId];
          if (c == null || l.status === 'refused') return l;
          dirty = true; linesUpdated++;
          return { ...l, cost: c, costSource: 'achat_reel', costAt: now,
                   status: l.clientPrice != null ? 'priced' : 'bought' };
        });
        if (dirty) await ordersCol.updateOne({ orderId }, { $set: { lines, updatedAt: now } });
      }

      // 4. mémoire du prix pour les prochains bons d'achat
      const skus = db.collection(COL.skus);
      for (const t of touched) {
        await skus.updateOne({ itemId: t.itemId }, { $set: { lastCost: t.perBase, lastCostAt: date } });
      }

      await audit(db, principal, 'marché.achats', poId,
        { produits: touched.length, commandesMisesÀJour: orderIds.length, totalPayé: po.totals.totalPaid }, by);
      return res.status(200).json({
        ok: true, poId, itemsSaved: touched.length,
        ordersTouched: orderIds.length, linesUpdated,
        totals: po.totals,
      });
    }

    if (action !== 'run') return res.status(400).json({ error: 'action=run ou action=buy attendu' });
    const dry = String(req.query?.dry || '') === '1';
    const businessDate = String(req.query?.date || '') || casaDate();

    try {
      const actor = cron ? 'cron' : await actorOf(db, principal);
      const { doc, eligible } = await computePO(db, {
        businessDate,
        generatedBy: actor,
        dryRun: dry,
      });
      if (!dry) {
        await persistPO(db, doc, eligible);
        await audit(db, principal, 'po.génération', doc.poId,
          { produits: doc.totals.lineCount, révision: doc.revision > 1 ? doc.revision : undefined }, actor);
      }
      return res.status(200).json({ ok: true, po: doc, text: poToText(doc) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'GET/POST only' });
}
