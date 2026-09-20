/** @jsxImportSource solid-js */
import { render } from 'solid-js/web'
import { Connection } from './channel.js'
import { ConnectionContext } from './sdk.js'
import { App } from './shell.js'
import './theme.css'

declare global { interface Window { SOLID_WEBUI_CONFIG: import('./channel.js').ClientConfig } }
const connection = new Connection(window.SOLID_WEBUI_CONFIG)
render(() => <ConnectionContext.Provider value={connection}><App /></ConnectionContext.Provider>, document.getElementById('app')!)
connection.start()
window.addEventListener('pagehide', () => connection.stop())
window.addEventListener('pageshow', () => connection.start())
