// Applique supabase/schema.sql (compatible tout Postgres : Neon, Supabase, RDS).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
const __dir = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL manquant'); process.exit(1); }
const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20 });
const ddl = readFileSync(join(__dir, '..', 'supabase', 'schema.sql'), 'utf-8');
const [{ v }] = await sql`select version() as v`;
console.log('connecté :', v.split(',')[0]);
await sql.unsafe(ddl);
const t = await sql`select table_name from information_schema.tables
                    where table_schema='public' and table_name like 'dima_%' order by 1`;
console.log('tables créées :', t.map(r => r.table_name).join(', '));
const [{ n }] = await sql`select dima_next_seq('__selftest') as n`;
const [{ n: n2 }] = await sql`select dima_next_seq('__selftest') as n`;
console.log('compteur atomique :', n, '->', n2, (n2 === n + 1 ? 'OK' : 'ANORMAL'));
await sql`delete from dima_counters where id='__selftest'`;
await sql.end();
