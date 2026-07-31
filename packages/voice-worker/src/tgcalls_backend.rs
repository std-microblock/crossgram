//! Feature-gated safe adaptation of the versioned native tgcalls session ABI.
//!
//! The concrete FFI owner implements [`TgcallsFfiSession`]. Its declarations
//! are isolated so the worker is not activated or linked in production before
//! the approved tgcalls archive is packaged. It limits foreign data and clears
//! temporary copies on return.

use std::cell::Cell;
use std::ffi::{c_char, c_void};
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};

use zeroize::Zeroize;

use crate::ipc::PCM_FRAME_BYTES;
use crate::worker::{MediaBackend, MediaError};

const PCM_SAMPLES: usize = PCM_FRAME_BYTES / size_of::<i16>();
pub const AUTH_KEY_BYTES: usize = 256;
pub const MAX_ENDPOINTS: usize = 16;
const OUTBOUND_SIGNAL_QUEUE_CAPACITY: usize = 16;
const NO_CALLBACK_ERROR: NativeTgcallsStatus = u32::MAX;
#[cfg(test)]
static ZEROIZED_OUTBOUND_SIGNALS: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TgcallsEndpoint {
    pub id: i64,
    pub ipv4: String,
    pub ipv6: String,
    pub port: u16,
    pub kind: TgcallsEndpointKind,
    pub peer_tag: [u8; 16],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TgcallsEndpointKind {
    Inet,
    Lan,
    UdpRelay,
    TcpRelay,
}

pub struct TgcallsTransportOptions {
    pub enable_p2p: bool,
    pub allow_tcp: bool,
    pub protocol_v1: bool,
}

pub struct TgcallsAudioProcessing {
    pub enable_aec: bool,
    pub enable_ns: bool,
    pub enable_agc: bool,
}

/// Typed values copied once into the native session during its creation.
pub struct TgcallsSessionConfig {
    pub initialization_timeout_ms: u32,
    pub receive_timeout_ms: u32,
    pub transport: TgcallsTransportOptions,
    pub audio_processing: TgcallsAudioProcessing,
    pub auth_key: [u8; AUTH_KEY_BYTES],
    pub is_outgoing: bool,
    pub endpoints: Vec<TgcallsEndpoint>,
}

impl TgcallsSessionConfig {
    pub fn validate(&self) -> Result<(), MediaError> {
        if self.endpoints.is_empty()
            || self.endpoints.len() > MAX_ENDPOINTS
            || self.endpoints.iter().any(|endpoint| {
                endpoint.port == 0
                    || endpoint.ipv4.len() > 255
                    || endpoint.ipv6.len() > 255
                    || endpoint.ipv4.contains('\0')
                    || endpoint.ipv6.contains('\0')
                    || (endpoint.ipv4.is_empty() && endpoint.ipv6.is_empty())
            })
        {
            return Err(MediaError);
        }
        Ok(())
    }

    fn zeroize(&mut self) {
        self.initialization_timeout_ms.zeroize();
        self.receive_timeout_ms.zeroize();
        self.transport.enable_p2p.zeroize();
        self.transport.allow_tcp.zeroize();
        self.transport.protocol_v1.zeroize();
        self.audio_processing.enable_aec.zeroize();
        self.audio_processing.enable_ns.zeroize();
        self.audio_processing.enable_agc.zeroize();
        self.auth_key.zeroize();
        self.is_outgoing.zeroize();
        for endpoint in &mut self.endpoints {
            endpoint.id.zeroize();
            endpoint.ipv4.zeroize();
            endpoint.ipv6.zeroize();
            endpoint.port.zeroize();
            endpoint.peer_tag.zeroize();
        }
        self.endpoints.clear();
    }
}

impl Drop for TgcallsSessionConfig {
    fn drop(&mut self) {
        self.zeroize();
    }
}

/// Safe owner of one opaque C ABI session. Implementations must synchronously
/// copy every input and must not retain pointers passed to these methods.
pub trait TgcallsFfiSession {
    fn start(&mut self) -> Result<(), MediaError>;
    fn receive_signaling(&mut self, signal: &[u8]) -> Result<(), MediaError>;
    fn push_capture_20ms(&mut self, samples: &[i16; PCM_SAMPLES]) -> Result<(), MediaError>;
    fn pop_playout_20ms(&mut self, samples: &mut [i16; PCM_SAMPLES]) -> Result<bool, MediaError>;
    fn stop(&mut self);
    fn join(&mut self);
}

pub type NativeTgcallsStatus = u32;
pub const NATIVE_STATUS_OK: NativeTgcallsStatus = 0;
pub const NATIVE_STATUS_INVALID_ARGUMENT: NativeTgcallsStatus = 1;
pub const NATIVE_STATUS_STOPPED: NativeTgcallsStatus = 2;
pub const NATIVE_STATUS_INPUT_FULL: NativeTgcallsStatus = 3;
pub const NATIVE_STATUS_OUTPUT_EMPTY: NativeTgcallsStatus = 4;
pub const NATIVE_STATUS_ABI_MISMATCH: NativeTgcallsStatus = 5;
pub const NATIVE_STATUS_ALLOCATION_FAILED: NativeTgcallsStatus = 6;
pub const NATIVE_STATUS_INVALID_STATE: NativeTgcallsStatus = 7;
pub const NATIVE_STATUS_BACKEND_UNAVAILABLE: NativeTgcallsStatus = 8;
pub const NATIVE_STATUS_INTERNAL_ERROR: NativeTgcallsStatus = 9;
pub const NATIVE_TGCALLS_ABI_VERSION: u32 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
enum NativeStatusCode {
    Ok = NATIVE_STATUS_OK,
    InvalidArgument = NATIVE_STATUS_INVALID_ARGUMENT,
    Stopped = NATIVE_STATUS_STOPPED,
    InputFull = NATIVE_STATUS_INPUT_FULL,
    OutputEmpty = NATIVE_STATUS_OUTPUT_EMPTY,
    AbiMismatch = NATIVE_STATUS_ABI_MISMATCH,
    AllocationFailed = NATIVE_STATUS_ALLOCATION_FAILED,
    InvalidState = NATIVE_STATUS_INVALID_STATE,
    BackendUnavailable = NATIVE_STATUS_BACKEND_UNAVAILABLE,
    InternalError = NATIVE_STATUS_INTERNAL_ERROR,
}

impl TryFrom<NativeTgcallsStatus> for NativeStatusCode {
    type Error = MediaError;

    fn try_from(status: NativeTgcallsStatus) -> Result<Self, Self::Error> {
        match status {
            NATIVE_STATUS_OK => Ok(Self::Ok),
            NATIVE_STATUS_INVALID_ARGUMENT => Ok(Self::InvalidArgument),
            NATIVE_STATUS_STOPPED => Ok(Self::Stopped),
            NATIVE_STATUS_INPUT_FULL => Ok(Self::InputFull),
            NATIVE_STATUS_OUTPUT_EMPTY => Ok(Self::OutputEmpty),
            NATIVE_STATUS_ABI_MISMATCH => Ok(Self::AbiMismatch),
            NATIVE_STATUS_ALLOCATION_FAILED => Ok(Self::AllocationFailed),
            NATIVE_STATUS_INVALID_STATE => Ok(Self::InvalidState),
            NATIVE_STATUS_BACKEND_UNAVAILABLE => Ok(Self::BackendUnavailable),
            NATIVE_STATUS_INTERNAL_ERROR => Ok(Self::InternalError),
            _ => Err(MediaError),
        }
    }
}

fn native_status_result(status: NativeTgcallsStatus) -> Result<(), MediaError> {
    match NativeStatusCode::try_from(status)? {
        NativeStatusCode::Ok => Ok(()),
        NativeStatusCode::InvalidArgument
        | NativeStatusCode::Stopped
        | NativeStatusCode::InputFull
        | NativeStatusCode::OutputEmpty
        | NativeStatusCode::AbiMismatch
        | NativeStatusCode::AllocationFailed
        | NativeStatusCode::InvalidState
        | NativeStatusCode::BackendUnavailable
        | NativeStatusCode::InternalError => Err(MediaError),
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NativeStringView {
    pub data: *const c_char,
    pub length: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NativeEndpoint {
    pub id: i64,
    pub ipv4: NativeStringView,
    pub ipv6: NativeStringView,
    pub port: u16,
    pub kind: u32,
    pub peer_tag: [u8; 16],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NativeSessionConfig {
    pub initialization_timeout_ms: u32,
    pub receive_timeout_ms: u32,
    pub enable_p2p: u8,
    pub allow_tcp: u8,
    pub enable_aec: u8,
    pub enable_ns: u8,
    pub enable_agc: u8,
    pub protocol_version: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NativeSessionAuth {
    pub key: *const u8,
    pub key_length: u32,
    pub is_outgoing: u8,
}

pub type NativeOutboundSignalingCallback = Option<extern "C" fn(*mut c_void, *const u8, u32)>;
pub type NativeErrorCallback = Option<extern "C" fn(*mut c_void, NativeTgcallsStatus)>;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NativeSessionCallbacks {
    pub context: *mut c_void,
    pub outbound_signaling: NativeOutboundSignalingCallback,
    pub error: NativeErrorCallback,
}

/// One copied outbound native signaling payload. The bytes are wiped when the
/// event is dropped, including when a future bridge rejects it.
pub struct NativeOutboundSignal {
    payload: Vec<u8>,
}

impl NativeOutboundSignal {
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.payload
    }
}

impl Drop for NativeOutboundSignal {
    fn drop(&mut self) {
        self.payload.zeroize();
        #[cfg(test)]
        ZEROIZED_OUTBOUND_SIGNALS.fetch_add(1, Ordering::Relaxed);
    }
}

struct NativeCallbackContext {
    accepting: AtomicBool,
    first_error: AtomicU32,
    sender: SyncSender<NativeOutboundSignal>,
    receiver: Mutex<Option<Receiver<NativeOutboundSignal>>>,
}

impl NativeCallbackContext {
    fn new() -> Self {
        let (sender, receiver) = sync_channel(OUTBOUND_SIGNAL_QUEUE_CAPACITY);
        Self {
            accepting: AtomicBool::new(true),
            first_error: AtomicU32::new(NO_CALLBACK_ERROR),
            sender,
            receiver: Mutex::new(Some(receiver)),
        }
    }

    fn callbacks(context: &Arc<Self>) -> NativeSessionCallbacks {
        NativeSessionCallbacks {
            context: Arc::as_ptr(context).cast_mut().cast(),
            outbound_signaling: Some(ffi::outbound_signaling),
            error: Some(ffi::error),
        }
    }

    fn disable_and_clear(&self) {
        self.accepting.store(false, Ordering::SeqCst);
        if let Ok(receiver) = self.receiver.lock()
            && let Some(receiver) = receiver.as_ref()
        {
            while let Ok(signal) = receiver.try_recv() {
                drop(signal);
            }
        }
    }

    fn first_error(&self) -> Option<NativeTgcallsStatus> {
        let status = self.first_error.load(Ordering::SeqCst);
        (status != NO_CALLBACK_ERROR).then_some(status)
    }
}

/// Safe future-facing access to copied native callback events. Draining is not
/// connected to worker IPC in this issue.
#[derive(Clone)]
pub struct NativeTgcallsEvents {
    context: Arc<NativeCallbackContext>,
}

impl NativeTgcallsEvents {
    #[must_use]
    pub fn try_recv(&self) -> Option<NativeOutboundSignal> {
        let receiver = self.context.receiver.lock().ok()?;
        receiver.as_ref()?.try_recv().ok()
    }

    #[cfg(test)]
    fn disconnect_for_test(&self) {
        let _ = self
            .context
            .receiver
            .lock()
            .map(|mut receiver| receiver.take());
    }

    #[must_use]
    pub fn first_error(&self) -> Option<NativeTgcallsStatus> {
        self.context.first_error()
    }
}

/// Borrowed native creation data. Its pointers remain valid only for the
/// synchronous [`NativeTgcallsApi::create`] call that received this value.
pub struct NativeSessionCreateInput {
    config: NativeSessionConfig,
    auth_key: [u8; AUTH_KEY_BYTES],
    is_outgoing: u8,
    hosts: Vec<Vec<u8>>,
    endpoints: Vec<NativeEndpoint>,
}

impl NativeSessionCreateInput {
    fn from_config(config: &TgcallsSessionConfig) -> Self {
        let mut hosts = Vec::with_capacity(config.endpoints.len() * 2);
        for endpoint in &config.endpoints {
            hosts.push(endpoint.ipv4.as_bytes().to_vec());
            hosts.push(endpoint.ipv6.as_bytes().to_vec());
        }
        let endpoints = config
            .endpoints
            .iter()
            .enumerate()
            .map(|(index, endpoint)| {
                let ipv4 = &hosts[index * 2];
                let ipv6 = &hosts[index * 2 + 1];
                NativeEndpoint {
                    id: endpoint.id,
                    ipv4: NativeStringView {
                        data: ipv4.as_ptr().cast(),
                        length: u32::try_from(ipv4.len())
                            .expect("validated endpoint host length fits u32"),
                    },
                    ipv6: NativeStringView {
                        data: ipv6.as_ptr().cast(),
                        length: u32::try_from(ipv6.len())
                            .expect("validated endpoint host length fits u32"),
                    },
                    port: endpoint.port,
                    kind: native_endpoint_kind(endpoint.kind),
                    peer_tag: endpoint.peer_tag,
                }
            })
            .collect();
        Self {
            config: NativeSessionConfig {
                initialization_timeout_ms: config.initialization_timeout_ms,
                receive_timeout_ms: config.receive_timeout_ms,
                enable_p2p: u8::from(config.transport.enable_p2p),
                allow_tcp: u8::from(config.transport.allow_tcp),
                enable_aec: u8::from(config.audio_processing.enable_aec),
                enable_ns: u8::from(config.audio_processing.enable_ns),
                enable_agc: u8::from(config.audio_processing.enable_agc),
                protocol_version: u32::from(config.transport.protocol_v1),
            },
            auth_key: config.auth_key,
            is_outgoing: u8::from(config.is_outgoing),
            hosts,
            endpoints,
        }
    }

    #[must_use]
    pub const fn config(&self) -> &NativeSessionConfig {
        &self.config
    }

    #[must_use]
    pub fn auth(&self) -> NativeSessionAuth {
        NativeSessionAuth {
            key: self.auth_key.as_ptr(),
            key_length: 256,
            is_outgoing: self.is_outgoing,
        }
    }

    /// Safe adapters can copy the key without retaining the borrowed input.
    #[must_use]
    pub fn auth_key(&self) -> &[u8; AUTH_KEY_BYTES] {
        &self.auth_key
    }

    #[must_use]
    pub fn endpoints(&self) -> &[NativeEndpoint] {
        &self.endpoints
    }

    fn zeroize(&mut self) {
        self.config.initialization_timeout_ms.zeroize();
        self.config.receive_timeout_ms.zeroize();
        self.config.enable_p2p.zeroize();
        self.config.allow_tcp.zeroize();
        self.config.enable_aec.zeroize();
        self.config.enable_ns.zeroize();
        self.config.enable_agc.zeroize();
        self.config.protocol_version.zeroize();
        self.auth_key.zeroize();
        self.is_outgoing.zeroize();
        for host in &mut self.hosts {
            host.zeroize();
        }
        self.hosts.clear();
        for endpoint in &mut self.endpoints {
            endpoint.id.zeroize();
            endpoint.ipv4.data = core::ptr::null();
            endpoint.ipv4.length.zeroize();
            endpoint.ipv6.data = core::ptr::null();
            endpoint.ipv6.length.zeroize();
            endpoint.port.zeroize();
            endpoint.kind.zeroize();
            endpoint.peer_tag.zeroize();
        }
        self.endpoints.clear();
    }
}

impl Drop for NativeSessionCreateInput {
    fn drop(&mut self) {
        self.zeroize();
    }
}

// The only unsafe boundary in this crate. The functions below map the versioned
// declarations in `crossgram/tgcalls_shim.h`; all callers use safe wrappers.
#[allow(unsafe_code, clippy::wildcard_imports)]
mod ffi {
    use super::*;

    #[repr(C)]
    pub(super) struct Session {
        _private: [u8; 0],
    }

    // Raw opaque C handles are transferable to their serialized !Sync owner.
    unsafe impl Send for super::ShimSessionHandle {}

    unsafe extern "C" {
        fn crossgram_tgcalls_shim_abi_version() -> u32;
        fn crossgram_tgcalls_session_create(
            abi_version: u32,
            config: *const NativeSessionConfig,
            auth: *const NativeSessionAuth,
            endpoints: *const NativeEndpoint,
            endpoint_count: u32,
            callbacks: *const NativeSessionCallbacks,
            out_session: *mut *mut Session,
        ) -> NativeTgcallsStatus;
        fn crossgram_tgcalls_session_start(session: *mut Session) -> NativeTgcallsStatus;
        fn crossgram_tgcalls_session_receive_signaling(
            session: *mut Session,
            data: *const u8,
            length: u32,
        ) -> NativeTgcallsStatus;
        fn crossgram_tgcalls_session_push_capture_20ms(
            session: *mut Session,
            samples: *const i16,
        ) -> NativeTgcallsStatus;
        fn crossgram_tgcalls_session_pop_playout_20ms(
            session: *mut Session,
            samples: *mut i16,
        ) -> NativeTgcallsStatus;
        fn crossgram_tgcalls_session_stop(session: *mut Session) -> NativeTgcallsStatus;
        fn crossgram_tgcalls_session_join(session: *mut Session) -> NativeTgcallsStatus;
        fn crossgram_tgcalls_session_destroy(session: *mut *mut Session) -> NativeTgcallsStatus;
    }

    pub(super) fn abi_version() -> u32 {
        // SAFETY: this ABI function has no arguments and cannot alias Rust data.
        unsafe { crossgram_tgcalls_shim_abi_version() }
    }

    pub(super) fn create(
        abi_version: u32,
        input: &NativeSessionCreateInput,
        callbacks: &NativeSessionCallbacks,
        out_session: *mut *mut Session,
    ) -> NativeTgcallsStatus {
        let auth = input.auth();
        let endpoint_count =
            u32::try_from(input.endpoints().len()).expect("validated endpoint count fits u32");
        // SAFETY: every referenced input lives for this synchronous C call and
        // the shim copies each typed input before it returns.
        unsafe {
            crossgram_tgcalls_session_create(
                abi_version,
                input.config(),
                &raw const auth,
                input.endpoints().as_ptr(),
                endpoint_count,
                callbacks,
                out_session,
            )
        }
    }

    pub(super) fn start(session: *mut Session) -> NativeTgcallsStatus {
        // SAFETY: `ShimSessionHandle` owns this non-null shim session pointer.
        unsafe { crossgram_tgcalls_session_start(session) }
    }

    pub(super) fn receive_signaling(session: *mut Session, signal: &[u8]) -> NativeTgcallsStatus {
        let length = u32::try_from(signal.len()).expect("worker signal bound fits u32");
        // SAFETY: the shim copies the bounded signaling bytes before returning.
        unsafe { crossgram_tgcalls_session_receive_signaling(session, signal.as_ptr(), length) }
    }

    pub(super) fn push_capture_20ms(
        session: *mut Session,
        samples: &[i16; PCM_SAMPLES],
    ) -> NativeTgcallsStatus {
        // SAFETY: the shim synchronously copies this fixed-size PCM frame.
        unsafe { crossgram_tgcalls_session_push_capture_20ms(session, samples.as_ptr()) }
    }

    pub(super) fn pop_playout_20ms(
        session: *mut Session,
        samples: &mut [i16; PCM_SAMPLES],
    ) -> NativeTgcallsStatus {
        // SAFETY: `samples` provides writable fixed-size caller-owned storage.
        unsafe { crossgram_tgcalls_session_pop_playout_20ms(session, samples.as_mut_ptr()) }
    }

    pub(super) fn stop(session: *mut Session) -> NativeTgcallsStatus {
        // SAFETY: `ShimSessionHandle` retains exclusive serialized ownership.
        unsafe { crossgram_tgcalls_session_stop(session) }
    }

    pub(super) fn join(session: *mut Session) -> NativeTgcallsStatus {
        // SAFETY: `ShimSessionHandle` retains exclusive serialized ownership.
        unsafe { crossgram_tgcalls_session_join(session) }
    }

    pub(super) fn destroy(session: *mut *mut Session) -> NativeTgcallsStatus {
        // SAFETY: this is an explicit C owning slot, not a Rust `Option` layout.
        unsafe { crossgram_tgcalls_session_destroy(session) }
    }

    pub(super) extern "C" fn outbound_signaling(
        context: *mut c_void,
        data: *const u8,
        length: u32,
    ) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if context.is_null() || data.is_null() || length == 0 {
                return;
            }
            let length = usize::try_from(length).expect("u32 always fits usize");
            if length > crate::ipc::MAX_SIGNAL_BYTES {
                return;
            }
            // SAFETY: C owns `data` for this synchronous callback. The session
            // owns `context` through Join's callback-quiescence boundary.
            let context = unsafe { &*context.cast::<NativeCallbackContext>() };
            if !context.accepting.load(Ordering::Acquire) {
                return;
            }
            // This is the sole copy from foreign memory; queue ownership transfers it.
            let payload = unsafe { std::slice::from_raw_parts(data, length) }.to_vec();
            match context.sender.try_send(NativeOutboundSignal { payload }) {
                Ok(()) => {}
                Err(TrySendError::Full(signal) | TrySendError::Disconnected(signal)) => {
                    drop(signal);
                }
            }
        }));
    }

    pub(super) extern "C" fn error(context: *mut c_void, status: NativeTgcallsStatus) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if context.is_null()
                || status == NATIVE_STATUS_OK
                || NativeStatusCode::try_from(status).is_err()
            {
                return;
            }
            // SAFETY: the native session cannot call this context after Join returns.
            let context = unsafe { &*context.cast::<NativeCallbackContext>() };
            let _ = context.first_error.compare_exchange(
                NO_CALLBACK_ERROR,
                status,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }));
    }
}

