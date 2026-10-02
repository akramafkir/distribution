// ─────────────────────────────────────────────────────────────────────────────
// Supabase / PostgreSQL data layer pour Akram Distribution.
//
// Presents the small document interface the app already speaks
// (findOne / find().sort().skip().limit().toArray() / updateOne / bulkWrite /
// insertOne / countDocuments) over jsonb tables — so lib/po.js, every API
// handler and the 27 PO tests stay byte-identical.
//
// Only the operators the app actually uses are implemented, and anything
// unrecognised THROWS rather than silently matching everything — a filter that
// quietly degrades to "all rows" is how you delete or overwrite the wrong data.
// ─────────────────────────────────────────────────────────────────────────────
import postgres from 'postgres';

let _sql = null;
export function sql() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('DATABASE_URL non configuré');
  _sql = postgres(url, {
    max: 1,                    // serverless: one socket per invocation
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,            // required by Supabase's transaction pooler (6543)
  });
  return _sql;
}

// collection name → table
const TABLE = {
  dima_skus: 'dima_skus', dima_clients: 'dima_clients', dima_suppliers: 'dima_suppliers',
  dima_orders: 'dima_orders', dima_invoices: 'dima_invoices', dima_po: 'dima_po',
  dima_settings: 'dima_settings', dima_counters: 'dima_counters',
  dima_tenants: 'dima_tenants', dima_library: 'dima_library',
  dima_platform: 'dima_platform',
  dima_users: 'dima_users', dima_logs: 'dima_logs',
};
// which doc field carries the primary key, per collection
const PK = {
  dima_skus: 'itemId', dima_clients: 'clientId', dima_suppliers: 'supplierId',
  dima_orders: 'orderId', dima_invoices: 'numero', dima_po: 'poId',
  dima_settings: '_id', dima_counters: '_id',
  dima_tenants: 'tenantId', dima_library: 'itemId',
  dima_platform: '_id',
  dima_users: 'userId', dima_logs: '_id',
};

/** jsonb path expression for a (possibly dotted) field name. */
function path(field) {
  const parts = String(field).split('.');
  if (parts.length === 1) return `doc->>${lit(parts[0])}`;
  const head = parts.slice(0, -1).map(p => `->${lit(p)}`).join('');
  return `doc${head}->>${lit(parts[parts.length - 1])}`;
}
function lit(s) { return `'${String(s).replace(/'/g, "''")}'`; }

/**
 * Translate a mongo-ish filter into a SQL WHERE fragment + params.
 * Unsupported operators throw — see the note at the top of this file.
 */
