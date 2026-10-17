import type { IMMessage, PlatformSession } from './platform.js'

/**
 * 发送 RPC 进行中的窗口。
 *
 * 平台把客户端刚发出的消息回显成一条普通事件时，若这条回显先被推给发送端，
 * 客户端会先插入一份服务端副本；随后发送 RPC 的回包再带 `updateMessageID`
 * 做对账，客户端就只能销毁其中一条（Telegram Desktop 会播放消息粉碎动画，
 * Android 会闪一下重复气泡）。因此发送 RPC 期间，该 auth key 必须只通过
 * 回包获知这条消息，平台回显不能再推给它。
 */
export class ActiveSends {
  private readonly _bySession = new Map<string, Map<string, number>>()

  /** 标记某个 auth key 正在等待自己这次发送的回包；返回释放函数。 */
  begin(platformSessionId: string, authKeyId?: string): () => void {
    if (!authKeyId) return () => {}
    let counting = this._bySession.get(platformSessionId)
    if (!counting) this._bySession.set(platformSessionId, counting = new Map())
    counting.set(authKeyId, (counting.get(authKeyId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const counts = this._bySession.get(platformSessionId)
      const count = counts?.get(authKeyId)
      if (!counts || count === undefined) return
      if (count > 1) {
        counts.set(authKeyId, count - 1)
      } else {
        counts.delete(authKeyId)
        if (!counts.size) this._bySession.delete(platformSessionId)
      }
    }
  }

  /**
   * 当前消息是本账号自己发出、且恰好只有一个 auth key 正在发送时，
   * 返回那个 auth key：它的回包会完成对账，回显不应再推过去。
   */
  excludeFor(session: PlatformSession, message: IMMessage): string | undefined {
    if (!message.outgoing || message.senderId !== session.userId) return
    const counting = this._bySession.get(session.platformSessionId)
    if (counting?.size !== 1) return undefined
    return counting.keys().next().value
  }
}
