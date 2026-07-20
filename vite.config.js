import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Precache the app shell so it loads with zero network requests.
        // The data layer (IndexedDB) is separate from this and always
        // works offline regardless of what's cached here.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
      manifest: {
        name: 'Bar POS',
        short_name: 'BarPOS',
        description: 'Offline-first POS and inventory for bars/restaurants',
        theme_color: '#2f6f4f',
        background_color: '#fafaf8',
        display: 'standalone',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
})
