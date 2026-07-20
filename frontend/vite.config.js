import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// ADR-035: версия сборки клиента (эпоха-секунды билда). Монотонна и сравнима —
// клиент шлёт её в заголовке X-Client-Version, а сервер по MIN_CLIENT_VERSION
// решает, совместим ли контракт. Проставляется один раз на сборку.
const buildVersion = String(Math.floor(Date.now() / 1000));

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  plugins: [
    react(),
    // Превращает статический билд в устанавливаемый PWA: генерирует манифест,
    // service worker (Workbox) с прекэшем оболочки приложения. Данные и очередь
    // синхронизации живут в IndexedDB (эпик 3) — service worker кэширует только
    // статику (JS/CSS/шрифты/иконки), запросы к API (кросс-доменные, на
    // VITE_API_BASE_URL) не перехватывает.
    //
    // ADR-035: registerType 'prompt' (не тихий autoUpdate) — новая версия встаёт
    // в waiting, приложение показывает ненавязчивый баннер «Доступна новая
    // версия», обновление применяется по нажатию и откладывается во время записи
    // (§4.3). Регистрацию SW делаем вручную в PwaUpdatePrompt (injectRegister:
    // null), чтобы управлять моментом применения.
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
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
        // §4.5 kill-switch: именованный кэш + очистка устаревших ревизий на
        // activate. cacheId неймспейсит все кэши Workbox под 'stenogram', чтобы
        // ручной сброс (unregister + удаление кэшей) бил точно по нашим.
        cacheId: 'stenogram',
        cleanupOutdatedCaches: true,
        // Не захватываем клиентов молча: при 'prompt' апдейт применяется только
        // по явному действию пользователя (skipWaiting/clients.claim делает
        // PwaUpdatePrompt через updateSW(true)).
        clientsClaim: false,
        skipWaiting: false,
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
