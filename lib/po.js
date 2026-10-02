// ─────────────────────────────────────────────────────────────────────────────
// Akram Distribution — calcul du bon d'achat (PO)
//
// Répond à une seule question : « qu'est-ce que je dois acheter au marché de
// gros ce matin ? », à partir des commandes clients reçues.
//
// Hérité de l'ancien système YolaFresh (yola_po_report.py) :
//   demande = commandes clients confirmées (jamais une prévision)
//   besoin  = max(0, commandé − stock) + majoration de perte
//   arrondi à l'unité d'achat entière
//
// Corrections délibérées par rapport à l'ancien code :
//   1. On N'EXCLUT PAS les lignes déjà facturées. Chez YolaFresh, facturé =
//      sorti du stock. Ici la facture est émise AVANT l'achat : exclure
//      garantirait de ne jamais acheter ce qu'on a déjà vendu.
//   2. Arrondi CEIL, jamais np.round. L'arrondi bancaire de l'ancien code
//      renvoyait à zéro tout besoin inférieur à une demi-caisse.
//   3. Fenêtre par filigrane (watermark) plutôt qu'un décalage fixe : pas de
//      trou, pas de double comptage, même si le cron passe en retard.
//   4. Fuseau via IANA Africa/Casablanca, jamais un +1h en dur (le Maroc passe
//      UTC+0 / UTC+1 pendant le Ramadan).
//   5. Un coût inconnu n'est jamais traité comme zéro — il est signalé.
// ─────────────────────────────────────────────────────────────────────────────
import { COL, casaDate, addDays } from './mongo.js';

const UOM_ENUM = new Set(['KG', 'CAISSE', 'BOTTE', 'BARQUETTE', 'PIECE', 'BOITE', 'SAC']);
const UOM_FIX = { GRAM: 'KG', GRAMME: 'KG', UNITE: 'PIECE', UNIT: 'PIECE', U: 'PIECE' };

export const PO_DEFAULTS = {
  maxBacklogDays: 3,
  wastageDefaultPct: 0,
  wastageByCategory: {},
  wastageCapPct: 25,
  kgStep: 1,
  categoryOrder: ['Vegetables', 'Légumes', 'Fruits', 'Herbes'],
  costMaxAgeDays: 14,
  includeRefusedInList: false,
};

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

function normaliseUom(u, fallback = 'KG') {
  const s = String(u || '').toUpperCase().trim();
  const fixed = UOM_FIX[s] || s;
  return UOM_ENUM.has(fixed) ? fixed : fallback;
}

/**
 * Compute the purchase order for a business date.
 * Pure-ish: reads collections, returns the document. Persisting + stamping is
 * done by the caller so a dry-run is possible.
 */