/// Concrete, feature-gated symbol adapter. Instantiating it is deliberately not
/// wired into `main.rs`; artifact linkage and production selection are separate.
pub struct ShimTgcallsApi;

impl ShimTgcallsApi {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

impl Default for ShimTgcallsApi {
    fn default() -> Self {
        Self::new()
    }
}

pub struct ShimSessionHandle {
    raw: *mut ffi::Session,
}

impl NativeTgcallsApi for ShimTgcallsApi {
    type Handle = ShimSessionHandle;

    fn create(
        &mut self,
        abi_version: u32,
        input: &NativeSessionCreateInput,
        callbacks: NativeSessionCallbacks,
        handle: &mut Option<Self::Handle>,
    ) -> NativeTgcallsStatus {
        if ffi::abi_version() != abi_version {
            return NATIVE_STATUS_ABI_MISMATCH;
        }
        let mut raw = core::ptr::null_mut();
        let status = ffi::create(abi_version, input, &callbacks, &raw mut raw);
        if !raw.is_null() {
            *handle = Some(ShimSessionHandle { raw });
        }
        status
    }

    fn start(&mut self, handle: &mut Self::Handle) -> NativeTgcallsStatus {
        ffi::start(handle.raw)
    }

    fn receive_signaling(
        &mut self,
        handle: &mut Self::Handle,
        signal: &[u8],
    ) -> NativeTgcallsStatus {
        ffi::receive_signaling(handle.raw, signal)
    }

