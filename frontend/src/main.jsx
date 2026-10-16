// This is Vite's browser entry point: mount the React app into index.html's #root element.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// StrictMode adds development-only checks that help reveal unsafe React side effects.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
