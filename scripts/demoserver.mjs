// Self-contained DEMO server for Dima Fresh — serves the built app + a full API
// backed by the captured snapshot JSON (no MongoDB). Now includes the SUPPLIER
// MARKETPLACE flow: orders route to a product's supplier, supplier accepts +
// sets his cost, client price = cost + per-product margin (1-2 DH).
// State is in-memory (resets on restart). For real multi-user use -> Atlas+deploy.
import http from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { makeMemDb } from './memdb.mjs';
import { computePO, persistPO, poToText } from '../lib/po.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const DIST = join(ROOT, 'dist');
const DATA = join(ROOT, 'data');

const TEAM_PASSWORD = 'dima2026';

// ---- suppliers (demo seed) ----
const SUPPLIERS = [
  { supplierId: 'SUP-LEG', name: 'Ferme Légumes Souss', phone: '0661000001', email: 'legumes@demo.ma', password: 'leg2026', active: 1 },
  { supplierId: 'SUP-FRU', name: 'Verger Fruits Atlas', phone: '0661000002', email: 'fruits@demo.ma', password: 'fru2026', active: 1 },
  { supplierId: 'SUP-GEN', name: 'Marché Général Casa', phone: '0661000003', email: 'general@demo.ma', password: 'gen2026', active: 1 },
];

// ---- load snapshot; attach supplier + per-product margin ----
function pickSupplier(cat) {
  const c = (cat || '').toLowerCase();
  if (/(veg|légum|legum|bulb|leaf|root)/.test(c)) return 'SUP-LEG';
  if (/(fruit|berry|citrus|melon)/.test(c)) return 'SUP-FRU';
  return 'SUP-GEN';
}
const SKUS = JSON.parse(readFileSync(join(DATA, 'skus.json'), 'utf-8')).map((s, i) => ({
  ...s,
  price: (s.seedPrice && s.seedPrice > 0) ? s.seedPrice : 0,
  supplierId: pickSupplier(s.category) || SUPPLIERS[i % 3].supplierId,
  margin: 1.5, // per-product client margin (DH), clamped 1..2
}));
const CLIENTS = JSON.parse(readFileSync(join(DATA, 'clients.json'), 'utf-8'));
let SETTINGS = {
  sellerName: 'Dima Fresh', sellerLegalForm: '', sellerAddress: '', sellerCity: 'Casablanca',
  sellerPhone: '', sellerEmail: '', ice: '', ifNo: '', rc: '', patente: '', rib: '', bank: '',
  tvaRate: 0, timbreRate: 0.25, timbreOnCashOnly: true, invoicePrefix: 'DF',
  footerNote: 'Merci de votre confiance — Dima Fresh',
};
const INVOICES = [];
const ORDERS = [];
const PO_DOCS = [];
let INV_SEQ = 0, ORD_SEQ = 0;

// token -> {role, supplierId?, name}
const TOKENS = new Map();
console.log(`loaded ${SKUS.length} SKUs, ${CLIENTS.length} clients, ${SUPPLIERS.length} suppliers`);

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const clampMargin = m => Math.min(2, Math.max(1, Number(m) || 1.5));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const skuById = id => SKUS.find(s => s.itemId === id);
const supById = id => SUPPLIERS.find(s => s.supplierId === id);

