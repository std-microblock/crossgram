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
import type { BridgeManagementService } from './management-service.js'
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
  }
}