    fn push_capture_20ms(
        &mut self,
        handle: &mut Self::Handle,
        samples: &[i16; PCM_SAMPLES],
    ) -> NativeTgcallsStatus {
        ffi::push_capture_20ms(handle.raw, samples)
    }

    fn pop_playout_20ms(
        &mut self,
        handle: &mut Self::Handle,
        samples: &mut [i16; PCM_SAMPLES],
    ) -> NativeTgcallsStatus {
        ffi::pop_playout_20ms(handle.raw, samples)
    }

    fn stop(&mut self, handle: &mut Self::Handle) -> NativeTgcallsStatus {
        ffi::stop(handle.raw)
    }

    fn join(&mut self, handle: &mut Self::Handle) -> NativeTgcallsStatus {
        ffi::join(handle.raw)
    }

    fn destroy(&mut self, handle: &mut Option<Self::Handle>) -> NativeTgcallsStatus {
        let mut raw = handle
            .as_ref()
            .map_or(core::ptr::null_mut(), |handle| handle.raw);
        let status = ffi::destroy(&raw mut raw);
        if status == NATIVE_STATUS_OK {
            *handle = None;
        }
        status
    }
}

const fn native_endpoint_kind(kind: TgcallsEndpointKind) -> u32 {
    match kind {
        TgcallsEndpointKind::Inet => 0,
        TgcallsEndpointKind::Lan => 1,
        TgcallsEndpointKind::UdpRelay => 2,
        TgcallsEndpointKind::TcpRelay => 3,
    }
}

/// Safe adapter for the native C symbols. `create` must synchronously copy all
/// fields from `input` and may retain `callbacks` only until Join returns. Its
/// opaque handle is owned by `NativeTgcallsSession`; `destroy` receives an
/// explicit owning slot rather than relying on Rust's `Option` layout.
pub trait NativeTgcallsApi: Send {
    type Handle: Send;

