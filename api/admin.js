// Console plateforme (rôle 'admin' uniquement).
// GET    /api/admin?action=stats                          → stockage + activité par client
// GET    /api/admin?action=export&tenant=X&before=DATE     → CSV de l'archive (sans rien supprimer)
// POST   /api/admin?action=archive {tenant, before}        → exporte PUIS purge (>90 j par défaut)
// DELETE /api/admin?tenant=X&confirm=<nom exact>           → supprime définitivement un client
// PATCH  /api/admin?action=password {current, next}        → change le mot de passe plateforme
// GET    /api/admin?action=analytics&tenant=X&days=30      → tonnage + CA par jour d'un client
// PATCH  /api/admin?action=billing {ratePerKg}            → tarif de facturation (DH par KG)
import { cors, requireAuth, COL, getDb, addDays, casaDate, platformPassword, passwordInUse } from '../lib/mongo.js';
import { sql, purgeTenant } from '../lib/db.js';

const QUOTA = 536_870_912;              // Neon Free : 0.5 Go
const MIN_AGE_DAYS = 30;                // garde-fou : on n'archive jamais du récent

// ── Tonnage & chiffre d'affaires par client ──────────────────────────────────
// Akram facture ses clients au KG passé dans l'app. Le poids doit donc être un
// VRAI poids : une ligne en caisse/sac est convertie en KG via le facteur du
// produit, mais seulement si le produit se vend au KG. Une botte ou une pièce
// n'a pas d'équivalent poids — elle est comptée à part, jamais devinée.
function lineKg(line, skuBy) {
  const uom = String(line.uom || 'KG').toUpperCase();
  const qty = Number(line.qty) || 0;
  if (!(qty > 0)) return { kg: 0, otherUom: null, otherQty: 0 };
  if (uom === 'KG') return { kg: qty, otherUom: null, otherQty: 0 };
  const sku = skuBy[line.itemId];
  const f = sku?.uomFactors?.[uom];
  if (sku && String(sku.uom || '').toUpperCase() === 'KG' && Number(f) > 0) {
    return { kg: qty * Number(f), otherUom: null, otherQty: 0 };   // ex: 2 caisses × 10 = 20 kg
  }
  return { kg: 0, otherUom: uom, otherQty: qty };                  // non pesable
}

/** Agrège tonnage + CA sur une période. Le CA (« ce qu'ils gagnent ») vient des
 *  FACTURES émises (hors annulées). Le tonnage facturé sert de base de facturation
 *  à Akram ; le tonnage commandé montre ce qui a été « placé » dans l'app. */
async function tonnage(db, from, to) {
  const invoices = await db.collection(COL.invoices).find({ date: { $gte: from, $lte: to } }).toArray();
  const orders = await db.collection(COL.orders).find({ date: { $gte: from, $lte: to } }).toArray();
  const ids = new Set();
  for (const d of [...invoices, ...orders]) for (const l of (d.lines || [])) ids.add(l.itemId);
  const skus = ids.size ? await db.collection(COL.skus).find({ itemId: { $in: [...ids] } }).toArray() : [];
  const skuBy = Object.fromEntries(skus.map(s => [s.itemId, s]));

  const day = {};
  const bump = (date) => (day[date] ||= { date, kg: 0, ca: 0, kgOrd: 0, inv: 0, ord: 0 });
  const other = {};
  let totKg = 0, totCa = 0, totKgOrd = 0, invCount = 0;

  for (const inv of invoices) {
    if (inv.status === 'cancelled' || !inv.date) continue;
    invCount++;
    const b = bump(inv.date); b.inv++;
    const net = Number(inv.net) || 0; b.ca += net; totCa += net;
    for (const l of (inv.lines || [])) {
      const r = lineKg(l, skuBy);
      b.kg += r.kg; totKg += r.kg;
      if (r.otherUom) other[r.otherUom] = (other[r.otherUom] || 0) + r.otherQty;
    }
  }
  for (const o of orders) {
    if (!o.date) continue;
    const b = bump(o.date); b.ord++;
    for (const l of (o.lines || [])) {
      if (l.status === 'refused') continue;
      const r = lineKg(l, skuBy);
      b.kgOrd += r.kg; totKgOrd += r.kg;
    }
  }
  const r2 = n => Math.round(n * 100) / 100;
  for (const b of Object.values(day)) { b.kg = r2(b.kg); b.ca = r2(b.ca); b.kgOrd = r2(b.kgOrd); }
  return { day, other, totKg: r2(totKg), totCa: r2(totCa), totKgOrd: r2(totKgOrd), invoices: invCount, orders: orders.length };
}

