// Test du calcul de bon d'achat, sans base de données (mock en mémoire).
//   node scripts/test-po.mjs
import { computePO, persistPO, poToText } from '../lib/po.js';

// ── minimal in-memory Mongo mock ─────────────────────────────────────────────
const deep = o => JSON.parse(JSON.stringify(o));
function match(doc, f = {}) {
  return Object.entries(f).every(([k, v]) => {
    if (k.includes('.')) {                       // supports "lines.supplierId"
      const [a, b] = k.split('.');
      return Array.isArray(doc[a]) && doc[a].some(x => x?.[b] === v);
    }
    const dv = doc[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$in' in v) return v.$in.includes(dv);
      if ('$gte' in v || '$lte' in v) {
        if (v.$gte != null && !(dv >= v.$gte)) return false;
        if (v.$lte != null && !(dv <= v.$lte)) return false;
        return true;
      }
      if ('$ne' in v) return dv !== v.$ne;
    }
    return dv === v;
  });
}
function makeDb(seed = {}) {
  const store = {};
  for (const [k, v] of Object.entries(seed)) store[k] = deep(v);
  return {
    _store: store,
    collection(name) {
      store[name] ??= [];
      const rows = () => store[name];
      return {
        collectionName: name,
        async findOne(f) { return rows().find(d => match(d, f)) || null; },
        find(f = {}) {
          let out = rows().filter(d => match(d, f));
          const api = {
            sort(s) {
              const [k, dir] = Object.entries(s)[0];
              const get = o => k.split('.').reduce((a, p) => a?.[p], o) ?? '';
              out = out.slice().sort((a, b) => (get(a) > get(b) ? 1 : get(a) < get(b) ? -1 : 0) * dir);
              return api;
            },
            limit(n) { out = out.slice(0, n); return api; },
            async next() { return out[0] || null; },
            async toArray() { return deep(out); },
          };
          return api;
        },
        async updateOne(f, u, o = {}) {
          let d = rows().find(x => match(x, f));
          if (!d && o.upsert) { d = {}; rows().push(d); }
          if (!d) return { matchedCount: 0 };
          if (u.$set) for (const [k, v] of Object.entries(u.$set)) {
            if (k.startsWith('lines.$.')) {
              const field = k.slice(8);
              // find the array element the filter selected
              const sel = Object.entries(f).find(([fk]) => fk.startsWith('lines.'));
              const [, sv] = sel || [];
              const key = sel ? sel[0].split('.')[1] : null;
              const el = key ? d.lines.find(x => x[key] === sv) : d.lines[0];
              if (el) el[field] = v;
            } else d[k] = v;
          }
          return { matchedCount: 1 };
        },
        async bulkWrite(ops) { for (const op of ops) if (op.updateOne) await this.updateOne(op.updateOne.filter, op.updateOne.update, {}); return { ok: 1 }; },
        async insertOne(d) { rows().push(deep(d)); return { insertedId: 1 }; },
        async countDocuments(f = {}) { return rows().filter(d => match(d, f)).length; },
      };
    },
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────────
// Anchored on the real clock: the window is computed from `now`, so fixtures
// dated in the future would fall outside it and silently test nothing.
const NOW = new Date();
const dayStr = d => d.toISOString().slice(0, 10);
const TODAY = dayStr(NOW);
const Y = dayStr(new Date(NOW.getTime() - 24 * 3600 * 1000));
const TOMORROW = dayStr(new Date(NOW.getTime() + 24 * 3600 * 1000));
// hours back from now, so every fixture order sits inside the 24h window
const iso = (d, hoursAgo = 3) => new Date(NOW.getTime() - hoursAgo * 3600 * 1000).toISOString();

const skus = [
  { itemId: 'T1', name: 'Tomate Agadir طماطم', category: 'Vegetables', subCategory: 'Tomates', uom: 'KG',
    purchase: { uom: 'CAISSE', qtyPerUnit: 20, moq: 1 }, uomFactors: { KG: 1, CAISSE: 20 }, supplierId: 'S1', margin: 1.5, price: 8 },
  { itemId: 'M1', name: 'Menthe النعناع', category: 'Vegetables', subCategory: 'Herbes', uom: 'BOTTE',
    supplierId: 'S1', margin: 1.2, price: 5 },
  { itemId: 'B1', name: 'Banane Locale', category: 'Fruits', subCategory: 'Bananes', uom: 'KG',
    purchase: { uom: 'CAISSE', qtyPerUnit: 18, moq: 1 }, uomFactors: { KG: 1 }, supplierId: 'S2', margin: 2, price: 12 },
  { itemId: 'X1', name: 'Produit sans fournisseur', category: 'Fruits', subCategory: 'Autres', uom: 'KG', margin: 1.5, price: 0 },
];
const suppliers = [
  { supplierId: 'S1', name: 'Hamid Légumes', phone: '0661000001', active: 1 },
  { supplierId: 'S2', name: 'Verger Atlas', phone: '0661000002', active: 1 },
];
const ord = (id, date, h, client, lines) => ({ orderId: id, date, createdAt: iso(date, h), client: { name: client }, lines, invoiceNo: null });
const L = (itemId, uom, qty, supplierId, extra = {}) =>
  ({ itemId, name: skus.find(s => s.itemId === itemId).name, uom, qty, supplierId,
     supplierName: (suppliers.find(s => s.supplierId === supplierId) || {}).name || '',
     margin: skus.find(s => s.itemId === itemId).margin, cost: null, clientPrice: null, status: 'pending', ...extra });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const findLine = (doc, itemId) => doc.bySupplier.flatMap(g => g.lines).find(l => l.itemId === itemId);

// ══ TEST 1 — ceil rounding to whole caisses (the legacy bug) ═════════════════
console.log('\n1. Arrondi CEIL a l\'unite d\'achat');
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [],
    dima_orders: [ ord('C1', TODAY, 8, 'Resto A', [L('T1', 'KG', 45, 'S1')]) ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  const l = findLine(doc, 'T1');
  console.log(`   demande 45 kg -> ${l.purchase.rawUnits} caisses brut -> ${l.purchase.units} caisses (${l.purchase.buyBaseQty} kg)`);
  ok(l.purchase.units === 3, '45 kg / 20 = 2.25 -> 3 caisses (l\'ancien np.round donnait 2)');
  ok(l.purchase.buyBaseQty === 60, 'achat = 60 kg');
  ok(l.purchase.overBuyBaseQty === 15, 'surplus visible = 15 kg');
}

// ══ TEST 2 — multi-unit aggregation on one product ══════════════════════════
console.log('\n2. Agregation multi-unites (kg + caisse) sur un meme produit');
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [],
    dima_orders: [ ord('C1', TODAY, 8, 'Resto A', [L('T1', 'KG', 45, 'S1')]),
                   ord('C2', TODAY, 9, 'Hotel B', [L('T1', 'CAISSE', 2, 'S1')]) ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  const l = findLine(doc, 'T1');
  console.log(`   45 kg + 2 caisses -> base ${l.demand.baseQty} kg -> ${l.purchase.units} caisses`);
  ok(l.demand.baseQty === 85, '45 + (2 x 20) = 85 kg en unite de base');
  ok(l.demand.byUom.length === 2, 'detail par unite conserve (pas de somme incoherente)');
  ok(l.purchase.units === 5, '85/20 = 4.25 -> 5 caisses');
  ok(l.demand.orderCount === 2, '2 commandes rattachees');
}

// ══ TEST 3 — the critical inversion: invoiced orders STILL count ════════════
console.log('\n3. INVERSION CRITIQUE : une commande deja facturee compte quand meme');
{
  const o = ord('C1', TODAY, 8, 'Resto A', [L('T1', 'KG', 40, 'S1', { status: 'priced', cost: 6, clientPrice: 7.5 })]);
  o.invoiceNo = 'DF-000001';
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [], dima_orders: [o] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  ok(doc.totals.lineCount === 1, 'la ligne facturee est TOUJOURS achetee (facture emise avant achat)');
  ok(findLine(doc, 'T1').cost.source === 'last_priced', 'cout repris du prix fournisseur');
}

// ══ TEST 4 — exactly-once via poRef ════════════════════════════════════════
console.log('\n4. Anti-double-achat (poRef)');
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [],
    dima_orders: [ ord('C1', TODAY, 8, 'Resto A', [L('T1', 'KG', 40, 'S1')]) ] });
  const r1 = await computePO(db, { businessDate: TODAY });
  await persistPO(db, r1.doc, r1.eligible);
  ok(r1.doc.totals.lineCount === 1, '1er passage : la ligne est achetee');
  const r2 = await computePO(db, { businessDate: TODAY });
  ok(r2.doc.totals.lineCount === 1, '2e passage du MEME jour : recalcul complet, pas un document vide');
  ok(r2.doc.bySupplier[0].lines[0].purchase.units === r1.doc.bySupplier[0].lines[0].purchase.units, 'quantite identique (idempotent)');
  // a DIFFERENT day must not re-buy lines already stamped by this PO
  const r3 = await computePO(db, { businessDate: TOMORROW });
  ok(r3.doc.totals.lineCount === 0, 'jour suivant : ligne deja achetee non reprise (anti-double-achat)');
}

