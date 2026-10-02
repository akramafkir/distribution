// Migration multi-tenant :
//   1. applique supabase/002-multitenant.sql
//   2. déplace le catalogue existant vers la bibliothèque partagée
//   3. crée le premier client et lui copie la bibliothèque
//
//   node --env-file=.env.local scripts/migrate-multitenant.mjs "Salim" <motdepasse>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';

const __dir = dirname(fileURLToPath(import.meta.url));
const [, , NAME = 'Salim', PASSWORD] = process.argv;
if (!PASSWORD || PASSWORD.length < 6) {
  console.error('usage: node scripts/migrate-multitenant.mjs "<Nom>" <motdepasse 6+ car.>');
  process.exit(1);
}
const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
const TID = slug(NAME);

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 20 });

// 1. schéma
await sql.unsafe(readFileSync(join(__dir, '..', 'supabase', '002-multitenant.sql'), 'utf-8'));
console.log('1. schéma multi-tenant appliqué');

// 2. catalogue existant -> bibliothèque partagée
const moved = await sql`
  insert into dima_library (id, doc)
  select id, doc from dima_skus where tenant_id = '__legacy'
  on conflict (id) do update set doc = excluded.doc
  returning id`;
console.log(`2. bibliothèque partagée : ${moved.length} produits`);
await sql`delete from dima_skus where tenant_id = '__legacy'`;

// 3. le premier client
const exists = await sql`select id from dima_tenants where id = ${TID}`;
if (!exists.length) {
  await sql`insert into dima_tenants (id, doc) values (${TID}, ${sql.json({
    tenantId: TID, name: NAME, password: PASSWORD, logo: '', color: '',
    active: 1, createdAt: new Date().toISOString(),
  })})`;
  console.log(`3. client créé : ${NAME} (${TID})`);
} else {
  await sql`update dima_tenants set doc = jsonb_set(doc,'{password}', to_jsonb(${PASSWORD}::text)) where id = ${TID}`;
  console.log(`3. client existant : ${TID} (mot de passe mis à jour)`);
}

// 4. copie de la bibliothèque dans SON catalogue
const copied = await sql`
  insert into dima_skus (tenant_id, id, doc)
  select ${TID}, id, doc from dima_library
  on conflict (tenant_id, id) do nothing
  returning id`;
console.log(`4. catalogue de ${NAME} : ${copied.length} produits copiés`);

// 5. réglages + fournisseurs existants rattachés au premier client
await sql`update dima_settings  set tenant_id = ${TID} where tenant_id = '__legacy'`;
await sql`update dima_suppliers set tenant_id = ${TID} where tenant_id = '__legacy'`;
await sql`update dima_clients   set tenant_id = ${TID} where tenant_id = '__legacy'`;
await sql`update dima_orders    set tenant_id = ${TID} where tenant_id = '__legacy'`;
await sql`update dima_invoices  set tenant_id = ${TID} where tenant_id = '__legacy'`;
await sql`update dima_po        set tenant_id = ${TID} where tenant_id = '__legacy'`;
await sql`update dima_counters  set tenant_id = ${TID} where tenant_id = '__legacy'`;
await sql`update dima_settings set doc = jsonb_set(doc,'{sellerName}', to_jsonb(${NAME}::text)) where tenant_id = ${TID}`;
console.log('5. données existantes rattachées au premier client');

const [{ n: libN }] = await sql`select count(*)::int n from dima_library`;
const [{ n: skuN }] = await sql`select count(*)::int n from dima_skus where tenant_id = ${TID}`;
const [{ n: tN }] = await sql`select count(*)::int n from dima_tenants`;
console.log(`\n✅ bibliothèque ${libN} · catalogue ${NAME} ${skuN} · clients plateforme ${tN}`);
await sql.end();