/** Tarif de facturation d'Akram : combien il gagne par KG passé dans l'app. */
async function getRatePerKg() {
  try {
    const db = await getDb(null);
    const r = await db.collection(COL.platform).findOne({ _id: 'billing' });
    return Number(r?.ratePerKg) || 0;
  } catch { return 0; }
}
const firstOfMonth = () => casaDate().slice(0, 8) + '01';

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const esc = v => {
    const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c])).join(';'))].join('\n');
}

/** Aplatit commandes + factures en lignes lisibles dans un tableur. */
function flatten(kind, docs) {
  const out = [];
  for (const d of docs) {
    const lines = d.lines || [];
    if (!lines.length) { out.push({ type: kind, ref: d.numero || d.orderId, date: d.date, client: d.client?.name || '' }); continue; }
    for (const l of lines) {
      out.push({
        type: kind,
        ref: d.numero || d.orderId,
        date: d.date,
        client: d.client?.name || '',
        telephone: d.client?.phone || '',
        produit: l.name,
        quantite: l.qty,
        unite: l.uom,
        prix_unitaire: l.unitPrice ?? l.clientPrice ?? '',
        total_ligne: l.total ?? '',
        fournisseur: l.supplierName || '',
        cout_fournisseur: l.cost ?? '',
        net_document: d.net ?? '',
        mode_paiement: d.paymentMode || '',
        facture_liee: d.invoiceNo || '',
      });
    }
  }
  return out;
}

