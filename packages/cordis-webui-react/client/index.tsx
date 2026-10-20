import { createRoot } from 'react-dom/client'
import { Connection } from './channel.js'
import { ConnectionContext } from './sdk.js'
import { applyAppearance, readAppearance } from './appearance.js'
import { consumeOAuthResult } from './session.js'
import { App } from './shell.js'
import './styles/tokens.css'
import './styles/base.css'
import './theme.css'

declare global {
  interface Window {
    REACT_WEBUI_CONFIG: import('./channel.js').ClientConfig
  }
}
const oauthError = consumeOAuthResult(window.REACT_WEBUI_CONFIG.uiPath)
const appearance = readAppearance()
applyAppearance(appearance.appearance, appearance.palette)
const connection = new Connection(window.REACT_WEBUI_CONFIG)

createRoot(document.getElementById('app')!).render(
  <ConnectionContext.Provider value={connection}>
    <App initialNotice={oauthError} />
  </ConnectionContext.Provider>,
)
connection.start()
window.addEventListener('pagehide', () => connection.stop())
window.addEventListener('pageshow', () => connection.start())