// ══ TEST 5 — refused lines excluded, supplier grouping, UNASSIGNED last ════
console.log('\n5. Groupement fournisseur, refus exclu, non-assigne en dernier');
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [],
    dima_orders: [ ord('C1', TODAY, 8, 'Resto A', [
      L('T1', 'KG', 40, 'S1'),
      L('B1', 'KG', 30, 'S2'),
      L('X1', 'KG', 10, ''),
      L('M1', 'BOTTE', 12, 'S1', { status: 'refused' }),
    ]) ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  console.log('   groupes :', doc.bySupplier.map(g => `${g.supplierName}(${g.lineCount})`).join(' | '));
  ok(doc.bySupplier.length === 3, '3 groupes fournisseurs');
  ok(doc.bySupplier[doc.bySupplier.length - 1].supplierId === 'UNASSIGNED', 'non-assigne en dernier');
  ok(!findLine(doc, 'M1'), 'ligne refusee non achetee');
  ok(doc.refusedCount === 1, 'refus compte separement');
}

// ══ TEST 6 — cost waterfall never treats unknown as zero ═══════════════════
console.log('\n6. Cascade de couts : inconnu != zero');
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [],
    dima_orders: [ ord('C1', TODAY, 8, 'Resto A', [ L('X1', 'KG', 10, '') ]) ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  const l = findLine(doc, 'X1');
  ok(l.cost.perBaseUnit === null, 'cout inconnu = null (jamais 0)');
  ok(l.flags.includes('cost_unknown'), 'signale par un flag');
  ok(doc.totals.estCostComplete === false, 'total marque incomplet');
}
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [],
    dima_orders: [ ord('C1', TODAY, 8, 'Resto A', [ L('B1', 'KG', 30, 'S2') ]) ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  const l = findLine(doc, 'B1');
  ok(l.cost.source === 'derived_price' && l.cost.perBaseUnit === 10, 'sinon deduit : prix 12 - marge 2 = 10 DH');
}

