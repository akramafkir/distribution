// La chaîne complète, sans fournisseur qui cote :
//   commande sans prix → PO → l'achat saisit le prix payé → il redescend sur
//   les commandes → la facturation pose le prix client → facture par client.
//   APP_TOKEN=x node --env-file=.env.local scripts/test-flow.mjs
import { getDb, COL, casaDate } from '../lib/mongo.js';
import { purgeTenant, sql } from '../lib/db.js';
import { createHmac } from 'node:crypto';

const T = 'zz-test-flow';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const head = t => console.log('\n' + t);
const sign = () => createHmac('sha256', process.env.APP_TOKEN || '').update('team:' + T).digest('hex').slice(0, 32);

async function call(mod, { method = 'GET', query = {}, body } = {}) {
  const h = (await import(`../api/${mod}.js`)).default;
  let status = 0, payload = null;
  const res = { setHeader() {}, status(c) { status = c; return this; },
    json(o) { payload = o; return this; }, send(o) { payload = o; return this; }, end() { return this; } };
  await h({ method, query, body, headers: { 'x-auth-token': `t.${T}.${sign()}` } }, res);
  return { status, payload };
}

const db = await getDb(T);
try {
  await db.collection(COL.settings).updateOne({ _id: 'app' }, { $set: {
    _id: 'app', tvaRate: 0, timbreRate: 0.25, timbreOnCashOnly: true, invoicePrefix: 'FL',
    po: { maxBacklogDays: 3, wastageDefaultPct: 0, wastageCapPct: 25, kgStep: 1, costMaxAgeDays: 14 },
  } }, { upsert: true });

  head('1. Le catalogue et deux clients');
  let r = await call('skus', { method: 'POST', body: { name: 'Tomate', uom: 'KG', price: 9, margin: 1.5,
    purchaseUom: 'CAISSE', qtyPerUnit: 10 } });
  const tom = r.payload.row.itemId;
  ok(r.status === 200, 'produit vendu au kg, acheté à la caisse de 10');

  const clients = [];
  for (const n of ['Restaurant A', 'Café B']) {
    const c = await call('clients', { method: 'POST', body: { name: n, city: 'Casablanca' } });
    clients.push(c.payload.row);
  }
  ok(clients.length === 2, 'deux clients');

  head('2. Deux commandes passées SANS prix — plus aucun fournisseur à attendre');
  const oids = [];
  for (const [i, c] of clients.entries()) {
    const q = i === 0 ? 12 : 8;
    const o = await call('orders', { method: 'POST', body: { client: c, lines: [{ itemId: tom, name: 'Tomate', uom: 'KG', qty: q }] } });
    oids.push(o.payload.order.orderId);
    ok(o.payload.order.status === 'pending', `${o.payload.order.orderId} — ${q} kg, statut « à acheter »`);
  }
  const before = await call('orders', { query: { id: oids[0] } });
  ok(before.payload.order.lines[0].cost == null, 'aucun coût à ce stade');

  head('3. PO Calculation consolide');
  r = await call('po', { method: 'POST', query: { action: 'run' } });
  ok(r.status === 200, 'génération du bon d\'achat');
  const line = r.payload.po.bySupplier.flatMap(g => g.lines).find(l => l.itemId === tom);
  ok(line.demand.baseQty === 20, '12 + 8 = 20 kg consolidés en une ligne');
  ok(line.purchase.units === 2 && line.purchase.uom === 'CAISSE', '→ 2 caisses à acheter');
  ok(line.demand.orderIds.length === 2, 'la ligne connaît ses 2 commandes d\'origine');

  head('4. Retour du marché : l\'équipe achat saisit le prix payé');
  // 2 caisses payées 70 DH la caisse = 7 DH/kg
  r = await call('po', { method: 'POST', query: { action: 'buy' },
    body: { date: casaDate(), by: 'Youssef', items: [{ itemId: tom, units: 2, unitPrice: 70 }] } });
  ok(r.status === 200, 'saisie enregistrée');
  ok(r.payload.ordersTouched === 2 && r.payload.linesUpdated === 2, 'le coût redescend sur les 2 commandes');
  ok(r.payload.totals.totalPaid === 140, 'total réellement payé : 140 DH');

  const po2 = await call('po', { query: { date: casaDate() } });
  const l2 = po2.payload.po.bySupplier.flatMap(g => g.lines).find(l => l.itemId === tom);
  ok(l2.bought.unitPrice === 70 && l2.bought.units === 2, 'le bon garde le détail de l\'achat');
  ok(l2.cost.perBaseUnit === 7 && l2.cost.source === 'achat_reel', '70 DH la caisse de 10 → 7 DH/kg');

  const sku = await db.collection(COL.skus).findOne({ itemId: tom });
  ok(sku.lastCost === 7, 'le prix est mémorisé pour les prochains bons');

  head('5. Les commandes sont maintenant « achetées », prêtes à tarifer');
  for (const id of oids) {
    const o = await call('orders', { query: { id } });
    ok(o.payload.order.status === 'bought', `${id} — coût connu (${o.payload.order.lines[0].cost} DH/kg)`);
  }
  r = await call('orders', { method: 'POST', query: { action: 'invoice' }, body: { orderId: oids[0] } });
  ok(r.status === 400 && /prix de vente/.test(r.payload.error), 'facturer sans prix client → refusé');

  head('6. La facturation pose le prix client, par commande donc par client');
  // marge 1.5 sur un coût de 7 → 10.50 suggéré ; on facture A à 10.50 et B à 11
  r = await call('orders', { method: 'PATCH', body: { orderId: oids[0], prices: [{ itemId: tom, clientPrice: 10.5 }] } });
  ok(r.status === 200 && r.payload.order.status === 'priced', 'Restaurant A tarifé à 10,50 DH');
  r = await call('orders', { method: 'PATCH', body: { orderId: oids[1], prices: [{ itemId: tom, clientPrice: 11 }] } });
  ok(r.status === 200, 'Café B tarifé à 11,00 DH — prix différent, même achat');

  r = await call('orders', { method: 'PATCH', body: { orderId: oids[0], prices: [{ itemId: tom, clientPrice: 5 }] } });
  ok(r.payload.belowCost?.length === 1, 'un prix sous le coût est accepté mais signalé');
  await call('orders', { method: 'PATCH', body: { orderId: oids[0], prices: [{ itemId: tom, clientPrice: 10.5 }] } });

  head('7. Une facture par client, au prix de vente saisi');
  const inv = [];
  for (const id of oids) {
    const f = await call('orders', { method: 'POST', query: { action: 'invoice' }, body: { orderId: id, paymentMode: 'espece' } });
    ok(f.status === 200, `facture de ${id}`);
    inv.push(f.payload.invoice);
  }
  ok(inv[0].lines[0].unitPrice === 10.5 && inv[0].subtotal === 126, 'A : 12 kg × 10,50 = 126 DH');
  ok(inv[1].lines[0].unitPrice === 11 && inv[1].subtotal === 88, 'B : 8 kg × 11,00 = 88 DH');
  ok(inv[0].numero !== inv[1].numero, 'deux numéros de facture distincts');

  const marge = (126 + 88) - 140;
  ok(marge === 74, `marge réelle vérifiable : 214 DH vendus − 140 DH payés = ${marge} DH`);

  head('8. Le prix payé ne bouge plus une fois facturé');
  r = await call('po', { method: 'POST', query: { action: 'buy' },
    body: { date: casaDate(), items: [{ itemId: tom, units: 2, unitPrice: 90 }] } });
  const after = await call('orders', { query: { id: oids[0] } });
  ok(after.payload.order.lines[0].cost === 7, 'la commande facturée garde son coût d\'origine');
} finally {
  await purgeTenant(T);
  await sql().end();
}
console.log(`\n═══ ${pass} réussis, ${fail} échoués ═══`);
process.exit(fail ? 1 : 0);
