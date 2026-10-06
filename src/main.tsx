import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { installAuthFetch } from './services/authFetch'

// Every same-origin /api request carries the session token; 401 returns the user to the login screen.
installAuthFetch()
import App from './App.tsx'
import { initAutoPhotoSelfHealing } from './services/photoCacheService'

// Enable client-side photo cache & auto-healing against ephemeral server restarts
initAutoPhotoSelfHealing()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
