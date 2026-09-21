import Page0 from './page.js'
import './style.css'
import type { ClientModule } from 'cordis-webui-solidjs/client'
export default { pages: [
  { path: "/mtproto-debug", title: "MTProto capture", icon: "⇄", group: "Observe", component: Page0 },
] } satisfies ClientModule