    fn create(
        &mut self,
        abi_version: u32,
        input: &NativeSessionCreateInput,
        callbacks: NativeSessionCallbacks,
        handle: &mut Option<Self::Handle>,
    ) -> NativeTgcallsStatus;
    fn start(&mut self, handle: &mut Self::Handle) -> NativeTgcallsStatus;
    fn receive_signaling(
        &mut self,
        handle: &mut Self::Handle,
        signal: &[u8],
    ) -> NativeTgcallsStatus;
    fn push_capture_20ms(
        &mut self,
        handle: &mut Self::Handle,
        samples: &[i16; PCM_SAMPLES],
    ) -> NativeTgcallsStatus;
    fn pop_playout_20ms(
        &mut self,
        handle: &mut Self::Handle,
        samples: &mut [i16; PCM_SAMPLES],
    ) -> NativeTgcallsStatus;
    fn stop(&mut self, handle: &mut Self::Handle) -> NativeTgcallsStatus;
    fn join(&mut self, handle: &mut Self::Handle) -> NativeTgcallsStatus;
    fn destroy(&mut self, handle: &mut Option<Self::Handle>) -> NativeTgcallsStatus;
}

/// An opaque native session owner. It is `Send` when its adapter and handle are
/// `Send`, but intentionally not `Sync`; all methods require exclusive access,
/// matching the native session's serialized control-owner requirement.
pub struct NativeTgcallsSession<A: NativeTgcallsApi> {
    api: A,
    handle: Option<A::Handle>,
    callbacks: Option<Arc<NativeCallbackContext>>,
    not_sync: PhantomData<Cell<()>>,
}

impl<A: NativeTgcallsApi> NativeTgcallsSession<A> {
    /// Creates the native opaque session during construction and zeroizes the
    /// supplied configuration regardless of validation or native-create status.
    /// A failed create intentionally retains a bounded callback context: without
    /// a successful Join, freeing C-visible userdata would risk a use-after-free.
    pub fn create(mut api: A, config: &mut TgcallsSessionConfig) -> Result<Self, MediaError> {
        if config.validate().is_err() {
            config.zeroize();
            return Err(MediaError);
        }
        let callbacks = Arc::new(NativeCallbackContext::new());
        let native_callbacks = NativeCallbackContext::callbacks(&callbacks);
        let mut input = NativeSessionCreateInput::from_config(config);
        let mut handle = None;
        let status = catch_unwind(AssertUnwindSafe(|| {
            api.create(
                NATIVE_TGCALLS_ABI_VERSION,
                &input,
                native_callbacks,
                &mut handle,
            )
        }));
        input.zeroize();
        config.zeroize();
        let Ok(status) = status else {
            callbacks.disable_and_clear();
            std::mem::forget(callbacks);
            return Err(MediaError);
        };
        if native_status_result(status).is_err() || handle.is_none() {
            let _ = catch_unwind(AssertUnwindSafe(|| api.destroy(&mut handle)));
            callbacks.disable_and_clear();
            std::mem::forget(callbacks);
            return Err(MediaError);
        }
        Ok(Self {
            api,
            handle,
            callbacks: Some(callbacks),
            not_sync: PhantomData,
        })
    }

    /// Returns a safe drain handle for native callback data. No worker-to-bridge
    /// delivery is attached here.
    #[must_use]
    pub fn events(&self) -> Option<NativeTgcallsEvents> {
        self.callbacks.as_ref().map(|context| NativeTgcallsEvents {
            context: Arc::clone(context),
        })
    }

    /// Stops, joins, and destroys the session. A failed destroy retains its
    /// explicit handle slot for a later idempotent retry.
    pub fn shutdown(&mut self) -> Result<(), MediaError> {
        let stop_result = catch_unwind(AssertUnwindSafe(|| {
            self.with_handle(NativeTgcallsApi::stop)
        }))
        .unwrap_or(Err(MediaError));
        // Join is the callback-quiescence boundary, so it must be attempted even
        // when stop failed or panicked. Preserve the stop failure when both fail.
        let join_result =
            catch_unwind(AssertUnwindSafe(|| self.join_terminal())).unwrap_or(Err(MediaError));
        stop_result.and(join_result)
    }

    fn with_handle(
        &mut self,
        call: impl FnOnce(&mut A, &mut A::Handle) -> NativeTgcallsStatus,
    ) -> Result<(), MediaError> {
        let handle = self.handle.as_mut().ok_or(MediaError)?;
        native_status_result(call(&mut self.api, handle))
    }

    fn join_terminal(&mut self) -> Result<(), MediaError> {
        let Some(handle) = self.handle.as_mut() else {
            return Ok(());
        };
        native_status_result(self.api.join(handle))?;
        if let Some(callbacks) = &self.callbacks {
            callbacks.disable_and_clear();
        }
        native_status_result(self.api.destroy(&mut self.handle))?;
        self.callbacks = None;
        Ok(())
    }