function who(req) { return TOKENS.get(req.headers['x-auth-token'] || ''); }
function paginate(rows, page, limit) {
  const total = rows.length, start = (page - 1) * limit;
  return { rows: rows.slice(start, start + limit), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}
function orderStatus(o) {
  const active = o.lines.filter(l => l.status !== 'refused');
  if (o.invoiceNo) return 'invoiced';
  if (active.length && active.every(l => l.status === 'priced')) return 'priced';
  return 'pending';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const qp = Object.fromEntries(url.searchParams);
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (path.startsWith('/api/')) {
    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH') {
      const chunks = []; for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { body = {}; }
    }

    // ---------- LOGIN (team or supplier) ----------
    if (path === '/api/login' && req.method === 'POST') {
      const pw = (body?.password || '').trim();
      if (pw === TEAM_PASSWORD) {
        const t = 'tok-team-' + TOKENS.size;
        TOKENS.set(t, { role: 'team', name: (body?.name || '').trim() });
        return send(200, { token: t, role: 'team' });
      }
      const sup = SUPPLIERS.find(s => s.password === pw && s.active);
      if (sup) {
        const t = 'tok-sup-' + sup.supplierId + '-' + TOKENS.size;
        TOKENS.set(t, { role: 'supplier', supplierId: sup.supplierId, name: sup.name });
        return send(200, { token: t, role: 'supplier', supplierId: sup.supplierId, name: sup.name });
      }
      return send(401, { error: 'Mot de passe incorrect' });
    }

    const u = who(req);
    if (!u) return send(401, { error: 'Non autorisé' });
    const isTeam = u.role === 'team';

    // ---------- SUPPLIER PORTAL ----------
    if (path === '/api/supplier/requests' && u.role === 'supplier') {
      // pending order-lines assigned to me, grouped by order
      const out = [];
      for (const o of ORDERS) {
        const mine = o.lines.filter(l => l.supplierId === u.supplierId);
        if (!mine.length) continue;
        out.push({
          orderId: o.orderId, client: o.client.name, createdAt: o.createdAt, createdBy: o.createdBy,
          status: orderStatus(o),
          lines: mine.map(l => ({ itemId: l.itemId, name: l.name, uom: l.uom, qty: l.qty, cost: l.cost, clientPrice: l.clientPrice, status: l.status })),
        });
      }
      out.sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1));
      const pendingCount = out.reduce((n, o) => n + o.lines.filter(l => l.status === 'pending').length, 0);
      return send(200, { requests: out, pendingCount });
    }
    if (path === '/api/supplier/price' && req.method === 'POST' && u.role === 'supplier') {
      const o = ORDERS.find(x => x.orderId === body.orderId);
      if (!o) return send(404, { error: 'Commande introuvable' });
      const line = o.lines.find(l => l.itemId === body.itemId && l.supplierId === u.supplierId);
      if (!line) return send(404, { error: 'Ligne introuvable' });
      if (body.refuse) { line.status = 'refused'; return send(200, { ok: true }); }
      const cost = Number(body.cost);
      if (isNaN(cost) || cost < 0) return send(400, { error: 'Prix invalide' });
      line.cost = r2(cost);
      line.clientPrice = r2(cost + clampMargin(line.margin));
      line.status = 'priced';
      return send(200, { ok: true, clientPrice: line.clientPrice });
    }

    // everything below = team only
    if (!isTeam) return send(403, { error: 'Réservé à l\'équipe' });

    // ---------- SUPPLIERS (team) ----------
    if (path === '/api/suppliers') {
      if (req.method === 'GET') return send(200, { rows: SUPPLIERS.map(s => ({ ...s, password: undefined, skuCount: SKUS.filter(k => k.supplierId === s.supplierId).length })) });
      if (req.method === 'POST') {
        const id = 'SUP-' + Date.now();
        const doc = { supplierId: id, name: body.name || 'Fournisseur', phone: body.phone || '', email: body.email || '', password: body.password || 'demo', active: 1 };
        SUPPLIERS.push(doc);
        return send(200, { ok: true, row: { ...doc, password: undefined } });
      }
    }

    // ---------- SKUS ----------
    if (path === '/api/skus') {
      if (req.method === 'GET') {
        const q = (qp.q || '').toLowerCase().trim();
        const active = qp.active || 'all';
        let rows = SKUS.filter(s =>
          (active === 'all' || (active === '1' ? s.active === 1 : s.active === 0)) &&
          (!q || (s.name || '').toLowerCase().includes(q) || (s.itemId || '').toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q)));
        rows = rows.sort((a, b) => (b.active - a.active) || (a.name || '').localeCompare(b.name || ''))
          .map(s => ({ ...s, supplierName: (supById(s.supplierId) || {}).name || '' }));
        return send(200, paginate(rows, +qp.page || 1, +qp.limit || 50));
      }
      if (req.method === 'PATCH') {
        const it = skuById(body.itemId);
        if (!it) return send(404, { error: 'SKU introuvable' });
        if (body.price !== undefined && body.price !== '') it.price = Number(body.price);
        if (body.active !== undefined) it.active = body.active ? 1 : 0;
        if (body.supplierId !== undefined) it.supplierId = body.supplierId;
        if (body.margin !== undefined && body.margin !== '') it.margin = clampMargin(body.margin);
        return send(200, { ok: true, row: { ...it, supplierName: (supById(it.supplierId) || {}).name || '' } });
      }
    }

    // ---------- CLIENTS ----------
    if (path === '/api/clients') {
      if (req.method === 'GET') {
        const q = (qp.q || '').toLowerCase().trim();
        let rows = CLIENTS.filter(c => !q || (c.name || '').toLowerCase().includes(q) || (c.clientId || '').toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.city || '').toLowerCase().includes(q) || (c.ice || '').toLowerCase().includes(q));
        rows = rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return send(200, paginate(rows, +qp.page || 1, +qp.limit || 50));
      }
      if (req.method === 'POST') { const doc = { clientId: 'DF-' + Date.now(), custom: true, active: 1, ...body }; CLIENTS.unshift(doc); return send(200, { ok: true, row: doc }); }
    }

    // ---------- SETTINGS ----------
    if (path === '/api/settings') {
      if (req.method === 'GET') return send(200, { settings: SETTINGS });
      if (req.method === 'PATCH') { SETTINGS = { ...SETTINGS, ...body, tvaRate: Number(body.tvaRate) || 0, timbreRate: Number(body.timbreRate) || 0 }; return send(200, { ok: true, settings: SETTINGS }); }
    }

    // ---------- ORDERS (procurement flow) ----------
    if (path === '/api/orders') {
      if (req.method === 'GET') {
        if (qp.id) { const o = ORDERS.find(x => x.orderId === qp.id); return o ? send(200, { order: { ...o, status: orderStatus(o) } }) : send(404, { error: 'introuvable' }); }
        let rows = ORDERS.map(o => ({ orderId: o.orderId, client: o.client, createdAt: o.createdAt, createdBy: o.createdBy, status: orderStatus(o), lineCount: o.lines.length, invoiceNo: o.invoiceNo || null }));
        rows = rows.reverse();
        return send(200, paginate(rows, +qp.page || 1, +qp.limit || 30));
      }
      if (req.method === 'POST') {
        if (!body.client?.name) return send(400, { error: 'Client requis' });
        const lines = (body.lines || []).filter(l => Number(l.qty) > 0).map(l => {
          const sku = skuById(l.itemId) || {};
          return { itemId: l.itemId, name: l.name || sku.name, uom: l.uom || sku.uom || 'KG', qty: r2(l.qty),
            supplierId: sku.supplierId || 'SUP-GEN', supplierName: (supById(sku.supplierId) || {}).name || 'Général',
            margin: clampMargin(sku.margin), cost: null, clientPrice: null, status: 'pending' };
        });
        if (!lines.length) return send(400, { error: 'Au moins une ligne' });
        ORD_SEQ += 1;
        const o = { orderId: 'CMD-' + String(ORD_SEQ).padStart(5, '0'),
          date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date()),
          client: body.client, createdBy: u.name || '', createdAt: new Date().toISOString(), lines, invoiceNo: null };
        ORDERS.push(o);
        return send(200, { ok: true, order: { ...o, status: 'pending' } });
      }
    }
    if (path === '/api/orders/invoice' && req.method === 'POST') {
      const o = ORDERS.find(x => x.orderId === body.orderId);
      if (!o) return send(404, { error: 'Commande introuvable' });
      if (orderStatus(o) !== 'priced') return send(400, { error: 'Toutes les lignes ne sont pas encore tarifées par les fournisseurs' });
      const lines = o.lines.filter(l => l.status === 'priced').map(l => ({ itemId: l.itemId, name: l.name, uom: l.uom, qty: l.qty, unitPrice: l.clientPrice, total: r2(l.qty * l.clientPrice) }));
      const subtotal = r2(lines.reduce((s, l) => s + l.total, 0));
      const base = subtotal;
      const tva = r2(base * (SETTINGS.tvaRate || 0) / 100);
      const pay = (body.paymentMode || 'espece').toLowerCase();
      const applyTimbre = (SETTINGS.timbreRate || 0) > 0 && (SETTINGS.timbreOnCashOnly === false || ['espece', 'cash', 'cod'].includes(pay));
      const timbre = applyTimbre ? r2((base + tva) * SETTINGS.timbreRate / 100) : 0;
      const net = r2(base + tva + timbre);
      INV_SEQ += 1;
      const numero = `${SETTINGS.invoicePrefix}-${String(INV_SEQ).padStart(6, '0')}`;
      const inv = { numero, date: new Date().toISOString().slice(0, 10), createdBy: u.name || '', paymentMode: pay, client: o.client, lines, subtotal, discount: 0, tvaRate: SETTINGS.tvaRate, tva, timbreRate: applyTimbre ? SETTINGS.timbreRate : 0, timbre, net, notes: 'Commande ' + o.orderId, status: 'issued', fromOrder: o.orderId };
      INVOICES.push(inv);
      o.invoiceNo = numero;
      return send(200, { ok: true, invoice: inv });
    }

    // ---------- INVOICES (direct sale, unchanged) ----------
    if (path === '/api/invoices') {
      if (req.method === 'GET') {
        if (qp.id) { const inv = INVOICES.find(i => i.numero === qp.id); return inv ? send(200, { invoice: inv }) : send(404, { error: 'introuvable' }); }
        const q = (qp.q || '').toLowerCase().trim();
        let rows = INVOICES.filter(i => !q || i.numero.toLowerCase().includes(q) || (i.client?.name || '').toLowerCase().includes(q)).slice().reverse();
        return send(200, paginate(rows, +qp.page || 1, +qp.limit || 30));
      }
      if (req.method === 'POST') {
        const lines = (body.lines || []).map(l => ({ itemId: l.itemId || '', name: l.name || '', uom: l.uom || 'KG', qty: r2(l.qty), unitPrice: r2(l.unitPrice), total: r2((l.qty || 0) * (l.unitPrice || 0)) })).filter(l => l.qty > 0);
        if (!body.client?.name) return send(400, { error: 'Client requis' });
        if (!lines.length) return send(400, { error: 'Au moins une ligne' });
        const subtotal = r2(lines.reduce((s, l) => s + l.total, 0));
        const discount = r2(body.discount || 0);
        const base = r2(subtotal - discount);
        const tva = r2(base * (SETTINGS.tvaRate || 0) / 100);
        const pay = (body.paymentMode || 'espece').toLowerCase();
        const applyTimbre = (SETTINGS.timbreRate || 0) > 0 && (SETTINGS.timbreOnCashOnly === false || ['espece', 'cash', 'cod'].includes(pay));
        const timbre = applyTimbre ? r2((base + tva) * SETTINGS.timbreRate / 100) : 0;
        const net = r2(base + tva + timbre);
        INV_SEQ += 1;
        const numero = `${SETTINGS.invoicePrefix}-${String(INV_SEQ).padStart(6, '0')}`;
        const inv = { numero, date: new Date().toISOString().slice(0, 10), createdBy: body.createdBy || u.name || '', paymentMode: pay, client: body.client, lines, subtotal, discount, tvaRate: SETTINGS.tvaRate, tva, timbreRate: applyTimbre ? SETTINGS.timbreRate : 0, timbre, net, notes: body.notes || '', status: 'issued' };
        INVOICES.push(inv);
        return send(200, { ok: true, invoice: inv });
      }
    }

    // ---------- BON D'ACHAT (PO) — runs the REAL lib/po.js engine ----------
    if (path === '/api/po') {
      // Wrap the live in-memory arrays (clone:false) so the engine sees, and
      // stamps, the same objects the rest of the demo mutates.
      const db = makeMemDb({
        dima_skus: SKUS, dima_orders: ORDERS, dima_suppliers: SUPPLIERS,
        dima_settings: [{ _id: 'app', ...SETTINGS }], dima_po: PO_DOCS,
      }, { clone: false });

      if (req.method === 'GET') {
        if (qp.list === '1') {
          return send(200, { rows: PO_DOCS.map(({ bySupplier, ...r }) => r).slice().reverse() });
        }
        const date = qp.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date());
        const doc = PO_DOCS.find(d => d.poId === 'PO-' + date);
        if (!doc) return send(404, { error: "Aucun bon d'achat pour " + date, date });
        if (qp.format === 'text') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(poToText(doc)); }
        return send(200, { po: doc });
      }
      if (req.method === 'POST' && qp.action === 'run') {
        try {
          const { doc, eligible } = await computePO(db, { businessDate: qp.date || undefined, generatedBy: 'manuel' });
          await persistPO(db, doc, eligible);
          return send(200, { ok: true, po: doc, text: poToText(doc) });
        } catch (e) { return send(500, { error: e.message }); }
      }
    }

    return send(405, { error: 'method' });
  }

  // static
  let file = join(DIST, path === '/' ? 'index.html' : path);
  if (!existsSync(file)) file = join(DIST, 'index.html');
  readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(3050, () => {
  console.log('Dima Fresh DEMO on http://localhost:3050');
  console.log('  team login    : password dima2026');
  console.log('  supplier logins: leg2026 / fru2026 / gen2026');
});
