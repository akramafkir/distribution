import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Logo, BRAND } from './Brand.jsx';
import { Layout } from './Layout.jsx';

// ───────────────────────── helpers ─────────────────────────
const TOKEN_KEY = 'df_token', USER_KEY = 'df_user', ROLE_KEY = 'df_role', SUP_KEY = 'df_supplier', TEN_KEY = 'df_tenant', UID_KEY = 'df_userid';
const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
const getUser = () => localStorage.getItem(USER_KEY) || '';
const getRole = () => localStorage.getItem(ROLE_KEY) || 'team';
const getTenant = () => { try { return JSON.parse(localStorage.getItem(TEN_KEY) || '{}'); } catch { return {}; } };
// compte principal = connecté avec le mot de passe du client (pas un membre) —
// seul lui voit la gestion d'équipe et le journal (le serveur le vérifie aussi)
const isOwner = () => getRole() === 'team' && !localStorage.getItem(UID_KEY);
// On efface AUSSI le nom : sinon celui du membre précédent resterait pré-rempli
// et le compte principal, en se reconnectant, journaliserait sous ce nom.
function logout() { [TOKEN_KEY, ROLE_KEY, SUP_KEY, TEN_KEY, UID_KEY, USER_KEY].forEach(k => localStorage.removeItem(k)); location.reload(); }

async function api(path, opts = {}) {
  const r = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      'x-auth-token': getToken(),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  // 401 = session finie ou coupée : on efface toute l'identité, pas seulement
  // le jeton, pour ne pas laisser un nom fantôme au prochain connecté.
  if (r.status === 401) { [TOKEN_KEY, ROLE_KEY, SUP_KEY, TEN_KEY, UID_KEY, USER_KEY].forEach(k => localStorage.removeItem(k)); location.hash = '#/'; location.reload(); }
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`);
  return data;
}

const fmt = (n) => (Number(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDH = (n) => `${fmt(n)} DH`;

function useRoute() {
  const [hash, setHash] = useState(window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}
const go = (p) => { window.location.hash = p; };

// Deprecated: use .input, .btn-primary, .btn-ghost, .btn-danger classes instead
const inputCls = 'input';
const btnPrimary = 'btn-primary';
const btnGhost = 'btn-ghost';

// ───────────────────────── shell ─────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const route = useRoute();
  const [activeTab, setActiveTab] = useState(() => {
    const routes = ['commandes', 'clients', 'factures', 'po', 'produits'];
    const top = route.split('/')[0];
    if (routes.includes(top)) return top;
    return 'home';
  });

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  if (getRole() === 'admin') return <AdminApp />;
  if (getRole() === 'supplier') return <SupplierApp />;

  const seg = route.split('/').filter(Boolean);
  const top = seg[0] || '';

  let page;
  if (top === 'catalogue') page = <Catalogue />;
  else if (top === 'produits') page = <Produits />;
  else if (top === 'vente') page = <Vente />;
  else if (top === 'clients') page = <Clients />;
  else if (top === 'po' || top === 'achats') page = <PoCalculation />;
  else if (top === 'fournisseurs') page = <Fournisseurs />;
  else if (top === 'factures') page = <Factures />;
  else if (top === 'reglages') page = <Reglages />;
  else if (top === 'facture') page = <InvoiceView numero={seg[1]} />;
  else page = <Commandes />;

  const tenant = getTenant();
  return (
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      workspaceName={tenant.name || BRAND.name}
      user={getUser()}
      onLogout={logout}
    >
      {page}
    </Layout>
  );
}

function Header({ route }) {
  // Volontairement court : l'équipe commande, achète, livre, facture.
  // Vente directe, Catalogue et Fournisseurs sont masqués pour l'instant.
  // Réglages (identité de facturation, RIB, équipe, journal) = compte principal.
  const links = [['/', 'Commandes'], ['/po', 'PO Calculation'], ['/produits', 'Produits'], ['/clients', 'Clients'], ['/factures', 'Factures'],
    ...(isOwner() ? [['/reglages', 'Réglages']] : [])];
  const user = getUser();
  return (
    <header className="bg-white border-b border-neutral-200 sticky top-0 z-20 no-print">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
        <button onClick={() => go('/')} className="shrink-0"><TenantMark size={34} /></button>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {links.map(([href, label]) => {
            const active = (href === '/' && (route === '' || route === 'commandes'))
              || (href !== '/' && ('/' + route) === href)
              || (href === '/po' && route === 'achats');
            return (
              <button key={href} onClick={() => go(href)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap ${active ? 'bg-yf-primary/10 text-yf-primary' : 'text-neutral-600 hover:bg-neutral-100'}`}>
                {label}
              </button>
            );
          })}
        </nav>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-neutral-500 hidden sm:block">{user || '—'}</span>
          <button onClick={logout} className="text-xs text-neutral-400 hover:text-yf-red">Quitter</button>
        </div>
      </div>
    </header>
  );
}

// ───────────────────────── login ─────────────────────────
function Login({ onDone }) {
  const [name, setName] = useState(getUser());
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw, name: name.trim() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erreur');
      localStorage.setItem(TOKEN_KEY, d.token);
      localStorage.setItem(ROLE_KEY, d.role || 'team');
      if (d.supplierId) localStorage.setItem(SUP_KEY, d.supplierId);
      if (d.userId) localStorage.setItem(UID_KEY, d.userId); else localStorage.removeItem(UID_KEY);
      if (d.tenant) localStorage.setItem(TEN_KEY, JSON.stringify({ ...d.tenant, tenantId: d.tenantId }));
      // le nom connu du serveur (membre / fournisseur) prime sur le nom tapé
      localStorage.setItem(USER_KEY, d.name || name.trim());
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-neutral-50 to-white">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-neutral-100 p-8">
        <div className="flex justify-center mb-6"><Logo size={48} /></div>
        <h1 className="text-center text-lg font-bold text-yf-primary mb-1">Espace ventes</h1>
        <p className="text-center text-sm text-neutral-500 mb-6">Connexion équipe</p>
        <label className="text-xs text-neutral-500">Votre nom <span className="text-neutral-400">(inutile si tu as ton mot de passe personnel)</span></label>
        <input className="input mb-3 mt-1" value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Karim" />
        <label className="text-xs text-neutral-500">Mot de passe</label>
        <input type="password" className="input mb-4 mt-1" value={pw} onChange={e => setPw(e.target.value)} placeholder="••••••••" required autoFocus />
        {err && <p className="text-sm text-yf-red mb-3">✗ {err}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Connexion…' : 'Entrer'}</button>
      </form>
    </div>
  );
}

