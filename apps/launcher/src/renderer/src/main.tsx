import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import './styles/layout.css'
import './styles/dialogs.css'
import App from './App'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
