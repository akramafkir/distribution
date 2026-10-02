import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // PWA : coquille installable + mise à jour proposée, jamais imposée.
    // Aucune donnée métier n'est mise en cache — /api/* passe toujours par le réseau
    // (sinon un membre pourrait voir les données d'un autre client depuis le cache).
    VitePWA({
      registerType: 'prompt',
      injectRegister: null, // l'enregistrement se fait dans src/main.jsx
      manifest: {
        id: '/',
        name: 'Akram Distribution',
        short_name: 'Akram',
        description: "Commandes, bon d'achat et facturation — Akram Distribution",
        lang: 'fr',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f0fdf4',
        theme_color: '#16a34a',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        shortcuts: [
          { name: 'Commandes', short_name: 'Commandes', url: '/#/commandes' },
          { name: 'PO Calculation', short_name: 'PO', url: '/#/po' },
          { name: 'Factures', short_name: 'Factures', url: '/#/factures' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Sources des icônes : servent à régénérer les PNG, inutiles hors ligne.
        globIgnores: ['icon-maskable.svg', 'icon-apple.svg'],
        navigateFallback: '/index.html',
        // Une navigation vers /api/* ne doit JAMAIS recevoir la coquille HTML.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        clientsClaim: false, // on ne bascule qu'au clic sur « Mettre à jour »
        skipWaiting: false,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Inter vient de Google Fonts : sans ça, l'app hors ligne retombe sur la
        // police système. Uniquement des polices — aucune donnée métier.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-css',
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-files',
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 3050 },
});
