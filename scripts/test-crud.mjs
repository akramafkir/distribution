// Test CRUD complet, sur un tenant jetable créé puis purgé.
// Vérifie les 4 opérations sur chaque entité ET les garde-fous métier :
// on ne supprime pas ce qui a un passé, on n'efface jamais une facture.
//
//   node --env-file=.env.local scripts/test-crud.mjs
import { getDb, COL } from '../lib/mongo.js';
import { purgeTenant, sql } from '../lib/db.js';

const T = 'zz-test-crud';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const head = t => console.log('\n' + t);

// Les handlers sont testés directement : même code qu'en production, sans réseau.
async function call(mod, { method = 'GET', query = {}, body } = {}) {
  const h = (await import(`../api/${mod}.js`)).default;
  let status = 0, payload = null;
  const res = {
    setHeader() {}, status(c) { status = c; return this; },
    json(o) { payload = o; return this; }, send(o) { payload = o; return this; }, end() { return this; },
  };
  await h({ method, query, body, headers: { 'x-auth-token': `t.${T}.${sign()}` } }, res);
  return { status, payload };
}
// jeton d'équipe valide pour le tenant de test
import { createHmac } from 'node:crypto';
function sign() {
  return createHmac('sha256', process.env.APP_TOKEN || '').update('team:' + T).digest('hex').slice(0, 32);
}