export async function computePO(db, { businessDate, generatedBy = 'cron', dryRun = false } = {}) {
  const now = new Date();
  const bizDate = businessDate || casaDate(now);

  const settingsDoc = (await db.collection(COL.settings).findOne({ _id: 'app' })) || {};
  const cfg = { ...PO_DEFAULTS, ...(settingsDoc.po || {}) };

  // ── 1. Window: continue from the previous run's watermark ──────────────────
  const prev = await db.collection(COL.po)
    .find({}, { projection: { window: 1 } }).sort({ 'window.toISO': -1 }).limit(1).next();
  const windowTo = now.toISOString();
  const windowFrom = prev?.window?.toISO || new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const windowSource = prev?.window?.toISO ? 'watermark' : 'default24h';
  const backlogFrom = addDays(bizDate, -cfg.maxBacklogDays);

  // ── 2. Eligible demand ─────────────────────────────────────────────────────
  const orders = await db.collection(COL.orders)
    .find({ date: { $gte: backlogFrom, $lte: bizDate } }).toArray();

  // Exactly-once across DIFFERENT purchase orders, but a re-run of THIS day
  // recomputes from the full set — otherwise the second run would find nothing
  // new and overwrite a good document with an empty one.
  const poId = `PO-${bizDate}`;
  const eligible = [];
  const refused = [];
  for (const o of orders) {
    for (const l of (o.lines || [])) {
      if (l.status === 'refused') { refused.push({ o, l }); continue; }
      if (l.poRef && l.poRef !== poId) continue;              // bought on another PO
      const createdAt = o.createdAt || '';
      const alreadyMine = l.poRef === poId;
      const inWindow = createdAt >= windowFrom && createdAt < windowTo;
      const isBacklog = createdAt < windowFrom;
      if (alreadyMine || inWindow || isBacklog) {
        eligible.push({ order: o, line: l, backlog: isBacklog && !alreadyMine });
      }
    }
  }

  // ── 3. Aggregate per itemId ────────────────────────────────────────────────
  const ids = [...new Set(eligible.map(e => e.line.itemId))];
  const skus = ids.length
    ? await db.collection(COL.skus).find({ itemId: { $in: ids } }).toArray() : [];
  const skuBy = Object.fromEntries(skus.map(s => [s.itemId, s]));
  const sups = await db.collection(COL.suppliers).find({}).toArray();
  const supBy = Object.fromEntries(sups.map(s => [s.supplierId, s]));

  const agg = new Map();
  for (const { order, line, backlog } of eligible) {
    const sku = skuBy[line.itemId] || {};
    const baseUom = normaliseUom(sku.uom, normaliseUom(line.uom));
    const uom = normaliseUom(line.uom, baseUom);
    let b = agg.get(line.itemId);
    if (!b) {
      b = {
        itemId: line.itemId,
        name: line.name || sku.name || line.itemId,
        category: sku.category || '', subCategory: sku.subCategory || '',
        baseUom,
        supplierId: line.supplierId || sku.supplierId || 'UNASSIGNED',
        supplierName: line.supplierName || (supBy[line.supplierId] || {}).name || '',
        byUom: {}, baseQty: 0, orderIds: new Set(), clients: new Set(),
        observedCosts: [], margins: [], flags: new Set(), sku,
      };
      agg.set(line.itemId, b);
    }
    // Convert to the SKU's base unit. Unknown conversion falls back 1:1 and is flagged
    // rather than silently dropping demand.
    const factors = sku.uomFactors || {};
    let factor = factors[uom];
    if (factor == null) factor = (uom === b.baseUom) ? 1 : null;
    if (factor == null) { factor = 1; b.flags.add('uom_conversion_missing'); }

    const q = Number(line.qty) || 0;
    b.byUom[uom] = r2((b.byUom[uom] || 0) + q);
    b.baseQty = r2(b.baseQty + q * factor);
    b.orderIds.add(order.orderId);
    if (order.client?.name) b.clients.add(order.client.name);
    if (backlog) b.flags.add('backlog');
    if (line.status === 'priced' && Number(line.cost) > 0) {
      b.observedCosts.push({ cost: Number(line.cost), at: order.createdAt || '' });
    }
    if (Number(line.margin) > 0) b.margins.push(Number(line.margin));
  }

  // ── 4-7. Wastage → rounding → cost ─────────────────────────────────────────
  const staleBefore = addDays(bizDate, -cfg.costMaxAgeDays);
  const lines = [];
  let seq = 0;
  for (const b of agg.values()) {
    const sku = b.sku;

    const pct = clamp(
      sku.wastagePct ?? cfg.wastageByCategory[b.category] ?? cfg.wastageDefaultPct,
      0, cfg.wastageCapPct);
    const wastageSource = sku.wastagePct != null ? 'sku'
      : (cfg.wastageByCategory[b.category] != null ? 'category' : 'default');

    const stockOnHand = 0;                                   // no inventory collection yet
    const uplift = r2(b.baseQty * pct / 100);
    const required = Math.max(0, r2(b.baseQty - stockOnHand + uplift));

    const p = sku.purchase || {};
    const purchaseUom = normaliseUom(p.uom, b.baseUom);
    const per = Number(p.qtyPerUnit) > 0 ? Number(p.qtyPerUnit) : 1;
    const moq = Number(p.moq) > 0 ? Number(p.moq) : 1;
    const conversionSource = sku.purchase ? 'sku' : 'fallback';
    if (!sku.purchase) b.flags.add('no_purchase_unit');

    // ALWAYS ceil — you cannot buy a fraction of a caisse, and being short at
    // 09:00 costs a client while being long costs a few dirhams.
    let units = 0, rawUnits = 0;
    if (required > 0) {
      if (purchaseUom === 'KG') {
        const step = Number(cfg.kgStep) > 0 ? Number(cfg.kgStep) : 1;
        rawUnits = required / step;
        units = Math.ceil(rawUnits) * step;
      } else {
        rawUnits = required / per;
        units = Math.ceil(Math.ceil(rawUnits) / moq) * moq;
      }
    }
    const buyBaseQty = purchaseUom === 'KG' ? units : r2(units * per);
    const overBuy = r2(buyBaseQty - required);

    // Cost waterfall — an unknown cost is null, never 0.
    let cost = null, costSource = 'none', costAsOf = null;
    b.observedCosts.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    const fresh = b.observedCosts.find(c => String(c.at).slice(0, 10) >= staleBefore);
    if (fresh) { cost = fresh.cost; costSource = 'last_priced'; costAsOf = String(fresh.at).slice(0, 10); }
    else if (sku.lastCost > 0 && String(sku.lastCostAt || '') >= staleBefore) {
      cost = Number(sku.lastCost); costSource = 'sku_cache'; costAsOf = sku.lastCostAt;
    } else if (b.observedCosts.length) {
      cost = b.observedCosts[0].cost; costSource = 'stale'; costAsOf = String(b.observedCosts[0].at).slice(0, 10);
      b.flags.add('stale_cost');
    } else if (sku.lastCost > 0) {
      cost = Number(sku.lastCost); costSource = 'stale'; costAsOf = sku.lastCostAt || null;
      b.flags.add('stale_cost');
    } else {
      // clientPrice = cost + margin, so invert it
      const med = b.margins.length
        ? b.margins.slice().sort((a, c) => a - c)[Math.floor(b.margins.length / 2)] : 1.5;
      const base = Number(sku.price) > 0 ? Number(sku.price) : Number(sku.seedPrice) || 0;
      if (base > med) { cost = r2(base - med); costSource = 'derived_price'; }
      else { b.flags.add('cost_unknown'); }
    }

    seq += 1;
    lines.push({
      lineId: `${bizDate}#${String(seq).padStart(3, '0')}`,
      itemId: b.itemId, name: b.name, category: b.category, subCategory: b.subCategory,
      supplierId: b.supplierId, supplierName: b.supplierName || (b.supplierId === 'UNASSIGNED' ? '' : b.supplierId),
      baseUom: b.baseUom,
      demand: {
        byUom: Object.entries(b.byUom).map(([uom, qty]) => ({ uom, qty })),
        baseQty: b.baseQty,
        orderCount: b.orderIds.size,
        orderIds: [...b.orderIds],
        clients: [...b.clients],
      },
      stockOnHand, wastagePct: pct, wastageSource, upliftBaseQty: uplift, requiredBaseQty: required,
      purchase: { uom: purchaseUom, qtyPerUnit: per, moq, rawUnits: r2(rawUnits), units, buyBaseQty, overBuyBaseQty: overBuy, conversionSource },
      cost: { perBaseUnit: cost, source: costSource, asOf: costAsOf, estTotal: cost == null ? null : r2(cost * buyBaseQty) },
      flags: [...b.flags],
    });
  }

  // ── 8. Group by supplier, in the buyer's walking order ─────────────────────
  const catIdx = c => {
    const i = cfg.categoryOrder.findIndex(x => x.toLowerCase() === String(c || '').toLowerCase());
    return i < 0 ? 999 : i;
  };
  const sortLines = (a, b) =>
    catIdx(a.category) - catIdx(b.category) ||
    String(a.subCategory).localeCompare(String(b.subCategory)) ||
    String(a.name).localeCompare(String(b.name));

  const groups = new Map();
  for (const l of lines) {
    let g = groups.get(l.supplierId);
    if (!g) {
      const sup = supBy[l.supplierId];
      g = {
        supplierId: l.supplierId,
        supplierName: l.supplierId === 'UNASSIGNED' ? 'Marché de gros — à acheter en direct' : (sup?.name || l.supplierName || l.supplierId),
        phone: sup?.phone || '',
        lines: [], purchaseUnits: 0, estCost: 0, estCostComplete: true,
      };
      groups.set(l.supplierId, g);
    }
    g.lines.push(l);
    g.purchaseUnits = r2(g.purchaseUnits + l.purchase.units);
    if (l.cost.estTotal == null) g.estCostComplete = false;
    else g.estCost = r2(g.estCost + l.cost.estTotal);
  }
  const bySupplier = [...groups.values()]
    .map(g => ({ ...g, lines: g.lines.sort(sortLines), lineCount: g.lines.length }))
    .sort((a, b) =>
      (a.supplierId === 'UNASSIGNED' ? 1 : 0) - (b.supplierId === 'UNASSIGNED' ? 1 : 0) ||
      String(a.supplierName).localeCompare(String(b.supplierName)));

  const totals = {
    lineCount: lines.length,
    purchaseUnits: r2(lines.reduce((s, l) => s + l.purchase.units, 0)),
    estCost: r2(lines.reduce((s, l) => s + (l.cost.estTotal || 0), 0)),
    estCostComplete: lines.every(l => l.cost.estTotal != null),
    orderCount: new Set(eligible.map(e => e.order.orderId)).size,
    supplierCount: bySupplier.length,
  };

  const doc = {
    poId,
    businessDate: bizDate,
    revision: 1,
    status: lines.length ? 'open' : 'empty',
    generatedAt: now.toISOString(),
    generatedBy,
    tz: 'Africa/Casablanca',
    window: { fromISO: windowFrom, toISO: windowTo, source: windowSource, backlogFrom },
    params: {
      wastageDefaultPct: cfg.wastageDefaultPct, wastageCapPct: cfg.wastageCapPct,
      maxBacklogDays: cfg.maxBacklogDays, kgStep: cfg.kgStep,
      rounding: 'ceil', stockSource: 'none', categoryOrder: cfg.categoryOrder,
    },
    bySupplier,
    totals,
    refusedCount: refused.length,
    dryRun: !!dryRun,
  };
  return { doc, eligible };
}

