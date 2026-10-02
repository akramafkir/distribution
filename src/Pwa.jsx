// PWA : bandeau de mise à jour + indicateur hors ligne.
// Volontairement hors de App.jsx — position fixe, aucun impact sur la mise en page,
// et masqué à l'impression (les factures ne doivent rien afficher de tout ça).

import { useEffect, useState } from 'react';

export function Pwa() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const onNeed = () => setNeedRefresh(true);
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener('pwa:need-refresh', onNeed);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('pwa:need-refresh', onNeed);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (!needRefresh && !offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="no-print print:hidden fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-3 pointer-events-none"
    >
      {offline && (
        <div className="pointer-events-auto w-full max-w-md rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-lg">
          <b>Hors ligne</b> — l'application reste ouverte, mais les commandes et factures
          ne se chargent ni ne s'enregistrent tant que la connexion n'est pas revenue.
        </div>
      )}
      {needRefresh && (
        <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border border-brand-200 bg-white px-3 py-2 shadow-lg">
          <span className="flex-1 text-xs text-slate-700">
            <b className="text-brand-800">Nouvelle version disponible.</b> Termine ta saisie,
            puis mets à jour.
          </span>
          <button
            onClick={() => window.__pwaUpdate?.()}
            className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          >
            Mettre à jour
          </button>
          <button
            onClick={() => setNeedRefresh(false)}
            aria-label="Plus tard"
            className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-slate-400 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
