# Cordis-native MTProto and message pipelines

The relay treats protocol and message work as scoped Cordis lifetimes instead
of a collection of global callback maps.

## MTProto lifetime tree

```text
Mtproto service fiber
└─ connectionFiber (one per TCP socket)
   ├─ derived connection context: ctx.mtprotoConnection
   ├─ derived packet context: ctx.mtprotoPacket
   └─ rpcInvocationFiber (one per decoded RPC)
      └─ derived RPC context: ctx.mtprotoRpc + ServerRpcContext fields
```

- Closing a socket disposes its `connectionFiber`. Session listeners and all
  in-flight or nested effects below that connection are therefore reclaimed by
  Cordis rather than by a second, manual lifecycle system.
- `mtproto/packet` is a waterfall around raw decoded-frame processing. It is
  suitable for tracing, validation, rate limits, and fault injection. An
  observer must call `next()` unless it intentionally rejects the packet.
- `mtproto/rpc` is a waterfall around RPC routing. Cross-cutting policies can
  wrap the method handler without modifying the MTProto session implementation.
- `mtproto/rpc/method` is the serial route event. `ctx.mtproto.register()` is a
  lifecycle-safe facade over this event: the route disappears automatically
  when the registering fiber unloads. Newer registrations run first, preserving
  the old route-replacement behavior while allowing the previous route to
  become visible again if an overriding fiber unloads.
- There is no parallel RPC registry or handler map. Direct decoded
  RPC tests use the same `registerRpcRoute()` / `invokeRpc()` Cordis event path
  as live socket traffic.
- `mtproto/connection` and `mtproto/debug` are observation events dispatched
  with the connection's derived context as `this`.

## Platform message lifetime tree

```text
bridge plugin fiber
└─ platformSessionFiber (one per active durable platform session)
   ├─ derived session context: ctx.bridgeSession
   └─ platformEventFiber (one per message/edit/delete/read/reaction/call event)
      └─ derived event context: ctx.bridgeEvent
```

Each session fiber owns the adapter subscription and its ordered event tail.
Events for different sessions can run concurrently; events within one session
remain in source order. Stopping an adapter or unloading the bridge disposes the
session fibers and waits for their current tails before unsubscribing.

The event processing stages are:

1. `bridge/platform-event` waterfall wraps canonical persistence.
2. `MessageStore` commits the platform event and produces a typed
   `CommittedPlatformEvent`.
3. `bridge/platform-event/publish` waterfall wraps MTProto update projection
   and delivery.
4. `im-platform/event-committed` fans out observers after the publish stage.

Registry and active-session changes are also Cordis events:

- `im-platform/change`
- `im-platform/session`
- `im-platform/event-committed`

The existing `IMPlatformService.onChange()`, `onSessionChange()`, and
`onCommittedEvent()` methods remain as small event-backed convenience APIs, so
their listeners are now owned by the calling fiber.

## Scope rules

- Process-wide mutable state belongs to a Service.
- Connection/session mutable state belongs to its long-lived child fiber.
- Packet/RPC/platform-event metadata belongs to a derived context.
- Registrations and external resources must be Cordis effects.
- Cross-cutting behavior uses waterfall events and calls `next()`.
- Observation uses `emit`/`parallel`; routing uses `serial`.

This split keeps transport mechanics, business routing, canonical persistence,
and update delivery independently interceptable while preserving their explicit
ordering and cleanup boundaries.
