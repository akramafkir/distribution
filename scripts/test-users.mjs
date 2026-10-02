// Comptes nommés + journal : qui a fait quoi, prouvé par le serveur.
//   APP_TOKEN=t node --env-file=.env.local scripts/test-users.mjs
import { getDb, COL, teamToken } from '../lib/mongo.js';
import { purgeTenant, sql } from '../lib/db.js';

const T = 'zz-test-users';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const head = t => console.log('\n' + t);

async function call(mod, { method = 'GET', query = {}, body, token } = {}) {
  const h = (await import(`../api/${mod}.js`)).default;
  let status = 0, payload = null;
  const res = { setHeader() {}, status(c) { status = c; return this; },
    json(o) { payload = o; return this; }, send(o) { payload = o; return this; }, end() { return this; } };
  await h({ method, query, body, headers: { 'x-auth-token': token || '' } }, res);
  return { status, payload };
}

const platform = await getDb(null);
const db = await getDb(T);
const OWNER = teamToken(T);
try {
  // un tenant de test avec un mot de passe, pour que la connexion le trouve
  await platform.collection(COL.tenants).updateOne({ tenantId: T }, { $set: {
    tenantId: T, name: 'Test Utilisateurs', password: 'zz-test-owner-pass', active: 1, createdAt: new Date().toISOString(),
  } }, { upsert: true });
  await db.collection(COL.settings).updateOne({ _id: 'app' },
    { $set: { _id: 'app', tvaRate: 0, timbreRate: 0, invoicePrefix: 'TU' } }, { upsert: true });

  head('1. Le compte principal crée les membres');
  let r = await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'Karim (livraison)', password: 'karim-zz-2026', phone: '0611' }, token: OWNER });
  ok(r.status === 200 && r.payload.row?.userId, 'création de Karim');
  const karimId = r.payload.row.userId;
  ok(!('password' in (r.payload.row || {})), 'le mot de passe n\'est jamais renvoyé');

  r = await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'X', password: 'court' }, token: OWNER });
  ok(r.status === 400, 'mot de passe trop court → 400');
  r = await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'X', password: 'karim-zz-2026' }, token: OWNER });
  ok(r.status === 409, 'mot de passe déjà pris par un membre → 409');
  r = await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'X', password: 'zz-test-owner-pass' }, token: OWNER });
  ok(r.status === 409, 'mot de passe du compte principal → 409');

  await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'Sara (facturation)', password: 'sara-zz-2026' }, token: OWNER });

  head('2. La connexion reconnaît le membre par SON mot de passe');
  r = await call('login', { method: 'POST', body: { password: 'karim-zz-2026' } });
  ok(r.status === 200 && r.payload.role === 'team', 'connexion acceptée, rôle équipe');
  ok(r.payload.userId === karimId && r.payload.name === 'Karim (livraison)', 'le serveur sait QUI se connecte');
  const KARIM = r.payload.token;
  ok(KARIM.startsWith('u.'), 'jeton nominatif');

  head('3. L\'identité vient du jeton, pas du formulaire');
  await db.collection(COL.clients).insertOne({ clientId: 'TU-C1', name: 'Client Test', active: 1 });
  await db.collection(COL.skus).insertOne({ itemId: 'TU-P1', name: 'Tomate', uom: 'KG', price: 9, margin: 1.5, active: 1 });
  r = await call('orders', { method: 'POST', token: KARIM,
    body: { client: { clientId: 'TU-C1', name: 'Client Test' },
            createdBy: 'QUELQU\'UN D\'AUTRE',            // tentative d'usurpation
            lines: [{ itemId: 'TU-P1', name: 'Tomate', uom: 'KG', qty: 5 }] } });
  ok(r.status === 200, 'commande créée avec le jeton de Karim');
  ok(r.payload.order.createdBy === 'Karim (livraison)', `créée par « ${r.payload.order.createdBy} » — le nom envoyé dans le formulaire est ignoré`);
  const orderId = r.payload.order.orderId;

  head('4. Un membre ne gère ni les membres ni le journal');
  r = await call('settings', { method: 'GET', query: { entity: 'users' }, token: KARIM });
  ok(r.status === 403, 'liste des membres → 403');
  r = await call('settings', { method: 'POST', query: { entity: 'users' }, body: { name: 'Pirate', password: 'pirate-2026' }, token: KARIM });
  ok(r.status === 403, 'créer un membre → 403');
  r = await call('settings', { method: 'GET', query: { entity: 'journal' }, token: KARIM });
  ok(r.status === 403, 'lire le journal → 403');
  r = await call('settings', { method: 'GET', token: KARIM });
  ok(r.status === 200, 'mais les réglages restent lisibles (il en a besoin pour facturer)');

  head('5. Le journal dit qui a fait quoi');
  r = await call('settings', { method: 'GET', query: { entity: 'journal', limit: '50' }, token: OWNER });
  ok(r.status === 200 && r.payload.rows.length >= 3, `${r.payload.rows.length} lignes au journal`);
  const jn = r.payload.rows;
  ok(jn.some(l => l.action === 'connexion' && l.actor === 'Karim (livraison)'), 'la connexion de Karim est tracée');
  ok(jn.some(l => l.action === 'commande.création' && l.actor === 'Karim (livraison)' && l.target === orderId), 'sa commande est tracée à son nom');
  ok(jn.some(l => l.action === 'membre.création'), 'la création de membre est tracée');
  ok(jn.every(l => l.at && l.actor && l.action), 'chaque ligne a quand/qui/quoi');

  r = await call('settings', { method: 'GET', query: { entity: 'journal', q: 'karim' }, token: OWNER });
  ok(r.payload.rows.length >= 2 && r.payload.rows.every(l => /karim/i.test(l.actor) || /karim/i.test(l.target)), 'filtre par nom');

  head('6. Désactivation = plus de connexion, historique intact');
  r = await call('settings', { method: 'PATCH', query: { entity: 'users' },
    body: { userId: karimId, active: false }, token: OWNER });
  ok(r.status === 200, 'Karim désactivé');
  r = await call('login', { method: 'POST', body: { password: 'karim-zz-2026' } });
  ok(r.status === 401, 'sa connexion est refusée');
  r = await call('orders', { method: 'GET', query: { id: orderId }, token: KARIM });
  ok(r.status === 401, 'son ancien jeton est coupé IMMÉDIATEMENT, même déjà connecté');

  r = await call('settings', { method: 'DELETE', query: { entity: 'users', userId: karimId }, token: OWNER });
  ok(r.status === 200 && r.payload.deactivated, 'suppression → désactivé (il a des actions au journal)');
  const still = await db.collection(COL.users).findOne({ userId: karimId });
  ok(!!still, 'sa fiche existe toujours — le journal reste lisible');

  const sara = await db.collection(COL.users).findOne({ name: 'Sara (facturation)' });
  r = await call('settings', { method: 'DELETE', query: { entity: 'users', userId: sara.userId }, token: OWNER });
  ok(r.status === 200 && (r.payload.deleted || r.payload.deactivated), 'Sara supprimée ou désactivée selon son journal');

  head('7. Rien ne fuit entre clients de la plateforme');
  const dbSalim = await getDb('salim');
  // salim est un vrai client en production (il peut avoir de vrais membres) :
  // on vérifie qu'AUCUN membre DE TEST n'a fuité chez lui, pas qu'il est vide.
  const salimUsers = await dbSalim.collection(COL.users).find({}).toArray();
  const leaked = salimUsers.filter(usr => /karim|sara|piège|membre rib/i.test(usr.name || ''));
  ok(leaked.length === 0, `aucun membre de TEST chez salim (${salimUsers.length} vrai(s) membre(s) préservé(s))`);

  head('8. Unicité GLOBALE du mot de passe (correctif revue : fuite entre clients)');
  // un second tenant de test avec un fournisseur, pour simuler deux clients
  const T2 = 'zz-test-users-2';
  await platform.collection(COL.tenants).updateOne({ tenantId: T2 }, { $set: {
    tenantId: T2, name: 'Autre Client', password: 'zz-t2-owner-pass', active: 1, createdAt: new Date().toISOString(),
  } }, { upsert: true });
  const db2 = await getDb(T2);
  await db2.collection(COL.suppliers).insertOne({ supplierId: 'S2', name: 'Fournisseur B', password: 'collision-globale-xyz', active: 1 });

  // le compte principal de T ne peut PAS créer un membre avec le mdp du fournisseur de T2
  let rr = await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'Piège', password: 'collision-globale-xyz' }, token: OWNER });
  ok(rr.status === 409, 'membre avec le mdp d\'un fournisseur d\'un AUTRE client → 409 (plus de fuite cross-client)');

  rr = await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'Piège2', password: 'zz-t2-owner-pass' }, token: OWNER });
  ok(rr.status === 409, 'membre avec le mdp d\'un AUTRE compte principal → 409');

  rr = await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'Piège3', password: 'zz-test-owner-pass' }, token: OWNER });
  ok(rr.status === 409, 'membre avec le mdp du compte principal courant → 409');
  await purgeTenant(T2);

  head('9. RIB / identité de facturation : compte principal uniquement');
  // recrée un membre actif pour le test
  await call('settings', { method: 'POST', query: { entity: 'users' },
    body: { name: 'Membre RIB', password: 'membre-rib-zz-2026' }, token: OWNER });
  const li = await call('login', { method: 'POST', body: { password: 'membre-rib-zz-2026' } });
  const MEMBRE = li.payload.token;
  rr = await call('settings', { method: 'PATCH', body: { rib: '007-PIRATE-999', bank: 'Banque du voleur' }, token: MEMBRE });
  ok(rr.status === 403, 'un membre ne peut PAS changer le RIB → 403 (anti-détournement)');
  rr = await call('settings', { method: 'PATCH', body: { rib: '011-LEGIT-001' }, token: OWNER });
  ok(rr.status === 200, 'le compte principal, si');
  rr = await call('settings', { method: 'GET', token: MEMBRE });
  ok(rr.status === 200 && rr.payload.settings.rib === '011-LEGIT-001', 'le membre lit quand même les réglages (pour facturer)');
} finally {
  try { await purgeTenant('zz-test-users-2'); } catch { /* déjà purgé */ }
  await purgeTenant(T);
  await sql().end();
}
console.log(`\n═══ ${pass} réussis, ${fail} échoués ═══`);
process.exit(fail ? 1 : 0);
