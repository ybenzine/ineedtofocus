import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AuthGate from './auth/AuthGate.tsx'
import { registerLocalDataHook } from './auth/localData.ts'
import { createAppServices } from './services.ts'
import { startAutoUpdate } from './update/start.ts'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing #root element in index.html')
}

// Created once, before sign-in is checked: a different user's sign-in calls the session store's
// hook to quarantine the previous owner's unsaved session before the app renders (#9, #19).
const services = createAppServices()
if (services.hook) registerLocalDataHook(services.hook)
void services.drainParked?.()

createRoot(root).render(
  <StrictMode>
    <AuthGate>
      <App services={services} />
    </AuthGate>
  </StrictMode>,
)

// A new version takes over by itself when the app is idle (#244). No worker in dev.
if (import.meta.env.PROD) startAutoUpdate()