/** Persist the PO and stamp every consumed order line so it is never bought twice. */
export async function persistPO(db, doc, eligible) {
  const col = db.collection(COL.po);
  const existing = await col.findOne({ poId: doc.poId }, { projection: { revision: 1 } });
  if (existing) doc.revision = (existing.revision || 1) + 1;
  await col.updateOne({ poId: doc.poId }, { $set: doc }, { upsert: true });

  const ops = eligible.map(({ order, line }) => ({
    updateOne: {
      filter: { orderId: order.orderId, 'lines.itemId': line.itemId },
      update: { $set: { 'lines.$.poRef': doc.poId, 'lines.$.poStampedAt': doc.generatedAt } },
    },
  }));
  if (ops.length) await db.collection(COL.orders).bulkWrite(ops, { ordered: false });

  // Write back freshly observed costs so tomorrow's estimate is better.
  const cache = [];
  for (const g of doc.bySupplier) for (const l of g.lines) {
    if (l.cost.source === 'last_priced' && l.cost.perBaseUnit > 0) {
      cache.push({ updateOne: { filter: { itemId: l.itemId }, update: { $set: { lastCost: l.cost.perBaseUnit, lastCostAt: doc.businessDate } } } });
    }
  }
  if (cache.length) await db.collection(COL.skus).bulkWrite(cache, { ordered: false });
  return doc;
}

/** Compact WhatsApp/Chat text for the buyer heading to the market. */
export function poToText(doc) {
  if (!doc.totals.lineCount) return `🧾 Achats ${doc.businessDate}\nAucune commande — rien à acheter.`;
  const L = [`🧾 *Achats du ${doc.businessDate.split('-').reverse().join('/')}*`,
             `${doc.totals.lineCount} produits · ${doc.totals.orderCount} commandes`, ''];
  for (const g of doc.bySupplier) {
    L.push(`*${g.supplierName}*${g.phone ? ' · ' + g.phone : ''}`);
    for (const l of g.lines) {
      const u = l.purchase.uom === 'KG' ? `${l.purchase.units} kg` : `${l.purchase.units} ${l.purchase.uom.toLowerCase()}`;
      L.push(`  • ${l.name} — ${u}${l.cost.estTotal != null ? ` (~${Math.round(l.cost.estTotal)} DH)` : ''}`);
    }
    L.push('');
  }
  L.push(`*Total estimé : ${Math.round(doc.totals.estCost)} DH*${doc.totals.estCostComplete ? '' : ' (incomplet — prix manquants)'}`);
  return L.join('\n');
}
