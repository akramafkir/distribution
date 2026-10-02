// Client de démonstration JETABLE pour vérifier l'écran PO Calculation.
//   node --env-file=.env.local scripts/seed-demo.mjs         → créer
//   node --env-file=.env.local scripts/seed-demo.mjs purge   → effacer
import { getDb, COL, casaDate, nextSeq } from '../lib/mongo.js';
import { purgeTenant, sql } from '../lib/db.js';

const T = 'zz-demo';
if (process.argv[2] === 'purge') {
  await purgeTenant(T);
  await sql().end();
  console.log('client de démonstration effacé');
  process.exit(0);
}

const platform = await getDb(null);
await platform.collection(COL.tenants).updateOne({ tenantId: T }, { $set: {
  tenantId: T, name: 'Démo vérification', password: 'demo-verif-po-2026', active: 1,
  logo: '', color: '', createdAt: new Date().toISOString(),
} }, { upsert: true });

const db = await getDb(T);
await db.collection(COL.settings).updateOne({ _id: 'app' }, { $set: {
  _id: 'app', sellerName: 'Démo', tvaRate: 0, timbreRate: 0.25, timbreOnCashOnly: true,
  invoicePrefix: 'DEMO', po: { maxBacklogDays: 3, wastageDefaultPct: 0, wastageCapPct: 25, kgStep: 1, costMaxAgeDays: 14 },
} }, { upsert: true });

// deux fournisseurs + un produit non assigné (= marché de gros)
const sups = [
  { supplierId: 'SUP-DEMO-A', name: 'Ferme Souss', phone: '0661000001', password: 'demo-sup-a-2026', active: 1 },
  { supplierId: 'SUP-DEMO-B', name: 'Verger Atlas', phone: '0661000002', password: 'demo-sup-b-2026', active: 1 },
];
for (const s of sups) await db.collection(COL.suppliers).updateOne({ supplierId: s.supplierId }, { $set: s }, { upsert: true });

const skus = [
  { itemId: 'D-TOM', name: 'Tomate', category: 'Légumes', uom: 'KG', price: 9, margin: 1.5, active: 1,
    supplierId: 'SUP-DEMO-A', purchase: { uom: 'CAISSE', qtyPerUnit: 10, moq: 1 }, uomFactors: { KG: 1, CAISSE: 10 }, lastCost: 6, lastCostAt: casaDate() },
  { itemId: 'D-POM', name: 'Pomme de terre', category: 'Légumes', uom: 'KG', price: 7, margin: 1.4, active: 1,
    supplierId: 'SUP-DEMO-A', purchase: { uom: 'SAC', qtyPerUnit: 25, moq: 1 }, uomFactors: { KG: 1, SAC: 25 }, lastCost: 4.5, lastCostAt: casaDate() },
  { itemId: 'D-ORA', name: 'Orange', category: 'Fruits', uom: 'KG', price: 12, margin: 1.5, active: 1,
    supplierId: 'SUP-DEMO-B', purchase: { uom: 'CAISSE', qtyPerUnit: 15, moq: 1 }, uomFactors: { KG: 1, CAISSE: 15 }, lastCost: 8, lastCostAt: casaDate() },
  { itemId: 'D-MEN', name: 'Menthe', category: 'Légumes', uom: 'BOTTE', price: 2, margin: 1.5, active: 1,
    supplierId: '', lastCost: 1.2, lastCostAt: casaDate() },   // sans fournisseur → marché de gros
];
for (const s of skus) await db.collection(COL.skus).updateOne({ itemId: s.itemId }, { $set: s }, { upsert: true });

const clients = [
  { clientId: 'D-C1', name: 'Restaurant Al Mounia', city: 'Casablanca', phone: '0522000001', active: 1,
    address: '95 Rue du Prince Moulay Abdallah',
    geo: { lat: 33.589886, lng: -7.603869, accuracy: 9, at: new Date().toISOString() } },
  { clientId: 'D-C2', name: 'Café Central', city: 'Casablanca', phone: '0522000002', active: 1 },
  { clientId: 'D-C3', name: 'Traiteur Anfa', city: 'Casablanca', phone: '0522000003', active: 1 },
];
for (const c of clients) await db.collection(COL.clients).updateOne({ clientId: c.clientId }, { $set: c }, { upsert: true });

// trois commandes du JOUR, avec des produits qui se recoupent — c'est tout
// l'intérêt de la consolidation : 12 + 8 kg de tomate = une seule ligne d'achat
const today = casaDate();
const now = new Date().toISOString();
const orders = [
  { client: clients[0], lines: [['D-TOM', 'Tomate', 'KG', 12], ['D-ORA', 'Orange', 'KG', 20], ['D-MEN', 'Menthe', 'BOTTE', 10]] },
  { client: clients[1], lines: [['D-TOM', 'Tomate', 'KG', 8], ['D-POM', 'Pomme de terre', 'KG', 30]] },
  { client: clients[2], lines: [['D-ORA', 'Orange', 'KG', 5], ['D-POM', 'Pomme de terre', 'KG', 12]] },
];
const supName = { 'SUP-DEMO-A': 'Ferme Souss', 'SUP-DEMO-B': 'Verger Atlas' };
for (const o of orders) {
  const seq = await nextSeq(db, 'order');
  const doc = {
    orderId: 'CMD-' + String(seq).padStart(5, '0'),
    date: today, createdAt: now, createdBy: 'démo',
    client: o.client, invoiceNo: null,
    lines: o.lines.map(([itemId, name, uom, qty]) => {
      const sku = skus.find(s => s.itemId === itemId);
      return {
        itemId, name, uom, qty,
        supplierId: sku.supplierId, supplierName: supName[sku.supplierId] || 'Non assigné',
        margin: sku.margin, cost: null, clientPrice: null, status: 'pending',
      };
    }),
  };
  await db.collection(COL.orders).insertOne(doc);
  console.log('commande', doc.orderId, '—', o.client.name, `(${doc.lines.length} lignes)`);
}

await sql().end();
console.log(`\nclient « Démo vérification » prêt — mot de passe : demo-verif-po-2026`);
