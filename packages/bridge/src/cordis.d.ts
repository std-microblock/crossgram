import 'cordis'
import type {
  ActivePlatformSession,
  CommittedPlatformEvent,
  IMPlatformService,
  PlatformEventDeliveryOptions,
  PlatformEventPublishResult,
  PlatformRegistryEvent,
  PlatformSessionEvent,
} from './platform-manager.js'
import type { IMEvent, IMPlatform, PlatformSession } from './platform.js'
import type { IMStickerService } from './sticker-provider.js'
import type { TelegramResourceService } from './resource-provider.js'
import type { SystemPeerService } from './system-peer.js'
import type { MtprotoBridgeService } from './bridge-service.js'
import type { ConversationViewService } from './conversation-view.js'
import type { ConversationViewMessageTarget } from './conversation-view.js'
import type { BridgeManagementService } from './management-service.js'
import type { tl } from '@mtcute/core'
import type {
  MessageProjectionInput,
  MessageProjectionPlan,
  MessageProjectionPlanInput,
  MessageProjectionResult,
} from './message-projection.js'

declare module 'cordis' {
  interface Context {
    imPlatform: IMPlatformService
    imSticker: IMStickerService
    telegramResource: TelegramResourceService
    systemPeer: SystemPeerService
    mtprotoBridge: MtprotoBridgeService
    bridgeManagement: BridgeManagementService
    conversationView: ConversationViewService
    /** Present on one active platform-session fiber and its descendants. */
    bridgeSession: {
      platform: IMPlatform
      session: PlatformSession
    }
    /** Present on the short-lived fiber processing one platform event. */
    bridgeEvent: {
      event: IMEvent
      options?: PlatformEventDeliveryOptions
    }
  }

  interface Events {
    'im-platform/change'(
      event: PlatformRegistryEvent,
      registrationId: string,
      platform: IMPlatform,
    ): void
    'im-platform/session'(event: PlatformSessionEvent, binding: ActivePlatformSession): void
    'im-platform/event-committed'(session: PlatformSession, event: CommittedPlatformEvent): void
    'bridge/platform-event'(
      session: PlatformSession,
      event: IMEvent,
      options: PlatformEventDeliveryOptions | undefined,
      next: () => Promise<PlatformEventPublishResult>,
    ): Promise<PlatformEventPublishResult>
    'bridge/platform-event/publish'(
      session: PlatformSession,
      event: CommittedPlatformEvent,
      options: PlatformEventDeliveryOptions | undefined,
      next: () => Promise<PlatformEventPublishResult>,
    ): Promise<PlatformEventPublishResult>
    'bridge/message/project-plan'(
      input: MessageProjectionPlanInput,
      next: () => MessageProjectionPlan | Promise<MessageProjectionPlan>,
    ): MessageProjectionPlan | Promise<MessageProjectionPlan>
    'bridge/message/project'(
      input: MessageProjectionInput,
      next: () => MessageProjectionResult | Promise<MessageProjectionResult>,
    ): MessageProjectionResult | Promise<MessageProjectionResult>
    'bridge/conversation-view/supports'(conversation: import('./platform.js').IMConversation): boolean | undefined
    'bridge/conversation-view/remember'(
      platformSessionId: string,
      chatId: number,
      conversation: import('./platform.js').IMConversation,
    ): string | undefined
    'bridge/conversation-view/resolve'(
      platformSessionId: string,
      chatId: number,
    ): import('./platform.js').IMConversation | undefined
    'bridge/conversation-view/resolve-username'(
      platformSessionId: string,
      username: string,
    ): { chatId: number, conversation: import('./platform.js').IMConversation } | undefined
    'bridge/conversation-view/owns-message'(
      platformSessionId: string,
      tlMessageId: number,
    ): boolean | undefined
    'bridge/conversation-view/target'(
      platformSessionId: string,
      chatId: number,
    ): ConversationViewMessageTarget | undefined
    'bridge/conversation-view/set-target'(
      platformSessionId: string,
      chatId: number,
      target: ConversationViewMessageTarget,
    ): boolean | undefined
    'bridge/conversation-view/make-link'(
      platformSessionId: string,
      chatId: number,
    ): string | undefined
    'bridge/conversation-view/make-preview'(
      platformSessionId: string,
      chatId: number,
    ): tl.RawMessageMediaWebPage | undefined
    'bridge/conversation-view/make-chat'(
      platformSessionId: string,
      chatId: number,
      dcId: number,
    ): tl.TypeChat | undefined
    'bridge/conversation-view/make-full-chat'(
      platformSessionId: string,
      chatId: number,
      notifySettings: tl.TypePeerNotifySettings,
    ): tl.messages.RawChatFull | undefined
  }
}