// ══ TEST 7 — wastage uplift, capped ════════════════════════════════════════
console.log('\n7. Majoration de perte (plafonnee)');
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_po: [],
    dima_settings: [{ _id: 'app', po: { wastageDefaultPct: 10 } }],
    dima_orders: [ ord('C1', TODAY, 8, 'Resto A', [L('T1', 'KG', 100, 'S1')]) ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  const l = findLine(doc, 'T1');
  ok(l.upliftBaseQty === 10 && l.requiredBaseQty === 110, '100 kg + 10% perte = 110 kg requis');
  ok(l.purchase.units === 6, '110/20 = 5.5 -> 6 caisses');
}
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_po: [],
    dima_settings: [{ _id: 'app', po: { wastageDefaultPct: 90 } }],
    dima_orders: [ ord('C1', TODAY, 8, 'Resto A', [L('T1', 'KG', 100, 'S1')]) ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  ok(findLine(doc, 'T1').wastagePct === 25, 'perte plafonnee a 25% (l\'ancien code etait non plafonne)');
}

// ══ TEST 8 — backlog + zero orders ═════════════════════════════════════════
console.log('\n8. Reliquat et journee vide');
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }],
    dima_po: [{ poId: 'PO-' + Y, window: { toISO: iso(TODAY, 6) } }],
    dima_orders: [ ord('C0', Y, 30, 'Vieux client', [L('T1', 'KG', 25, 'S1')]) ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  ok(doc.window.source === 'watermark', 'fenetre reprise du filigrane precedent');
  ok(findLine(doc, 'T1')?.flags.includes('backlog'), 'commande non achetee d\'hier reprise en reliquat');
}
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [], dima_orders: [] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  ok(doc.status === 'empty' && doc.totals.lineCount === 0, 'aucune commande -> document ecrit, statut empty');
  console.log('   texte:', JSON.stringify(poToText(doc)));
}

// ══ sample output ══════════════════════════════════════════════════════════
console.log('\n─── Exemple de sortie WhatsApp ───');
{
  const db = makeDb({ dima_skus: skus, dima_suppliers: suppliers, dima_settings: [{ _id: 'app' }], dima_po: [],
    dima_orders: [
      ord('C1', TODAY, 7, 'Restaurant Chez Ali', [L('T1', 'KG', 45, 'S1', { status: 'priced', cost: 6.5, clientPrice: 8 }), L('M1', 'BOTTE', 20, 'S1')]),
      ord('C2', TODAY, 8, 'Hotel Atlas', [L('T1', 'CAISSE', 2, 'S1'), L('B1', 'KG', 30, 'S2')]),
      ord('C3', TODAY, 9, 'Snack Medina', [L('X1', 'KG', 8, '')]),
    ] });
  const { doc } = await computePO(db, { businessDate: TODAY });
  console.log(poToText(doc));
}

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