const db = await getDb(T);
try {
  await db.collection(COL.settings).updateOne({ _id: 'app' },
    { $set: { _id: 'app', tvaRate: 0, timbreRate: 0.25, timbreOnCashOnly: true, invoicePrefix: 'TT' } }, { upsert: true });

  // ── FOURNISSEUR ───────────────────────────────────────────────────────────
  head('1. Fournisseur — créer / lire / modifier / supprimer');
  let r = await call('suppliers', { method: 'POST', body: { name: 'Ferme A', password: 'motdepasse1' } });
  ok(r.status === 200, 'création');
  const supId = r.payload?.row?.supplierId;
  ok(!('password' in (r.payload?.row || {})), 'le mot de passe n\'est jamais renvoyé');

  r = await call('suppliers', { method: 'POST', body: { name: 'Ferme B', password: 'motdepasse1' } });
  ok(r.status === 409, 'refuse un mot de passe déjà pris');

  r = await call('suppliers', { method: 'PATCH', body: { supplierId: supId, name: 'Ferme A bis', phone: '0600' } });
  ok(r.status === 200 && r.payload.row.name === 'Ferme A bis', 'modification');
  ok(!('password' in (r.payload?.row || {})), 'la modification ne fuit pas le mot de passe');

  r = await call('suppliers', { method: 'PATCH', body: { supplierId: supId, password: 'court' } });
  ok(r.status === 400, 'refuse un mot de passe trop court');

  // ── PRODUIT ───────────────────────────────────────────────────────────────
  head('2. Produit — créer / modifier / supprimer');
  r = await call('skus', { method: 'POST', body: { name: 'Tomate', uom: 'KG', price: 8, supplierId: supId } });
  ok(r.status === 200, 'création');
  const itemId = r.payload.row.itemId;

  r = await call('skus', { method: 'PATCH', body: { itemId, price: 9.5, supplierId: supId, margin: 1.4 } });
  ok(r.status === 200 && r.payload.row.price === 9.5, 'modification du prix');
  ok(r.payload.row.margin === 1.4, 'modification de la marge (PATCH la prenait en compte ?)');
  ok(r.payload.row.supplierId === supId, 'modification du fournisseur');

  r = await call('skus', { method: 'PATCH', body: { itemId, purchaseUom: 'CAISSE', qtyPerUnit: 10 } });
  ok(r.payload.row.purchase?.uom === 'CAISSE' && r.payload.row.uomFactors?.KG === 1, 'unité d\'achat + facteurs');
  r = await call('skus', { method: 'PATCH', body: { itemId, purchaseUom: '' } });
  ok(!r.payload.row.purchase, '« identique à la vente » efface le bloc d\'achat');

  // ── CLIENT ────────────────────────────────────────────────────────────────
  head('3. Client — créer / modifier / supprimer');
  r = await call('clients', { method: 'POST', body: { name: 'Restaurant Test', city: 'Casablanca' } });
  ok(r.status === 200, 'création');
  const clientId = r.payload.row.clientId;

  r = await call('clients', { method: 'PATCH', body: { clientId, name: 'Restaurant Modifié', phone: '0611' } });
  ok(r.status === 200 && r.payload.row.name === 'Restaurant Modifié', 'modification');

  r = await call('clients', { method: 'PATCH', body: { clientId, name: '' } });
  ok(r.status === 400, 'refuse un nom vide');

  r = await call('clients', { method: 'DELETE', query: { clientId: 'inexistant' } });
  ok(r.status === 404, 'supprimer un client inconnu → 404');

  // position GPS du magasin (pour l'itinéraire du livreur)
  r = await call('clients', { method: 'PATCH', body: { clientId, geo: { lat: 33.5892, lng: -7.6036, accuracy: 12.4 } } });
  ok(r.status === 200 && r.payload.row.geo?.lat === 33.5892 && r.payload.row.geo?.accuracy === 12, 'position enregistrée (lat/lng + précision arrondie)');
  r = await call('clients', { method: 'PATCH', body: { clientId, geo: { lat: 999, lng: 0 } } });
  ok(r.status === 400, 'coordonnées impossibles → 400');
  r = await call('clients', { method: 'PATCH', body: { clientId, name: 'Restaurant Modifié' } });
  ok(r.payload.row.geo?.lat === 33.5892, 'un PATCH sans geo ne touche pas la position');
  r = await call('clients', { method: 'PATCH', body: { clientId, geo: { lat: 33.5892, lng: -7.6036, accuracy: 5000 } } });
  ok(r.status === 400, 'précision > 1 km (fix WiFi de bureau) → 400');
  r = await call('clients', { method: 'PATCH', body: { clientId, geo: null } });
  ok(r.status === 200 && !r.payload.row.geo, 'geo: null retire la position');
  r = await call('clients', { method: 'PATCH', body: { clientId, geo: { lat: 33.5892, lng: -7.6036 } } });
  ok(r.status === 200, 'position re-capturée pour la suite');
  // même position renvoyée par un formulaire d'édition → l'horodatage d'origine survit
  const at0 = r.payload.row.geo.at;
  await new Promise(res2 => setTimeout(res2, 1100));
  r = await call('clients', { method: 'PATCH', body: { clientId, geo: { lat: 33.5892, lng: -7.6036 } } });
  ok(r.payload.row.geo.at === at0, 'même position re-envoyée → horodatage de capture préservé');
  r = await call('clients', { method: 'POST', body: { name: 'Client géolocalisé', geo: { lat: 33.6, lng: -7.61, accuracy: 8 } } });
  ok(r.status === 200 && r.payload.row.geo?.lng === -7.61, 'création avec position');
  await call('clients', { method: 'DELETE', query: { clientId: r.payload.row.clientId } });

  // ── COMMANDE ──────────────────────────────────────────────────────────────
  head('4. Commande — créer / modifier / supprimer');
  const client = { clientId, name: 'Restaurant Modifié', city: 'Casablanca' };
  r = await call('orders', { method: 'POST', body: { client, lines: [{ itemId, name: 'Tomate', uom: 'KG', qty: 10 }] } });
  ok(r.status === 200, 'création');
  const orderId = r.payload.order.orderId;

  r = await call('orders', { method: 'PATCH', body: { orderId, lines: [{ itemId, name: 'Tomate', uom: 'KG', qty: 25 }] } });
  ok(r.status === 200 && r.payload.order.lines[0].qty === 25, 'modification de la quantité');

  r = await call('orders', { method: 'PATCH', body: { orderId, lines: [] } });
  ok(r.status === 400, 'refuse une commande sans ligne');

  // le client a maintenant un historique → désactivation, pas suppression
  r = await call('clients', { method: 'DELETE', query: { clientId } });
  ok(r.status === 200 && r.payload.deactivated, 'client avec commande → désactivé, pas supprimé');
  const c = await db.collection(COL.clients).findOne({ clientId });
  ok(c && c.active === 0, 'le client existe toujours, marqué inactif');

  // le fournisseur a un produit → désactivation
  r = await call('suppliers', { method: 'DELETE', query: { supplierId: supId } });
  ok(r.status === 200 && r.payload.deactivated, 'fournisseur avec produits → désactivé');

  // ── FACTURE ───────────────────────────────────────────────────────────────
  head('5. Facture — émettre / corriger / annuler');
  await db.collection(COL.orders).updateOne({ orderId },
    { $set: { 'lines.$.cost': 6, 'lines.$.clientPrice': 9, 'lines.$.status': 'priced' } },
    { });
  // (updateOne positionnel a besoin d'un filtre sur lines : on repasse en direct)
  const ord = await db.collection(COL.orders).findOne({ orderId });
  ord.lines = ord.lines.map(l => ({ ...l, cost: 6, clientPrice: 9, status: 'priced' }));
  await db.collection(COL.orders).updateOne({ orderId }, { $set: { lines: ord.lines } });

  r = await call('orders', { method: 'POST', query: { action: 'invoice' }, body: { orderId, paymentMode: 'espece' } });
  ok(r.status === 200, 'facturation de la commande');
  const numero = r.payload?.invoice?.numero;
  const netCash = r.payload?.invoice?.net;

  r = await call('orders', { method: 'DELETE', query: { orderId } });
  ok(r.status === 409, 'commande facturée → suppression refusée');

  r = await call('invoices', { method: 'PATCH', body: { numero, paymentMode: 'virement' } });
  ok(r.status === 200 && r.payload.invoice.timbre === 0, 'virement → droit de timbre retiré');
  ok(r.payload.invoice.net < netCash, 'le net est recalculé, pas repris du client');

  r = await call('invoices', { method: 'DELETE', query: { numero } });
  ok(r.status === 400, 'annulation sans motif → refusée');

  r = await call('invoices', { method: 'DELETE', query: { numero, reason: 'erreur de quantité' } });
  ok(r.status === 200 && r.payload.cancelled === numero, 'annulation avec motif');
  ok(r.payload.releasedOrder === orderId, 'la commande redevient facturable');

  const inv = await db.collection(COL.invoices).findOne({ numero });
  ok(!!inv, 'la facture EXISTE toujours en base (conservation 10 ans)');
  ok(inv.status === 'cancelled' && inv.cancelReason === 'erreur de quantité', 'marquée annulée, motif conservé');

  r = await call('invoices', { method: 'PATCH', body: { numero, notes: 'x' } });
  ok(r.status === 409, 'une facture annulée ne se modifie plus');

  r = await call('invoices', { method: 'DELETE', query: { numero, reason: 'encore' } });
  ok(r.status === 409, 'double annulation refusée');

  // la commande libérée peut maintenant être supprimée
  r = await call('orders', { method: 'DELETE', query: { orderId } });
  ok(r.status === 200 && r.payload.deleted, 'commande libérée → suppression possible');

  // ── garde-fou : ligne déjà achetée ────────────────────────────────────────
  head('6. Garde-fou — marchandise déjà achetée');
  r = await call('orders', { method: 'POST', body: { client, lines: [{ itemId, name: 'Tomate', uom: 'KG', qty: 5 }] } });
  const o2 = r.payload.order.orderId;
  const doc = await db.collection(COL.orders).findOne({ orderId: o2 });
  doc.lines[0].poRef = 'PO-2026-08-11';
  await db.collection(COL.orders).updateOne({ orderId: o2 }, { $set: { lines: doc.lines } });

  r = await call('orders', { method: 'DELETE', query: { orderId: o2 } });
  ok(r.status === 409 && /achetée/.test(r.payload.error), 'suppression refusée : déjà achetée');

  r = await call('orders', { method: 'PATCH', body: { orderId: o2, lines: [{ itemId: 'AUTRE', name: 'x', qty: 1 }] } });
  ok(r.status === 409, 'retirer une ligne déjà achetée → refusé');

  // ── suppression franche quand rien n'y est rattaché ───────────────────────
  head('7. Suppression franche quand il n\'y a pas d\'historique');
  r = await call('clients', { method: 'POST', body: { name: 'Client éphémère' } });
  const tmpId = r.payload.row.clientId;
  r = await call('clients', { method: 'DELETE', query: { clientId: tmpId } });
  ok(r.status === 200 && r.payload.deleted, 'client sans historique → réellement supprimé');
  ok(!(await db.collection(COL.clients).findOne({ clientId: tmpId })), 'il a bien disparu de la base');

  r = await call('suppliers', { method: 'POST', body: { name: 'Ferme éphémère', password: 'motdepasse2' } });
  const tmpSup = r.payload.row.supplierId;
  r = await call('suppliers', { method: 'DELETE', query: { supplierId: tmpSup } });
  ok(r.status === 200 && r.payload.deleted, 'fournisseur sans produit → réellement supprimé');
} finally {
  await purgeTenant(T);
  await sql().end();
}

console.log(`\n═══ ${pass} réussis, ${fail} échoués ═══`);
process.exit(fail ? 1 : 0);
