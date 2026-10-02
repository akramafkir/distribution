import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import { Pwa } from './Pwa.jsx';
import './index.css';

// Service worker : enregistré une seule fois, hors de React (StrictMode monte
// les effets deux fois). La bascule vers la nouvelle version n'a lieu qu'au clic
// sur « Mettre à jour » — jamais pendant que quelqu'un saisit un prix.
const HOUR = 60 * 60 * 1000;
let lastCheck = 0;

const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent('pwa:need-refresh'));
  },
  // Installée, l'app reste ouverte des jours : sans ces vérifications, une
  // nouvelle version ne serait jamais proposée (le navigateur ne vérifie qu'au
  // chargement de la page).
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    const check = async () => {
      if (!navigator.onLine || document.hidden) return;
      if (Date.now() - lastCheck < 10 * 60 * 1000) return;
      lastCheck = Date.now();
      try {
        await registration.update();
      } catch {
        /* hors ligne ou réseau instable : on retentera au prochain passage */
      }
    };
    setInterval(check, HOUR);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check();
    });
  },
});

window.__pwaUpdate = () => updateSW(true);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <Pwa />
  </StrictMode>
);
