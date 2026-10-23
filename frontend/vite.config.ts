/// <reference types="vitest/config" />
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Files the service worker precaches so the app works offline once loaded (AC13.1): the app
 * shell (HTML, JS, CSS), icons, and the alert sounds and rain loop. Sounds and rain arrive with
 * #16/#17: put them under `public/sounds/` or `public/audio/` and they are cached with the next
 * build (a pattern for a folder that doesn't exist yet is left out, since Workbox warns on it).
 * Another folder or file type: add it to `MEDIA_FOLDERS` or `MEDIA_TYPES`.
 */
const MEDIA_FOLDERS = ['sounds', 'audio']
const MEDIA_TYPES = '{mp3,ogg,opus,m4a,wav,webm}'
const OFFLINE_ASSETS = [
  '**/*.{html,js,css,svg,png,ico}',
  ...MEDIA_FOLDERS.filter((folder) =>
    existsSync(fileURLToPath(new URL(`./public/${folder}`, import.meta.url))),
  ).map((folder) => `${folder}/**/*.${MEDIA_TYPES}`),
]

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // A new version waits until every tab of the old one is closed, so a running timer is
      // never reloaded under the user.
      registerType: 'prompt',
      injectRegister: 'script-defer',
      // The icons are already in OFFLINE_ASSETS, and the plugin adds the manifest itself.
      includeManifestIcons: false,
      manifest: {
        id: '/',
        name: 'I Need To Focus',
        short_name: 'Focus',
        description: 'Focus sessions with countdown, Pomodoro and unlimited timers.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0e1116',
        theme_color: '#0e1116',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: OFFLINE_ASSETS,
        // The rain loop can be a few MB.
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        // Pages load the cached shell offline; the API and health checks always go to the network
        // and are never cached (sessions are kept in IndexedDB instead).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api(\/|$)/, /^\/healthz$/, /^\/readyz$/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
