// Charge le catalogue + les réglages dans Supabase.
//   node scripts/seed-supabase.mjs            (catalogue étendu, 945 produits)
//   node scripts/seed-supabase.mjs --active   (seulement les 255 actifs)
//   node scripts/seed-supabase.mjs --demo     (+ fournisseurs de démo)
//
// N'IMPORTE PAS les clients — chaque vendeur saisit les siens (loi 09-08).
// Idempotent : relancer met à jour sans dupliquer.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from '../lib/db.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PACK = 'C:\\Users\\Yola fresh\\Desktop\\YolaFresh-Marketplace-DATA';

const args = process.argv.slice(2);
const activeOnly = args.includes('--active');
const withDemo = args.includes('--demo');

function loadCatalogue() {
  const candidates = [
    join(PACK, 'catalogue-etendu.json'),
    join(PACK, 'catalogue-suggere.json'),
    join(ROOT, 'data', 'skus.json'),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error('Aucun fichier catalogue trouvé.\nCherché :\n  ' + candidates.join('\n  '));
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  console.log(`catalogue : ${file}`);

  return raw.map(r => {
    // accepts either the packaged shape (ref/nom/unite) or the raw snapshot
    const itemId = r.ref || r.itemId;
    const name = r.nom || r.name || '';
    const uom = (r.unite || r.uom || 'KG').toUpperCase();
    const price = Number(r.prix_indicatif_dh ?? r.seedPrice ?? r.price ?? 0) || 0;
    const active = r.actif_yolafresh != null ? Number(r.actif_yolafresh) : Number(r.active ?? 1);
    return {
      itemId, name,
      nomFr: r.nom_fr || '', nomAr: r.nom_ar || '',
      category: r.categorie || r.category || '',
      subCategory: r.sous_categorie || r.subCategory || '',
      uom,
      active,
      price,
      margin: 1.5,                       // marge client par défaut (1–2 DH)
      supplierId: '',                    // à assigner dans le Catalogue
      priceAsOf: r.prix_date || r.priceAsOf || null,
    };
  }).filter(s => s.itemId && s.name);
}

const DEMO_SUPPLIERS = [
  { supplierId: 'SUP-LEG', name: 'Ferme Légumes Souss', phone: '0661000001', email: '', password: 'leg2026', active: 1 },
  { supplierId: 'SUP-FRU', name: 'Verger Fruits Atlas', phone: '0661000002', email: '', password: 'fru2026', active: 1 },
  { supplierId: 'SUP-GEN', name: 'Marché Général Casa', phone: '0661000003', email: '', password: 'gen2026', active: 1 },
];

const SETTINGS = {
  _id: 'app',
  sellerName: 'Dima Fresh', sellerLegalForm: '', sellerAddress: '', sellerCity: 'Casablanca',
  sellerPhone: '', sellerEmail: '', ice: '', ifNo: '', rc: '', patente: '', rib: '', bank: '',
  tvaRate: 0, timbreRate: 0.25, timbreOnCashOnly: true, invoicePrefix: 'DF',
  footerNote: 'Merci de votre confiance — Dima Fresh',
  po: { maxBacklogDays: 3, wastageDefaultPct: 0, wastageCapPct: 25, kgStep: 1, costMaxAgeDays: 14 },
};

async function upsertMany(table, rows, pk) {
  const S = sql();
  const CH = 250;
  for (let i = 0; i < rows.length; i += CH) {
    // postgres.js serialises a JS object into jsonb natively — let it, rather
    // than hand-rolling a jsonb_array_elements unnest (which the driver quotes
    // as a scalar and Postgres then refuses to expand).
    const chunk = rows.slice(i, i + CH).map(d => ({ id: String(d[pk]), doc: S.json(d) }));
    await S`
      INSERT INTO ${S(table)} ${S(chunk, 'id', 'doc')}
      ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`;
    process.stdout.write(`\r  ${table}: ${Math.min(i + CH, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');
}

const run = async () => {
  const S = sql();
  const [{ now }] = await S`select now()`;
  console.log('connecté à Supabase —', now.toISOString());

  // tables present?
  const t = await S`select table_name from information_schema.tables
                    where table_schema='public' and table_name like 'dima_%'`;
  const have = t.map(r => r.table_name);
  const need = ['dima_skus', 'dima_clients', 'dima_suppliers', 'dima_orders', 'dima_invoices', 'dima_po', 'dima_settings', 'dima_counters'];
  const missing = need.filter(x => !have.includes(x));
  if (missing.length) {
    console.error('\n❌ Tables manquantes :', missing.join(', '));
    console.error('   Lance d\'abord supabase/schema.sql dans Supabase → SQL Editor.');
    process.exit(1);
  }

  let cat = loadCatalogue();
  if (activeOnly) cat = cat.filter(s => s.active === 1);
  console.log(`${cat.length} produits (actifs: ${cat.filter(s => s.active === 1).length})`);
  await upsertMany('dima_skus', cat, 'itemId');

  await S.unsafe(`INSERT INTO dima_settings (id, doc) VALUES ('app', $1::jsonb)
                  ON CONFLICT (id) DO NOTHING`, [JSON.stringify(SETTINGS)]);
  console.log('  réglages initialisés (non écrasés si déjà présents)');

  await S.unsafe(`INSERT INTO dima_counters (id, value) VALUES ('invoice',0),('order',0)
                  ON CONFLICT (id) DO NOTHING`);
  console.log('  compteurs facture/commande initialisés');

  if (withDemo) {
    await upsertMany('dima_suppliers', DEMO_SUPPLIERS, 'supplierId');
    console.log('  3 fournisseurs de démo (mots de passe leg2026 / fru2026 / gen2026)');
  }

  const [{ n: nSkus }] = await S`select count(*)::int as n from dima_skus`;
  const [{ n: nCli }] = await S`select count(*)::int as n from dima_clients`;
  const [{ n: nSup }] = await S`select count(*)::int as n from dima_suppliers`;
  console.log(`\n✅ Terminé — ${nSkus} produits, ${nSup} fournisseurs, ${nCli} clients (carnet vide voulu).`);
  await S.end();
};

run().catch(e => { console.error('\n❌', e.message); process.exit(1); });
