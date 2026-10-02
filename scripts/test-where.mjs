// Vérifie la traduction filtre document -> SQL (sans base de données).
//   node scripts/test-where.mjs
import { buildWhere } from '../lib/db.js';

let pass = 0, fail = 0;
function check(label, filter, expectSql, expectParams) {
  const params = [];
  let text;
  try { text = buildWhere(filter, params).text; }
  catch (e) { text = 'THREW: ' + e.message; }
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const okSql = norm(text) === norm(expectSql);
  const okP = JSON.stringify(params) === JSON.stringify(expectParams);
  if (okSql && okP) { pass++; console.log('  ✓', label); }
  else {
    fail++; console.log('  ✗ FAIL', label);
    console.log('      got sql :', norm(text));
    console.log('      want sql:', norm(expectSql));
    if (!okP) { console.log('      got par :', JSON.stringify(params)); console.log('      want par:', JSON.stringify(expectParams)); }
  }
}

console.log('\nTraduction des filtres reellement utilises par l\'app :');

check('égalité simple (settings)',
  { _id: 'app' },
  `doc->>'_id' = $1`, ['app']);

check('$in (PO: skus par itemId)',
  { itemId: { $in: ['A', 'B'] } },
  `doc->>'itemId' = ANY($1)`, [['A', 'B']]);

check('plage de dates (PO: fenêtre commandes)',
  { date: { $gte: '2026-08-07', $lte: '2026-08-10' } },
  `doc->>'date' >= $1 AND doc->>'date' <= $2`, ['2026-08-07', '2026-08-10']);

check('recherche $or + $regex (catalogue)',
  { $or: [{ name: { $regex: 'tomate', $options: 'i' } }, { itemId: { $regex: 'tomate', $options: 'i' } }] },
  `((doc->>'name' ILIKE $1) OR (doc->>'itemId' ILIKE $2))`, ['%tomate%', '%tomate%']);

check('champ imbriqué client.name (factures)',
  { 'client.name': 'Resto A' },
  `doc->'client'->>'name' = $1`, ['Resto A']);

check('élément de tableau lines.supplierId (portail fournisseur)',
  { 'lines.supplierId': 'SUP-1' },
  `EXISTS (SELECT 1 FROM jsonb_array_elements(doc->'lines') e WHERE e->>'supplierId' = $1)`, ['SUP-1']);

check('filtre combiné (login fournisseur)',
  { password: 'leg2026', active: 1 },
  `doc->>'password' = $1 AND doc->>'active' = $2`, ['leg2026', '1']);

check('$ne',
  { invoiceNo: { $ne: null } },
  `(doc->>'invoiceNo' IS DISTINCT FROM $1)`, ['null']);

check('$exists',
  { poRef: { $exists: false } },
  `doc->>'poRef' IS NULL`, []);

check('filtre vide = tout',
  {}, `TRUE`, []);

check('update positionnel : sélection ligne (orders)',
  { orderId: 'CMD-1', 'lines.itemId': 'YF1' },
  `doc->>'orderId' = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(doc->'lines') e WHERE e->>'itemId' = $2)`,
  ['CMD-1', 'YF1']);

// sécurité : un opérateur inconnu doit LEVER, pas matcher toutes les lignes
console.log('\nSécurité — un opérateur inconnu ne doit jamais dégrader en "toutes les lignes" :');
{
  const params = [];
  let threw = false;
  try { buildWhere({ qty: { $where: 'x' } }, params); } catch { threw = true; }
  if (threw) { pass++; console.log('  ✓ $where non supporté -> exception'); }
  else { fail++; console.log('  ✗ FAIL: opérateur inconnu accepté silencieusement'); }
}

// injection : une valeur avec apostrophe doit passer en paramètre, pas dans le SQL
{
  const params = [];
  const { text } = buildWhere({ name: "O'Brien; DROP TABLE dima_skus;--" }, params);
  const safe = !text.includes('DROP') && params[0] === "O'Brien; DROP TABLE dima_skus;--";
  if (safe) { pass++; console.log('  ✓ valeurs paramétrées (pas d\'injection)'); }
  else { fail++; console.log('  ✗ FAIL: valeur interpolée dans le SQL'); }
}
// nom de champ avec apostrophe : échappé dans le chemin jsonb
{
  const params = [];
  const { text } = buildWhere({ "we'ird": 1 }, params);
  const safe = text.includes("''");
  if (safe) { pass++; console.log('  ✓ nom de champ échappé'); }
  else { fail++; console.log('  ✗ FAIL: nom de champ non échappé ->', text); }
}
// ── projection : un secret ne doit JAMAIS sortir d'une API ──────────────────
console.log('\nProjection (les handlers comptent dessus pour masquer les mots de passe) :');
{
  const { projectDoc } = await import('../lib/db.js');
  const doc = { supplierId: 'S1', name: 'Hamid', password: 'secret123', active: 1 };

  const a = projectDoc(doc, { _id: 0, password: 0 });
  if (!('password' in a) && a.name === 'Hamid' && a.active === 1) {
    pass++; console.log('  OK  {password:0} retire le secret et garde le reste');
  } else { fail++; console.log('  FAIL exclusion ->', JSON.stringify(a)); }

  const b = projectDoc(doc, { name: 1, supplierId: 1 });
  if (Object.keys(b).length === 2 && !('password' in b)) {
    pass++; console.log('  OK  {name:1} ne renvoie que les champs demandes');
  } else { fail++; console.log('  FAIL inclusion ->', JSON.stringify(b)); }

  if (projectDoc(doc, undefined) === doc) {
    pass++; console.log('  OK  sans projection : document complet');
  } else { fail++; console.log('  FAIL sans projection'); }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