// ───────────────────────── modal ─────────────────────────
function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // On NE ferme PAS en tapant le fond : sur un téléphone, un doigt qui glisse
  // hors du formulaire effacerait une saisie à moitié faite. On ferme par le ×,
  // Échap, ou les boutons d'action.
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto no-print">
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} mt-8 sm:mt-16`}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-100 sticky top-0 bg-white rounded-t-2xl">
          <h3 className="font-semibold text-neutral-800">{title}</h3>
          <button onClick={onClose} aria-label="Fermer"
            className="-mr-2 p-2 text-neutral-400 hover:text-neutral-700 text-2xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const Loading = () => <div className="text-sm text-neutral-400 py-8 text-center">Chargement…</div>;
const Empty = ({ msg }) => <div className="text-sm text-neutral-400 py-8 text-center">{msg}</div>;

// ───────────────────────── VENTE (order builder) ─────────────────────────
function Vente() {
  const [client, setClient] = useState(() => {
    try {
      const pre = sessionStorage.getItem('_preselectedClient');
      if (pre) {
        sessionStorage.removeItem('_preselectedClient');
        return JSON.parse(pre);
      }
    } catch {}
    return null;
  });
  const [lines, setLines] = useState([]); // {itemId,name,uom,qty,unitPrice}
  const [pickClient, setPickClient] = useState(false);
  const [payment, setPayment] = useState('espece');
  const [discount, setDiscount] = useState(0);
  const [notes, setNotes] = useState('');
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api('/settings').then(d => setSettings(d.settings)).catch(() => {}); }, []);

  function addItem(sku) {
    setLines(ls => {
      const ex = ls.find(l => l.itemId === sku.itemId);
      if (ex) return ls.map(l => l.itemId === sku.itemId ? { ...l, qty: l.qty + 1 } : l);
      return [...ls, { itemId: sku.itemId, name: sku.name, uom: sku.uom || 'KG', qty: 1, unitPrice: Number(sku.price) || 0 }];
    });
  }
  const setLine = (id, patch) => setLines(ls => ls.map(l => l.itemId === id ? { ...l, ...patch } : l));
  const removeLine = (id) => setLines(ls => ls.filter(l => l.itemId !== id));

  const subtotal = useMemo(() => lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0), [lines]);
  const tvaRate = Number(settings?.tvaRate) || 0;
  const timbreRate = Number(settings?.timbreRate) || 0;
  const base = Math.max(0, subtotal - (Number(discount) || 0));
  const tva = base * tvaRate / 100;
  const applyTimbre = timbreRate > 0 && (settings?.timbreOnCashOnly === false || ['espece', 'cash', 'cod'].includes(payment));
  const timbre = applyTimbre ? (base + tva) * timbreRate / 100 : 0;
  const net = base + tva + timbre;

  async function generate() {
    setErr('');
    if (!client) { setErr('Choisis un client.'); return; }
    if (!lines.length) { setErr('Ajoute au moins un article.'); return; }
    setBusy(true);
    try {
      const d = await api('/invoices', { method: 'POST', body: {
        client, lines, paymentMode: payment, discount: Number(discount) || 0, notes, createdBy: getUser(),
      }});
      go('/facture/' + d.invoice.numero);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-yf-primary">Nouvelle vente</h1>
        {lines.length > 0 && <button onClick={() => { setLines([]); setClient(null); setDiscount(0); setNotes(''); }} className="text-xs text-neutral-400 hover:text-yf-red">Réinitialiser</button>}
      </div>

      {/* client */}
      <div className="bg-white rounded-xl border border-neutral-200 p-4">
        {client ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-neutral-800 truncate">{client.name}</div>
              <div className="text-xs text-neutral-500 truncate">{[client.city, client.phone, client.ice && ('ICE ' + client.ice)].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            <button onClick={() => setPickClient(true)} className="btn-ghost">Changer</button>
          </div>
        ) : (
          <button onClick={() => setPickClient(true)} className="btn-primary">+ Choisir le client</button>
        )}
      </div>

      {/* item search */}
      <ItemSearch onAdd={addItem} />

      {/* cart */}
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        {lines.length === 0 ? <Empty msg="Aucun article. Cherche un produit ci-dessus." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Article</th>
                  <th className="text-right px-3 py-2 w-24">Qté</th>
                  <th className="text-right px-3 py-2 w-28">PU (DH)</th>
                  <th className="text-right px-3 py-2 w-28">Total</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {lines.map(l => (
                  <tr key={l.itemId}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-neutral-800 leading-tight">{l.name}</div>
                      <div className="text-xs text-neutral-400">{l.itemId} · {l.uom}</div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min="0" step="any" value={l.qty}
                        onChange={e => setLine(l.itemId, { qty: e.target.value })}
                        className="w-20 border border-neutral-200 rounded px-2 py-1 text-right" />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min="0" step="any" value={l.unitPrice}
                        onChange={e => setLine(l.itemId, { unitPrice: e.target.value })}
                        className={'w-24 border rounded px-2 py-1 text-right ' + (Number(l.unitPrice) > 0 ? 'border-neutral-200' : 'border-citrus-400 bg-amber-50')} />
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{fmt((Number(l.qty) || 0) * (Number(l.unitPrice) || 0))}</td>
                    <td className="px-2 text-center">
                      <button onClick={() => removeLine(l.itemId)} className="text-neutral-300 hover:text-yf-red">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* totals + actions */}
      {lines.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-3">
            <div>
              <label className="text-xs text-neutral-500">Mode de paiement</label>
              <select value={payment} onChange={e => setPayment(e.target.value)} className="input mt-1">
                <option value="espece">Espèces</option>
                <option value="cheque">Chèque</option>
                <option value="virement">Virement</option>
                <option value="credit">Crédit</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-neutral-500">Remise (DH)</label>
              <input type="number" min="0" step="any" value={discount} onChange={e => setDiscount(e.target.value)} className="input mt-1" />
            </div>
            <div>
              <label className="text-xs text-neutral-500">Note (optionnel)</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} className="input mt-1" placeholder="Ex: livraison demain" />
            </div>
          </div>
          <div className="bg-white rounded-xl border border-neutral-200 p-4">
            <Row k="Sous-total (HT)" v={fmtDH(subtotal)} />
            {Number(discount) > 0 && <Row k="Remise" v={'− ' + fmtDH(discount)} />}
            {tvaRate > 0 && <Row k={`TVA (${tvaRate}%)`} v={fmtDH(tva)} />}
            {timbre > 0 && <Row k={`Droit de timbre (${timbreRate}%)`} v={fmtDH(timbre)} />}
            <div className="border-t border-neutral-200 my-2" />
            <Row k="Net à payer" v={fmtDH(net)} big />
            {err && <p className="text-sm text-yf-red mt-3">✗ {err}</p>}
            <button onClick={generate} disabled={busy} className={btnPrimary + ' w-full justify-center mt-3'}>
              {busy ? 'Génération…' : 'Générer la facture'}
            </button>
          </div>
        </div>
      )}

      {pickClient && <ClientPicker onPick={c => { setClient(c); setPickClient(false); }} onClose={() => setPickClient(false)} />}
    </div>
  );
}

function Row({ k, v, big }) {
  return (
    <div className={`flex items-center justify-between ${big ? 'text-lg font-bold text-yf-primary' : 'text-sm text-neutral-600'}`}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
}

// live item search with debounce
function ItemSearch({ onAdd }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const t = useRef(null);
  useEffect(() => {
    if (!q.trim()) { setRows([]); return; }
    clearTimeout(t.current);
    t.current = setTimeout(() => {
      api(`/skus?q=${encodeURIComponent(q)}&active=1&limit=8`).then(d => { setRows(d.rows); setOpen(true); }).catch(() => {});
    }, 220);
    return () => clearTimeout(t.current);
  }, [q]);
  return (
    <div className="relative">
      <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => rows.length && setOpen(true)}
        className="input" placeholder="🔍 Chercher un produit à ajouter…" />
      {open && rows.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-neutral-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {rows.map(s => (
            <button key={s.itemId} onClick={() => { onAdd(s); setQ(''); setRows([]); setOpen(false); }}
              className="w-full text-left px-3 py-2 hover:bg-neutral-50 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-neutral-800 truncate">{s.name}</div>
                <div className="text-xs text-neutral-400">{s.category} · {s.uom}</div>
              </div>
              <div className="text-sm font-semibold text-yf-primary whitespace-nowrap">{s.price > 0 ? fmtDH(s.price) : 'prix ?'}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── client picker ─────────────────────────
function ClientPicker({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [addNew, setAddNew] = useState(false);
  const t = useRef(null);
  const load = useCallback((query) => {
    api(`/clients?q=${encodeURIComponent(query)}&limit=25`).then(d => setRows(d.rows)).catch(() => setRows([]));
  }, []);
  useEffect(() => { load(''); }, [load]);
  useEffect(() => {
    clearTimeout(t.current);
    t.current = setTimeout(() => load(q), 250);
    return () => clearTimeout(t.current);
  }, [q, load]);

  if (addNew) return <NewClient onCreated={c => onPick(c)} onClose={() => setAddNew(false)} />;
  return (
    <Modal title="Choisir le client" onClose={onClose} wide>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} className="input mb-3" placeholder="Nom, téléphone, ville, ICE…" />
      {rows === null ? <Loading /> : rows.length === 0 ? <Empty msg="Aucun client." /> : (
        <div className="max-h-80 overflow-y-auto border border-neutral-100 rounded-lg divide-y divide-neutral-100">
          {rows.map(c => (
            <button key={c.clientId} onClick={() => onPick(c)} className="w-full text-left px-3 py-2.5 hover:bg-neutral-50">
              <div className="font-medium text-neutral-800 text-sm">{c.name}</div>
              <div className="text-xs text-neutral-400">{[c.city, c.phone, c.ice && ('ICE ' + c.ice)].filter(Boolean).join(' · ') || '—'}</div>
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 flex justify-between">
        <button onClick={() => setAddNew(true)} className="text-sm text-yf-primary hover:underline">+ Nouveau client</button>
        <button onClick={onClose} className="btn-ghost">Annuler</button>
      </div>
    </Modal>
  );
}

/** Création ET modification d'un client — un seul formulaire pour les deux. */
function NewClient({ client, onCreated, onClose }) {
  const editing = !!client;
  const [f, setF] = useState({
    name: client?.name || '', phone: client?.phone || '', address: client?.address || '',
    city: client?.city || '', ice: client?.ice || '', email: client?.email || '',
    priceTier: client?.priceTier || 'RC', active: client ? client.active !== 0 : true,
    geo: client?.geo || null,
  });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [geoBusy, setGeoBusy] = useState(false); const [geoErr, setGeoErr] = useState('');
  // La position n'est envoyée au serveur QUE si elle a été touchée ici :
  // sinon, modifier un téléphone depuis une liste pas rafraîchie écraserait
  // la capture qu'un collègue vient de faire devant le magasin.
  const [geoDirty, setGeoDirty] = useState(false);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  /** À utiliser SUR PLACE, devant le magasin : la position du téléphone
   *  devient la position du client, et servira d'itinéraire au livreur. */
  function capture() {
    setGeoErr('');
    if (!navigator.geolocation) { setGeoErr('Localisation non disponible sur cet appareil'); return; }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        const acc = pos.coords.accuracy;
        // Un fix WiFi/IP d'ordinateur peut être « réussi » à ±2 km : l'accepter
        // enverrait le livreur n'importe où, avec un badge 📍 rassurant en prime.
        if (acc > 150) {
          setGeoErr(`Position trop imprécise (±${Math.round(acc)} m) — utilise un téléphone, dehors, devant le magasin`);
        } else {
          set('geo', { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: acc });
          setGeoDirty(true);
        }
        setGeoBusy(false);
      },
      e => {
        setGeoErr(e.code === 1
          ? 'Autorisation refusée — active la localisation du téléphone pour ce site'
          : 'Position introuvable — réessaie dehors, devant le magasin');
        setGeoBusy(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }
  function clearGeo() { set('geo', null); setGeoDirty(true); }

  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const body = { ...f };
      if (editing && !geoDirty) delete body.geo;   // non touchée → on n'y touche pas
      const d = editing
        ? await api('/clients', { method: 'PATCH', body: { ...body, clientId: client.clientId } })
        : await api('/clients', { method: 'POST', body });
      onCreated(d.row);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={editing ? `Modifier — ${client.name}` : 'Nouveau client'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div><label className="text-xs text-neutral-500">Nom / Raison sociale *</label><input required className="input mt-1" value={f.name} onChange={e => set('name', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs text-neutral-500">Téléphone</label><input type="tel" inputMode="tel" autoComplete="tel" className="input mt-1" value={f.phone} onChange={e => set('phone', e.target.value)} /></div>
          <div><label className="text-xs text-neutral-500">Ville</label><input className="input mt-1" value={f.city} onChange={e => set('city', e.target.value)} /></div>
        </div>
        <div><label className="text-xs text-neutral-500">Adresse</label><input className="input mt-1" value={f.address} onChange={e => set('address', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs text-neutral-500">ICE (optionnel)</label><input className="input mt-1" value={f.ice} onChange={e => set('ice', e.target.value)} /></div>
          <div><label className="text-xs text-neutral-500">Email (optionnel)</label><input type="email" inputMode="email" autoComplete="email" className="input mt-1" value={f.email} onChange={e => set('email', e.target.value)} /></div>
        </div>

        {/* position du magasin — capturée sur place, sert d'itinéraire au livreur */}
        <div className="border border-neutral-200 rounded-lg p-3 bg-neutral-50/60">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm">
              <div className="font-medium text-neutral-700">📍 Position du magasin</div>
              {f.geo
                ? <div className="text-xs text-yf-primary mt-0.5">
                    ✓ Enregistrée{f.geo.accuracy ? ` (±${Math.round(f.geo.accuracy)} m)` : ''} — le livreur aura l'itinéraire
                  </div>
                : <div className="text-xs text-neutral-400 mt-0.5">À capturer quand tu es devant le magasin</div>}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={capture} disabled={geoBusy} className="btn-ghost">
                {geoBusy ? 'Localisation…' : f.geo ? '🔁 Recapturer ici' : '📍 Je suis devant le magasin'}
              </button>
              {f.geo && <button type="button" onClick={clearGeo}
                className="text-xs text-neutral-400 hover:text-yf-red">retirer</button>}
            </div>
          </div>
          {geoErr && <p className="text-xs text-yf-red mt-2">✗ {geoErr}</p>}
        </div>

        {editing && (
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            <input type="checkbox" checked={f.active} onChange={e => set('active', e.target.checked)} />
            Client actif <span className="text-xs text-neutral-400">(décoché : il n'apparaît plus dans les ventes)</span>
          </label>
        )}
        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        {/* geoBusy bloque aussi : enregistrer pendant la localisation perdrait
            la position sans que personne ne s'en rende compte */}
        <button className="btn-primary w-full" disabled={busy || geoBusy}>
          {geoBusy ? 'Localisation en cours…' : busy ? 'Enregistrement…' : editing ? 'Enregistrer' : 'Créer et sélectionner'}
        </button>
      </form>
    </Modal>
  );
}

/** Confirmation de suppression réutilisable — dit ce qui va réellement se passer. */
function ConfirmDelete({ title, what, warning, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState(null);
  async function go() {
    setBusy(true); setErr('');
    try {
      const r = await onConfirm();
      if (r?.deactivated) { setDone(r.reason); setBusy(false); }
      else onClose(true);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  if (done) return (
    <Modal title={title} onClose={() => onClose(true)}>
      <div className="space-y-3">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">{done}</div>
        <button onClick={() => onClose(true)} className="btn-primary w-full">Compris</button>
      </div>
    </Modal>
  );
  return (
    <Modal title={title} onClose={() => onClose(false)}>
      <div className="space-y-3">
        <p className="text-sm text-neutral-700">Supprimer <b>{what}</b> ?</p>
        {warning && <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 text-xs text-neutral-600">{warning}</div>}
        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <div className="flex gap-2">
          <button onClick={() => onClose(false)} className="btn-ghost flex-1">Annuler</button>
          <button onClick={go} disabled={busy}
            className="flex-1 px-4 py-2.5 rounded-lg bg-yf-red text-white font-semibold text-sm disabled:opacity-40">
            {busy ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── CATALOGUE ─────────────────────────
function Catalogue() {
  const [q, setQ] = useState('');
  const [active, setActive] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [newSku, setNewSku] = useState(false);
  const [editSku, setEditSku] = useState(null);
  const t = useRef(null);
  const load = useCallback(() => {
    api(`/skus?q=${encodeURIComponent(q)}&active=${active}&page=${page}&limit=50`).then(setData).catch(() => setData({ rows: [], total: 0, pages: 0 }));
  }, [q, active, page]);
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(load, 200); return () => clearTimeout(t.current); }, [load]);
  useEffect(() => { setPage(1); }, [q, active]);
  useEffect(() => { api('/suppliers').then(d => setSuppliers(d.rows || [])).catch(() => {}); }, []);

  async function saveSku(itemId, patch) { await api('/skus', { method: 'PATCH', body: { itemId, ...patch } }); load(); }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <h1 className="text-xl font-bold text-yf-primary">Catalogue {data && <span className="text-sm font-normal text-neutral-400">({data.total})</span>}</h1>
        <div className="flex gap-2 items-center">
          {[['all', 'Tous'], ['1', 'Actifs'], ['0', 'Inactifs']].map(([v, l]) => (
            <button key={v} onClick={() => setActive(v)} className={`px-3 py-1.5 rounded-lg text-sm ${active === v ? 'bg-yf-primary/10 text-yf-primary font-semibold' : 'bg-white border border-neutral-200 text-neutral-600'}`}>{l}</button>
          ))}
          <button onClick={() => setNewSku(true)} className="btn-primary">+ Nouveau produit</button>
        </div>
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} className="input" placeholder="🔍 Chercher un produit, une catégorie…" />
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        {!data ? <Loading /> : data.rows.length === 0 ? <Empty msg="Aucun produit." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase">
                <tr><th className="text-left px-3 py-2">Produit</th><th className="text-left px-3 py-2">Fournisseur</th><th className="text-right px-3 py-2 w-24">Marge</th><th className="text-right px-3 py-2 w-32">Prix (DH)</th><th className="text-center px-3 py-2 w-24">Statut</th></tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {data.rows.map(s => <SkuRow key={s.itemId} s={s} suppliers={suppliers} onSave={saveSku} onEdit={setEditSku} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {data && data.pages > 1 && <Pager page={page} pages={data.pages} onPage={setPage} />}
      {newSku && <SkuForm suppliers={suppliers} onDone={() => { setNewSku(false); load(); }} onClose={() => setNewSku(false)} />}
      {editSku && <SkuForm sku={editSku} suppliers={suppliers} onDone={() => { setEditSku(null); load(); }} onClose={() => setEditSku(null)} />}
    </div>
  );
}

// ─────────────── PRODUITS : activer / désactiver (équipe) ───────────────
// Vue simple, sans édition : on masque un produit qu'on ne veut plus proposer,
// on le réactive quand on veut. Désactivé = invisible en vente ET dans le
// calcul d'achat (ItemSearch et /skus?active=1 le filtrent déjà).
function Produits() {
  const [q, setQ] = useState('');
  const [active, setActive] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const t = useRef(null);
  const load = useCallback(() => {
    api(`/skus?q=${encodeURIComponent(q)}&active=${active}&page=${page}&limit=50`)
      .then(setData).catch(() => setData({ rows: [], total: 0, pages: 0 }));
  }, [q, active, page]);
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(load, 200); return () => clearTimeout(t.current); }, [load]);
  useEffect(() => { setPage(1); }, [q, active]);

  async function toggle(s) {
    const next = s.active ? 0 : 1;
    setBusyId(s.itemId);
    // maj optimiste : la carte réagit tout de suite (on peut aussi annuler aussitôt)
    setData(d => ({ ...d, rows: d.rows.map(x => x.itemId === s.itemId ? { ...x, active: next } : x) }));
    try { await api('/skus', { method: 'PATCH', body: { itemId: s.itemId, active: next } }); }
    catch { load(); }                 // échec → on recharge la vérité serveur
    finally { setBusyId(null); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-yf-primary">Produits {data && <span className="text-sm font-normal text-neutral-400">({data.total})</span>}</h1>
        <p className="text-sm text-neutral-500">
          Désactive un produit que tu ne veux plus proposer : il disparaît des ventes et du bon d'achat.
          Réactive-le quand tu veux — rien n'est supprimé.
        </p>
      </div>
      <div className="flex gap-2">
        {[['all', 'Tous'], ['1', 'Actifs'], ['0', 'Désactivés']].map(([v, l]) => (
          <button key={v} onClick={() => setActive(v)}
            className={`px-3 py-2 rounded-lg text-sm ${active === v ? 'bg-yf-primary/10 text-yf-primary font-semibold' : 'bg-white border border-neutral-200 text-neutral-600'}`}>{l}</button>
        ))}
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} className="input" placeholder="🔍 Chercher un produit, une catégorie…" />

      {!data ? <Loading /> : data.rows.length === 0 ? <Empty msg="Aucun produit." /> : (
        <div className="space-y-2">
          {data.rows.map(s => (
            <div key={s.itemId} className={`bg-white rounded-xl border border-neutral-200 p-3 flex items-center justify-between gap-3 ${s.active ? '' : 'opacity-60'}`}>
              <div className="min-w-0">
                <div className="font-medium text-neutral-800 truncate">{s.name}
                  {!s.active && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600 align-middle">désactivé</span>}
                </div>
                <div className="text-xs text-neutral-400 truncate">
                  {[s.category, s.subCategory].filter(Boolean).join(' / ') || '—'} · {(s.uom || 'KG').toLowerCase()}
                </div>
              </div>
              <button onClick={() => toggle(s)} disabled={busyId === s.itemId}
                className={`shrink-0 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 ${s.active
                  ? 'border border-neutral-300 text-neutral-600 hover:bg-neutral-50'
                  : 'bg-yf-primary text-white hover:bg-yf-primary'}`}>
                {busyId === s.itemId ? '…' : s.active ? 'Désactiver' : 'Activer'}
              </button>
            </div>
          ))}
        </div>
      )}
      {data && data.pages > 1 && <Pager page={page} pages={data.pages} onPage={setPage} />}
    </div>
  );
}

// ─────────────── créer / modifier un produit ───────────────
const UOMS = ['KG', 'CAISSE', 'BOTTE', 'BARQUETTE', 'PIECE', 'BOITE', 'SAC'];

function SkuForm({ sku, suppliers = [], onDone, onClose }) {
  const editing = !!sku;
  const [f, setF] = useState({
    name: sku?.name || '', nomAr: sku?.nomAr || '',
    category: sku?.category || '', subCategory: sku?.subCategory || '',
    uom: sku?.uom || 'KG', price: sku?.price ?? '', margin: sku?.margin ?? 1.5,
    supplierId: sku?.supplierId || '', active: sku ? !!sku.active : true,
    purchaseUom: sku?.purchase?.uom || '', qtyPerUnit: sku?.purchase?.qtyPerUnit || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      if (editing) await api('/skus', { method: 'PATCH', body: { itemId: sku.itemId, ...f } });
      else await api('/skus', { method: 'POST', body: f });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm(`Supprimer « ${sku.name} » ?`)) return;
    setBusy(true); setErr('');
    try {
      const r = await api(`/skus?itemId=${encodeURIComponent(sku.itemId)}`, { method: 'DELETE' });
      if (r.deactivated) alert(r.reason);
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal title={editing ? 'Modifier le produit' : 'Nouveau produit'} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-neutral-500">Nom du produit *</label>
            <input required className="input mt-1" value={f.name} onChange={e => set('name', e.target.value)} placeholder="Ex : Tomate Agadir" />
          </div>
          <div>
            <label className="text-xs text-neutral-500">Nom en arabe</label>
            <input className="input mt-1" dir="rtl" value={f.nomAr} onChange={e => set('nomAr', e.target.value)} placeholder="ماطشة أكادير" />
          </div>
          <div>
            <label className="text-xs text-neutral-500">Catégorie</label>
            <input className="input mt-1" value={f.category} onChange={e => set('category', e.target.value)} placeholder="Légumes / Fruits" list="cats" />
            <datalist id="cats"><option value="Légumes" /><option value="Fruits" /></datalist>
          </div>
          <div>
            <label className="text-xs text-neutral-500">Sous-catégorie</label>
            <input className="input mt-1" value={f.subCategory} onChange={e => set('subCategory', e.target.value)} placeholder="Tomates" />
          </div>
          <div>
            <label className="text-xs text-neutral-500">Unité de vente *</label>
            <select className="input mt-1" value={f.uom} onChange={e => set('uom', e.target.value)}>
              {UOMS.map(u => <option key={u} value={u}>{u.toLowerCase()}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-neutral-500">Prix indicatif (DH)</label>
            <input type="number" min="0" step="any" className="input mt-1" value={f.price} onChange={e => set('price', e.target.value)} placeholder="0" />
          </div>
        </div>

        <div className="border-t border-neutral-100 pt-3">
          <div className="text-xs font-semibold text-neutral-600 mb-2">Achat au marché (optionnel)</div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-neutral-500">Unité d'achat</label>
              <select className="input mt-1" value={f.purchaseUom} onChange={e => set('purchaseUom', e.target.value)}>
                <option value="">— identique à la vente —</option>
                {UOMS.map(u => <option key={u} value={u}>{u.toLowerCase()}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-neutral-500">{f.uom.toLowerCase()} par unité d'achat</label>
              <input type="number" min="1" step="any" className="input mt-1" value={f.qtyPerUnit} onChange={e => set('qtyPerUnit', e.target.value)} placeholder="ex : 20" />
            </div>
            <div>
              <label className="text-xs text-neutral-500">Marge client (1–2 DH)</label>
              <input type="number" min="1" max="2" step="0.1" className="input mt-1" value={f.margin} onChange={e => set('margin', e.target.value)} />
            </div>
          </div>
          <p className="text-[11px] text-neutral-400 mt-1">Ex : vendu au kilo mais acheté à la caisse de 20 kg → le bon d'achat arrondit à la caisse entière.</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-neutral-500">Fournisseur</label>
            <select className="input mt-1" value={f.supplierId} onChange={e => set('supplierId', e.target.value)}>
              <option value="">— non assigné —</option>
              {suppliers.map(x => <option key={x.supplierId} value={x.supplierId}>{x.name}</option>)}
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-neutral-600">
              <input type="checkbox" checked={f.active} onChange={e => set('active', e.target.checked)} /> Produit actif
            </label>
          </div>
        </div>

        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <div className="flex gap-2">
          <button className={btnPrimary + ' flex-1 justify-center'} disabled={busy}>
            {busy ? 'Enregistrement…' : (editing ? 'Enregistrer' : 'Créer le produit')}
          </button>
          {editing && <button type="button" onClick={remove} disabled={busy}
            className="px-4 py-2.5 rounded-lg border border-rose-200 text-yf-red hover:bg-rose-50 text-sm">Supprimer</button>}
        </div>
      </form>
    </Modal>
  );
}

function SkuRow({ s, suppliers, onSave, onEdit }) {
  const [p, setP] = useState(s.price ?? 0);
  const [m, setM] = useState(s.margin ?? 1.5);
  const [saving, setSaving] = useState(false);
  const dirtyP = Number(p) !== Number(s.price ?? 0);
  const dirtyM = Number(m) !== Number(s.margin ?? 1.5);
  return (
    <tr className={s.active ? '' : 'bg-neutral-50/60'}>
      <td className="px-3 py-2">
        <button type="button" onClick={() => onEdit && onEdit(s)} className="text-left hover:underline">
          <div className="font-medium text-neutral-800 leading-tight">{s.name}</div>
          <div className="text-xs text-neutral-400">
            {s.category}{s.subCategory ? ' / ' + s.subCategory : ''} · {s.uom}
            {s.purchase ? ` · achat ${String(s.purchase.uom).toLowerCase()}` : ''}
          </div>
        </button>
      </td>
      <td className="px-3 py-2">
        <select value={s.supplierId || ''} onChange={e => onSave(s.itemId, { supplierId: e.target.value })}
          className="border border-neutral-200 rounded px-2 py-1 text-xs max-w-[10rem]">
          {suppliers.map(sup => <option key={sup.supplierId} value={sup.supplierId}>{sup.name}</option>)}
        </select>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center gap-1 justify-end">
          <input type="number" min="1" max="2" step="0.1" value={m} onChange={e => setM(e.target.value)} title="Marge client 1–2 DH"
            className="w-14 border border-neutral-200 rounded px-1 py-1 text-right" />
          {dirtyM && <button disabled={saving} onClick={async () => { setSaving(true); await onSave(s.itemId, { margin: m }); setSaving(false); }} className="text-xs px-1.5 py-1 rounded bg-yf-primary text-white">✓</button>}
        </div>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center gap-1 justify-end">
          <input type="number" min="0" step="any" value={p} onChange={e => setP(e.target.value)}
            className={'w-24 border rounded px-2 py-1 text-right ' + (Number(p) > 0 ? 'border-neutral-200' : 'border-citrus-400 bg-amber-50')} />
          {dirtyP && <button disabled={saving} onClick={async () => { setSaving(true); await onSave(s.itemId, { price: p }); setSaving(false); }} className="text-xs px-2 py-1 rounded bg-yf-primary text-white">OK</button>}
        </div>
      </td>
      <td className="px-3 py-2 text-center">
        <button onClick={() => onSave(s.itemId, { active: !s.active })} className={`text-xs px-2 py-1 rounded-full ${s.active ? 'bg-yf-primary/10 text-yf-primary' : 'bg-neutral-200 text-neutral-500'}`}>
          {s.active ? 'Actif' : 'Inactif'}
        </button>
      </td>
    </tr>
  );
}

// ───────────────────────── CLIENTS ─────────────────────────
function Clients() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [addNew, setAddNew] = useState(false);
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const [card, setCard] = useState(null);     // fiche client (pour le livreur)
  const t = useRef(null);
  const load = useCallback(() => {
    api(`/clients?q=${encodeURIComponent(q)}&page=${page}&limit=50`).then(setData).catch(() => setData({ rows: [], total: 0, pages: 0 }));
  }, [q, page]);
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(load, 200); return () => clearTimeout(t.current); }, [load]);
  useEffect(() => { setPage(1); }, [q]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-yf-primary">Clients {data && <span className="text-sm font-normal text-neutral-400">({data.total})</span>}</h1>
        <button onClick={() => setAddNew(true)} className="btn-primary">+ Nouveau</button>
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} className="input" placeholder="🔍 Nom, téléphone, ville, ICE…" />
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        {!data ? <Loading /> : data.rows.length === 0 ? <Empty msg="Aucun client." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase"><tr><th className="text-left px-3 py-2">Client</th><th className="text-left px-3 py-2">Ville</th><th className="text-left px-3 py-2">Téléphone</th><th className="text-left px-3 py-2">ICE</th><th className="w-32"></th></tr></thead>
              <tbody className="divide-y divide-neutral-100">
                {data.rows.map(c => (
                  <tr key={c.clientId} onClick={() => setCard(c)}
                    className={'cursor-pointer hover:bg-neutral-50 ' + (c.active === 0 ? 'opacity-50' : '')}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-neutral-800">{c.name}
                        {c.geo && <span className="ml-1.5" title="Position du magasin enregistrée">📍</span>}
                        {c.active === 0 && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600">désactivé</span>}
                      </div>
                      <div className="text-xs text-neutral-400">{c.clientId}{c.custom ? ' · ajouté' : ''}</div>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{c.city || '—'}</td>
                    <td className="px-3 py-2 text-neutral-500">{c.phone || '—'}</td>
                    <td className="px-3 py-2 text-neutral-500">{c.ice || '—'}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button onClick={e => { e.stopPropagation(); setEdit(c); }} className="px-2.5 py-2 -my-1 text-xs font-medium text-yf-primary hover:underline">Modifier</button>
                      <button onClick={e => { e.stopPropagation(); setDel(c); }} className="ml-1 px-2.5 py-2 -my-1 text-xs text-neutral-400 hover:text-yf-red">Supprimer</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {data && data.pages > 1 && <Pager page={page} pages={data.pages} onPage={setPage} />}
      {card && <ClientCard client={card} onEdit={() => { setEdit(card); setCard(null); }} onClose={() => setCard(null)} />}
      {addNew && <NewClient onCreated={() => { setAddNew(false); load(); }} onClose={() => setAddNew(false)} />}
      {edit && <NewClient client={edit} onCreated={() => { setEdit(null); load(); }} onClose={() => setEdit(null)} />}
      {del && <ConfirmDelete
        title="Supprimer le client" what={del.name}
        warning="S'il a déjà des commandes ou des factures, il sera désactivé plutôt que supprimé : son historique reste consultable."
        onConfirm={() => api(`/clients?clientId=${encodeURIComponent(del.clientId)}`, { method: 'DELETE' })}
        onClose={(changed) => { setDel(null); if (changed) load(); }} />}
    </div>
  );
}

/** Fiche client — pensée pour le livreur : tout ce qu'il faut pour trouver le
 *  magasin et appeler, avec l'itinéraire qui s'ouvre dans l'app Maps du téléphone. */
function ClientCard({ client: c, onEdit, onClose }) {
  // L'URL universelle Google Maps : sur téléphone elle ouvre l'application
  // Maps directement en mode itinéraire ; sur ordinateur, le site.
  const mapsUrl = c.geo
    ? `https://www.google.com/maps/dir/?api=1&destination=${c.geo.lat},${c.geo.lng}&travelmode=driving`
    : null;

  function startOrder() {
    sessionStorage.setItem('_preselectedClient', JSON.stringify(c));
    go('/vente');
    onClose();
  }

  return (
    <Modal title={c.name} onClose={onClose}>
      <div className="space-y-3">
        <button onClick={startOrder}
          className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-lg bg-yf-primary hover:bg-blue-600 text-white font-semibold text-sm">
          🛒 Prise de commande
        </button>

        {mapsUrl ? (
          <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-lg bg-yf-primary hover:bg-yf-primary text-white font-semibold text-sm">
            🗺️ Itinéraire vers le magasin
          </a>
        ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
            Position du magasin non enregistrée. La prochaine fois qu'un membre de l'équipe est
            sur place : <b>Modifier → 📍 Je suis devant le magasin</b>.
          </div>
        )}

        {c.phone && (
          <a href={`tel:${c.phone}`}
            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg border border-neutral-300 text-neutral-700 hover:bg-neutral-50 font-medium text-sm">
            📞 Appeler — {c.phone}
          </a>
        )}

        <div className="bg-neutral-50 rounded-lg p-3 text-sm space-y-1.5">
          <Row k="Référence" v={c.clientId} />
          {c.address && <Row k="Adresse" v={c.address} />}
          {c.city && <Row k="Ville" v={c.city} />}
          {c.ice && <Row k="ICE" v={c.ice} />}
          {c.geo?.accuracy != null && <Row k="Position" v={`±${Math.round(c.geo.accuracy)} m`} />}
          {c.active === 0 && <Row k="Statut" v="désactivé" />}
        </div>

        <div className="flex gap-2">
          <button onClick={onEdit} className="btn-ghost flex-1">Modifier la fiche</button>
          <button onClick={onClose} className={btnPrimary + ' flex-1 justify-center'}>Fermer</button>
        </div>
      </div>
    </Modal>
  );
}