export function buildWhere(filter = {}, params = []) {
  const clauses = [];
  for (const [key, val] of Object.entries(filter)) {
    if (key === '$or') {
      const parts = val.map(sub => {
        const r = buildWhere(sub, params);
        return r.text === 'TRUE' ? 'TRUE' : `(${r.text})`;
      });
      clauses.push(`(${parts.join(' OR ')})`);
      continue;
    }
    // array-element match, e.g. { 'lines.supplierId': 'SUP-1' }
    if (key.startsWith('lines.')) {
      const sub = key.slice('lines.'.length);
      params.push(String(val));
      clauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(doc->'lines') e
                            WHERE e->>${lit(sub)} = $${params.length})`);
      continue;
    }
    const p = path(key);
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [op, v] of Object.entries(val)) {
        switch (op) {
          case '$in':
            params.push(v.map(String));
            clauses.push(`${p} = ANY($${params.length})`); break;
          case '$gte': params.push(String(v)); clauses.push(`${p} >= $${params.length}`); break;
          case '$lte': params.push(String(v)); clauses.push(`${p} <= $${params.length}`); break;
          case '$gt':  params.push(String(v)); clauses.push(`${p} >  $${params.length}`); break;
          case '$lt':  params.push(String(v)); clauses.push(`${p} <  $${params.length}`); break;
          case '$ne':
            params.push(String(v));
            clauses.push(`(${p} IS DISTINCT FROM $${params.length})`); break;
          case '$exists':
            clauses.push(v ? `${p} IS NOT NULL` : `${p} IS NULL`); break;
          case '$regex': {
            params.push(`%${String(v)}%`);
            clauses.push(`${p} ILIKE $${params.length}`); break;
          }
          case '$options': break;                       // handled with $regex
          default: throw new Error(`Opérateur non supporté: ${op}`);
        }
      }
      continue;
    }
    params.push(String(val));
    clauses.push(`${p} = $${params.length}`);
  }
  return { text: clauses.length ? clauses.join(' AND ') : 'TRUE', params };
}

/**
 * Apply a mongo-style projection. MUST be honoured: handlers rely on
 * `{ password: 0 }` to keep supplier login secrets out of API responses; an
 * adapter that silently ignored projections would leak them.
 */
export function projectDoc(doc, projection) {
  if (!doc || !projection) return doc;
  const keys = Object.keys(projection).filter(k => k !== '_id');
  if (!keys.length) return doc;
  const including = keys.some(k => projection[k] === 1 || projection[k] === true);
  const out = {};
  if (including) {
    for (const k of keys) if (projection[k] && k in doc) out[k] = doc[k];
    return out;
  }
  for (const [k, v] of Object.entries(doc)) {
    if (projection[k] === 0 || projection[k] === false) continue;
    out[k] = v;
  }
  return out;
}

// Tables that are NOT tenant-scoped (platform-level).
const GLOBAL = new Set(['dima_tenants', 'dima_library', 'dima_platform']);

function collection(name, tenantId) {
  const table = TABLE[name];
  if (!table) throw new Error(`Collection inconnue: ${name}`);
  const pk = PK[name];
  const S = () => sql();
  const scoped = !GLOBAL.has(table);

  // The single most important line in this file: a tenant-scoped collection can
  // never be queried without a tenant. Forgetting it must be impossible, not
  // merely discouraged — one missing WHERE would show client A's book to B.
  if (scoped && !tenantId) {
    throw new Error(`Accès à ${name} sans tenant — refusé`);
  }

  const project = projectDoc;

  async function rows(filter, { sort, skip, limit, projection } = {}) {
    const params = [];
    const { text } = buildWhere(filter, params);
    let where = text;
    if (scoped) { params.push(String(tenantId)); where = `tenant_id = $${params.length} AND (${text})`; }
    let q = `SELECT doc FROM ${table} WHERE ${where}`;
    if (sort) {
      const order = Object.entries(sort)
        .map(([k, dir]) => `${path(k)} ${dir < 0 ? 'DESC' : 'ASC'} NULLS LAST`).join(', ');
      q += ` ORDER BY ${order}`;
    }
    if (limit != null) q += ` LIMIT ${Number(limit)}`;
    if (skip) q += ` OFFSET ${Number(skip)}`;
    const res = await S().unsafe(q, params);
    return res.map(r => project(r.doc, projection));
  }

  const api = {
    collectionName: name,

    async findOne(filter = {}, o = {}) {
      const r = await rows(filter, { limit: 1, projection: o.projection });
      return r[0] || null;
    },

    find(filter = {}, o = {}) {
      const opts = { projection: o.projection };
      const cur = {
        sort(s) { opts.sort = s; return cur; },
        skip(n) { opts.skip = n; return cur; },
        limit(n) { opts.limit = n; return cur; },
        async next() { const r = await rows(filter, { ...opts, limit: 1 }); return r[0] || null; },
        async toArray() { return rows(filter, opts); },
      };
      return cur;
    },

    async countDocuments(filter = {}) {
      const params = [];
      const { text } = buildWhere(filter, params);
      let where = text;
      if (scoped) { params.push(String(tenantId)); where = `tenant_id = $${params.length} AND (${text})`; }
      const r = await S().unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
      return r[0]?.n || 0;
    },

    async insertOne(doc) {
      const id = String(doc[pk] ?? doc._id);
      // Must go through the driver's json() helper. Passing JSON.stringify(doc)
      // as a text param + ::jsonb stores a jsonb *string*, not an object —
      // every doc->>'field' then returns null and the row is unreadable.
      const q = S();
      if (scoped) {
        await q`INSERT INTO ${q(table)} (tenant_id, id, doc) VALUES (${String(tenantId)}, ${id}, ${q.json(doc)})`;
      } else {
        await q`INSERT INTO ${q(table)} (id, doc) VALUES (${id}, ${q.json(doc)})`;
      }
      return { insertedId: id };
    },

    /**
     * Supports $set (incl. positional "lines.$.field"), $unset and $inc.
     * Positional updates are done read-modify-write inside a transaction —
     * jsonb has no native positional operator and the arrays here are small.
     */
    async updateOne(filter = {}, update = {}, opts = {}) {
      const params = [];
      const { text } = buildWhere(filter, params);
      let where = text;
      if (scoped) { params.push(String(tenantId)); where = `tenant_id = $${params.length} AND (${text})`; }
      return S().begin(async trx => {
        const found = await trx.unsafe(`SELECT id, doc FROM ${table} WHERE ${where} LIMIT 1 FOR UPDATE`, params);
        let id, doc;
        if (found.length) { id = found[0].id; doc = found[0].doc; }
        else if (opts.upsert) {
          doc = {};
          // seed the doc from equality terms so the row is identifiable
          for (const [k, v] of Object.entries(filter)) if (typeof v !== 'object') doc[k] = v;
          id = String(doc[pk] ?? doc._id ?? update.$set?.[pk] ?? update.$set?._id ?? '');
          if (!id) throw new Error(`upsert sans clé primaire sur ${name}`);
        } else return { matchedCount: 0, modifiedCount: 0 };

        for (const [k, v] of Object.entries(update.$set || {})) {
          if (k.startsWith('lines.$.')) {
            const field = k.slice('lines.$.'.length);
            const sel = Object.entries(filter).find(([fk]) => fk.startsWith('lines.'));
            const selKey = sel ? sel[0].split('.')[1] : null;
            const arr = Array.isArray(doc.lines) ? doc.lines : [];
            const el = selKey ? arr.find(x => x?.[selKey] === sel[1]) : arr[0];
            if (el) el[field] = v;
          } else setDeep(doc, k, v);
        }
        for (const k of Object.keys(update.$unset || {})) delDeep(doc, k);
        for (const [k, v] of Object.entries(update.$inc || {})) setDeep(doc, k, (Number(getDeep(doc, k)) || 0) + Number(v));
        if (!doc[pk] && pk !== '_id') doc[pk] = id;

        if (scoped) {
          await trx`
            INSERT INTO ${trx(table)} (tenant_id, id, doc) VALUES (${String(tenantId)}, ${id}, ${trx.json(doc)})
            ON CONFLICT (tenant_id, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`;
        } else {
          await trx`
            INSERT INTO ${trx(table)} (id, doc) VALUES (${id}, ${trx.json(doc)})
            ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`;
        }
        return { matchedCount: found.length ? 1 : 0, upsertedId: found.length ? null : id, modifiedCount: 1 };
      });
    },

    async deleteOne(filter = {}) {
      const params = [];
      const { text } = buildWhere(filter, params);
      let where = text;
      if (scoped) { params.push(String(tenantId)); where = `tenant_id = $${params.length} AND (${text})`; }
      // ctid keeps this to exactly one row, matching Mongo's deleteOne
      const r = await S().unsafe(
        `DELETE FROM ${table} WHERE ctid = (SELECT ctid FROM ${table} WHERE ${where} LIMIT 1)`, params);
      return { deletedCount: r.count || 0 };
    },

    async bulkWrite(ops = []) {
      let n = 0;
      for (const op of ops) {
        if (op.updateOne) { await api.updateOne(op.updateOne.filter, op.updateOne.update, op.updateOne); n++; }
        else if (op.insertOne) { await api.insertOne(op.insertOne.document); n++; }
        else if (op.deleteOne) { await api.deleteOne(op.deleteOne.filter); n++; }
      }
      return { ok: 1, nModified: n };
    },
  };
  return api;
}

function getDeep(o, k) { return k.split('.').reduce((a, p) => a?.[p], o); }
function setDeep(o, k, v) {
  const parts = k.split('.');
  let cur = o;
  for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= {});
  cur[parts[parts.length - 1]] = v;
}
function delDeep(o, k) {
  const parts = k.split('.');
  let cur = o;
  for (let i = 0; i < parts.length - 1; i++) { cur = cur?.[parts[i]]; if (!cur) return; }
  delete cur[parts[parts.length - 1]];
}

/**
 * Get a TENANT-SCOPED database handle.
 *   getDb('salim')  → every query is confined to that tenant
 *   getDb(null)     → platform level; only dima_tenants / dima_library reachable,
 *                     any business collection throws.
 */
export async function getDb(tenantId = null) {
  sql();                                   // fail fast if DATABASE_URL is missing
  return {
    tenantId,
    collection: (name) => collection(name, tenantId),
  };
}

/**
 * Copy the shared product library into a new client's catalogue.
 * One INSERT..SELECT — a row-by-row bulkWrite of ~1000 products blows the
 * serverless function timeout.
 */
export async function copyLibraryToTenant(tenantId) {
  // ::text is required — inside SELECT, Postgres cannot infer a bare parameter's
  // type and errors with "could not determine data type of parameter $1".
  const r = await sql().unsafe(
    `insert into dima_skus (tenant_id, id, doc)
     select $1::text, id, doc from dima_library
     on conflict (tenant_id, id) do nothing
     returning id`, [String(tenantId)]);
  return r.length;
}

/**
 * Un mot de passe = UNE seule porte.
 *
 * La connexion résout globalement et dans l'ordre : plateforme → compte
 * principal d'un client → membre (tous clients) → fournisseur (tous clients).
 * Si deux entités de clients DIFFÉRENTS partageaient un mot de passe, la
 * connexion ouvrirait le mauvais espace — une fuite entre clients. Avant
 * d'attribuer ou de changer un mot de passe, on vérifie donc qu'il n'ouvre
 * rien d'autre, dans TOUTE la base et pas seulement dans le client courant.
 *
 * Renvoie null si libre, sinon un libellé de la porte déjà ouverte.
 */
export async function passwordInUse(password, opts = {}) {
  const p = String(password || '');
  if (!p) return null;
  const { exceptTenantId = null, exceptUserId = null, exceptSupplierId = null } = opts;
  const S = sql();

  if (p === (process.env.APP_PASSWORD || '')) return 'installation';
  if ((await S`select 1 from dima_platform where doc->>'password' = ${p} limit 1`).length) return 'plateforme';

  const ten = await S`select id from dima_tenants where doc->>'password' = ${p} limit 1`;
  if (ten.length && ten[0].id !== exceptTenantId) return 'client';

  const usr = await S`select id from dima_users where doc->>'password' = ${p} limit 1`;
  if (usr.length && usr[0].id !== exceptUserId) return 'membre';

  const sup = await S`select id from dima_suppliers where doc->>'password' = ${p} limit 1`;
  if (sup.length && sup[0].id !== exceptSupplierId) return 'fournisseur';

  return null;
}

/** Le client (tenant) est-il encore actif ? Sert à couper une session en cours
 *  quand la plateforme suspend un client, pas seulement à bloquer une nouvelle
 *  connexion. */
export async function tenantActive(tenantId) {
  const r = await sql()`select 1 from dima_tenants where id = ${String(tenantId)} and doc->>'active' = '1' limit 1`;
  return r.length > 0;
}

/** Atomic, gapless sequence, PER TENANT — delegated to Postgres. */
export async function nextSeq(db, name) {
  const tenant = typeof db === 'string' ? db : db?.tenantId;
  if (!tenant) throw new Error('nextSeq sans tenant — refusé');
  const r = await sql().unsafe(`SELECT dima_next_seq($1, $2) AS v`, [String(tenant), String(name)]);
  return Number(r[0].v);
}

/** Supprime intégralement un client (rollback d'une création interrompue). */
export async function purgeTenant(tenantId) {
  const t = String(tenantId);
  const S = sql();
  for (const tbl of ['dima_skus','dima_clients','dima_suppliers','dima_orders',
                     'dima_invoices','dima_po','dima_settings','dima_counters',
                     'dima_users','dima_logs']) {
    await S.unsafe(`delete from ${tbl} where tenant_id = $1`, [t]);
  }
  await S.unsafe(`delete from dima_tenants where id = $1`, [t]);
}