    fn leak_callbacks(&mut self) {
        if let Some(callbacks) = self.callbacks.take() {
            std::mem::forget(callbacks);
        }
    }
}

impl<A: NativeTgcallsApi> Drop for NativeTgcallsSession<A> {
    fn drop(&mut self) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if let Some(handle) = self.handle.as_mut() {
                let _ = self.api.stop(handle);
            }
        }));
        let joined = catch_unwind(AssertUnwindSafe(|| self.join_terminal()));
        if !matches!(joined, Ok(Ok(())))
            && self.handle.is_some()
            && self
                .callbacks
                .as_ref()
                .is_some_and(|callbacks| callbacks.accepting.load(Ordering::Acquire))
        {
            // Without Join's quiescence guarantee, native code may still hold
            // this pointer, so preserving the bounded context is safer than UAF.
            self.leak_callbacks();
        }
    }
}

impl<A: NativeTgcallsApi> TgcallsFfiSession for NativeTgcallsSession<A> {
    fn start(&mut self) -> Result<(), MediaError> {
        self.with_handle(NativeTgcallsApi::start)
    }

    fn receive_signaling(&mut self, signal: &[u8]) -> Result<(), MediaError> {
        self.with_handle(|api, handle| api.receive_signaling(handle, signal))
    }

    fn push_capture_20ms(&mut self, samples: &[i16; PCM_SAMPLES]) -> Result<(), MediaError> {
        self.with_handle(|api, handle| api.push_capture_20ms(handle, samples))
    }

    fn pop_playout_20ms(&mut self, samples: &mut [i16; PCM_SAMPLES]) -> Result<bool, MediaError> {
        let handle = self.handle.as_mut().ok_or(MediaError)?;
        match NativeStatusCode::try_from(self.api.pop_playout_20ms(handle, samples))? {
            NativeStatusCode::Ok => Ok(true),
            NativeStatusCode::OutputEmpty => Ok(false),
            NativeStatusCode::InvalidArgument
            | NativeStatusCode::Stopped
            | NativeStatusCode::InputFull
            | NativeStatusCode::AbiMismatch
            | NativeStatusCode::AllocationFailed
            | NativeStatusCode::InvalidState
            | NativeStatusCode::BackendUnavailable
            | NativeStatusCode::InternalError => Err(MediaError),
        }
    }

    fn stop(&mut self) {
        let _ = self.with_handle(NativeTgcallsApi::stop);
    }

    fn join(&mut self) {
        let _ = self.join_terminal();
    }
}

/// Production fallback adapter. It creates no handle and therefore cannot make
/// media active before an approved native symbol adapter is linked.
pub struct UnavailableNativeTgcallsApi;

impl NativeTgcallsApi for UnavailableNativeTgcallsApi {
    type Handle = ();

    fn create(
        &mut self,
        _abi_version: u32,
        _input: &NativeSessionCreateInput,
        _callbacks: NativeSessionCallbacks,
        _handle: &mut Option<Self::Handle>,
    ) -> NativeTgcallsStatus {
        NATIVE_STATUS_BACKEND_UNAVAILABLE
    }

    fn start(&mut self, _handle: &mut Self::Handle) -> NativeTgcallsStatus {
        NATIVE_STATUS_BACKEND_UNAVAILABLE
    }

    fn receive_signaling(
        &mut self,
        _handle: &mut Self::Handle,
        _signal: &[u8],
    ) -> NativeTgcallsStatus {
        NATIVE_STATUS_BACKEND_UNAVAILABLE
    }

    fn push_capture_20ms(
        &mut self,
        _handle: &mut Self::Handle,
        _samples: &[i16; PCM_SAMPLES],
    ) -> NativeTgcallsStatus {
        NATIVE_STATUS_BACKEND_UNAVAILABLE
    }

    fn pop_playout_20ms(
        &mut self,
        _handle: &mut Self::Handle,
        _samples: &mut [i16; PCM_SAMPLES],
    ) -> NativeTgcallsStatus {
        NATIVE_STATUS_BACKEND_UNAVAILABLE
    }

    fn stop(&mut self, _handle: &mut Self::Handle) -> NativeTgcallsStatus {
        NATIVE_STATUS_BACKEND_UNAVAILABLE
    }

    fn join(&mut self, _handle: &mut Self::Handle) -> NativeTgcallsStatus {
        NATIVE_STATUS_BACKEND_UNAVAILABLE
    }

    fn destroy(&mut self, handle: &mut Option<Self::Handle>) -> NativeTgcallsStatus {
        *handle = None;
        NATIVE_STATUS_BACKEND_UNAVAILABLE
    }
}

/// A `MediaBackend` which exposes PCM only after the native session has started.
/// It is intentionally feature-gated and is not selected by the production
/// worker entrypoint until the approved native artifact is linked.
pub struct TgcallsMediaBackend<S: TgcallsFfiSession> {
    session: Option<S>,
    config: TgcallsSessionConfig,
    started: bool,
}

impl<S: TgcallsFfiSession> TgcallsMediaBackend<S> {
    #[must_use]
    pub fn new(session: S, config: TgcallsSessionConfig) -> Self {
        Self {
            session: Some(session),
            config,
            started: false,
        }
    }

    #[must_use]
    pub fn config_auth_is_zeroized(&self) -> bool {
        self.config.auth_key == [0; AUTH_KEY_BYTES]
    }

    fn session_mut(&mut self) -> Result<&mut S, MediaError> {
        self.session.as_mut().ok_or(MediaError)
    }

    fn terminal_stop(&mut self) {
        if let Some(mut session) = self.session.take() {
            let _ = catch_unwind(AssertUnwindSafe(|| session.stop()));
            let _ = catch_unwind(AssertUnwindSafe(|| session.join()));
        }
        self.started = false;
        self.config.zeroize();
    }
}

impl<S: TgcallsFfiSession> Drop for TgcallsMediaBackend<S> {
    fn drop(&mut self) {
        self.terminal_stop();
    }
}

impl<S: TgcallsFfiSession> MediaBackend for TgcallsMediaBackend<S> {
    type Handle = ();
    type Pcm = ();

    fn start(&mut self, _call_id: u64) -> Result<Self::Handle, MediaError> {
        if self.started {
            return Err(MediaError);
        }
        if self.config.validate().is_err() {
            self.config.zeroize();
            return Err(MediaError);
        }
        let result = self.session_mut().and_then(|session| {
            catch_unwind(AssertUnwindSafe(|| session.start())).map_err(|_| MediaError)?
        });
        self.config.zeroize();
        if result.is_err() {
            self.terminal_stop();
            return Err(MediaError);
        }
        self.started = true;
        Ok(())
    }

    fn forward_signal(
        &mut self,
        _handle: &mut Self::Handle,
        signal: &[u8],
    ) -> Result<(), MediaError> {
        if !self.started {
            return Err(MediaError);
        }
        let mut copy = signal.to_vec();
        let result = self.session_mut().and_then(|session| {
            catch_unwind(AssertUnwindSafe(|| session.receive_signaling(&copy)))
                .map_err(|_| MediaError)?
        });
        copy.zeroize();
        result
    }

    fn attach_pcm(&mut self, _handle: &mut Self::Handle) -> Result<Self::Pcm, MediaError> {
        self.started.then_some(()).ok_or(MediaError)
    }

    fn send_pcm(
        &mut self,
        _pcm: &mut Self::Pcm,
        frame: &[u8; PCM_FRAME_BYTES],
    ) -> Result<(), MediaError> {
        if !self.started {
            return Err(MediaError);
        }
        let mut samples = decode_pcm(frame);
        let result = self.session_mut().and_then(|session| {
            catch_unwind(AssertUnwindSafe(|| session.push_capture_20ms(&samples)))
                .map_err(|_| MediaError)?
        });
        samples.zeroize();
        result
    }

