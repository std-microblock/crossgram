import { Context, Service } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { IMPlatformService, IMStickerService } from '@mtproto-relay/bridge'
import { apply } from './index.js'
import { QQVoiceMedia } from './voice-media.js'

class TestModel extends Service {
  constructor(ctx: Context) {
    super(ctx, 'model')
  }

  extend() {}
}

class TestDatabase extends Service {
  constructor(ctx: Context) {
    super(ctx, 'database')
  }

  async prepared() {}

  async get() {
    return []
  }

  async withTransaction(callback: (database: TestDatabase) => Promise<void>) {
    await callback(this)
  }
}

function loadedQQNTPlugin(id: string) {
  const plugin = (ctx: Context) => {
    ;(ctx.fiber as unknown as {
      entry?: { id: string, options: { id: string, name: string } }
    }).entry = { id: `parent:${id}`, options: { id, name: id } }
    apply(ctx, {})
  }
  plugin.inject = ['imPlatform', 'imSticker', 'database', 'model']
  return plugin
}

describe('QQNT voice media isolation', () => {
  it('loads independently registered QQNT adapters and closes each media service on disposal', async () => {
    const ctx = new Context()
    const services = ctx.plugin((serviceCtx) => {
      new IMPlatformService(serviceCtx)
      new IMStickerService(serviceCtx)
      new TestDatabase(serviceCtx)
      new TestModel(serviceCtx)
    })
    await services
    const close = vi.spyOn(QQVoiceMedia.prototype, 'close')
    const first = ctx.plugin(loadedQQNTPlugin('qqnt-one'))
    const second = ctx.plugin(loadedQQNTPlugin('qqnt-two'))
    try {
      await Promise.all([first, second])
      expect(ctx.imPlatform.ids).toEqual(['qqnt-one', 'qqnt-two'])
      await first.dispose()
      expect(close).toHaveBeenCalledTimes(1)
      await second.dispose()
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      await Promise.allSettled([first.dispose(), second.dispose()])
      close.mockRestore()
      await services.dispose()
    }
  })
})
