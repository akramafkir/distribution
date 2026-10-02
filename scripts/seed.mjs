// Seed the independent Dima Fresh database from the captured snapshot.
//   MONGO_URI="mongodb+srv://..." node scripts/seed.mjs
// Idempotent: upserts SKUs (by itemId) and clients (by clientId), sets seedPrice
// as the starting editable `price`, and initialises settings + invoice counter.
import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, '..', 'data');
const uri = process.env.MONGO_URI;
if (!uri) { console.error('❌ MONGO_URI not set'); process.exit(1); }

const load = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf-8'));

async function bulkUpsert(col, docs, key) {
  const CH = 1000;
  let done = 0;
  for (let i = 0; i < docs.length; i += CH) {
    const chunk = docs.slice(i, i + CH);
    const ops = chunk.map(d => ({
      updateOne: { filter: { [key]: d[key] }, update: { $set: d }, upsert: true },
    }));
    await col.bulkWrite(ops, { ordered: false });
    done += chunk.length;
    process.stdout.write(`\r  ${col.collectionName}: ${done}/${docs.length}`);
  }
  process.stdout.write('\n');
}

const run = async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();
  console.log('Connected to', db.databaseName);

  const skus = load('skus.json').map(s => ({
    ...s,
    price: (s.seedPrice && s.seedPrice > 0) ? s.seedPrice : 0, // editable selling price
  }));
  const clients = load('clients.json');

  console.log(`Seeding ${skus.length} SKUs, ${clients.length} clients…`);
  await bulkUpsert(db.collection('dima_skus'), skus, 'itemId');
  await bulkUpsert(db.collection('dima_clients'), clients, 'clientId');

  // indexes for fast search
  await db.collection('dima_skus').createIndex({ name: 1 });
  await db.collection('dima_skus').createIndex({ itemId: 1 }, { unique: true });
  await db.collection('dima_clients').createIndex({ name: 1 });
  await db.collection('dima_clients').createIndex({ clientId: 1 }, { unique: true });
  await db.collection('dima_invoices').createIndex({ numero: 1 }, { unique: true });
  await db.collection('dima_invoices').createIndex({ createdAt: -1 });

  // settings (only if not present — don't clobber edits)
  const settingsCol = db.collection('dima_settings');
  if (!(await settingsCol.findOne({ _id: 'app' }))) {
    await settingsCol.insertOne({
      _id: 'app', sellerName: 'Dima Fresh', sellerCity: 'Casablanca',
      tvaRate: 0, timbreRate: 0.25, timbreOnCashOnly: true, invoicePrefix: 'DF',
      footerNote: 'Merci de votre confiance — Dima Fresh',
    });
    console.log('  settings initialised');
  }
  // invoice counter (only if not present)
  const counters = db.collection('dima_counters');
  if (!(await counters.findOne({ _id: 'invoice' }))) {
    await counters.insertOne({ _id: 'invoice', value: 0 });
    console.log('  invoice counter initialised at 0');
  }

  const meta = load('meta.json');
  console.log('✅ Seed complete. Snapshot from', meta.extractedAt, '| SKUs', meta.skuCount, '| clients', meta.clientCount);
  await client.close();
};

run().catch(e => { console.error('❌', e); process.exit(1); });