    fn receive_pcm(
        &mut self,
        _pcm: &mut Self::Pcm,
    ) -> Result<Option<[u8; PCM_FRAME_BYTES]>, MediaError> {
        if !self.started {
            return Err(MediaError);
        }
        let mut samples = [0_i16; PCM_SAMPLES];
        let result = self.session_mut().and_then(|session| {
            catch_unwind(AssertUnwindSafe(|| session.pop_playout_20ms(&mut samples)))
                .map_err(|_| MediaError)?
        });
        let output = result.map(|has_frame| has_frame.then(|| encode_pcm(&samples)));
        samples.zeroize();
        output
    }

    fn close_pcm(&mut self, _pcm: Self::Pcm) {
        self.terminal_stop();
    }

    fn stop(&mut self, _handle: Self::Handle) {
        self.terminal_stop();
    }
}

fn decode_pcm(frame: &[u8; PCM_FRAME_BYTES]) -> [i16; PCM_SAMPLES] {
    let mut samples = [0_i16; PCM_SAMPLES];
    for (sample, bytes) in samples.iter_mut().zip(frame.chunks_exact(size_of::<i16>())) {
        *sample = i16::from_le_bytes([bytes[0], bytes[1]]);
    }
    samples
}

fn encode_pcm(samples: &[i16; PCM_SAMPLES]) -> [u8; PCM_FRAME_BYTES] {
    let mut frame = [0_u8; PCM_FRAME_BYTES];
    for (sample, bytes) in samples.iter().zip(frame.chunks_exact_mut(size_of::<i16>())) {
        bytes.copy_from_slice(&sample.to_le_bytes());
    }
    frame
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Default)]
    struct FakeFfiSession {
        started: usize,
        stopped: usize,
        joined: usize,
        inbound: Vec<Vec<u8>>,
        playout: VecDeque<[i16; PCM_SAMPLES]>,
        capture: Vec<[i16; PCM_SAMPLES]>,
        fail_start: bool,
    }

    impl TgcallsFfiSession for FakeFfiSession {
        fn start(&mut self) -> Result<(), MediaError> {
            self.started += 1;
            (!self.fail_start).then_some(()).ok_or(MediaError)
        }

        fn receive_signaling(&mut self, signal: &[u8]) -> Result<(), MediaError> {
            self.inbound.push(signal.to_vec());
            Ok(())
        }

        fn push_capture_20ms(&mut self, samples: &[i16; PCM_SAMPLES]) -> Result<(), MediaError> {
            self.capture.push(*samples);
            Ok(())
        }

        fn pop_playout_20ms(
            &mut self,
            samples: &mut [i16; PCM_SAMPLES],
        ) -> Result<bool, MediaError> {
            let Some(frame) = self.playout.pop_front() else {
                return Ok(false);
            };
            *samples = frame;
            Ok(true)
        }

        fn stop(&mut self) {
            self.stopped += 1;
        }

        fn join(&mut self) {
            self.joined += 1;
        }
    }

    fn config() -> TgcallsSessionConfig {
        TgcallsSessionConfig {
            initialization_timeout_ms: 1,
            receive_timeout_ms: 1,
            transport: TgcallsTransportOptions {
                enable_p2p: true,
                allow_tcp: false,
                protocol_v1: true,
            },
            audio_processing: TgcallsAudioProcessing {
                enable_aec: false,
                enable_ns: false,
                enable_agc: false,
            },
            auth_key: [7; AUTH_KEY_BYTES],
            is_outgoing: true,
            endpoints: vec![TgcallsEndpoint {
                id: 1,
                ipv4: "149.154.167.51".into(),
                ipv6: String::new(),
                port: 443,
                kind: TgcallsEndpointKind::UdpRelay,
                peer_tag: [1; 16],
            }],
        }
    }

    #[test]
    fn no_network_backend_forwards_signaling_and_pcm_after_start() {
        let mut session = FakeFfiSession::default();
        session.playout.push_back([22; PCM_SAMPLES]);
        let mut backend = TgcallsMediaBackend::new(session, config());
        let mut handle = ();
        let mut pcm = ();
        assert!(!backend.config_auth_is_zeroized());

        assert_eq!(backend.start(9), Ok(()));
        assert!(backend.config_auth_is_zeroized());
        assert_eq!(backend.forward_signal(&mut handle, &[4, 5]), Ok(()));
        assert_eq!(backend.attach_pcm(&mut handle), Ok(()));
        assert_eq!(backend.send_pcm(&mut pcm, &[3; PCM_FRAME_BYTES]), Ok(()));
        let frame = backend.receive_pcm(&mut pcm).unwrap().unwrap();
        assert_eq!(&frame[..2], &[22, 0]);
        let session = backend.session.as_ref().unwrap();
        assert_eq!(session.started, 1);
        assert_eq!(session.inbound, vec![vec![4, 5]]);
        assert_eq!(session.capture, vec![[0x0303_i16; PCM_SAMPLES]]);
        assert_eq!(backend.receive_pcm(&mut pcm), Ok(None));
        backend.close_pcm(pcm);
        assert!(backend.session.is_none());
    }

    #[test]
    fn failing_start_never_exposes_pcm_and_zeroizes_auth() {
        let session = FakeFfiSession {
            fail_start: true,
            ..FakeFfiSession::default()
        };
        let mut backend = TgcallsMediaBackend::new(session, config());
        assert_eq!(backend.start(1), Err(MediaError));
        assert!(backend.config_auth_is_zeroized());
        assert_eq!(backend.attach_pcm(&mut ()), Err(MediaError));
    }

    #[derive(Default)]
    struct PanicStopSession {
        joined: Arc<Mutex<usize>>,
    }

    impl TgcallsFfiSession for PanicStopSession {
        fn start(&mut self) -> Result<(), MediaError> {
            Ok(())
        }

        fn receive_signaling(&mut self, _signal: &[u8]) -> Result<(), MediaError> {
            Ok(())
        }

        fn push_capture_20ms(&mut self, _samples: &[i16; PCM_SAMPLES]) -> Result<(), MediaError> {
            Ok(())
        }

        fn pop_playout_20ms(
            &mut self,
            _samples: &mut [i16; PCM_SAMPLES],
        ) -> Result<bool, MediaError> {
            Ok(false)
        }

        fn stop(&mut self) {
            panic!("test stop panic");
        }

        fn join(&mut self) {
            *self.joined.lock().unwrap() += 1;
        }
    }

    #[test]
    fn terminal_stop_attempts_join_after_a_stop_panic() {
        let joined = Arc::new(Mutex::new(0));
        let session = PanicStopSession {
            joined: Arc::clone(&joined),
        };
        let mut backend = TgcallsMediaBackend::new(session, config());
        backend.stop(());
        assert!(backend.session.is_none());
        assert_eq!(*joined.lock().unwrap(), 1);
    }

    #[derive(Clone, Copy)]
    struct FakeCallbacks {
        context: usize,
        outbound_signaling: NativeOutboundSignalingCallback,
        error: NativeErrorCallback,
    }

    #[derive(Default)]
    struct NativeCallState {
        abi_version: u32,
        copied_auth: Vec<u8>,
        copied_endpoint_kind: u32,
        callbacks: Option<FakeCallbacks>,
        create_status: NativeTgcallsStatus,
        created: usize,
        stopped: usize,
        joined: usize,
        destroyed: usize,
        stop_panics: bool,
        destroy_failures: usize,
        callback_during_join: Option<Vec<u8>>,
    }

    struct FakeNativeApi {
        state: Arc<Mutex<NativeCallState>>,
    }

    impl NativeTgcallsApi for FakeNativeApi {
        type Handle = u64;

        fn create(
            &mut self,
            abi_version: u32,
            input: &NativeSessionCreateInput,
            callbacks: NativeSessionCallbacks,
            handle: &mut Option<Self::Handle>,
        ) -> NativeTgcallsStatus {
            let mut state = self.state.lock().unwrap();
            state.abi_version = abi_version;
            state.copied_auth = input.auth_key().to_vec();
            state.copied_endpoint_kind = input.endpoints()[0].kind;
            state.callbacks = Some(FakeCallbacks {
                context: callbacks.context as usize,
                outbound_signaling: callbacks.outbound_signaling,
                error: callbacks.error,
            });
            state.created += 1;
            *handle = Some(7);
            state.create_status
        }

        fn start(&mut self, _handle: &mut Self::Handle) -> NativeTgcallsStatus {
            NATIVE_STATUS_OK
        }

        fn receive_signaling(
            &mut self,
            _handle: &mut Self::Handle,
            _signal: &[u8],
        ) -> NativeTgcallsStatus {
            NATIVE_STATUS_OK
        }

        fn push_capture_20ms(
            &mut self,
            _handle: &mut Self::Handle,
            _samples: &[i16; PCM_SAMPLES],
        ) -> NativeTgcallsStatus {
            NATIVE_STATUS_OK
        }

        fn pop_playout_20ms(
            &mut self,
            _handle: &mut Self::Handle,
            _samples: &mut [i16; PCM_SAMPLES],
        ) -> NativeTgcallsStatus {
            NATIVE_STATUS_OUTPUT_EMPTY
        }

        fn stop(&mut self, _handle: &mut Self::Handle) -> NativeTgcallsStatus {
            let panics = {
                let mut state = self.state.lock().unwrap();
                state.stopped += 1;
                state.stop_panics
            };
            assert!(!panics, "fake native stop panic");
            NATIVE_STATUS_OK
        }

        fn join(&mut self, _handle: &mut Self::Handle) -> NativeTgcallsStatus {
            let (callbacks, payload) = {
                let mut state = self.state.lock().unwrap();
                state.joined += 1;
                (state.callbacks, state.callback_during_join.take())
            };
            if let (Some(callbacks), Some(payload)) = (callbacks, payload) {
                let callback = callbacks
                    .outbound_signaling
                    .expect("fake installs callback");
                callback(
                    callbacks.context as *mut c_void,
                    payload.as_ptr(),
                    payload.len().try_into().unwrap(),
                );
            }
            NATIVE_STATUS_OK
        }

        fn destroy(&mut self, handle: &mut Option<Self::Handle>) -> NativeTgcallsStatus {
            let mut state = self.state.lock().unwrap();
            state.destroyed += 1;
            if state.destroy_failures > 0 {
                state.destroy_failures -= 1;
                return NATIVE_STATUS_INTERNAL_ERROR;
            }
            *handle = None;
            NATIVE_STATUS_OK
        }
    }

    fn emit_outbound(state: &Arc<Mutex<NativeCallState>>, payload: &[u8]) {
        let callbacks = state
            .lock()
            .unwrap()
            .callbacks
            .expect("create stored callbacks");
        let callback = callbacks
            .outbound_signaling
            .expect("outbound callback installed");
        callback(
            callbacks.context as *mut c_void,
            payload.as_ptr(),
            payload.len().try_into().unwrap(),
        );
    }

    fn emit_error(state: &Arc<Mutex<NativeCallState>>, status: NativeTgcallsStatus) {
        let callbacks = state
            .lock()
            .unwrap()
            .callbacks
            .expect("create stored callbacks");
        let callback = callbacks.error.expect("error callback installed");
        callback(callbacks.context as *mut c_void, status);
    }

    #[test]
    fn native_factory_copies_synchronously_then_zeroizes_config() {
        let state = Arc::new(Mutex::new(NativeCallState::default()));
        let mut native_config = config();
        let session = NativeTgcallsSession::create(
            FakeNativeApi {
                state: Arc::clone(&state),
            },
            &mut native_config,
        )
        .unwrap();
        assert!(native_config.auth_key.iter().all(|byte| *byte == 0));
        assert!(native_config.endpoints.is_empty());
        let observed = state.lock().unwrap();
        assert_eq!(observed.abi_version, NATIVE_TGCALLS_ABI_VERSION);
        assert_eq!(observed.copied_auth, vec![7; AUTH_KEY_BYTES]);
        assert_eq!(observed.copied_endpoint_kind, 2);
        drop(observed);
        drop(session);
        let observed = state.lock().unwrap();
        assert_eq!(observed.created, 1);
        assert_eq!(observed.stopped, 1);
        assert_eq!(observed.joined, 1);
        assert_eq!(observed.destroyed, 1);
    }

    #[test]
    fn shutdown_catches_stop_panic_then_joins_and_destroys() {
        let state = Arc::new(Mutex::new(NativeCallState {
            stop_panics: true,
            ..NativeCallState::default()
        }));
        let mut native_config = config();
        let mut session = NativeTgcallsSession::create(
            FakeNativeApi {
                state: Arc::clone(&state),
            },
            &mut native_config,
        )
        .unwrap();

        assert!(matches!(
            catch_unwind(AssertUnwindSafe(|| session.shutdown())),
            Ok(Err(MediaError))
        ));
        let observed = state.lock().unwrap();
        assert_eq!(observed.stopped, 1);
        assert_eq!(observed.joined, 1);
        assert_eq!(observed.destroyed, 1);
    }

    #[test]
    fn failed_create_retains_callback_userdata_and_attempts_destroy() {
        let state = Arc::new(Mutex::new(NativeCallState {
            create_status: NATIVE_STATUS_INTERNAL_ERROR,
            ..NativeCallState::default()
        }));
        let mut native_config = config();
        assert!(
            NativeTgcallsSession::create(
                FakeNativeApi {
                    state: Arc::clone(&state),
                },
                &mut native_config,
            )
            .is_err()
        );
        let observed = state.lock().unwrap();
        assert_eq!(observed.created, 1);
        assert_eq!(observed.destroyed, 1);
        assert!(observed.callbacks.is_some());
    }

    #[test]
    fn native_callbacks_are_copied_once_and_expose_sticky_events() {
        let state = Arc::new(Mutex::new(NativeCallState::default()));
        let mut native_config = config();
        let session = NativeTgcallsSession::create(
            FakeNativeApi {
                state: Arc::clone(&state),
            },
            &mut native_config,
        )
        .unwrap();
        let events = session.events().expect("live native session has events");
        assert!(state.lock().unwrap().callbacks.is_some());

        emit_outbound(&state, &[4, 5, 6]);
        emit_error(&state, NATIVE_STATUS_INTERNAL_ERROR);
        emit_error(&state, NATIVE_STATUS_INVALID_STATE);
        let signal = events
            .try_recv()
            .expect("outbound callback is delivered once");
        assert_eq!(signal.as_bytes(), &[4, 5, 6]);
        drop(signal);
        assert!(events.try_recv().is_none());
        assert_eq!(events.first_error(), Some(NATIVE_STATUS_INTERNAL_ERROR));
        drop(session);
    }

    #[test]
    fn native_callback_queue_drops_full_and_disconnected_payloads_zeroized() {
        let state = Arc::new(Mutex::new(NativeCallState::default()));
        let mut native_config = config();
        let session = NativeTgcallsSession::create(
            FakeNativeApi {
                state: Arc::clone(&state),
            },
            &mut native_config,
        )
        .unwrap();
        let events = session.events().unwrap();
        let baseline = ZEROIZED_OUTBOUND_SIGNALS.load(Ordering::Relaxed);
        for value in 0..=OUTBOUND_SIGNAL_QUEUE_CAPACITY {
            emit_outbound(&state, &[u8::try_from(value).unwrap()]);
        }
        assert_eq!(
            ZEROIZED_OUTBOUND_SIGNALS.load(Ordering::Relaxed),
            baseline + 1,
            "the full queue's rejected payload was wiped"
        );
        events.disconnect_for_test();
        let after_disconnect = ZEROIZED_OUTBOUND_SIGNALS.load(Ordering::Relaxed);
        emit_outbound(&state, &[99]);
        assert_eq!(
            ZEROIZED_OUTBOUND_SIGNALS.load(Ordering::Relaxed),
            after_disconnect + 1,
            "the disconnected queue's rejected payload was wiped"
        );
        drop(session);
    }

    #[test]
    fn callback_context_survives_stop_join_destroy_and_destroy_retries() {
        let state = Arc::new(Mutex::new(NativeCallState {
            callback_during_join: Some(vec![9, 8]),
            destroy_failures: 1,
            ..NativeCallState::default()
        }));
        let mut native_config = config();
        let mut session = NativeTgcallsSession::create(
            FakeNativeApi {
                state: Arc::clone(&state),
            },
            &mut native_config,
        )
        .unwrap();
        let events = session.events().unwrap();

        assert_eq!(session.shutdown(), Err(MediaError));
        assert!(
            events.try_recv().is_none(),
            "the admitted callback payload is zeroized at the Join boundary"
        );
        assert_eq!(session.shutdown(), Ok(()));
        assert!(session.events().is_none());
        let observed = state.lock().unwrap();
        assert_eq!(observed.stopped, 2);
        assert_eq!(observed.joined, 2);
        assert_eq!(observed.destroyed, 2);
    }

    #[test]
    fn native_session_owner_is_send_and_callbacks_contain_panics() {
        fn assert_send<T: Send>() {}
        assert_send::<NativeTgcallsSession<FakeNativeApi>>();
        // The `Cell` marker on NativeTgcallsSession deliberately makes it !Sync.
        let state = Arc::new(Mutex::new(NativeCallState::default()));
        let mut native_config = config();
        let session = NativeTgcallsSession::create(
            FakeNativeApi {
                state: Arc::clone(&state),
            },
            &mut native_config,
        )
        .unwrap();
        let callbacks = state.lock().unwrap().callbacks.unwrap();
        assert!(
            catch_unwind(AssertUnwindSafe(|| {
                let callback = callbacks.outbound_signaling.unwrap();
                callback(callbacks.context as *mut c_void, core::ptr::null(), 1);
                let callback = callbacks.error.unwrap();
                callback(callbacks.context as *mut c_void, u32::MAX);
            }))
            .is_ok()
        );
        drop(session);
    }

    #[test]
    fn native_abi_layout_and_values_match_c() {
        assert_eq!(NATIVE_TGCALLS_ABI_VERSION, 3);
        assert_eq!(size_of::<NativeTgcallsStatus>(), 4);
        assert_eq!(core::mem::align_of::<NativeTgcallsStatus>(), 4);
        for (status, value) in [
            (NATIVE_STATUS_OK, 0),
            (NATIVE_STATUS_INVALID_ARGUMENT, 1),
            (NATIVE_STATUS_STOPPED, 2),
            (NATIVE_STATUS_INPUT_FULL, 3),
            (NATIVE_STATUS_OUTPUT_EMPTY, 4),
            (NATIVE_STATUS_ABI_MISMATCH, 5),
            (NATIVE_STATUS_ALLOCATION_FAILED, 6),
            (NATIVE_STATUS_INVALID_STATE, 7),
            (NATIVE_STATUS_BACKEND_UNAVAILABLE, 8),
            (NATIVE_STATUS_INTERNAL_ERROR, 9),
        ] {
            assert_eq!(status, value);
            assert_eq!(NativeStatusCode::try_from(status).unwrap() as u32, value);
        }
        assert_eq!(native_endpoint_kind(TgcallsEndpointKind::Inet), 0);
        assert_eq!(native_endpoint_kind(TgcallsEndpointKind::Lan), 1);
        assert_eq!(native_endpoint_kind(TgcallsEndpointKind::UdpRelay), 2);
        assert_eq!(native_endpoint_kind(TgcallsEndpointKind::TcpRelay), 3);
        assert_eq!(u32::from(false), 0);
        assert_eq!(u32::from(true), 1);

        assert_eq!(size_of::<NativeStringView>(), 16);
        assert_eq!(core::mem::align_of::<NativeStringView>(), 8);
        assert_eq!(core::mem::offset_of!(NativeStringView, data), 0);
        assert_eq!(core::mem::offset_of!(NativeStringView, length), 8);

        assert_eq!(size_of::<NativeEndpoint>(), 64);
        assert_eq!(core::mem::align_of::<NativeEndpoint>(), 8);
        assert_eq!(core::mem::offset_of!(NativeEndpoint, id), 0);
        assert_eq!(core::mem::offset_of!(NativeEndpoint, ipv4), 8);
        assert_eq!(core::mem::offset_of!(NativeEndpoint, ipv6), 24);
        assert_eq!(core::mem::offset_of!(NativeEndpoint, port), 40);
        assert_eq!(core::mem::offset_of!(NativeEndpoint, kind), 44);
        assert_eq!(core::mem::offset_of!(NativeEndpoint, peer_tag), 48);

        assert_eq!(size_of::<NativeSessionConfig>(), 20);
        assert_eq!(core::mem::align_of::<NativeSessionConfig>(), 4);
        assert_eq!(
            core::mem::offset_of!(NativeSessionConfig, initialization_timeout_ms),
            0
        );
        assert_eq!(
            core::mem::offset_of!(NativeSessionConfig, receive_timeout_ms),
            4
        );
        assert_eq!(core::mem::offset_of!(NativeSessionConfig, enable_p2p), 8);
        assert_eq!(core::mem::offset_of!(NativeSessionConfig, allow_tcp), 9);
        assert_eq!(core::mem::offset_of!(NativeSessionConfig, enable_aec), 10);
        assert_eq!(core::mem::offset_of!(NativeSessionConfig, enable_ns), 11);
        assert_eq!(core::mem::offset_of!(NativeSessionConfig, enable_agc), 12);
        assert_eq!(
            core::mem::offset_of!(NativeSessionConfig, protocol_version),
            16
        );

        assert_eq!(size_of::<NativeSessionAuth>(), 16);
        assert_eq!(core::mem::align_of::<NativeSessionAuth>(), 8);
        assert_eq!(core::mem::offset_of!(NativeSessionAuth, key), 0);
        assert_eq!(core::mem::offset_of!(NativeSessionAuth, key_length), 8);
        assert_eq!(core::mem::offset_of!(NativeSessionAuth, is_outgoing), 12);

        assert_eq!(size_of::<NativeSessionCallbacks>(), 24);
        assert_eq!(core::mem::align_of::<NativeSessionCallbacks>(), 8);
        assert_eq!(core::mem::offset_of!(NativeSessionCallbacks, context), 0);
        assert_eq!(
            core::mem::offset_of!(NativeSessionCallbacks, outbound_signaling),
            8
        );
        assert_eq!(core::mem::offset_of!(NativeSessionCallbacks, error), 16);

        assert_eq!(native_status_result(NATIVE_STATUS_OK), Ok(()));
        assert_eq!(
            native_status_result(NATIVE_STATUS_BACKEND_UNAVAILABLE),
            Err(MediaError)
        );
        assert_eq!(native_status_result(u32::MAX), Err(MediaError));
    }

    #[test]
    fn unavailable_native_factory_never_creates_media() {
        let mut native_config = config();
        assert!(
            NativeTgcallsSession::create(UnavailableNativeTgcallsApi, &mut native_config).is_err()
        );
        assert!(native_config.auth_key.iter().all(|byte| *byte == 0));
        assert!(native_config.endpoints.is_empty());
    }
}
