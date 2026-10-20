import Page0 from './page.js'
import './style.css'
import type { ClientModule } from 'cordis-webui-react/client'
export default {
  pages: [
    {
      path: '/mtproto-statistics',
      title: 'MTProto statistics',
      icon: '▥',
      group: 'Observe',
      component: Page0,
    },
  ],
} satisfies ClientModule
