// Create a test tenant account in the production database
import { sql } from '../lib/db.js';

const tenantId = 'TEST-001';
const tenantName = 'Test Tenant';
const password = 'test1234';

async function run() {
  const S = sql();
  try {
    const [{ now }] = await S`select now()`;
    console.log('✓ Connected to database —', now.toISOString());

    // Create tenant in dima_tenants table
    const tenant = {
      tenantId,
      name: tenantName,
      password,
      active: 1,
      createdAt: new Date().toISOString(),
    };

    await S`INSERT INTO dima_tenants (id, doc) VALUES (${tenantId}, ${S.json(tenant)})
            ON CONFLICT (id) DO UPDATE SET doc = ${S.json(tenant)}`;

    console.log(`✓ Tenant created: ${tenantName} (ID: ${tenantId}, password: ${password})`);

    // Verify it was created
    const [row] = await S`SELECT doc FROM dima_tenants WHERE id = ${tenantId}`;
    if (row) {
      console.log('✓ Verified in database:', row.doc);
    }

    await S.end();
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
}

run();
