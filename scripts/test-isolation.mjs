// Test d'ISOLATION multi-tenant — le test le plus important de l'application.
// Si un client peut voir les données d'un autre, tout le reste n'a aucune valeur.
//   node --env-file=.env.local scripts/test-isolation.mjs
import { getDb, sql, nextSeq } from '../lib/db.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ ÉCHEC', m); } };

const A = '__test_a', B = '__test_b';
const S = sql();
const cleanup = async () => {
  for (const t of ['dima_skus','dima_clients','dima_orders','dima_invoices','dima_suppliers','dima_settings','dima_counters','dima_po'])
    await S.unsafe(`delete from ${t} where tenant_id in ($1,$2)`, [A, B]);
  await S`delete from dima_tenants where id in (${A},${B})`;
};
await cleanup();

const dbA = await getDb(A), dbB = await getDb(B);

console.log('\n1. Les données d\'un client sont invisibles pour l\'autre');
await dbA.collection('dima_clients').insertOne({ clientId:'C1', name:'Client SECRET de A', phone:'0600000001' });
await dbB.collection('dima_clients').insertOne({ clientId:'C1', name:'Client de B',        phone:'0600000002' });

const aRows = await dbA.collection('dima_clients').find({}).toArray();
const bRows = await dbB.collection('dima_clients').find({}).toArray();
ok(aRows.length === 1 && aRows[0].name === 'Client SECRET de A', 'A ne voit que son client');
ok(bRows.length === 1 && bRows[0].name === 'Client de B', 'B ne voit que le sien');
ok(!JSON.stringify(bRows).includes('SECRET'), "aucune trace des données de A chez B");

console.log('\n2. Même identifiant chez deux clients : pas de collision');
ok(aRows[0].clientId === 'C1' && bRows[0].clientId === 'C1', 'C1 existe chez A ET chez B, séparément');

console.log('\n3. Lecture ciblée : impossible d\'atteindre la fiche d\'un autre');
const cross = await dbB.collection('dima_clients').findOne({ name: 'Client SECRET de A' });
ok(cross === null, 'findOne sur le nom exact du client de A -> null depuis B');

console.log('\n4. Écriture : impossible de modifier la fiche d\'un autre');
await dbB.collection('dima_clients').updateOne({ clientId:'C1' }, { $set:{ name:'PIRATÉ' } });
const aAfter = await dbA.collection('dima_clients').findOne({ clientId:'C1' });
ok(aAfter.name === 'Client SECRET de A', "l'écriture de B n'a pas touché la fiche de A");

console.log('\n5. Comptage : countDocuments est aussi cloisonné');
await dbA.collection('dima_clients').insertOne({ clientId:'C2', name:'Deuxième de A' });
ok(await dbA.collection('dima_clients').countDocuments({}) === 2, 'A compte 2');
ok(await dbB.collection('dima_clients').countDocuments({}) === 1, 'B compte 1');

console.log('\n6. Numérotation des factures : indépendante par client');
const a1 = await nextSeq(dbA, 'invoice'), a2 = await nextSeq(dbA, 'invoice');
const b1 = await nextSeq(dbB, 'invoice');
ok(a1 === 1 && a2 === 2, `A : ${a1} puis ${a2}`);
ok(b1 === 1, `B repart à 1 (${b1}) — la facture n°1 de B n'est pas la n°3`);

console.log('\n7. Un accès sans client est REFUSÉ, pas silencieusement global');
{
  const plat = await getDb(null);
  let threw = false;
  try { plat.collection('dima_clients'); } catch { threw = true; }
  ok(threw, 'getDb(null).collection("dima_clients") lève une exception');
  let ok2 = true;
  try { plat.collection('dima_tenants'); } catch { ok2 = false; }
  ok(ok2, 'les tables plateforme (dima_tenants) restent accessibles');
  let threwSeq = false;
  try { await nextSeq(plat, 'invoice'); } catch { threwSeq = true; }
  ok(threwSeq, 'nextSeq sans client lève une exception');
}

console.log('\n8. Le catalogue est propre à chaque client');
await dbA.collection('dima_skus').insertOne({ itemId:'P1', name:'Tomate A', uom:'KG', price:8, active:1 });
await dbB.collection('dima_skus').insertOne({ itemId:'P1', name:'Tomate B', uom:'KG', price:12, active:1 });
const pA = await dbA.collection('dima_skus').findOne({ itemId:'P1' });
const pB = await dbB.collection('dima_skus').findOne({ itemId:'P1' });
ok(pA.price === 8 && pB.price === 12, 'même référence, prix différents par client (8 vs 12 DH)');

await cleanup();
await S.end({ timeout: 5 });
console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
