// POST /api/login { password }
//   → { token, role:'admin' }                          mot de passe plateforme
//   → { token, role:'team', tenantId, tenant:{...} }    mot de passe d'un client
//   → { token, role:'supplier', tenantId, supplierId }  mot de passe fournisseur
import { getDb, COL, cors, teamToken, supplierToken, userToken, platformPassword, audit } from '../lib/mongo.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const password = (body?.password || '').trim();
  if (!password) return res.status(400).json({ error: 'Mot de passe requis' });

  // 1. plateforme (Akram) — gère les clients.
  // Une fois qu'il a choisi son propre mot de passe, celui livré à
  // l'installation n'est plus accepté : un secret transmis une fois ne doit pas
  // rester valable indéfiniment.
  const plat = await platformPassword();
  if (!plat.password) return res.status(500).json({ error: 'APP_PASSWORD non configuré' });
  if (password === plat.password) {
    return res.status(200).json({
      token: process.env.APP_TOKEN || '',
      role: 'admin',
      mustChangePassword: !plat.chosen,
    });
  }

  try {
    const platform = await getDb(null);

    // 2. compte principal d'un client (le mot de passe remis par la plateforme)
    const tenant = await platform.collection(COL.tenants)
      .findOne({ password, active: 1 }, { projection: { password: 0 } });
    if (tenant) {
      const db = await getDb(tenant.tenantId);
      await audit(db, { role: 'team', tenantId: tenant.tenantId }, 'connexion', 'compte principal');
      return res.status(200).json({
        token: teamToken(tenant.tenantId),
        role: 'team',
        tenantId: tenant.tenantId,
        tenant: { name: tenant.name, logo: tenant.logo || '', color: tenant.color || '' },
      });
    }

    const tenants = await platform.collection(COL.tenants).find({ active: 1 }).toArray();

    // 3. membre nommé de l'équipe — son mot de passe personnel l'identifie
    for (const t of tenants) {
      const db = await getDb(t.tenantId);
      const usr = await db.collection(COL.users).findOne({ password, active: 1 });
      if (usr) {
        const principal = { role: 'team', tenantId: t.tenantId, userId: usr.userId };
        await audit(db, principal, 'connexion', usr.name, null, usr.name);
        return res.status(200).json({
          token: userToken(t.tenantId, usr.userId),
          role: 'team',
          tenantId: t.tenantId,
          userId: usr.userId,
          name: usr.name,
          tenant: { name: t.name, logo: t.logo || '', color: t.color || '' },
        });
      }
    }

    // 4. fournisseur — on cherche dans le périmètre de chaque client actif
    for (const t of tenants) {
      const db = await getDb(t.tenantId);
      const sup = await db.collection(COL.suppliers).findOne({ password, active: 1 });
      if (sup) {
        await audit(db, { role: 'supplier', tenantId: t.tenantId, supplierId: sup.supplierId },
          'connexion', sup.name, null, `${sup.name} (fournisseur)`);
        return res.status(200).json({
          token: supplierToken(t.tenantId, sup.supplierId),
          role: 'supplier',
          tenantId: t.tenantId,
          supplierId: sup.supplierId,
          name: sup.name,
          tenant: { name: t.name, logo: t.logo || '' },
        });
      }
    }
  } catch (e) {
    return res.status(500).json({ error: 'Erreur serveur' });
  }

  return res.status(401).json({ error: 'Mot de passe incorrect' });
}
