import Page0 from './accounts.js'
import Page1 from './stickers.js'
import Page2 from './bots.js'
import StoragePage from './storage.js'
import './style.css'
import type { ClientModule } from 'cordis-webui-react/client'
export default {
  pages: [
    {
      path: '/platform-accounts',
      title: 'Platform accounts',
      icon: '○',
      group: 'Workspace',
      component: Page0,
    },
    {
      path: '/sticker-packs',
      title: 'Sticker collections',
      icon: '✦',
      group: 'Workspace',
      component: Page1,
    },
    {
      path: '/bots',
      title: 'Your bots',
      icon: '◇',
      group: 'Workspace',
      component: Page2,
    },
    {
      path: '/image-storage',
      title: 'Image storage',
      icon: '▣',
      group: 'Workspace',
      component: StoragePage,
    },
  ],
} satisfies ClientModule
