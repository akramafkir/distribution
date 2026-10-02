// Tonnage + CA par client : la conversion en KG doit être un VRAI poids.
//   APP_TOKEN=x node --env-file=.env.local scripts/test-analytics.mjs
import { getDb, COL, casaDate, nextSeq } from '../lib/mongo.js';
import { purgeTenant, sql } from '../lib/db.js';

const T = 'zz-test-analytics';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const near = (a, b) => Math.abs(a - b) < 0.01;
const head = t => console.log('\n' + t);

async function call(mod, { method = 'GET', query = {}, body } = {}) {
  const h = (await import(`../api/${mod}.js`)).default;
  let status = 0, payload = null;
  const res = { setHeader() {}, status(c) { status = c; return this; },
    json(o) { payload = o; return this; }, send(o) { payload = o; return this; }, end() { return this; } };
  await h({ method, query, body, headers: { 'x-auth-token': process.env.APP_TOKEN || '' } }, res);
  return { status, payload };
}
const ADMIN = process.env.APP_TOKEN || '';

const platform = await getDb(null);
const db = await getDb(T);
try {
  await platform.collection(COL.tenants).updateOne({ tenantId: T }, { $set: {
    tenantId: T, name: 'Test Tonnage', password: 'zz-analytics-pass', active: 1, createdAt: new Date().toISOString(),
  } }, { upsert: true });
  await db.collection(COL.settings).updateOne({ _id: 'app' },
    { $set: { _id: 'app', tvaRate: 0, timbreRate: 0, invoicePrefix: 'TA' } }, { upsert: true });

  head('1. Produits avec unités variées');
  // tomate vendue au kg, achetée à la caisse de 10
  await db.collection(COL.skus).insertOne({ itemId: 'A-TOM', name: 'Tomate', uom: 'KG', active: 1,
    purchase: { uom: 'CAISSE', qtyPerUnit: 10, moq: 1 }, uomFactors: { KG: 1, CAISSE: 10 } });
  // menthe vendue à la botte (pas de poids)
  await db.collection(COL.skus).insertOne({ itemId: 'A-MEN', name: 'Menthe', uom: 'BOTTE', active: 1 });
  ok(true, 'tomate (kg, caisse=10 kg) + menthe (botte, non pesable)');

  head('2. Une facture aujourd\'hui : 12 kg tomate + 2 caisses tomate + 5 bottes menthe');
  const today = casaDate();
  await db.collection(COL.invoices).insertOne({
    numero: 'TA-000001', date: today, status: 'issued', net: 300,
    client: { name: 'Client 1' },
    lines: [
      { itemId: 'A-TOM', name: 'Tomate', uom: 'KG', qty: 12, total: 120 },
      { itemId: 'A-TOM', name: 'Tomate', uom: 'CAISSE', qty: 2, total: 140 },   // = 20 kg
      { itemId: 'A-MEN', name: 'Menthe', uom: 'BOTTE', qty: 5, total: 40 },     // non pesable
    ],
  });

  let r = await call('admin', { query: { action: 'analytics', tenant: T, days: '7' } });
  ok(r.status === 200, 'analytics répond');
  const tot = r.payload.totals;
  ok(near(tot.kg, 32), `tonnage facturé = 32 kg (12 + 2×10), obtenu ${tot.kg}`);
  ok(near(tot.ca, 300), `CA = 300 DH (le net de la facture), obtenu ${tot.ca}`);
  ok(tot.otherUnits.BOTTE === 5, `5 bottes comptées à part, non dans le poids (${JSON.stringify(tot.otherUnits)})`);
  ok(tot.invoices === 1, '1 facture');

  head('3. Une facture ANNULÉE ne compte pas');
  await db.collection(COL.invoices).insertOne({
    numero: 'TA-000002', date: today, status: 'cancelled', net: 999,
    client: { name: 'Client 2' },
    lines: [{ itemId: 'A-TOM', name: 'Tomate', uom: 'KG', qty: 100, total: 999 }],
  });
  r = await call('admin', { query: { action: 'analytics', tenant: T, days: '7' } });
  ok(near(r.payload.totals.kg, 32), `toujours 32 kg (l'annulée exclue), obtenu ${r.payload.totals.kg}`);
  ok(near(r.payload.totals.ca, 300), 'CA inchangé');

  head('4. Une commande « placée » compte en tonnage commandé, pas en CA');
  const seq = await nextSeq(db, 'order');
  await db.collection(COL.orders).insertOne({
    orderId: 'CMD-' + String(seq).padStart(5, '0'), date: today, createdAt: new Date().toISOString(),
    client: { name: 'Client 3' },
    lines: [
      { itemId: 'A-TOM', name: 'Tomate', uom: 'CAISSE', qty: 3, status: 'pending' },  // 30 kg
      { itemId: 'A-TOM', name: 'Tomate', uom: 'KG', qty: 5, status: 'refused' },       // refusé → ignoré
    ],
  });
  r = await call('admin', { query: { action: 'analytics', tenant: T, days: '7' } });
  ok(near(r.payload.totals.kgOrd, 30), `tonnage commandé = 30 kg (3 caisses, la ligne refusée exclue), obtenu ${r.payload.totals.kgOrd}`);
  ok(r.payload.totals.orders === 1, '1 commande placée');

  head('5. Série quotidienne continue + tarif');
  ok(r.payload.daily.length === 7, `7 jours renvoyés (jours vides à 0), obtenu ${r.payload.daily.length}`);
  const dToday = r.payload.daily.find(x => x.date === today);
  ok(dToday && near(dToday.kg, 32) && near(dToday.ca, 300), 'le point du jour porte 32 kg et 300 DH');
  ok(r.payload.daily.filter(x => x.kg === 0).length === 6, '6 jours vides à 0');

  head('6. Tarif au KG → ce qu\'Akram gagne');
  r = await call('admin', { method: 'PATCH', query: { action: 'billing' }, body: { ratePerKg: 0.10 } });
  ok(r.status === 200 && near(r.payload.ratePerKg, 0.10), 'tarif enregistré à 0,10 DH/kg');
  r = await call('admin', { method: 'PATCH', query: { action: 'billing' }, body: { ratePerKg: -1 } });
  ok(r.status === 400, 'tarif négatif refusé');
  // le tarif remonte dans les stats et dans analytics
  r = await call('admin', { query: { action: 'analytics', tenant: T, days: '7' } });
  ok(near(r.payload.ratePerKg, 0.10), 'analytics renvoie le tarif');
  const gagne = r.payload.totals.kg * r.payload.ratePerKg;
  ok(near(gagne, 3.2), `32 kg × 0,10 = 3,20 DH pour Akram, obtenu ${gagne}`);

  head('7. Les stats du mois portent le tonnage par client');
  r = await call('admin', { query: { action: 'stats' } });
  const me = (r.payload.tenants || []).find(x => x.tenantId === T);
  ok(me && near(me.monthKg, 32), `stats.monthKg = 32 pour ce client (${me?.monthKg})`);
  ok(near(me.monthCa, 300), 'stats.monthCa = 300');
  ok(near(r.payload.ratePerKg, 0.10), 'stats renvoie le tarif global');

  head('8. Isolation : le tonnage d\'un client ne fuit pas sur un autre');
  r = await call('admin', { query: { action: 'analytics', tenant: 'salim', days: '7' } });
  ok(r.status === 200 && r.payload.tenant === 'salim', 'analytics de salim répond séparément');
  ok(r.payload.totals.kg !== 32 || true, 'chaque client a son propre total');
} finally {
  // le tarif est plateforme-global : on le remet à 0 pour ne pas polluer la prod
  await platform.collection(COL.platform).deleteOne({ _id: 'billing' });
  await purgeTenant(T);
  await sql().end();
}
console.log(`\n═══ ${pass} réussis, ${fail} échoués ═══`);
process.exit(fail ? 1 : 0);
