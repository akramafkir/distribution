// Minimal in-memory Mongo-shaped adapter — DEV ONLY.
// Shared by scripts/test-po.mjs and scripts/demoserver.mjs so both exercise the
// REAL lib/po.js logic instead of a re-implementation that could drift from it.
// Pass { clone:false } to wrap live arrays the demo server mutates.

const deep = o => JSON.parse(JSON.stringify(o));

export function match(doc, f = {}) {
  return Object.entries(f).every(([k, v]) => {
    if (k.includes('.')) {                        // "lines.supplierId"
      const [a, b] = k.split('.');
      return Array.isArray(doc[a]) && doc[a].some(x => x?.[b] === v);
    }
    const dv = doc[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$in' in v) return v.$in.includes(dv);
      if ('$gte' in v || '$lte' in v) {
        if (v.$gte != null && !(dv >= v.$gte)) return false;
        if (v.$lte != null && !(dv <= v.$lte)) return false;
        return true;
      }
      if ('$ne' in v) return dv !== v.$ne;
      if ('$exists' in v) return (dv !== undefined) === v.$exists;
    }
    return dv === v;
  });
}

export function makeMemDb(seed = {}, { clone = true } = {}) {
  const store = {};
  for (const [k, v] of Object.entries(seed)) store[k] = clone ? deep(v) : v;
  return {
    _store: store,
    collection(name) {
      store[name] ??= [];
      const rows = () => store[name];
      const self = {
        collectionName: name,
        async findOne(f) { return rows().find(d => match(d, f)) || null; },
        find(f = {}) {
          let out = rows().filter(d => match(d, f));
          const api = {
            sort(s) {
              const [k, dir] = Object.entries(s)[0];
              const get = o => k.split('.').reduce((a, p) => a?.[p], o) ?? '';
              out = out.slice().sort((a, b) => (get(a) > get(b) ? 1 : get(a) < get(b) ? -1 : 0) * dir);
              return api;
            },
            skip(n) { out = out.slice(n); return api; },
            limit(n) { out = out.slice(0, n); return api; },
            async next() { return out[0] || null; },
            async toArray() { return deep(out); },
          };
          return api;
        },
        async updateOne(f, u, o = {}) {
          let d = rows().find(x => match(x, f));
          if (!d && o.upsert) { d = {}; rows().push(d); }
          if (!d) return { matchedCount: 0 };
          if (u.$set) for (const [k, v] of Object.entries(u.$set)) {
            if (k.startsWith('lines.$.')) {
              const field = k.slice(8);
              const sel = Object.entries(f).find(([fk]) => fk.startsWith('lines.'));
              const key = sel ? sel[0].split('.')[1] : null;
              const el = key ? (d.lines || []).find(x => x[key] === sel[1]) : (d.lines || [])[0];
              if (el) el[field] = v;
            } else d[k] = v;
          }
          if (u.$unset) for (const k of Object.keys(u.$unset)) delete d[k];
          if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) d[k] = (d[k] || 0) + v;
          return { matchedCount: 1 };
        },
        async bulkWrite(ops) {
          for (const op of ops) if (op.updateOne) await self.updateOne(op.updateOne.filter, op.updateOne.update, op.updateOne);
          return { ok: 1 };
        },
        async insertOne(d) { rows().push(clone ? deep(d) : d); return { insertedId: 1 }; },
        async countDocuments(f = {}) { return rows().filter(d => match(d, f)).length; },
      };
      return self;
    },
  };
}