function Pager({ page, pages, onPage }) {
  return (
    <div className="flex items-center justify-center gap-3 text-sm">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="btn-ghost disabled:opacity-40">‹ Préc.</button>
      <span className="text-neutral-500">Page {page} / {pages}</span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)} className="btn-ghost disabled:opacity-40">Suiv. ›</button>
    </div>
  );
}

// ───────────────────────── FACTURES (history) ─────────────────────────
function Factures() {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [batch, setBatch] = useState(null); // array of full invoices to print
  const [settings, setSettings] = useState(null);
  const t = useRef(null);
  const load = useCallback(() => { api(`/invoices?q=${encodeURIComponent(q)}&limit=50`).then(setData).catch(() => setData({ rows: [] })); }, [q]);
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(load, 200); return () => clearTimeout(t.current); }, [load]);
  useEffect(() => { api('/settings').then(d => setSettings(d.settings)).catch(() => {}); }, []);

  const toggle = (n) => setSel(s => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  async function printSelected() {
    const nums = [...sel];
    const full = await Promise.all(nums.map(n => api('/invoices?id=' + encodeURIComponent(n)).then(d => d.invoice)));
    setBatch(full);
    setTimeout(() => window.print(), 300);
  }

  if (batch) return <PrintBatch invoices={batch} settings={settings} onBack={() => setBatch(null)} />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-yf-primary">Factures</h1>
        {sel.size > 0 && <button onClick={printSelected} className="btn-primary">🖨 Imprimer ({sel.size})</button>}
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} className="input" placeholder="🔍 N° facture ou client…" />
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        {!data ? <Loading /> : data.rows.length === 0 ? <Empty msg="Aucune facture." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase"><tr><th className="w-10 px-3 py-2"></th><th className="text-left px-3 py-2">N°</th><th className="text-left px-3 py-2">Date</th><th className="text-left px-3 py-2">Client</th><th className="text-right px-3 py-2">Net</th><th className="w-16"></th></tr></thead>
              <tbody className="divide-y divide-neutral-100">
                {data.rows.map(inv => (
                  <tr key={inv.numero} className={'hover:bg-neutral-50' + (inv.status === 'cancelled' ? ' opacity-50' : '')}>
                    <td className="px-3 text-center"><input type="checkbox" checked={sel.has(inv.numero)} onChange={() => toggle(inv.numero)} /></td>
                    <td className="px-3 py-2 font-mono text-yf-primary">{inv.numero}
                      {inv.status === 'cancelled' && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">annulée</span>}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{inv.date}</td>
                    <td className="px-3 py-2 text-neutral-700">{inv.client?.name}</td>
                    <td className={'px-3 py-2 text-right font-semibold' + (inv.status === 'cancelled' ? ' line-through' : '')}>{fmtDH(inv.net)}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => go('/facture/' + inv.numero)} className="text-xs text-yf-primary hover:underline">Voir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PrintBatch({ invoices, settings, onBack }) {
  return (
    <div>
      <div className="no-print mb-4 flex gap-2">
        <button onClick={() => window.print()} className="btn-primary">🖨 Imprimer</button>
        <button onClick={onBack} className="btn-ghost">Retour</button>
      </div>
      <div className="print-area space-y-6">
        {invoices.map(inv => <InvoiceSheet key={inv.numero} invoice={inv} settings={settings} />)}
      </div>
    </div>
  );
}

// ───────────────────────── single invoice view ─────────────────────────
function InvoiceView({ numero }) {
  const [inv, setInv] = useState(null);
  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(false);
  const [cancel, setCancel] = useState(false);
  const load = useCallback(() => {
    api('/invoices?id=' + encodeURIComponent(numero)).then(d => setInv(d.invoice)).catch(e => setErr(e.message));
  }, [numero]);
  useEffect(() => { load(); api('/settings').then(d => setSettings(d.settings)).catch(() => {}); }, [load]);
  if (err) return <Empty msg={'✗ ' + err} />;
  if (!inv) return <Loading />;
  const cancelled = inv.status === 'cancelled';
  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => window.print()} className="btn-primary">🖨 Imprimer / PDF</button>
          <button onClick={() => go('/')} className="btn-ghost">← Commandes</button>
          {!cancelled && <>
            <button onClick={() => setEdit(true)} className="btn-ghost">Modifier</button>
            <button onClick={() => setCancel(true)} className="text-sm px-3 text-neutral-400 hover:text-yf-red">Annuler la facture</button>
          </>}
        </div>
        <button onClick={() => go('/factures')} className="text-sm text-neutral-500 hover:text-neutral-800">← Factures</button>
      </div>
      {cancelled && (
        <div className="no-print mb-4 bg-rose-50 border border-rose-200 rounded-xl p-3 text-sm text-rose-800">
          <b>Facture annulée</b> le {inv.cancelledOn || (inv.cancelledAt || '').slice(0, 10)} — motif : {inv.cancelReason || '—'}.
          <br />Elle reste conservée : le numéro {inv.numero} ne sera jamais réattribué.
        </div>
      )}
      <div className="print-area"><InvoiceSheet invoice={inv} settings={settings} /></div>

      {edit && <EditInvoice invoice={inv} onDone={() => { setEdit(false); load(); }} onClose={() => setEdit(false)} />}
      {cancel && <CancelInvoice invoice={inv} onDone={() => { setCancel(false); load(); }} onClose={() => setCancel(false)} />}
    </div>
  );
}

/** Corrections admises sur une facture émise : le mode de paiement (qui change
 *  le droit de timbre, donc le net) et la note de bas de page. Jamais les
 *  lignes ni les montants — pour ça, on annule et on refait. */
function EditInvoice({ invoice, onDone, onClose }) {
  const [f, setF] = useState({ paymentMode: invoice.paymentMode || 'espece', notes: invoice.notes || '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('/invoices', { method: 'PATCH', body: { numero: invoice.numero, ...f } }); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={`Modifier ${invoice.numero}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div>
          <label className="text-xs text-neutral-500">Mode de paiement</label>
          <select className="input mt-1" value={f.paymentMode} onChange={e => setF(s => ({ ...s, paymentMode: e.target.value }))}>
            <option value="espece">Espèces</option>
            <option value="cheque">Chèque</option>
            <option value="virement">Virement</option>
            <option value="credit">Crédit</option>
          </select>
          <p className="text-xs text-neutral-400 mt-1">Le droit de timbre et le net à payer sont recalculés par le serveur.</p>
        </div>
        <div><label className="text-xs text-neutral-500">Note</label><input className="input mt-1" value={f.notes} onChange={e => setF(s => ({ ...s, notes: e.target.value }))} /></div>
        <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 text-xs text-neutral-600">
          Les lignes et les montants ne sont pas modifiables : une facture émise fait foi.
          Pour corriger un montant, annule-la et refais-en une.
        </div>
        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
      </form>
    </Modal>
  );
}

/** Annulation — jamais suppression. Le motif est obligatoire. */
function CancelInvoice({ invoice, onDone, onClose }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState(null);
  async function go_() {
    setBusy(true); setErr('');
    try {
      const r = await api(`/invoices?numero=${encodeURIComponent(invoice.numero)}&reason=${encodeURIComponent(reason)}`, { method: 'DELETE' });
      setDone(r);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  if (done) return (
    <Modal title="Facture annulée" onClose={onDone}>
      <div className="space-y-3">
        <div className="bg-neutral-50 border border-brand-200 rounded-lg p-3 text-sm text-yf-primary">
          ✓ {invoice.numero} est annulée. Elle reste dans l'historique, marquée comme telle.
          {done.releasedOrder && <><br />La commande <b>{done.releasedOrder}</b> redevient facturable.</>}
        </div>
        <button onClick={onDone} className="btn-primary w-full">Fermer</button>
      </div>
    </Modal>
  );
  return (
    <Modal title={`Annuler ${invoice.numero}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          Une facture ne se supprime pas : la loi marocaine impose de conserver les pièces
          comptables <b>10 ans</b>, et un numéro manquant dans une séquence est le premier
          signal qu'un contrôle recherche. Elle sera marquée <b>annulée</b> et conservée.
        </div>
        <div>
          <label className="text-xs text-neutral-500">Motif de l'annulation *</label>
          <input className="input mt-1" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="ex : erreur de quantité, client a annulé…" />
        </div>
        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-ghost flex-1">Retour</button>
          <button onClick={go_} disabled={busy || reason.trim().length < 3}
            className="flex-1 px-4 py-2.5 rounded-lg bg-yf-red text-white font-semibold text-sm disabled:opacity-40">
            {busy ? 'Annulation…' : 'Annuler la facture'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── la facture imprimable ─────────────────────────
function InvoiceSheet({ invoice: inv, settings: s = {} }) {
  const seller = s || {};
  const legalLine = [seller.ice && `ICE: ${seller.ice}`, seller.ifNo && `IF: ${seller.ifNo}`, seller.rc && `RC: ${seller.rc}`, seller.patente && `Patente: ${seller.patente}`].filter(Boolean).join('  ·  ');
  return (
    <div className="invoice-sheet bg-white mx-auto max-w-3xl p-8 rounded-xl border border-neutral-200 shadow-sm" style={{ fontSize: 13 }}>
      {/* header */}
      <div className="flex items-start justify-between gap-4 pb-4 border-b-2 border-yf-primary">
        <div>
          <TenantMark size={40} />
          <div className="mt-2 text-xs text-neutral-500 leading-relaxed">
            {seller.sellerLegalForm && <div>{seller.sellerName} {seller.sellerLegalForm}</div>}
            {seller.sellerAddress && <div>{seller.sellerAddress}</div>}
            <div>{[seller.sellerCity, seller.sellerPhone].filter(Boolean).join(' · ')}</div>
            {seller.sellerEmail && <div>{seller.sellerEmail}</div>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-yf-primary">FACTURE</div>
          <div className="text-sm font-mono text-neutral-700 mt-1">{inv.numero}</div>
          <div className="text-xs text-neutral-500 mt-1">Date : {inv.date}</div>
          <div className="text-xs text-neutral-500">Paiement : {labelPay(inv.paymentMode)}</div>
        </div>
      </div>

      {/* client */}
      <div className="flex justify-between gap-6 py-4">
        <div className="text-xs text-neutral-400 uppercase tracking-wide">
          <div className="mb-1">Facturé à</div>
          <div className="text-sm text-neutral-800 font-semibold normal-case tracking-normal">{inv.client?.name}</div>
          {inv.client?.address && <div className="text-xs text-neutral-500 normal-case">{inv.client.address}</div>}
          <div className="text-xs text-neutral-500 normal-case">{[inv.client?.city, inv.client?.phone].filter(Boolean).join(' · ')}</div>
          {inv.client?.ice && <div className="text-xs text-neutral-500 normal-case">ICE : {inv.client.ice}</div>}
        </div>
      </div>

      {/* lines */}
      <div className="overflow-x-auto -mx-1 px-1 mb-4">
      <table className="w-full text-sm min-w-[19rem]">
        <thead>
          <tr className="bg-neutral-50 text-yf-primary text-xs uppercase">
            <th className="text-left px-2 py-2 rounded-l">Désignation</th>
            <th className="text-right px-2 py-2 w-20">Qté</th>
            <th className="text-center px-2 py-2 w-16">Unité</th>
            <th className="text-right px-2 py-2 w-24">P.U.</th>
            <th className="text-right px-2 py-2 w-28 rounded-r">Montant</th>
          </tr>
        </thead>
        <tbody>
          {(inv.lines || []).map((l, i) => (
            <tr key={i} className="border-b border-neutral-100">
              <td className="px-2 py-1.5 text-neutral-800">{l.name}</td>
              <td className="px-2 py-1.5 text-right">{fmt(l.qty)}</td>
              <td className="px-2 py-1.5 text-center text-neutral-500">{l.uom}</td>
              <td className="px-2 py-1.5 text-right">{fmt(l.unitPrice)}</td>
              <td className="px-2 py-1.5 text-right font-medium">{fmt(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {/* totals */}
      <div className="flex justify-end">
        <div className="w-full max-w-[16rem] text-sm">
          <TR k="Sous-total HT" v={fmt(inv.subtotal)} />
          {inv.discount > 0 && <TR k="Remise" v={'− ' + fmt(inv.discount)} />}
          {inv.tva > 0 && <TR k={`TVA (${inv.tvaRate}%)`} v={fmt(inv.tva)} />}
          {inv.timbre > 0 && <TR k={`Droit de timbre (${inv.timbreRate}%)`} v={fmt(inv.timbre)} />}
          <div className="flex justify-between border-t-2 border-yf-primary mt-1 pt-2 font-bold text-yf-primary text-base">
            <span>Net à payer</span><span>{fmtDH(inv.net)}</span>
          </div>
        </div>
      </div>

      {legalLine && <div className="mt-6 pt-3 border-t border-neutral-100 text-[10px] text-neutral-400 text-center">{legalLine}{seller.rib ? `  ·  RIB: ${seller.rib}` : ''}</div>}
      <div className="mt-2 text-center text-xs text-neutral-500">{seller.footerNote || 'Merci de votre confiance'}</div>
      {inv.notes && <div className="mt-2 text-xs text-neutral-400">Note : {inv.notes}</div>}
    </div>
  );
}
const TR = ({ k, v }) => <div className="flex justify-between py-0.5 text-neutral-600"><span>{k}</span><span>{v}</span></div>;
function labelPay(m) { return ({ espece: 'Espèces', cheque: 'Chèque', virement: 'Virement', credit: 'Crédit', cod: 'Espèces', cash: 'Espèces' }[m] || m); }

// ───────────────────────── RÉGLAGES ─────────────────────────
function Reglages() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/settings').then(d => setS(d.settings)).catch(() => {}); }, []);
  const set = (k, v) => setS(x => ({ ...x, [k]: v }));
  async function save() {
    setBusy(true); setSaved(false);
    try { const d = await api('/settings', { method: 'PATCH', body: s }); setS(d.settings); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    finally { setBusy(false); }
  }
  if (!s) return <Loading />;
  // Appelé comme une FONCTION ({F(...)}), pas comme un composant (<F/>) : sinon
  // React remonte l'input à chaque frappe et le clavier se referme sur mobile.
  const F = (k, label, type = 'text') => (
    <div key={k}>
      <label className="text-xs text-neutral-500">{label}</label>
      <input type={type} inputMode={type === 'number' ? 'decimal' : undefined}
        className="input mt-1" value={s[k] ?? ''} onChange={e => set(k, e.target.value)} />
    </div>
  );
  return (
    <div className="space-y-4 max-w-2xl">
      <h1 className="text-xl font-bold text-yf-primary">Réglages</h1>
      <div className="bg-white rounded-xl border border-neutral-200 p-5 space-y-4">
        <h2 className="font-semibold text-neutral-700">Identité (en-tête facture)</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {F('sellerName', 'Nom / Marque')}
          {F('sellerLegalForm', 'Forme juridique (ex: SARL AU)')}
          {F('sellerAddress', 'Adresse')}
          {F('sellerCity', 'Ville')}
          {F('sellerPhone', 'Téléphone', 'tel')}
          {F('sellerEmail', 'Email', 'email')}
        </div>
        <h2 className="font-semibold text-neutral-700 pt-2">Informations légales</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {F('ice', 'ICE')}{F('ifNo', 'Identifiant Fiscal (IF)')}
          {F('rc', 'Registre de Commerce (RC)')}{F('patente', 'Patente')}
          {F('rib', 'RIB')}{F('bank', 'Banque')}
        </div>
        <h2 className="font-semibold text-neutral-700 pt-2">Taxes</h2>
        <div className="grid sm:grid-cols-3 gap-3">
          {F('tvaRate', 'TVA %', 'number')}
          {F('timbreRate', 'Droit de timbre %', 'number')}
          <div className="flex items-end pb-2"><label className="flex items-center gap-2 text-sm text-neutral-600"><input type="checkbox" checked={s.timbreOnCashOnly !== false} onChange={e => set('timbreOnCashOnly', e.target.checked)} /> Timbre sur espèces uniquement</label></div>
        </div>
        {F('footerNote', 'Note de bas de page')}
        <div className="flex items-center gap-3 pt-2">
          <button onClick={save} disabled={busy} className="btn-primary">{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
          {saved && <span className="text-sm text-yf-primary">✓ Enregistré</span>}
        </div>
      </div>

      {/* gestion d'équipe + journal — visibles du compte principal uniquement
          (le serveur refuse de toute façon les membres avec un 403) */}
      {isOwner() && <UsersSection />}
      {isOwner() && <JournalSection />}
    </div>
  );
}

// ───────────────────────── ÉQUIPE (comptes nommés) ─────────────────────────
function UsersSection() {
  const [rows, setRows] = useState(null);
  const [addNew, setAddNew] = useState(false);
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const load = useCallback(() => {
    api('/settings?entity=users').then(d => setRows(d.rows || [])).catch(() => setRows([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-neutral-700">Équipe {rows && <span className="text-sm font-normal text-neutral-400">({rows.length})</span>}</h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Chaque membre a son propre mot de passe. Ses actions apparaissent à son nom dans le journal —
            plus personne ne travaille sous un nom tapé à la main.
          </p>
        </div>
        <button onClick={() => setAddNew(true)} className={btnPrimary + ' shrink-0'}>+ Membre</button>
      </div>

      {!rows ? <Loading /> : rows.length === 0 ? (
        <Empty msg="Aucun membre. Crée un accès par personne : vendeur, acheteur, facturation, livreur…" />
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase"><tr>
            <th className="text-left px-3 py-2">Membre</th>
            <th className="text-left px-3 py-2">Téléphone</th>
            <th className="w-32"></th>
          </tr></thead>
          <tbody className="divide-y divide-neutral-100">
            {rows.map(m => (
              <tr key={m.userId} className={m.active === 0 ? 'opacity-50' : ''}>
                <td className="px-3 py-2">
                  <div className="font-medium text-neutral-800">{m.name}
                    {m.active === 0 && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600">désactivé</span>}
                  </div>
                  <div className="text-xs text-neutral-400">{m.userId}</div>
                </td>
                <td className="px-3 py-2 text-neutral-500">{m.phone || '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button onClick={() => setEdit(m)} className="px-2.5 py-2 -my-1 text-xs font-medium text-yf-primary hover:underline">Modifier</button>
                  <button onClick={() => setDel(m)} className="ml-1 px-2.5 py-2 -my-1 text-xs text-neutral-400 hover:text-yf-red">Supprimer</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {addNew && <UserForm onDone={() => { setAddNew(false); load(); }} onClose={() => setAddNew(false)} />}
      {edit && <UserForm user={edit} onDone={() => { setEdit(null); load(); }} onClose={() => setEdit(null)} />}
      {del && <ConfirmDelete
        title="Supprimer le membre" what={del.name}
        warning="S'il a déjà des actions au journal, il sera désactivé (il ne peut plus se connecter) et son nom restera lisible dans l'historique."
        onConfirm={() => api(`/settings?entity=users&userId=${encodeURIComponent(del.userId)}`, { method: 'DELETE' })}
        onClose={(changed) => { setDel(null); if (changed) load(); }} />}
    </div>
  );
}

function UserForm({ user, onDone, onClose }) {
  const editing = !!user;
  const [f, setF] = useState({
    name: user?.name || '', phone: user?.phone || '', password: '',
    active: user ? user.active !== 0 : true,
  });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      if (editing) {
        const body = { userId: user.userId, name: f.name, phone: f.phone, active: f.active };
        if (f.password.trim()) body.password = f.password.trim();
        await api('/settings?entity=users', { method: 'PATCH', body });
      } else {
        await api('/settings?entity=users', { method: 'POST', body: f });
      }
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={editing ? `Modifier — ${user.name}` : 'Nouveau membre'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div><label className="text-xs text-neutral-500">Nom *</label>
          <input required className="input mt-1" value={f.name} onChange={e => set('name', e.target.value)} placeholder="Ex: Karim — livraison" /></div>
        <div><label className="text-xs text-neutral-500">Téléphone</label>
          <input type="tel" inputMode="tel" autoComplete="tel" className="input mt-1" value={f.phone} onChange={e => set('phone', e.target.value)} /></div>
        <div>
          <label className="text-xs text-neutral-500">
            {editing ? 'Nouveau mot de passe (laisse vide pour le garder)' : 'Son mot de passe de connexion *'}
          </label>
          <input required={!editing} type={editing ? 'password' : 'text'} className="input mt-1"
            value={f.password} onChange={e => set('password', e.target.value)}
            placeholder={editing ? '••••••' : 'ex: karim-livraison-2026'} autoComplete="new-password" />
          <p className="text-xs text-neutral-400 mt-1">
            C'est SON identifiant : il tape ce mot de passe sur la page de connexion et l'app sait qui il est.
          </p>
        </div>
        {editing && (
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            <input type="checkbox" checked={f.active} onChange={e => set('active', e.target.checked)} />
            Membre actif <span className="text-xs text-neutral-400">(décoché : il ne peut plus se connecter)</span>
          </label>
        )}
        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Enregistrement…' : editing ? 'Enregistrer' : 'Créer le membre'}
        </button>
      </form>
    </Modal>
  );
}

// ───────────────────────── JOURNAL (qui a fait quoi) ─────────────────────────
function JournalSection() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const t = useRef(null);
  const seq = useRef(0);   // ignore une réponse lente arrivée après une plus récente
  const load = useCallback(() => {
    const my = ++seq.current;
    api(`/settings?entity=journal&q=${encodeURIComponent(q)}&page=${page}&limit=50`)
      .then(d => { if (my === seq.current) setData(d); })
      .catch(() => { if (my === seq.current) setData({ rows: [], total: 0, pages: 0 }); });
  }, [q, page]);
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(load, 250); return () => clearTimeout(t.current); }, [load]);
  useEffect(() => { setPage(1); }, [q]);

  const fmtAt = (iso) => {
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Africa/Casablanca', day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }).format(new Date(iso));
    } catch { return iso; }
  };

  return (
    <div className="bg-white rounded-xl border border-neutral-200 p-5 space-y-3">
      <div>
        <h2 className="font-semibold text-neutral-700">Journal {data && <span className="text-sm font-normal text-neutral-400">({data.total})</span>}</h2>
        <p className="text-xs text-neutral-500 mt-0.5">
          Qui a fait quoi, horodaté par le serveur. Les connexions, commandes, achats, prix et factures y sont.
        </p>
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} className="input"
        placeholder="🔍 Filtrer : un nom, une action (facture, achat…), un numéro…" />
      {!data ? <Loading /> : data.rows.length === 0 ? <Empty msg="Rien au journal pour ce filtre." /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase"><tr>
              <th className="text-left px-3 py-2 w-28">Quand</th>
              <th className="text-left px-3 py-2">Qui</th>
              <th className="text-left px-3 py-2">Action</th>
              <th className="text-left px-3 py-2">Sur</th>
            </tr></thead>
            <tbody className="divide-y divide-neutral-100">
              {data.rows.map((l, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 text-neutral-500 whitespace-nowrap">{fmtAt(l.at)}</td>
                  <td className="px-3 py-2 font-medium text-neutral-800">{l.actor}</td>
                  <td className="px-3 py-2"><span className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-700">{l.action}</span></td>
                  <td className="px-3 py-2 text-neutral-600">
                    {l.target}
                    {l.detail && <span className="text-xs text-neutral-400 ml-2">
                      {Object.entries(l.detail).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                    </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.pages > 1 && <Pager page={page} pages={data.pages} onPage={setPage} />}
    </div>
  );
}

// ───────────────────────── FOURNISSEURS (team) ─────────────────────────
const STATUS_BADGE = {
  pending: 'bg-amber-100 text-amber-800', bought: 'bg-sky-100 text-sky-800',
  priced: 'bg-yf-primary/10 text-yf-primary',
  invoiced: 'bg-indigo-100 text-indigo-800', refused: 'bg-rose-100 text-rose-700',
};
const STATUS_LABEL = {
  pending: 'À acheter', bought: 'Acheté — à tarifer', priced: 'Prêt à facturer',
  invoiced: 'Facturé', refused: 'Refusé',
};

function Fournisseurs() {
  const [rows, setRows] = useState(null);
  const [addNew, setAddNew] = useState(false);
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const load = useCallback(() => { api('/suppliers').then(d => setRows(d.rows || [])).catch(() => setRows([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-yf-primary">Fournisseurs {rows && <span className="text-sm font-normal text-neutral-400">({rows.length})</span>}</h1>
        <button onClick={() => setAddNew(true)} className="btn-primary">+ Nouveau fournisseur</button>
      </div>
      <p className="text-sm text-neutral-500">Chaque fournisseur se connecte avec son mot de passe et reçoit les demandes d'achat de ses produits. Assigne les produits dans le <b>Catalogue</b>.</p>
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
        {!rows ? <Loading /> : rows.length === 0 ? <Empty msg="Aucun fournisseur." /> : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase"><tr><th className="text-left px-3 py-2">Fournisseur</th><th className="text-left px-3 py-2">Contact</th><th className="text-right px-3 py-2">Produits</th><th className="w-32"></th></tr></thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map(s => (
                <tr key={s.supplierId} className={s.active === 0 ? 'opacity-50' : ''}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-neutral-800">{s.name}
                      {s.active === 0 && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600">désactivé</span>}
                    </div>
                    <div className="text-xs text-neutral-400">{s.supplierId}</div>
                  </td>
                  <td className="px-3 py-2 text-neutral-500">{[s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold">{s.skuCount ?? 0}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => setEdit(s)} className="px-2.5 py-2 -my-1 text-xs font-medium text-yf-primary hover:underline">Modifier</button>
                    <button onClick={() => setDel(s)} className="ml-1 px-2.5 py-2 -my-1 text-xs text-neutral-400 hover:text-yf-red">Supprimer</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
      {addNew && <NewSupplier onCreated={() => { setAddNew(false); load(); }} onClose={() => setAddNew(false)} />}
      {edit && <NewSupplier supplier={edit} onCreated={() => { setEdit(null); load(); }} onClose={() => setEdit(null)} />}
      {del && <ConfirmDelete
        title="Supprimer le fournisseur" what={del.name}
        warning="S'il a des produits assignés ou des commandes passées, il sera désactivé plutôt que supprimé : il perd son accès mais l'historique reste."
        onConfirm={() => api(`/suppliers?supplierId=${encodeURIComponent(del.supplierId)}`, { method: 'DELETE' })}
        onClose={(changed) => { setDel(null); if (changed) load(); }} />}
    </div>
  );
}

/** Création ET modification d'un fournisseur. */
function NewSupplier({ supplier, onCreated, onClose }) {
  const editing = !!supplier;
  const [f, setF] = useState({
    name: supplier?.name || '', phone: supplier?.phone || '', email: supplier?.email || '',
    password: '', active: supplier ? supplier.active !== 0 : true,
  });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      if (editing) {
        const body = { supplierId: supplier.supplierId, name: f.name, phone: f.phone, email: f.email, active: f.active };
        if (f.password.trim()) body.password = f.password.trim();   // vide = on n'y touche pas
        await api('/suppliers', { method: 'PATCH', body });
      } else {
        await api('/suppliers', { method: 'POST', body: f });
      }
      onCreated();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={editing ? `Modifier — ${supplier.name}` : 'Nouveau fournisseur'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div><label className="text-xs text-neutral-500">Nom *</label><input required className="input mt-1" value={f.name} onChange={e => set('name', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs text-neutral-500">Téléphone</label><input type="tel" inputMode="tel" autoComplete="tel" className="input mt-1" value={f.phone} onChange={e => set('phone', e.target.value)} /></div>
          <div><label className="text-xs text-neutral-500">Email</label><input type="email" inputMode="email" autoComplete="email" className="input mt-1" value={f.email} onChange={e => set('email', e.target.value)} /></div>
        </div>
        <div>
          <label className="text-xs text-neutral-500">
            {editing ? 'Nouveau mot de passe (laisse vide pour le garder)' : 'Mot de passe (pour sa connexion) *'}
          </label>
          <input required={!editing} type={editing ? 'password' : 'text'} className="input mt-1"
            value={f.password} onChange={e => set('password', e.target.value)}
            placeholder={editing ? '••••••' : 'ex: tomate2026'} autoComplete="new-password" />
          {editing && <p className="text-xs text-neutral-400 mt-1">Le mot de passe existant n'est jamais réaffiché — il n'est plus renvoyé par le serveur.</p>}
        </div>
        {editing && (
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            <input type="checkbox" checked={f.active} onChange={e => set('active', e.target.checked)} />
            Fournisseur actif <span className="text-xs text-neutral-400">(décoché : il ne peut plus se connecter)</span>
          </label>
        )}
        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Enregistrement…' : editing ? 'Enregistrer' : 'Créer le fournisseur'}
        </button>
      </form>
    </Modal>
  );
}

// ───────────────────────── COMMANDES (procurement) ─────────────────────────
function Commandes() {
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [newOrder, setNewOrder] = useState(false);
  const [newClient, setNewClient] = useState(false);
  const load = useCallback(() => { api('/orders?limit=50').then(setData).catch(() => setData({ rows: [] })); }, []);
  useEffect(() => { load(); }, [load]);

  if (detail) return <OrderDetail orderId={detail} onBack={() => { setDetail(null); load(); }} />;

  // Get greeting based on time of day
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bon matin' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';
  const userName = getUser();

  return (
    <div className="space-y-4">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Salut {userName}</h1>
        <p className="text-sm text-neutral-500">{greeting}</p>
      </div>

      {/* Hero Cards */}
      <div className="grid grid-cols-2 gap-3">
        <button onClick={() => go('/clients')} className="bg-gradient-to-br from-yf-primary to-blue-600 rounded-2xl p-4 text-white shadow-md hover:shadow-lg transition">
          <div className="flex items-start justify-between">
            <div className="text-left">
              <div className="text-lg font-bold">MES CLIENTS</div>
              <div className="text-xs opacity-90">GESTION DES CLIENTS</div>
            </div>
            <div className="w-12 h-12 rounded-full bg-white/15 flex items-center justify-center text-xl">👥</div>
          </div>
        </button>
        <button onClick={() => go('/reglages')} className="bg-gradient-to-br from-yf-primary to-blue-600 rounded-2xl p-4 text-white shadow-md hover:shadow-lg transition">
          <div className="flex items-start justify-between">
            <div className="text-left">
              <div className="text-lg font-bold">MON PROFIL</div>
              <div className="text-xs opacity-90">GESTION DU PROFIL</div>
            </div>
            <div className="w-12 h-12 rounded-full bg-white/15 flex items-center justify-center text-xl">👤</div>
          </div>
        </button>
      </div>

      {/* Quick Action Tiles */}
      <div className="grid grid-cols-3 gap-2">
        <button onClick={() => setNewClient(true)} className="flex flex-col items-center gap-1 p-3 rounded-lg bg-neutral-50 hover:bg-neutral-100 transition">
          <div className="text-2xl">➕</div>
          <div className="text-xs font-medium text-neutral-600 text-center">Ajouter un client</div>
        </button>
        <button onClick={() => go('/factures')} className="flex flex-col items-center gap-1 p-3 rounded-lg bg-neutral-50 hover:bg-neutral-100 transition">
          <div className="text-2xl">📄</div>
          <div className="text-xs font-medium text-neutral-600 text-center">Facturation</div>
        </button>
        <button onClick={() => go('/po')} className="flex flex-col items-center gap-1 p-3 rounded-lg bg-neutral-50 hover:bg-neutral-100 transition">
          <div className="text-2xl">🛒</div>
          <div className="text-xs font-medium text-neutral-600 text-center">Achats</div>
        </button>
      </div>

      {/* Orders Section */}
      <div className="pt-4 border-t border-neutral-200">
        <h2 className="text-lg font-bold text-neutral-900 mb-3">Commandes récentes</h2>
        <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
          {!data ? <Loading /> : !data.rows.length ? <Empty msg="Aucune commande. Crée la première." /> : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-neutral-500 text-xs uppercase"><tr><th className="text-left px-3 py-2">N°</th><th className="text-left px-3 py-2">Client</th><th className="text-left px-3 py-2">Statut</th><th className="text-right px-3 py-2">Lignes</th><th className="w-16"></th></tr></thead>
              <tbody className="divide-y divide-neutral-100">
                {data.rows.map(o => (
                  <tr key={o.orderId} className="hover:bg-neutral-50">
                    <td className="px-3 py-2 font-mono text-yf-primary">{o.orderId}</td>
                    <td className="px-3 py-2 text-neutral-700">{o.client?.name}</td>
                    <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[o.status]}`}>{STATUS_LABEL[o.status]}</span></td>
                    <td className="px-3 py-2 text-right text-neutral-500">{o.lineCount}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => setDetail(o.orderId)} className="text-xs text-yf-primary hover:underline">Ouvrir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>

      {newOrder && <NewOrder onSaved={id => { setNewOrder(false); load(); setDetail(id); }} onClose={() => setNewOrder(false)} />}
      {newClient && <NewClient onCreated={() => { setNewClient(false); }} onClose={() => setNewClient(false)} />}
    </div>
  );
}

/** Création ET modification d'une commande (tant qu'elle n'est pas facturée). */
function NewOrder({ order, onSaved, onClose }) {
  const editing = !!order;
  const [client, setClient] = useState(order?.client || null);
  const [pickClient, setPickClient] = useState(false);
  const [lines, setLines] = useState(order?.lines || []);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  function addItem(sku) {
    setLines(ls => { const ex = ls.find(l => l.itemId === sku.itemId); return ex ? ls.map(l => l.itemId === sku.itemId ? { ...l, qty: Number(l.qty) + 1 } : l) : [...ls, { itemId: sku.itemId, name: sku.name, uom: sku.uom || 'KG', qty: 1, supplierName: sku.supplierName }]; });
  }
  async function submit() {
    setErr('');
    if (!client) { setErr('Choisis un client.'); return; }
    if (!lines.length) { setErr('Ajoute au moins un produit.'); return; }
    setBusy(true);
    try {
      const d = editing
        ? await api('/orders', { method: 'PATCH', body: { orderId: order.orderId, client, lines } })
        : await api('/orders', { method: 'POST', body: { client, lines } });
      onSaved(d.order.orderId);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={editing ? `Modifier ${order.orderId}` : 'Nouvelle commande'} onClose={onClose} wide>
      {client ? (
        <div className="flex items-center justify-between mb-3 bg-neutral-50 rounded-lg p-3">
          <div><div className="font-semibold text-neutral-800">{client.name}</div><div className="text-xs text-neutral-500">{client.city}</div></div>
          <button onClick={() => setPickClient(true)} className="btn-ghost">Changer</button>
        </div>
      ) : <button onClick={() => setPickClient(true)} className={btnPrimary + ' mb-3'}>+ Choisir le client</button>}
      <ItemSearch onAdd={addItem} />
      <div className="mt-3 border border-neutral-100 rounded-lg divide-y divide-neutral-100 max-h-64 overflow-y-auto">
        {lines.length === 0 ? <Empty msg="Aucun produit. Cherche ci-dessus." /> : lines.map(l => (
          <div key={l.itemId} className="flex items-center gap-2 px-3 py-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-800 truncate">{l.name}</div>
              <div className="text-xs text-neutral-400">
                {l.supplierName && l.supplierName !== 'Non assigné' ? `→ ${l.supplierName}` : `${l.uom.toLowerCase()}`}
                {l.poRef && <span className="ml-2 text-amber-600">· déjà acheté ({l.poRef})</span>}
              </div>
            </div>
            <input type="number" min="0" step="any" inputMode="decimal" value={l.qty} onChange={e => setLines(ls => ls.map(x => x.itemId === l.itemId ? { ...x, qty: e.target.value } : x))} className="w-20 border border-neutral-200 rounded px-2 py-2 text-right" />
            <span className="text-xs text-neutral-400 w-8">{l.uom}</span>
            {l.poRef
              ? <span className="text-neutral-200 w-8 text-center shrink-0" title="Marchandise déjà achetée — ligne verrouillée">🔒</span>
              : <button onClick={() => setLines(ls => ls.filter(x => x.itemId !== l.itemId))} aria-label="Retirer" className="text-neutral-400 hover:text-yf-red w-8 h-8 shrink-0 text-lg leading-none">×</button>}
          </div>
        ))}
      </div>
      {err && <p className="text-sm text-yf-red mt-2">✗ {err}</p>}
      <button onClick={submit} disabled={busy} className={btnPrimary + ' w-full justify-center mt-4'}>
        {busy ? 'Envoi…' : editing ? 'Enregistrer les modifications' : '📤 Envoyer aux fournisseurs'}
      </button>
      {pickClient && <ClientPicker onPick={c => { setClient(c); setPickClient(false); }} onClose={() => setPickClient(false)} />}
    </Modal>
  );
}

function OrderDetail({ orderId, onBack }) {
  const [o, setO] = useState(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [price, setPrice] = useState({});      // prix de vente en cours de saisie
  const [warn, setWarn] = useState([]);
  const load = useCallback(() => { api('/orders?id=' + encodeURIComponent(orderId)).then(d => setO(d.order)).catch(e => setErr(e.message)); }, [orderId]);
  // On suspend le rafraîchissement pendant une saisie : sinon la commande
  // rechargée écrase ce qui est en train d'être tapé.
  const typing = edit || Object.keys(price).length > 0;
  useEffect(() => { load(); if (typing) return; const t = setInterval(load, 8000); return () => clearInterval(t); }, [load, typing]);

  /** Prix de vente suggéré : coût réellement payé × marge du produit. */
  const sugg = (l) => Math.round((Number(l.cost) || 0) * (Number(l.margin) || 1.5) * 100) / 100;
  const applyMargin = () => {
    setWarn([]);
    setPrice(Object.fromEntries((o?.lines || [])
      .filter(l => l.cost != null && l.status !== 'refused')
      .map(l => [l.itemId, String(sugg(l))])));
  };
  const total = (o?.lines || []).reduce((s, l) => {
    const cp = price[l.itemId] ?? l.clientPrice;
    return s + (cp == null || cp === '' ? 0 : Number(cp) * l.qty);
  }, 0);

  async function savePrices() {
    setBusy(true); setErr(''); setWarn([]);
    try {
      const prices = Object.entries(price).map(([itemId, clientPrice]) => ({ itemId, clientPrice }));
      const r = await api('/orders', { method: 'PATCH', body: { orderId, prices } });
      setPrice({}); setO(r.order); setWarn(r.belowCost || []);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function invoice() {
    setBusy(true); setErr('');
    // ?action=invoice — /api/orders/invoice n'existe pas comme fonction et renvoie 404
    try { const d = await api('/orders?action=invoice', { method: 'POST', body: { orderId } }); go('/facture/' + d.invoice.numero); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  if (err && !o) return <div><button onClick={onBack} className="text-sm text-neutral-500 mb-3">← Commandes</button><Empty msg={'✗ ' + err} /></div>;
  if (!o) return <Loading />;
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-neutral-500 hover:text-neutral-800">← Commandes</button>
      <div className="flex items-center justify-between gap-3">
        <div><h1 className="text-xl font-bold text-yf-primary">{o.orderId}</h1><div className="text-sm text-neutral-500">{o.client?.name} · {o.client?.city}</div></div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs px-2.5 py-1 rounded-full ${STATUS_BADGE[o.status]}`}>{STATUS_LABEL[o.status]}</span>
          {!o.invoiceNo && <>
            <button onClick={() => setEdit(true)} className="btn-ghost">Modifier</button>
            <button onClick={() => setDel(true)} className="text-xs text-neutral-400 hover:text-yf-red px-2">Supprimer</button>
          </>}
        </div>
      </div>
      {/* Une carte par ligne : sur téléphone les champs s'empilent au lieu de
          déborder hors de l'écran (le tableau était coupé à droite). */}
      <div className="space-y-2">
        {o.lines.map(l => {
          const cp = price[l.itemId] ?? (l.clientPrice ?? '');
          const cpn = cp === '' ? null : Number(cp);
          const marge = (cpn != null && l.cost > 0) ? cpn / l.cost : null;
          const editable = l.cost != null && !o.invoiceNo;
          return (
            <div key={l.itemId} className={`bg-white rounded-xl border border-neutral-200 p-3 ${l.status === 'refused' ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-neutral-800 leading-tight">{l.name}</div>
                  {l.supplierName && l.supplierName !== 'Non assigné' && <div className="text-xs text-neutral-400">{l.supplierName}</div>}
                </div>
                <div className="text-sm text-neutral-500 whitespace-nowrap shrink-0">{fmt(l.qty)} {l.uom}</div>
              </div>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-neutral-400">Coût payé</div>
                  {l.cost != null
                    ? <div className="font-medium text-neutral-700">{fmt(l.cost)} DH</div>
                    : <div className="text-xs text-amber-600">pas encore acheté</div>}
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-neutral-400">Prix client</div>
                  {editable ? (
                    <input type="number" min="0" step="any" inputMode="decimal"
                      value={cp} onChange={e => setPrice(s => ({ ...s, [l.itemId]: e.target.value }))}
                      placeholder={fmt(sugg(l))}
                      className="w-full border border-neutral-300 rounded px-2 py-1.5 text-right font-semibold text-yf-primary" />
                  ) : (
                    <div className="font-semibold text-yf-primary">{l.clientPrice != null ? fmt(l.clientPrice) + ' DH' : '—'}</div>
                  )}
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-neutral-400">Marge</div>
                  <div className={`text-sm ${marge != null && marge < 1 ? 'text-yf-red font-semibold' : 'text-neutral-600'}`}>
                    {marge != null ? '×' + marge.toFixed(2) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-neutral-400">Total ligne</div>
                  <div className="font-semibold text-neutral-800">{cpn != null ? fmtDH(cpn * l.qty) : '—'}</div>
                </div>
              </div>
            </div>
          );
        })}
        {!o.invoiceNo && total > 0 && (
          <div className="flex items-center justify-between bg-neutral-50 border border-neutral-200 rounded-xl px-4 py-3 font-semibold">
            <span className="text-neutral-600">Total commande</span>
            <span className="text-yf-primary text-lg">{fmtDH(total)}</span>
          </div>
        )}
      </div>

      {o.status === 'bought' || (o.status === 'priced' && !o.invoiceNo) ? (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={applyMargin} className="btn-ghost">Appliquer la marge du catalogue</button>
          <button onClick={savePrices} disabled={busy} className="btn-primary">
            {busy ? 'Enregistrement…' : '💾 Enregistrer les prix'}
          </button>
          {warn.length > 0 && (
            <span className="text-xs text-yf-red">⚠ sous le prix d'achat : {warn.join(', ')}</span>
          )}
        </div>
      ) : null}

      {err && <p className="text-sm text-yf-red">✗ {err}</p>}
      {o.status === 'priced' && <button onClick={invoice} disabled={busy} className="btn-primary">{busy ? 'Génération…' : '🧾 Générer la facture'}</button>}
      {o.status === 'pending' && (
        <p className="text-sm text-amber-600">
          ⏳ En attente de l'achat. L'équipe achat saisit le prix payé dans <b>PO Calculation</b> — le coût arrivera ici tout seul.
        </p>
      )}
      {o.invoiceNo && <button onClick={() => go('/facture/' + o.invoiceNo)} className="btn-ghost">Voir la facture {o.invoiceNo}</button>}

      {edit && <NewOrder order={o} onSaved={() => { setEdit(false); load(); }} onClose={() => setEdit(false)} />}
      {del && <ConfirmDelete
        title="Supprimer la commande" what={o.orderId}
        warning="Une commande déjà facturée ou dont la marchandise est déjà achetée ne peut pas être supprimée — le serveur le refusera en expliquant pourquoi."
        onConfirm={() => api(`/orders?orderId=${encodeURIComponent(o.orderId)}`, { method: 'DELETE' })}
        onClose={(gone) => { setDel(false); if (gone) onBack(); }} />}
    </div>
  );
}

// ───────────────────────── MARQUE DU CLIENT ─────────────────────────
/** Logo + nom du client connecté. Retombe sur la marque de la plateforme
 *  tant qu'aucun logo n'a été téléversé. */
function TenantMark({ size = 34, stacked = false }) {
  const t = getTenant();
  if (!t.logo && !t.name) return <Logo size={size} />;
  return (
    <span className={`inline-flex ${stacked ? 'flex-col' : 'items-center'} gap-2`} style={{ alignItems: stacked ? 'center' : undefined }}>
      {t.logo
        ? <img src={t.logo} alt={t.name || ''} style={{ height: size, width: 'auto', maxWidth: size * 4, objectFit: 'contain' }} />
        : <Logo size={size} withWordmark={false} />}
      {!t.logo && <span className="font-extrabold text-yf-primary" style={{ fontSize: size * 0.5 }}>{t.name}</span>}
    </span>
  );
}

// ───────────────────────── ESPACE PLATEFORME (admin) ─────────────────────────
const MB = b => (Number(b || 0) / 1048576).toFixed(1);

function AdminApp() {
  const [stats, setStats] = useState(null);
  const [addNew, setAddNew] = useState(false);
  const [edit, setEdit] = useState(null);
  const [archive, setArchive] = useState(null);
  const [del, setDel] = useState(null);
  const [pwd, setPwd] = useState(false);
  const [activity, setActivity] = useState(null);   // client dont on regarde le graphe
  const load = useCallback(() => {
    api('/admin?action=stats').then(setStats).catch(() => setStats({ tenants: [], tables: [] }));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Facturation d'Akram : il gagne `ratePerKg` DH par kg facturé chez ses clients.
  const rate = stats?.ratePerKg || 0;
  const monthKgTotal = (stats?.tenants || []).reduce((s, t) => s + (t.monthKg || 0), 0);
  const monthEarn = monthKgTotal * rate;
  const monthLabel = stats?.monthFrom
    ? new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date(stats.monthFrom + 'T00:00:00'))
    : '';

  const pct = stats?.pct ?? 0;
  const bar = pct > 80 ? 'bg-rose-500' : pct > 50 ? 'bg-citrus-500' : 'bg-brand-500';
  // projection : à ce rythme, dans combien de temps la limite est-elle atteinte
  const perYear = stats ? (stats.avgDocBytes || 700) * 2 * 50 * 300 : 0;   // ~50 docs/j/client
  const nT = stats?.tenants?.length || 1;
  const years = stats ? Math.max(0, (stats.quota - stats.used)) / (perYear * nT) : 0;

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3"><Logo size={32} />
            <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-800 text-white">plateforme</span></div>
          <button onClick={logout} className="text-xs text-neutral-400 hover:text-yf-red">Quitter</button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        {/* ── mon accès ── */}
        {stats && !stats.ownPassword && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
            <span className="text-lg leading-none">⚠</span>
            <div className="flex-1 text-sm text-amber-900">
              <b>Choisis ton propre mot de passe.</b> Tu utilises encore celui qui t'a été remis à
              l'installation. Dès que tu en choisis un, l'ancien cesse d'être accepté.
            </div>
            <button onClick={() => setPwd(true)}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold">
              Le changer
            </button>
          </div>
        )}

        <div className="bg-white rounded-xl border border-neutral-200 p-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold text-neutral-800">Mon accès — super-admin</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Cet écran n'est visible qu'avec ce mot de passe. Les clients, eux, entrent le leur et
              ne voient que leur propre espace.
            </p>
          </div>
          <button onClick={() => setPwd(true)} className={btnGhost + ' shrink-0'}>
            {stats?.ownPassword ? 'Changer mon mot de passe' : 'Choisir mon mot de passe'}
          </button>
        </div>

        {/* ── ma facturation (au KG) ── */}
        {stats && (
          <div className="bg-gradient-to-br from-yf-primary to-yf-primary text-white rounded-xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">Ma facturation — {monthLabel}</h2>
                <p className="text-xs text-white/70 mt-0.5">Je facture mes clients au kilo passé dans l'app.</p>
              </div>
              <RateEditor rate={rate} onSaved={load} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4">
              <div>
                <div className="text-xs text-white/70">Tonnage facturé ce mois</div>
                <div className="text-2xl font-bold">{fmt(monthKgTotal)} <span className="text-sm font-normal">kg</span></div>
                <div className="text-xs text-white/60">{fmt(monthKgTotal / 1000)} tonnes · {stats.tenants.length} client{stats.tenants.length > 1 ? 's' : ''}</div>
              </div>
              <div>
                <div className="text-xs text-white/70">Ce que je gagne</div>
                <div className="text-2xl font-bold">{rate > 0 ? fmtDH(monthEarn) : '—'}</div>
                <div className="text-xs text-white/60">{rate > 0 ? `${fmt(monthKgTotal)} kg × ${fmt(rate)} DH` : 'définis ton tarif →'}</div>
              </div>
              <div className="hidden sm:block">
                <div className="text-xs text-white/70">CA total des clients</div>
                <div className="text-2xl font-bold">{fmtDH((stats.tenants || []).reduce((s, t) => s + (t.monthCa || 0), 0))}</div>
                <div className="text-xs text-white/60">ce qu'ils ont vendu via l'app</div>
              </div>
            </div>
          </div>
        )}

        {/* ── stockage ── */}
        <div className="bg-white rounded-xl border border-neutral-200 p-4">
          <div className="flex items-end justify-between mb-2">
            <div>
              <h2 className="font-semibold text-neutral-800">Stockage</h2>
              <p className="text-xs text-neutral-500">Base Neon — offre gratuite 500 Mo</p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-yf-primary">{stats ? MB(stats.used) : '—'} Mo</div>
              <div className="text-xs text-neutral-500">sur {stats ? MB(stats.quota) : '—'} Mo · {pct}%</div>
            </div>
          </div>
          <div className="h-3 rounded-full bg-neutral-100 overflow-hidden">
            <div className={`h-full ${bar} transition-all`} style={{ width: `${Math.min(100, Math.max(1, pct))}%` }} />
          </div>
          {stats && (
            <p className="text-xs text-neutral-500 mt-2">
              {pct < 60
                ? <>À ce rythme, la limite ne serait atteinte que dans <b>~{years < 1 ? Math.round(years * 12) + ' mois' : Math.round(years) + ' ans'}</b> avec {nT} client{nT > 1 ? 's' : ''}. Rien à archiver pour l'instant.</>
                : <>Il est temps d'archiver les données de plus de 90 jours (bouton sur chaque client).</>}
            </p>
          )}
          {stats?.tables?.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-neutral-400 cursor-pointer">détail par table</summary>
              <div className="mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-500">
                {stats.tables.map(t => (
                  <div key={t.name} className="flex justify-between">
                    <span>{t.name.replace('dima_', '')}</span>
                    <span>{t.rows} lignes · {MB(t.bytes)} Mo</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        {/* ── clients ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-yf-primary">Clients de la plateforme</h1>
            <p className="text-sm text-neutral-500">Chaque client a son propre catalogue, ses clients et ses factures — invisibles des autres.</p>
          </div>
          <button onClick={() => setAddNew(true)} className="btn-primary">+ Nouveau client</button>
        </div>

        {!stats ? <Loading /> : !stats.tenants.length ? <Empty msg="Aucun client. Crée le premier." /> : (
          <div className="space-y-3">
            {stats.tenants.map(t => (
              <div key={t.tenantId} className="bg-white rounded-xl border border-neutral-200 p-4">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-lg bg-neutral-50 border border-neutral-100 flex items-center justify-center overflow-hidden shrink-0">
                    {t.logo ? <img src={t.logo} alt="" className="max-w-full max-h-full object-contain" />
                            : <span className="text-2xl font-bold text-neutral-300">{(t.name || '?')[0]}</span>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-neutral-800 truncate">{t.name}</span>
                      {!t.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600">désactivé</span>}
                    </div>
                    <div className="text-xs text-neutral-400">{t.tenantId}</div>
                    <div className="text-xs text-neutral-500 mt-1">
                      {t.skus} produits · {t.clients} clients · {t.orders} commandes · {t.invoices} factures · {MB(t.bytes)} Mo
                    </div>
                    <div className="text-xs mt-1">
                      <span className="text-yf-primary font-semibold">{fmt(t.monthKg || 0)} kg</span>
                      <span className="text-neutral-400"> facturés ce mois · {fmtDH(t.monthCa || 0)} de ventes</span>
                      {rate > 0 && <span className="text-neutral-500"> · me rapporte <b>{fmtDH((t.monthKg || 0) * rate)}</b></span>}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button onClick={() => setActivity(t)} className={btnPrimary + ' text-xs'}>📊 Activité</button>
                    <button onClick={() => setEdit(t)} className="btn-ghost">Modifier</button>
                    <button onClick={() => setArchive(t)} className="text-xs text-neutral-500 hover:text-yf-primary px-3">Archiver</button>
                    <button onClick={() => setDel(t)} className="text-xs text-neutral-400 hover:text-yf-red px-3">Supprimer</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {addNew && <TenantForm onDone={() => { setAddNew(false); load(); }} onClose={() => setAddNew(false)} />}
      {edit && <TenantForm tenant={edit} onDone={() => { setEdit(null); load(); }} onClose={() => setEdit(null)} />}
      {archive && <ArchiveModal tenant={archive} minAgeDays={stats?.minAgeDays ?? 30} onDone={() => { setArchive(null); load(); }} onClose={() => setArchive(null)} />}
      {del && <DeleteTenantModal tenant={del} onDone={() => { setDel(null); load(); }} onClose={() => setDel(null)} />}
      {pwd && <PasswordModal onDone={() => { setPwd(false); load(); }} onClose={() => setPwd(false)} />}
      {activity && <ActivityModal tenant={activity} onClose={() => setActivity(null)} />}
    </div>
  );
}

/** Le tarif au KG d'Akram, éditable en place dans la carte facturation. */
function RateEditor({ rate, onSaved }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(String(rate || ''));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV(String(rate || '')); }, [rate]);
  async function save() {
    setBusy(true);
    try { await api('/admin?action=billing', { method: 'PATCH', body: { ratePerKg: Number(v) || 0 } }); setEdit(false); onSaved(); }
    finally { setBusy(false); }
  }
  if (!edit) return (
    <button onClick={() => setEdit(true)} className="text-right group">
      <div className="text-xs text-white/70">Mon tarif</div>
      <div className="text-lg font-bold group-hover:underline">{rate > 0 ? `${fmt(rate)} DH / kg` : 'définir →'}</div>
    </button>
  );
  return (
    <div className="flex items-center gap-2 bg-white/10 rounded-lg p-2">
      <input type="number" step="0.001" min="0" autoFocus value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && save()}
        className="w-24 px-2 py-1 rounded text-neutral-900 text-sm text-right" />
      <span className="text-xs text-white/80">DH / kg</span>
      <button onClick={save} disabled={busy} className="text-xs px-2 py-1 rounded bg-white text-yf-primary font-semibold">{busy ? '…' : 'OK'}</button>
    </div>
  );
}

/** Graphe d'activité d'un client : tonnage + CA par jour, avec les totaux. */
function ActivityModal({ tenant, onClose }) {
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    api(`/admin?action=analytics&tenant=${encodeURIComponent(tenant.tenantId)}&days=${days}`)
      .then(setD).catch(() => setD({ daily: [], totals: { kg: 0, ca: 0, kgOrd: 0, invoices: 0, orders: 0, otherUnits: {} }, ratePerKg: 0 }));
  }, [days, tenant]);

  const T = d?.totals;
  const rate = d?.ratePerKg || 0;
  const other = T?.otherUnits && Object.keys(T.otherUnits).length
    ? Object.entries(T.otherUnits).map(([u, n]) => `${fmt(n)} ${u.toLowerCase()}`).join(' · ') : null;

  return (
    <Modal title={`Activité — ${tenant.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex gap-1 no-print">
          {[[30, '30 j'], [90, '90 j'], [180, '6 mois'], [365, '1 an']].map(([n, l]) => (
            <button key={n} onClick={() => setDays(n)}
              className={`text-xs px-3 py-1.5 rounded-lg ${days === n ? 'bg-yf-primary/10 text-yf-primary font-semibold' : 'bg-neutral-100 text-neutral-600'}`}>{l}</button>
          ))}
        </div>

        {!d ? <Loading /> : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatBox k="Tonnage facturé" v={`${fmt(T.kg)} kg`} sub={`${fmt(T.kg / 1000)} t`} strong />
              <StatBox k="Ce qu'ils ont gagné" v={fmtDH(T.ca)} sub={`${T.invoices} facture${T.invoices > 1 ? 's' : ''}`} />
              <StatBox k="Tonnage commandé" v={`${fmt(T.kgOrd)} kg`} sub={`${T.orders} commande${T.orders > 1 ? 's' : ''} placée${T.orders > 1 ? 's' : ''}`} />
              <StatBox k="Me rapporte" v={rate > 0 ? fmtDH(T.kg * rate) : '—'} sub={rate > 0 ? `${fmt(T.kg)} kg × ${fmt(rate)} DH` : 'définis ton tarif'} accent />
            </div>

            {other && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                En plus du poids : <b>{other}</b> — produits vendus à la botte/pièce, sans équivalent en kilos, non comptés dans le tonnage.
              </p>
            )}

            <DayChart daily={d.daily} />

            <p className="text-xs text-neutral-400">
              Le tonnage facturé (barres) est la base de ta facturation. Le chiffre d'affaires (ligne) est ce que
              le client a vendu à ses propres clients via l'app. Les factures annulées sont exclues.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

function StatBox({ k, v, sub, strong, accent }) {
  return (
    <div className={`rounded-xl border p-3 ${accent ? 'bg-neutral-50 border-brand-200' : 'bg-neutral-50 border-neutral-100'}`}>
      <div className="text-xs text-neutral-500">{k}</div>
      <div className={`font-bold ${strong || accent ? 'text-xl text-yf-primary' : 'text-lg text-neutral-800'}`}>{v}</div>
      {sub && <div className="text-[11px] text-neutral-400">{sub}</div>}
    </div>
  );
}

/** Barres = tonnage facturé/jour (kg) · ligne = CA/jour (DH). SVG autonome. */
function DayChart({ daily }) {
  if (!daily || !daily.length) return <Empty msg="Aucune activité sur la période." />;
  const W = 720, H = 220, padL = 44, padR = 44, padT = 12, padB = 28;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxKg = Math.max(1, ...daily.map(x => x.kg));
  const maxCa = Math.max(1, ...daily.map(x => x.ca));
  const n = daily.length;
  const bw = Math.max(1, (iw / n) * 0.7);
  const x = i => padL + (iw / n) * (i + 0.5);
  const yKg = v => padT + ih - (v / maxKg) * ih;
  const yCa = v => padT + ih - (v / maxCa) * ih;
  const caPts = daily.map((p, i) => `${x(i)},${yCa(p.ca)}`).join(' ');
  // ticks de date : ~6 étiquettes réparties
  const step = Math.max(1, Math.round(n / 6));
  const fmtDay = s => { const [, m, dd] = s.split('-'); return `${dd}/${m}`; };
  const nice = v => v >= 1000 ? Math.round(v / 100) / 10 + 'k' : Math.round(v);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 340 }} role="img" aria-label="Tonnage et CA par jour">
        {/* grille horizontale + axe kg (gauche) */}
        {[0, 0.5, 1].map(f => {
          const y = padT + ih - f * ih;
          return (
            <g key={f}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="9" fill="#16a34a">{nice(f * maxKg)}</text>
              <text x={W - padR + 6} y={y + 3} textAnchor="start" fontSize="9" fill="#d97706">{nice(f * maxCa)}</text>
            </g>
          );
        })}
        {/* barres tonnage */}
        {daily.map((p, i) => p.kg > 0 && (
          <rect key={i} x={x(i) - bw / 2} y={yKg(p.kg)} width={bw} height={padT + ih - yKg(p.kg)}
            fill="#16a34a" opacity="0.85" rx="1">
            <title>{fmtDay(p.date)} — {fmt(p.kg)} kg · {fmtDH(p.ca)}</title>
          </rect>
        ))}
        {/* ligne CA */}
        <polyline points={caPts} fill="none" stroke="#d97706" strokeWidth="1.5" opacity="0.9" />
        {/* étiquettes de date */}
        {daily.map((p, i) => (i % step === 0 || i === n - 1) && (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="#94a3b8">{fmtDay(p.date)}</text>
        ))}
      </svg>
      <div className="flex gap-4 text-xs text-neutral-500 justify-center">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-2 rounded-sm bg-yf-primary" /> tonnage (kg)</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-citrus-600" /> chiffre d'affaires (DH)</span>
      </div>
    </div>
  );
}

/** Le propriétaire choisit son mot de passe super-admin lui-même. */
function PasswordModal({ onDone, onClose }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [ok, setOk] = useState(false);
  const mismatch = f.confirm && f.next !== f.confirm;

  async function save() {
    setBusy(true); setErr('');
    try {
      await api('/admin?action=password', { method: 'PATCH', body: { current: f.current, next: f.next } });
      setOk(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (ok) return (
    <Modal title="Mot de passe changé" onClose={onDone}>
      <div className="space-y-3">
        <div className="bg-neutral-50 border border-brand-200 rounded-lg p-3 text-sm text-yf-primary">
          ✓ C'est fait. L'ancien mot de passe n'ouvre plus rien — utilise le nouveau à la prochaine
          connexion. Note-le : personne ne peut te le rappeler.
        </div>
        <button onClick={onDone} className="btn-primary w-full">Fermer</button>
      </div>
    </Modal>
  );

  return (
    <Modal title="Mon mot de passe super-admin" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-neutral-500">Mot de passe actuel</label>
          <input type="password" autoComplete="current-password" className="input mt-1"
            value={f.current} onChange={e => setF({ ...f, current: e.target.value })} />
        </div>
        <div>
          <label className="text-xs text-neutral-500">Nouveau mot de passe (8 caractères minimum)</label>
          <input type="password" autoComplete="new-password" className="input mt-1"
            value={f.next} onChange={e => setF({ ...f, next: e.target.value })} />
        </div>
        <div>
          <label className="text-xs text-neutral-500">Confirme le nouveau mot de passe</label>
          <input type="password" autoComplete="new-password" className="input mt-1"
            value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })} />
          {mismatch && <p className="text-xs text-yf-red mt-1">Les deux saisies diffèrent.</p>}
        </div>
        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <button onClick={save} disabled={busy || !f.current || f.next.length < 8 || mismatch}
          className={btnPrimary + ' w-full justify-center disabled:opacity-40'}>
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </Modal>
  );
}

/** Archivage : export CSV (pour Google Sheets) puis purge du plus ancien. */
function ArchiveModal({ tenant, minAgeDays, onDone, onClose }) {
  const maxDate = new Date(Date.now() - minAgeDays * 86400000).toISOString().slice(0, 10);
  const [before, setBefore] = useState(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [done, setDone] = useState(null);

  async function check() {
    setBusy(true); setErr(''); setDone(null);
    try { setPreview(await api('/admin?action=archive', { method: 'POST', body: { tenant: tenant.tenantId, before } })); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  function download() {
    const url = `/api/admin?action=export&tenant=${encodeURIComponent(tenant.tenantId)}&before=${before}`;
    fetch(url, { headers: { 'x-auth-token': getToken() } })
      .then(r => r.blob()).then(b => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = `archive-${tenant.tenantId}-avant-${before}.csv`;
        a.click(); URL.revokeObjectURL(a.href);
      }).catch(() => setErr('Téléchargement impossible'));
  }
  async function purge() {
    if (!confirm(`Supprimer définitivement les données de ${tenant.name} antérieures au ${before} ?\n\nTélécharge d'abord le CSV — cette suppression est irréversible.`)) return;
    setBusy(true); setErr('');
    try { setDone(await api('/admin?action=archive', { method: 'POST', body: { tenant: tenant.tenantId, before, dryRun: false, confirm: true } })); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Archiver — ${tenant.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">
          Exporte les anciennes commandes et factures en CSV (à importer dans Google Sheets),
          puis libère l'espace en base. Les données récentes ne sont jamais touchées.
        </p>
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
          Les factures doivent rester tant qu'elles peuvent être encaissées, et la loi marocaine
          impose de conserver les pièces comptables <b>10 ans</b> : garde le CSV en lieu sûr.
          Rien de plus récent que <b>{minAgeDays} jours</b> ne peut être purgé.
        </div>
        <div>
          <label className="text-xs text-neutral-500">Archiver tout ce qui est antérieur au</label>
          <input type="date" max={maxDate} value={before} onChange={e => { setBefore(e.target.value); setPreview(null); setDone(null); }}
            className="input mt-1" />
        </div>

        {!preview && !done && <button onClick={check} disabled={busy} className="btn-primary w-full">
          {busy ? 'Analyse…' : '1. Voir ce qui serait archivé'}</button>}

        {preview && !done && (
          <div className="space-y-3">
            {preview.archived === 0 ? (
              <p className="text-sm text-neutral-500">{preview.message}</p>
            ) : (
              <>
                <div className="bg-neutral-50 rounded-lg p-3 text-sm">
                  <b>{preview.wouldArchive?.lignes ?? 0} lignes</b> — {preview.wouldArchive?.orders ?? 0} commandes,
                  {' '}{preview.wouldArchive?.invoices ?? 0} factures, {preview.wouldArchive?.po ?? 0} bons d'achat
                </div>
                <button onClick={download} className={btnGhost + ' w-full justify-center'}>2. Télécharger le CSV</button>
                <button onClick={purge} disabled={busy} className="w-full px-4 py-2.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-sm font-semibold">
                  {busy ? 'Suppression…' : '3. Supprimer de la base (irréversible)'}
                </button>
              </>
            )}
          </div>
        )}

        {done && <div className="bg-neutral-50 border border-brand-200 rounded-lg p-3 text-sm text-yf-primary">
          ✓ Archivé : {done.archived?.orders ?? 0} commandes, {done.archived?.invoices ?? 0} factures, {done.archived?.po ?? 0} bons d'achat.
          <button onClick={onDone} className="block mt-2 text-yf-primary underline">Fermer</button>
        </div>}

        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
      </div>
    </Modal>
  );
}

function DeleteTenantModal({ tenant, onDone, onClose }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function remove() {
    setBusy(true); setErr('');
    try {
      await api(`/admin?tenant=${encodeURIComponent(tenant.tenantId)}&confirm=${encodeURIComponent(name)}`, { method: 'DELETE' });
      onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={`Supprimer ${tenant.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-800">
          Cette action efface <b>définitivement</b> tout ce qui appartient à ce client :
          son catalogue ({tenant.skus} produits), ses {tenant.clients} clients,
          ses {tenant.orders} commandes et ses {tenant.invoices} factures.
          <br /><br />
          Si tu veux seulement lui couper l'accès, utilise plutôt <b>Modifier → décocher « Client actif »</b>.
        </div>
        <div>
          <label className="text-xs text-neutral-500">Retape le nom exact pour confirmer : <b>{tenant.name}</b></label>
          <input className="input mt-1" value={name} onChange={e => setName(e.target.value)} placeholder={tenant.name} />
        </div>
        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <button onClick={remove} disabled={busy || name !== tenant.name}
          className="w-full px-4 py-2.5 rounded-lg bg-yf-red text-white font-semibold text-sm disabled:opacity-40">
          {busy ? 'Suppression…' : 'Supprimer définitivement'}
        </button>
      </div>
    </Modal>
  );
}

/** Lit un fichier image en data URI, redimensionné pour rester léger. */
function fileToDataUrl(file, max = 320) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function TenantForm({ tenant, onDone, onClose }) {
  const editing = !!tenant;
  const [f, setF] = useState({
    name: tenant?.name || '', password: '', logo: tenant?.logo || '',
    active: tenant ? !!tenant.active : true, seedCatalogue: true,
  });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  async function pickLogo(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (!/^image\//.test(file.type)) { setErr('Choisis une image'); return; }
    try { set('logo', await fileToDataUrl(file)); setErr(''); }
    catch { setErr('Image illisible'); }
  }
  async function save(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      if (editing) {
        const body = { tenantId: tenant.tenantId, name: f.name, logo: f.logo, active: f.active };
        if (f.password.trim()) body.password = f.password.trim();
        await api('/tenants', { method: 'PATCH', body });
      } else {
        await api('/tenants', { method: 'POST', body: f });
      }
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title={editing ? `Modifier ${tenant.name}` : 'Nouveau client'} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div>
          <label className="text-xs text-neutral-500">Nom du client *</label>
          <input required className="input mt-1" value={f.name}
            onChange={e => set('name', e.target.value)} placeholder="Ex : Salim" />
        </div>

        <div>
          <label className="text-xs text-neutral-500">Logo</label>
          <div className="mt-1 flex items-center gap-3">
            <div className="w-20 h-20 rounded-lg bg-neutral-50 border border-neutral-200 flex items-center justify-center overflow-hidden shrink-0">
              {f.logo ? <img src={f.logo} alt="" className="max-w-full max-h-full object-contain" />
                      : <span className="text-xs text-neutral-400">aucun</span>}
            </div>
            <div className="space-y-1">
              <input type="file" accept="image/*" onChange={pickLogo} className="text-xs" />
              {f.logo && <button type="button" onClick={() => set('logo', '')} className="block text-xs text-neutral-400 hover:text-yf-red">Retirer</button>}
              <p className="text-[11px] text-neutral-400">Apparaît dans l'app et sur ses factures.</p>
            </div>
          </div>
        </div>

        <div>
          <label className="text-xs text-neutral-500">Mot de passe {editing ? '(laisser vide pour ne pas changer)' : '*'}</label>
          <input required={!editing} className="input mt-1" value={f.password}
            onChange={e => set('password', e.target.value)} placeholder="6 caractères minimum" />
          <p className="text-[11px] text-neutral-400 mt-1">C'est avec ça que son équipe se connecte.</p>
        </div>

        {!editing && (
          <label className="flex items-start gap-2 text-sm text-neutral-600">
            <input type="checkbox" className="mt-0.5" checked={f.seedCatalogue}
              onChange={e => set('seedCatalogue', e.target.checked)} />
            <span>Pré-remplir son catalogue avec la bibliothèque (945 produits, qu'il peut ensuite renommer, retarifer ou supprimer)</span>
          </label>
        )}
        {editing && (
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            <input type="checkbox" checked={f.active} onChange={e => set('active', e.target.checked)} /> Client actif
          </label>
        )}

        {err && <p className="text-sm text-yf-red">✗ {err}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Enregistrement…' : (editing ? 'Enregistrer' : 'Créer le client')}
        </button>
      </form>
    </Modal>
  );
}

// ───────────────────────── ACHATS (bon d'achat / PO) ─────────────────────────
function todayCasa() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Casablanca' }).format(new Date());
}
const FLAG_LABEL = {
  backlog: 'reliquat',
  stale_cost: 'prix ancien',
  cost_unknown: 'prix inconnu',
  uom_conversion_missing: 'conversion manquante',
  no_purchase_unit: 'unité d’achat non définie',
};

function PoCalculation() {
  const [date, setDate] = useState(todayCasa());
  const [po, setPo] = useState(undefined);   // undefined = chargement, null = aucun
  const [orders, setOrders] = useState(null); // commandes de la journée, pour le contrôle
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const [buy, setBuy] = useState({});          // saisies en cours de l'équipe achat
  const [saved, setSaved] = useState(null);

  const setBuyField = (itemId, k, v) => {
    setSaved(null);
    setBuy(s => ({ ...s, [itemId]: { ...(s[itemId] || {}), [k]: v } }));
  };
  const unitShort = u => (u === 'KG' ? 'kg' : u.toLowerCase());

  /** Prix ramené à l'unité de base (le kg), à partir du prix par caisse/sac. */
  const perBase = (l) => {
    const raw = buy[l.itemId]?.unitPrice ?? l.bought?.unitPrice;
    const p = Number(raw);
    if (raw === '' || raw == null || isNaN(p)) return null;
    if (l.purchase.uom === l.baseUom) return p;
    const per = Number(l.purchase.qtyPerUnit) > 0 ? Number(l.purchase.qtyPerUnit) : 1;
    return Math.round((p / per) * 100) / 100;
  };
  const lineTotal = (l) => {
    const raw = buy[l.itemId]?.unitPrice ?? l.bought?.unitPrice;
    const p = Number(raw);
    if (raw === '' || raw == null || isNaN(p)) return l.cost?.estTotal ?? null;
    const u = Number(buy[l.itemId]?.units ?? l.bought?.units ?? l.purchase.units) || 0;
    return Math.round(u * p * 100) / 100;
  };
  const pending = Object.entries(buy).filter(([, v]) => v.unitPrice !== '' && v.unitPrice != null);

  const load = useCallback((d) => {
    setPo(undefined); setErr(''); setBuy({}); setSaved(null);
    api('/po?date=' + encodeURIComponent(d))
      .then(r => setPo(r.po))
      .catch(e => { setPo(null); if (!/Aucun bon/.test(e.message)) setErr(e.message); });
    // On recharge aussi les commandes : le seul moyen honnête de dire si le
    // bon d'achat a bien tout pris, c'est de comparer avec la source.
    api('/orders?limit=100')
      .then(r => setOrders((r.rows || []).filter(o => o.date === d)))
      .catch(() => setOrders([]));
  }, []);
  useEffect(() => { load(date); }, [date, load]);

  async function run() {
    setBusy(true); setErr('');
    try {
      const r = await api(`/po?action=run&date=${encodeURIComponent(date)}`, { method: 'POST' });
      setPo(r.po); setBuy({}); setSaved(null);
      const o = await api('/orders?limit=100');
      setOrders((o.rows || []).filter(x => x.date === date));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  /** Enregistre les achats : le coût redescend sur les commandes concernées. */
  async function saveBuys() {
    setBusy(true); setErr(''); setSaved(null);
    try {
      const items = pending.map(([itemId, v]) => ({
        itemId,
        unitPrice: Number(v.unitPrice),
        units: v.units === '' || v.units == null ? undefined : Number(v.units),
      }));
      const r = await api(`/po?action=buy`, { method: 'POST', body: { date, items, by: getUser() } });
      setSaved(r);
      setBuy({});
      const p = await api('/po?date=' + encodeURIComponent(date));
      setPo(p.po);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  // Quelles commandes du jour ont réellement été consolidées ?
  const consolidated = useMemo(() => {
    if (!po?.bySupplier) return new Set();
    const s = new Set();
    for (const g of po.bySupplier) for (const l of g.lines) for (const id of (l.demand?.orderIds || [])) s.add(id);
    return s;
  }, [po]);
  const missing = (orders || []).filter(o => !consolidated.has(o.orderId));

  async function copyText() {
    try {
      const r = await fetch(`/api/po?date=${encodeURIComponent(date)}&format=text`, { headers: { 'x-auth-token': getToken() } });
      const t = await r.text();
      await navigator.clipboard.writeText(t);
      setCopied(true); setTimeout(() => setCopied(false), 2200);
    } catch { setErr('Copie impossible'); }
  }

  const empty = po && !po.totals?.lineCount;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div>
          <h1 className="text-xl font-bold text-yf-primary">PO Calculation</h1>
          <p className="text-sm text-neutral-500">
            Regroupe toutes les commandes du jour en une seule liste d'achat, prête pour le marché de gros.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-neutral-300 rounded-lg px-3 py-2 text-sm" />
          <button onClick={run} disabled={busy} className="btn-primary">
            {busy ? 'Consolidation…' : (po ? '↻ Regénérer' : '⚡ Générer')}
          </button>
        </div>
      </div>

      {/* Ce que le bouton va prendre — visible AVANT de cliquer. */}
      {orders !== null && (
        <div className="bg-white rounded-xl border border-neutral-200 p-4 no-print">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="font-semibold text-neutral-800">Commandes du {date.split('-').reverse().join('/')}</h2>
            <span className="text-sm text-neutral-500">
              {orders.length === 0 ? 'aucune commande'
                : po ? <><b className="text-yf-primary">{orders.length - missing.length}</b> consolidée{orders.length - missing.length > 1 ? 's' : ''} sur {orders.length}</>
                     : <>{orders.length} commande{orders.length > 1 ? 's' : ''} en attente de génération</>}
            </span>
          </div>

          {orders.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {orders.map(o => {
                const inPo = consolidated.has(o.orderId);
                return (
                  <button key={o.orderId} onClick={() => go('/commandes')}
                    title={`${o.client?.name || ''} · ${o.lineCount} ligne(s)`}
                    className={`text-xs px-2 py-1 rounded-lg border ${po
                      ? (inPo ? 'bg-neutral-50 border-brand-200 text-yf-primary' : 'bg-amber-50 border-amber-200 text-amber-800')
                      : 'bg-neutral-50 border-neutral-200 text-neutral-600'}`}>
                    {po && (inPo ? '✓ ' : '⚠ ')}{o.orderId} · {o.client?.name}
                  </button>
                );
              })}
            </div>
          )}

          {po && missing.length > 0 && (
            <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <b>{missing.length} commande{missing.length > 1 ? 's' : ''} non reprise{missing.length > 1 ? 's' : ''}</b> — c'est normal
              si la marchandise a déjà été achetée sur un bon précédent, ou si le fournisseur a refusé les lignes.
              Ouvre la commande pour voir le détail avant d'aller au marché.
            </p>
          )}
          {po && orders.length > 0 && missing.length === 0 && (
            <p className="mt-3 text-xs text-yf-primary">
              ✓ Toutes les commandes du jour sont dans ce bon d'achat.
            </p>
          )}
          {!po && orders.length > 0 && (
            <p className="mt-3 text-xs text-neutral-500">
              Clique sur <b>Générer</b> : les quantités identiques sont additionnées, la casse est ajoutée,
              puis chaque total est arrondi à l'unité d'achat réelle (on n'achète pas une demi-caisse).
            </p>
          )}
        </div>
      )}

      {err && <p className="text-sm text-yf-red no-print">✗ {err}</p>}
      {po === undefined && <Loading />}

      {po === null && (
        <div className="bg-white rounded-xl border border-neutral-200 p-8 text-center no-print">
          <p className="text-neutral-500 mb-3">Pas encore de bon d'achat pour le {date.split('-').reverse().join('/')}.</p>
          <button onClick={run} disabled={busy} className="btn-primary">
            {busy ? 'Consolidation…' : '⚡ Générer le bon d\'achat'}
          </button>
          <p className="text-xs text-neutral-400 mt-3">Il se génère aussi tout seul chaque nuit à 1h (heure de Casablanca).</p>
        </div>
      )}

      {empty && (
        <div className="bg-white rounded-xl border border-neutral-200 p-8 text-center">
          <p className="text-neutral-600 font-medium">Aucune commande sur la période — rien à acheter.</p>
          <p className="text-xs text-neutral-400 mt-1">Calculé le {new Date(po.generatedAt).toLocaleString('fr-FR')}</p>
        </div>
      )}

      {po && !empty && (
        <>
          {/* résumé (écran seulement — inutile sur le papier du marché) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 no-print">
            <Stat k="Produits" v={po.totals.lineCount} />
            <Stat k="Commandes" v={po.totals.orderCount} />
            <Stat k="Fournisseurs" v={po.totals.supplierCount} />
            <Stat k="Coût estimé" v={fmtDH(po.totals.estCost)} warn={!po.totals.estCostComplete} />
          </div>

          {/* barre de saisie de l'équipe achat */}
          <div className="bg-white rounded-xl border border-neutral-200 p-4 no-print">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="font-semibold text-neutral-800">Retour du marché</h2>
                <p className="text-xs text-neutral-500 mt-0.5">
                  Saisis le prix payé sur chaque ligne ci-dessous. Il devient le coût de toutes
                  les commandes du produit — la facturation calcule ensuite le prix client.
                </p>
              </div>
              <button onClick={saveBuys} disabled={busy || !pending.length}
                className={btnPrimary + ' disabled:opacity-40'}>
                {busy ? 'Enregistrement…' : `💾 Enregistrer ${pending.length || ''} prix`}
              </button>
            </div>
            {saved && (
              <div className="mt-3 bg-neutral-50 border border-brand-200 rounded-lg px-3 py-2 text-sm text-yf-primary">
                ✓ {saved.itemsSaved} prix enregistré{saved.itemsSaved > 1 ? 's' : ''} ·
                {' '}{saved.linesUpdated} ligne{saved.linesUpdated > 1 ? 's' : ''} de commande mise{saved.linesUpdated > 1 ? 's' : ''} à jour
                sur {saved.ordersTouched} commande{saved.ordersTouched > 1 ? 's' : ''}.
                {' '}<button onClick={() => go('/commandes')} className="underline">Aller facturer →</button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 no-print">
            <button onClick={copyText} className="btn-ghost">{copied ? '✓ Copié' : '📋 Copier pour WhatsApp'}</button>
            <button onClick={() => window.print()} className="btn-ghost">🖨 Imprimer</button>
            <span className="text-xs text-neutral-400">
              Généré {new Date(po.generatedAt).toLocaleString('fr-FR')} · {po.generatedBy}
              {po.revision > 1 && ` · révision ${po.revision}`}
            </span>
          </div>

          {!po.totals.estCostComplete && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 no-print">
              ⚠ Certains prix d'achat sont inconnus — le total est incomplet, pas faux.
            </p>
          )}

          {/* liste par fournisseur */}
          <div className="print-area space-y-4">
            <div className="hidden print:block mb-2">
              <Logo size={34} />
              <div className="text-sm font-bold mt-1">Bon d'achat — {po.businessDate.split('-').reverse().join('/')}</div>
            </div>
            {po.bySupplier.map(g => (
              <div key={g.supplierId} className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
                <div className="px-4 py-2.5 bg-neutral-50 border-b border-yf-primary/10 flex items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold text-yf-primary">{g.supplierName}</span>
                    {g.phone && <a href={`tel:${g.phone}`} className="ml-2 text-xs text-yf-primary no-print">{g.phone}</a>}
                  </div>
                  <div className="text-xs text-neutral-600">
                    {g.lineCount} produit{g.lineCount > 1 ? 's' : ''}
                    {g.estCost > 0 && <> · <b>{fmtDH(g.estCost)}</b>{!g.estCostComplete && '*'}</>}
                  </div>
                </div>
                {/* Une ligne = une carte : la saisie du prix reste à l'écran
                    sur téléphone au lieu d'être coupée à droite. */}
                <div className="divide-y divide-neutral-100">
                  {g.lines.map(l => (
                    <div key={l.itemId} className={`px-3 py-2.5 ${buy[l.itemId]?.unitPrice ? 'bg-neutral-50/30' : ''}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-neutral-800 leading-tight">{l.name}</div>
                          <div className="text-xs text-neutral-400">
                            {l.subCategory || l.category}
                            {l.demand.orderCount > 0 && ` · ${l.demand.orderCount} cmd`}
                            {l.flags.map(f => (
                              <span key={f} className="ml-1 px-1 rounded bg-amber-100 text-amber-800">{FLAG_LABEL[f] || f}</span>
                            ))}
                          </div>
                          <div className="text-xs text-neutral-500 mt-0.5">
                            demande : {l.demand.byUom.map(d => `${fmt(d.qty)} ${d.uom.toLowerCase()}`).join(' + ')}
                            {l.upliftBaseQty > 0 && <span className="text-amber-600"> +{fmt(l.upliftBaseQty)} perte</span>}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-bold text-yf-primary text-base whitespace-nowrap">
                            {fmt(l.purchase.units)} {l.purchase.uom === 'KG' ? 'kg' : l.purchase.uom.toLowerCase()}
                          </div>
                          <div className="text-[10px] uppercase tracking-wide text-neutral-400">à acheter</div>
                          {l.purchase.overBuyBaseQty > 0 && (
                            <div className="text-[10px] text-neutral-400">+{fmt(l.purchase.overBuyBaseQty)} {l.baseUom.toLowerCase()} d'arrondi</div>
                          )}
                        </div>
                      </div>

                      {/* saisie de l'équipe achat : ce qui a réellement été pris et payé */}
                      <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-2 no-print">
                        <span className="text-[10px] uppercase tracking-wide text-neutral-400 w-full sm:w-auto">Acheté / prix payé</span>
                        <input type="number" min="0" step="any" inputMode="decimal"
                          value={buy[l.itemId]?.units ?? l.bought?.units ?? l.purchase.units}
                          onChange={e => setBuyField(l.itemId, 'units', e.target.value)}
                          className="w-16 border border-neutral-200 rounded px-2 py-1.5 text-right text-sm" />
                        <span className="text-xs text-neutral-400 w-12">{unitShort(l.purchase.uom)}</span>
                        <span className="text-neutral-300">×</span>
                        <input type="number" min="0" step="any" inputMode="decimal" placeholder="prix"
                          value={buy[l.itemId]?.unitPrice ?? l.bought?.unitPrice ?? ''}
                          onChange={e => setBuyField(l.itemId, 'unitPrice', e.target.value)}
                          className="w-20 border border-neutral-300 rounded px-2 py-1.5 text-right text-sm font-semibold" />
                        <span className="text-xs text-neutral-400">DH</span>
                        <span className="ml-auto text-sm font-medium text-neutral-700">
                          {lineTotal(l) != null ? fmtDH(lineTotal(l)) : <span className="text-amber-600 text-xs">prix ?</span>}
                        </span>
                      </div>
                      {perBase(l) != null && (
                        <div className="text-[10px] text-neutral-400 mt-0.5 no-print">
                          = {fmt(perBase(l))} DH / {l.baseUom.toLowerCase()}
                          {l.bought && !buy[l.itemId] && <span className="ml-1 text-yf-primary">· enregistré</span>}
                        </div>
                      )}
                      {/* à l'impression, on montre juste le total (la saisie est masquée) */}
                      {lineTotal(l) != null && (
                        <div className="hidden print:block text-right text-sm">Total : {fmt(lineTotal(l))} DH</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex justify-end">
              <div className="text-right">
                <div className="text-sm text-neutral-500">
                  {po.totals.boughtLineCount ? 'Total payé' : 'Total estimé'}
                </div>
                <div className="text-2xl font-bold text-yf-primary">
                  {fmtDH(po.totals.totalPaid || po.totals.estCost)}
                </div>
                {!po.totals.estCostComplete && <div className="text-xs text-amber-600">* prix manquants</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ k, v, warn }) {
  return (
    <div className="bg-white rounded-xl border border-neutral-200 px-4 py-3">
      <div className="text-xs text-neutral-500">{k}</div>
      <div className={`text-xl font-bold ${warn ? 'text-amber-600' : 'text-yf-primary'}`}>{v}</div>
    </div>
  );
}

// ───────────────────────── SUPPLIER PORTAL ─────────────────────────
function SupplierApp() {
  const [data, setData] = useState(null);
  const load = useCallback(() => { api('/supplier/requests').then(setData).catch(() => setData({ requests: [], pendingCount: 0 })); }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  async function price(orderId, itemId, cost) { await api('/supplier/price', { method: 'POST', body: { orderId, itemId, cost } }); load(); }
  async function refuse(orderId, itemId) { await api('/supplier/price', { method: 'POST', body: { orderId, itemId, refuse: true } }); load(); }

  return (
    <div className="min-h-screen">
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-4 h-16 flex items-center justify-between">
          <Logo size={32} />
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-600">{getUser()}</span>
            <button onClick={logout} className="text-xs text-neutral-400 hover:text-yf-red">Quitter</button>
          </div>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-yf-primary">Demandes d'achat</h1>
          {data?.pendingCount > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-yf-red text-white font-semibold">{data.pendingCount} en attente</span>}
        </div>
        {!data ? <Loading /> : !data.requests.length ? <Empty msg="Aucune demande pour le moment." /> : (
          data.requests.map(o => (
            <div key={o.orderId} className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-neutral-50 border-b border-neutral-100 flex items-center justify-between">
                <div className="text-sm"><span className="font-mono text-yf-primary">{o.orderId}</span> · <span className="text-neutral-600">{o.client}</span></div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[o.status]}`}>{STATUS_LABEL[o.status]}</span>
              </div>
              <div className="divide-y divide-neutral-100">
                {o.lines.map(l => <SupplierLine key={l.itemId} orderId={o.orderId} l={l} onPrice={price} onRefuse={refuse} />)}
              </div>
            </div>
          ))
        )}
      </main>
    </div>
  );
}

function SupplierLine({ orderId, l, onPrice, onRefuse }) {
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  if (l.status === 'priced') return (
    <div className="px-4 py-3 flex items-center justify-between bg-neutral-50/40">
      <div><div className="text-sm font-medium text-neutral-800">{l.name}</div><div className="text-xs text-neutral-500">{fmt(l.qty)} {l.uom} · ton prix {fmt(l.cost)} DH → prix client {fmt(l.clientPrice)} DH</div></div>
      <span className="text-xs px-2 py-1 rounded-full bg-yf-primary/10 text-yf-primary">✓ Tarifé</span>
    </div>
  );
  if (l.status === 'refused') return (
    <div className="px-4 py-3 flex items-center justify-between opacity-60"><div className="text-sm text-neutral-500">{l.name} — {fmt(l.qty)} {l.uom}</div><span className="text-xs px-2 py-1 rounded-full bg-rose-100 text-rose-700">Refusé</span></div>
  );
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0"><div className="text-sm font-medium text-neutral-800">{l.name}</div><div className="text-xs text-neutral-500">Quantité demandée : <b>{fmt(l.qty)} {l.uom}</b></div></div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <input type="number" min="0" step="any" value={cost} onChange={e => setCost(e.target.value)} placeholder="ton prix" className="w-28 border border-neutral-300 rounded-lg px-3 py-2 text-sm text-right" />
            <span className="absolute right-3 top-2.5 text-xs text-neutral-400">DH</span>
          </div>
          <button disabled={busy || cost === ''} onClick={async () => { setBusy(true); await onPrice(orderId, l.itemId, cost); setBusy(false); }} className={btnPrimary + ' text-xs px-3 py-2'}>Accepter</button>
          <button disabled={busy} onClick={() => onRefuse(orderId, l.itemId)} className="text-xs text-neutral-400 hover:text-yf-red px-2">Refuser</button>
        </div>
      </div>
    </div>
  );
}