async function collect(tenantId, before) {
  const db = await getDb(tenantId);
  const orders = await db.collection(COL.orders).find({ date: { $lt: before } }).toArray();
  const invoices = await db.collection(COL.invoices).find({ date: { $lt: before } }).toArray();
  const pos = await db.collection(COL.po).find({ businessDate: { $lt: before } }).toArray();
  return { orders, invoices, pos };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const u = await requireAuth(req, res);
  if (!u) return;
  if (u.role !== 'admin') return res.status(403).json({ error: 'Réservé au compte plateforme' });

  const action = String(req.query?.action || '');
  const S = sql();

  // ── stockage + activité ───────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'stats') {
    const [{ bytes }] = await S`select pg_database_size(current_database())::bigint bytes`;
    const tables = await S`
      select relname, n_live_tup rows, pg_total_relation_size(relid)::bigint b
      from pg_stat_user_tables where relname like 'dima%' order by b desc`;
    const platform = await getDb(null);
    const tenants = await platform.collection(COL.tenants).find({}, { projection: { password: 0 } }).sort({ name: 1 }).toArray();
    const monthFrom = firstOfMonth(), today = casaDate();
    const per = [];
    for (const t of tenants) {
      const db = await getDb(t.tenantId);
      const [skus, clients, orders, invoices] = await Promise.all([
        db.collection(COL.skus).countDocuments({}),
        db.collection(COL.clients).countDocuments({}),
        db.collection(COL.orders).countDocuments({}),
        db.collection(COL.invoices).countDocuments({}),
      ]);
      const [{ b }] = await S.unsafe(
        `select coalesce(sum(pg_column_size(doc)),0)::bigint b from (
           select doc from dima_orders where tenant_id=$1
           union all select doc from dima_invoices where tenant_id=$1
           union all select doc from dima_skus where tenant_id=$1) x`, [t.tenantId]);
      // tonnage + CA du MOIS EN COURS, pour la facturation d'Akram
      const m = await tonnage(db, monthFrom, today);
      per.push({ ...t, skus, clients, orders, invoices, bytes: Number(b),
        monthKg: m.totKg, monthCa: m.totCa, monthKgOrd: m.totKgOrd });
    }
    const used = Number(bytes);
    // projection : poids moyen d'un document transactionnel × rythme observé
    const [{ avg }] = await S`select coalesce(avg(pg_column_size(doc)),700)::int avg from dima_orders`;
    const plat = await platformPassword();
    return res.status(200).json({
      quota: QUOTA, used, pct: +(used / QUOTA * 100).toFixed(2),
      avgDocBytes: Number(avg),
      ownPassword: plat.chosen,      // faux tant qu'Akram n'a pas choisi le sien
      ratePerKg: await getRatePerKg(),
      monthFrom,
      tables: tables.map(t => ({ name: t.relname, rows: Number(t.rows), bytes: Number(t.b) })),
      tenants: per,
      minAgeDays: MIN_AGE_DAYS,
    });
  }

  // ── activité d'un client : tonnage + CA par jour ──────────────────────────
  if (req.method === 'GET' && action === 'analytics') {
    const tenantId = String(req.query?.tenant || '').trim();
    if (!tenantId) return res.status(400).json({ error: 'tenant requis' });
    const platform = await getDb(null);
    if (!(await platform.collection(COL.tenants).findOne({ tenantId }))) {
      return res.status(404).json({ error: 'Client introuvable' });
    }
    const days = Math.min(370, Math.max(1, parseInt(req.query?.days || '30') || 30));
    const to = casaDate();
    const from = addDays(to, -(days - 1));
    const db = await getDb(tenantId);
    const { day, other, totKg, totCa, totKgOrd, invoices, orders } = await tonnage(db, from, to);
    // série continue, un point par jour (les jours vides valent 0)
    const daily = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      daily.push(day[d] || { date: d, kg: 0, ca: 0, kgOrd: 0, inv: 0, ord: 0 });
    }
    return res.status(200).json({
      tenant: tenantId, from, to, days, daily,
      totals: { kg: totKg, ca: totCa, kgOrd: totKgOrd, invoices, orders, otherUnits: other },
      ratePerKg: await getRatePerKg(),
    });
  }

  // ── tarif de facturation d'Akram (DH par KG) ──────────────────────────────
  if (req.method === 'PATCH' && action === 'billing') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const rate = Number(b?.ratePerKg);
    if (!(rate >= 0) || !isFinite(rate)) return res.status(400).json({ error: 'Tarif invalide' });
    const platform = await getDb(null);
    await platform.collection(COL.platform).updateOne(
      { _id: 'billing' },
      { $set: { _id: 'billing', ratePerKg: Math.round(rate * 10000) / 10000, updatedAt: new Date().toISOString() } },
      { upsert: true });
    return res.status(200).json({ ok: true, ratePerKg: await getRatePerKg() });
  }

  // ── export CSV (aperçu, ne supprime rien) ─────────────────────────────────
  if (req.method === 'GET' && action === 'export') {
    const tenantId = String(req.query?.tenant || '').trim();
    const before = String(req.query?.before || addDays(casaDate(), -90));
    if (!tenantId) return res.status(400).json({ error: 'tenant requis' });
    const { orders, invoices } = await collect(tenantId, before);
    const csv = toCsv([...flatten('commande', orders), ...flatten('facture', invoices)]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="archive-${tenantId}-avant-${before}.csv"`);
    return res.status(200).send('﻿' + csv);      // BOM : Excel/Sheets lisent l'UTF-8
  }

  // ── archivage : exporte PUIS purge ────────────────────────────────────────
  if (req.method === 'POST' && action === 'archive') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const tenantId = String(b?.tenant || '').trim();
    const before = String(b?.before || addDays(casaDate(), -90));
    if (!tenantId) return res.status(400).json({ error: 'tenant requis' });

    // Garde-fou : jamais de purge sur des données récentes. Une facture doit
    // rester tant qu'elle peut être encaissée, et la loi impose 10 ans de
    // conservation — l'export CSV est la copie qui part aux archives.
    const limit = addDays(casaDate(), -MIN_AGE_DAYS);
    if (before > limit) {
      return res.status(400).json({
        error: `Sécurité : on n'archive que ce qui a plus de ${MIN_AGE_DAYS} jours. Date maximale autorisée : ${limit}`,
      });
    }

    const { orders, invoices, pos } = await collect(tenantId, before);
    const rows = [...flatten('commande', orders), ...flatten('facture', invoices)];
    if (!rows.length) return res.status(200).json({ ok: true, archived: 0, message: 'Rien à archiver sur cette période' });

    if (b.dryRun !== false && b.confirm !== true) {
      return res.status(200).json({
        ok: true, dryRun: true,
        wouldArchive: { orders: orders.length, invoices: invoices.length, po: pos.length, lignes: rows.length },
        message: 'Aperçu — rien n\'a été supprimé. Télécharge le CSV, puis relance avec confirm.',
      });
    }

    // purge après export
    const del = async (tbl, col) => (await S.unsafe(
      `delete from ${tbl} where tenant_id=$1 and doc->>'${col}' < $2 returning id`, [tenantId, before])).length;
    const n = {
      orders: await del('dima_orders', 'date'),
      invoices: await del('dima_invoices', 'date'),
      po: await del('dima_po', 'businessDate'),
    };
    return res.status(200).json({ ok: true, archived: n, before, lignes: rows.length });
  }

  // ── mot de passe du compte plateforme ─────────────────────────────────────
  // Le super-admin choisit lui-même son mot de passe : celui livré à
  // l'installation cesse alors d'être accepté (voir api/login.js).
  if (req.method === 'PATCH' && action === 'password') {
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const current = String(b?.current || '').trim();
    const next = String(b?.next || '').trim();

    // Le jeton admin suffirait, mais on redemande le mot de passe en cours :
    // un poste laissé ouvert ne doit pas permettre de verrouiller le compte.
    const plat = await platformPassword();
    if (current !== plat.password) return res.status(403).json({ error: 'Mot de passe actuel incorrect' });

    if (next.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
    if (next === current) return res.status(400).json({ error: 'Choisis un mot de passe différent de l\'actuel' });
    if (next === process.env.APP_PASSWORD) {
      return res.status(400).json({ error: 'Celui-ci a été transmis à l\'installation — choisis-en un autre' });
    }
    // unicité globale : ne pas reprendre un mot de passe de client, membre ou fournisseur
    if (await passwordInUse(next)) {
      return res.status(409).json({ error: 'Ce mot de passe est déjà utilisé ailleurs' });
    }
    const platform = await getDb(null);
    await platform.collection(COL.platform).updateOne(
      { _id: 'admin' },
      { $set: { _id: 'admin', password: next, updatedAt: new Date().toISOString() } },
      { upsert: true });
    return res.status(200).json({ ok: true });
  }

  // ── suppression définitive d'un client ────────────────────────────────────
  if (req.method === 'DELETE') {
    const tenantId = String(req.query?.tenant || '').trim();
    const confirm = String(req.query?.confirm || '');
    if (!tenantId) return res.status(400).json({ error: 'tenant requis' });
    const platform = await getDb(null);
    const t = await platform.collection(COL.tenants).findOne({ tenantId });
    if (!t) return res.status(404).json({ error: 'Client introuvable' });
    // Le nom exact doit être retapé : c'est irréversible et ça efface tout son
    // historique (catalogue, clients, commandes, factures).
    if (confirm !== t.name) {
      return res.status(400).json({ error: `Pour confirmer, retape exactement le nom du client : "${t.name}"` });
    }
    await purgeTenant(tenantId);
    return res.status(200).json({ ok: true, deleted: tenantId });
  }

  return res.status(400).json({ error: 'action inconnue' });
}
