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

  function doUpdate() {
    if (window.__pwaUpdate) {
      window.__pwaUpdate();
    } else {
      // Fallback: hard refresh if PWA update isn't available
      window.location.reload(true);
    }
  }

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
        <div className="pointer-events-auto w-full max-w-md rounded-xl border border-yf-primary/20 bg-blue-50 px-4 py-3 shadow-lg">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-sm font-semibold text-yf-primary">✨ Nouvelle version disponible</div>
              <p className="text-xs text-neutral-600 mt-1">
                Une mise à jour est prête. Clique sur "Mettre à jour" pour charger les nouvelles fonctionnalités.
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={doUpdate}
              className="flex-1 rounded-lg bg-yf-primary px-3 py-2 text-xs font-semibold text-white hover:bg-blue-600 transition"
            >
              ⚡ Mettre à jour maintenant
            </button>
            <button
              onClick={() => setNeedRefresh(false)}
              className="px-3 py-2 text-xs text-neutral-500 hover:text-neutral-700"
            >
              Plus tard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
