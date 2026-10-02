// Migration 003 — table du compte plateforme.
//   node --env-file=.env.local scripts/migrate-platform.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';

const __dir = dirname(fileURLToPath(import.meta.url));
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 20 });

await sql.unsafe(readFileSync(join(__dir, '..', 'supabase', '003-platform.sql'), 'utf-8'));
const [{ n }] = await sql`select count(*)::int n from dima_platform`;
console.log(`dima_platform prête — ${n} enregistrement(s)`);
await sql.end();
