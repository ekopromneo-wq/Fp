import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Превращает статический билд в устанавливаемый PWA: генерирует манифест,
    // service worker (Workbox) с прекэшем оболочки приложения и авто-обновление.
    // Данные и очередь синхронизации по-прежнему живут в IndexedDB (эпик 3) —
    // service worker кэширует только статику (JS/CSS/шрифты/иконки), а запросы к
    // API (кросс-доменные, на VITE_API_BASE_URL) не перехватывает.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-64.png'],
      manifest: {
        name: 'Stenogram — мобильный AI-ассистент',
        short_name: 'Stenogram',
        description:
          'Запись встреч, расшифровка по спикерам, протокол и задачи «кто-что-когда». Работает офлайн.',
        lang: 'ru',
        theme_color: '#2FB3B7',
        background_color: '#0F1419',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 4173,
    watch: {
      usePolling: true,
    },
  },
});
