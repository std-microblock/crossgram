//! Single-call coordinator. No media backend receives key material.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::crypto::{
    DhPrivate, SecretBytes, derive_shared_key, ga_hash, key_fingerprint, public_value,
    verify_ga_hash,
};
use crate::ipc::{
    ErrorCode, MAX_SIGNAL_BYTES, PCM_CAPABILITY_BYTES, PCM_FRAME_BYTES, Request, Response,
};
use zeroize::Zeroize;

pub const CALL_TTL: Duration = Duration::from_secs(30);
const MAX_SIGNAL_REPLAY_ENTRIES: usize = 16;
#[cfg(any(test, feature = "test-fake"))]
const MAX_FAKE_PCM_QUEUE_FRAMES: usize = 4;

pub trait MediaBackend {
    type Handle;
    type Pcm;

    fn start(&mut self, call_id: u64) -> Result<Self::Handle, MediaError>;
    fn forward_signal(
        &mut self,
        handle: &mut Self::Handle,
        signal: &[u8],
    ) -> Result<(), MediaError>;
    /// Opens both fixed-format PCM directions for an already-active call.
    fn attach_pcm(&mut self, handle: &mut Self::Handle) -> Result<Self::Pcm, MediaError>;
    fn send_pcm(
        &mut self,
        pcm: &mut Self::Pcm,
        frame: &[u8; PCM_FRAME_BYTES],
    ) -> Result<(), MediaError>;
    fn receive_pcm(
        &mut self,
        pcm: &mut Self::Pcm,
    ) -> Result<Option<[u8; PCM_FRAME_BYTES]>, MediaError>;
    fn close_pcm(&mut self, pcm: Self::Pcm);
    fn stop(&mut self, handle: Self::Handle);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaError;

/// Production placeholder until a real media backend is linked. It deliberately
/// refuses to start media, so no completed handshake can become active by accident.
pub struct UnavailableMediaBackend;

impl MediaBackend for UnavailableMediaBackend {
    type Handle = ();
    type Pcm = ();

    fn start(&mut self, _call_id: u64) -> Result<Self::Handle, MediaError> {
        Err(MediaError)
    }
    fn forward_signal(
        &mut self,
        _handle: &mut Self::Handle,
        _signal: &[u8],
    ) -> Result<(), MediaError> {
        Err(MediaError)
    }
    fn attach_pcm(&mut self, _handle: &mut Self::Handle) -> Result<Self::Pcm, MediaError> {
        Err(MediaError)
    }
    fn send_pcm(
        &mut self,
        _pcm: &mut Self::Pcm,
        _frame: &[u8; PCM_FRAME_BYTES],
    ) -> Result<(), MediaError> {
        Err(MediaError)
    }
    fn receive_pcm(
        &mut self,
        _pcm: &mut Self::Pcm,
    ) -> Result<Option<[u8; PCM_FRAME_BYTES]>, MediaError> {
        Err(MediaError)
    }
    fn close_pcm(&mut self, _pcm: Self::Pcm) {}
    fn stop(&mut self, _handle: Self::Handle) {}
}

struct MediaEndpoint<P> {
    request_id: u64,
    capability: [u8; PCM_CAPABILITY_BYTES],
    pcm: P,
}

pub struct VoiceWorker<B: MediaBackend> {
    backend: B,
    state: CallState,
    media: Option<B::Handle>,
    endpoint: Option<MediaEndpoint<B::Pcm>>,
    recent: Option<Replay>,
    ttl: Duration,
}

enum CallState {
    Idle,
    CallerPrepared {
        call_id: u64,
        private: DhPrivate,
        ga: [u8; 256],
        ga_hash: [u8; 32],
        created: Instant,
    },
    RecipientPrepared {
        call_id: u64,
        private: DhPrivate,
        expected_ga_hash: [u8; 32],
        gb: [u8; 256],
        created: Instant,
    },
    Active {
        call_id: u64,
        shared_key: SecretBytes,
        completed_request: Box<Request>,
        completed_response: Box<Response>,
        signal_replays: VecDeque<SignalReplay>,
        created: Instant,
    },
}

struct SignalReplay {
    call_id: u64,
    request_id: u64,
    signal_digest: [u8; 32],
    response: Response,
}

const MAX_SIGNAL_REPLAY_BYTES: usize =
    MAX_SIGNAL_REPLAY_ENTRIES * core::mem::size_of::<SignalReplay>();

struct Replay {
    request: Request,
    response: Response,
    expires: Instant,
}

impl<B: MediaBackend> VoiceWorker<B> {
    #[must_use]
    pub fn new(backend: B) -> Self {
        Self::with_ttl(backend, CALL_TTL)
    }

    #[must_use]
    pub fn with_ttl(backend: B, ttl: Duration) -> Self {
        Self {
            backend,
            state: CallState::Idle,
            media: None,
            endpoint: None,
            recent: None,
            ttl,
        }
    }

    /// Handles one local IPC request. All returned variants are public-only.
    pub fn handle(&mut self, request: Request) -> Response {
        self.expire();
        if let Some(replay) = &self.recent {
            if replay.request == request {
                return replay.response.clone();
            }
            if replay.request.call_id() == request.call_id() {
                return invalid_state();
            }
        }
        match request {
            Request::PrepareCaller { call_id } => self.prepare_caller(call_id),
            Request::PrepareRecipient { call_id, ga_hash } => {
                self.prepare_recipient(call_id, ga_hash)
            }
            Request::CompleteCaller { call_id, gb } => self.complete_caller(call_id, gb),
            Request::CompleteRecipient {
                call_id,
                ga,
                expected_fingerprint,
            } => self.complete_recipient(call_id, ga, expected_fingerprint),
            Request::Signal {
                call_id,
                request_id,
                mut signal,
            } => {
                let response = self.forward_signal(call_id, request_id, &signal);
                signal.zeroize();
                response
            }
            Request::Hangup { call_id } => self.hangup(call_id),
            Request::AttachMedia {
                call_id,
                request_id,
            } => self.attach_media(call_id, request_id),
            Request::SendPcm {
                call_id,
                capability,
                frame,
            } => self.send_pcm(call_id, capability, frame),
            Request::ReceivePcm {
                call_id,
                capability,
            } => self.receive_pcm(call_id, capability),
            Request::CloseMedia {
                call_id,
                capability,
            } => self.close_media(call_id, capability),
        }
    }

    #[must_use]
    pub fn is_active(&self) -> bool {
        matches!(self.state, CallState::Active { .. })
    }

    #[must_use]
    pub fn backend(&self) -> &B {
        &self.backend
    }

    #[must_use]
    pub fn active_fingerprint(&self) -> Option<i64> {
        let CallState::Active {
            shared_key,
            completed_response,
            ..
        } = &self.state
        else {
            return None;
        };
        if shared_key.as_slice().is_empty() {
            return None;
        }
        match completed_response.as_ref() {
            Response::CallerCompleted { fingerprint, .. }
            | Response::RecipientCompleted { fingerprint } => Some(*fingerprint),
            Response::CallerPrepared { .. }
            | Response::RecipientPrepared { .. }
            | Response::SignalForwarded { .. }
            | Response::HungUp
            | Response::MediaAttached { .. }
            | Response::PcmSent
            | Response::PcmReceived { .. }
            | Response::PcmPending
            | Response::MediaClosed
            | Response::Error { .. } => None,
        }
    }

    /// Stops the active backend handle exactly once and drops all call secrets.
    pub fn teardown(&mut self) {
        let old_state = core::mem::replace(&mut self.state, CallState::Idle);
        if let Some(mut endpoint) = self.endpoint.take() {
            endpoint.capability.zeroize();
            self.backend.close_pcm(endpoint.pcm);
        }
        if let Some(handle) = self.media.take() {
            self.backend.stop(handle);
        }
        drop(old_state);
    }

    fn prepare_caller(&mut self, call_id: u64) -> Response {
        match &self.state {
            CallState::CallerPrepared {
                call_id: active_id,
                ga_hash,
                ..
            } if *active_id == call_id => {
                return Response::CallerPrepared { ga_hash: *ga_hash };
            }
            CallState::Idle => {}
            CallState::CallerPrepared { .. }
            | CallState::RecipientPrepared { .. }
            | CallState::Active { .. } => return self.busy_or_invalid(call_id),
        }
        let Ok(private) = DhPrivate::generate() else {
            return crypto_error();
        };
        let ga = public_value(&private);
        let ga_hash = ga_hash(&ga);
        self.state = CallState::CallerPrepared {
            call_id,
            private,
            ga,
            ga_hash,
            created: Instant::now(),
        };
        Response::CallerPrepared { ga_hash }
    }

    fn prepare_recipient(&mut self, call_id: u64, ga_hash: [u8; 32]) -> Response {
        match &self.state {
            CallState::RecipientPrepared {
                call_id: active_id,
                expected_ga_hash,
                gb,
                ..
            } if *active_id == call_id && *expected_ga_hash == ga_hash => {
                return Response::RecipientPrepared { gb: *gb };
            }
            CallState::Idle => {}
            CallState::CallerPrepared { .. }
            | CallState::RecipientPrepared { .. }
            | CallState::Active { .. } => return self.busy_or_invalid(call_id),
        }
        let Ok(private) = DhPrivate::generate() else {
            return crypto_error();
        };
        let gb = public_value(&private);
        self.state = CallState::RecipientPrepared {
            call_id,
            private,
            expected_ga_hash: ga_hash,
            gb,
            created: Instant::now(),
        };
        Response::RecipientPrepared { gb }
    }

    fn complete_caller(&mut self, call_id: u64, gb: [u8; 256]) -> Response {
        let request = Request::CompleteCaller { call_id, gb };
        if let CallState::Active {
            call_id: active_id,
            completed_request,
            completed_response,
            ..
        } = &self.state
        {
            return if *active_id == call_id && **completed_request == request {
                (**completed_response).clone()
            } else {
                invalid_state()
            };
        }
        if !matches!(&self.state, CallState::CallerPrepared { call_id: active_id, .. } if *active_id == call_id)
        {
            return invalid_state();
        }
        let CallState::CallerPrepared { private, ga, .. } =
            core::mem::replace(&mut self.state, CallState::Idle)
        else {
            unreachable!("caller state was checked above");
        };
        let Ok(shared_key) = derive_shared_key(&private, &gb) else {
            return self.remember(request, crypto_error());
        };
        let fingerprint = key_fingerprint(shared_key.as_slice());
        let Ok(handle) = self.backend.start(call_id) else {
            return self.remember(request, media_unavailable());
        };
        let response = Response::CallerCompleted { ga, fingerprint };
        self.media = Some(handle);
        self.state = CallState::Active {
            call_id,
            shared_key,
            completed_request: Box::new(request),
            completed_response: Box::new(response.clone()),
            signal_replays: VecDeque::with_capacity(MAX_SIGNAL_REPLAY_ENTRIES),
            created: Instant::now(),
        };
        response
    }

    fn complete_recipient(
        &mut self,
        call_id: u64,
        ga: [u8; 256],
        expected_fingerprint: i64,
    ) -> Response {
        let request = Request::CompleteRecipient {
            call_id,
            ga,
            expected_fingerprint,
        };
        if let CallState::Active {
            call_id: active_id,
            completed_request,
            completed_response,
            ..
        } = &self.state
        {
            return if *active_id == call_id && **completed_request == request {
                (**completed_response).clone()
            } else {
                invalid_state()
            };
        }
        if !matches!(&self.state, CallState::RecipientPrepared { call_id: active_id, .. } if *active_id == call_id)
        {
            return invalid_state();
        }
        let CallState::RecipientPrepared {
            private,
            expected_ga_hash,
            ..
        } = core::mem::replace(&mut self.state, CallState::Idle)
        else {
            unreachable!("recipient state was checked above");
        };
        if verify_ga_hash(&ga, &expected_ga_hash).is_err() {
            return self.remember(request, crypto_error());
        }
        let Ok(shared_key) = derive_shared_key(&private, &ga) else {
            return self.remember(request, crypto_error());
        };
        let fingerprint = key_fingerprint(shared_key.as_slice());
        if fingerprint != expected_fingerprint {
            return self.remember(request, crypto_error());
        }
        let Ok(handle) = self.backend.start(call_id) else {
            return self.remember(request, media_unavailable());
        };
        let response = Response::RecipientCompleted { fingerprint };
        self.media = Some(handle);
        self.state = CallState::Active {
            call_id,
            shared_key,
            completed_request: Box::new(request),
            completed_response: Box::new(response.clone()),
            signal_replays: VecDeque::with_capacity(MAX_SIGNAL_REPLAY_ENTRIES),
            created: Instant::now(),
        };
        response
    }

    fn forward_signal(&mut self, call_id: u64, request_id: u64, signal: &[u8]) -> Response {
        if signal.len() > MAX_SIGNAL_BYTES {
            return Response::Error {
                code: ErrorCode::InvalidRequest,
            };
        }
        let signal_digest: [u8; 32] = Sha256::digest(signal).into();
        let CallState::Active {
            call_id: active_id,
            signal_replays,
            ..
        } = &self.state
        else {
            return invalid_state();
        };
        if *active_id != call_id {
            return invalid_state();
        }
        if let Some(replay) = signal_replays
            .iter()
            .find(|replay| replay.call_id == call_id && replay.request_id == request_id)
        {
            return if replay.signal_digest == signal_digest {
                replay.response.clone()
            } else {
                invalid_state()
            };
        }
        if signal_replays.len() == MAX_SIGNAL_REPLAY_ENTRIES
            || (signal_replays.len() + 1) * core::mem::size_of::<SignalReplay>()
                > MAX_SIGNAL_REPLAY_BYTES
        {
            return invalid_state();
        }
        let Some(handle) = self.media.as_mut() else {
            return media_unavailable();
        };
        if self.backend.forward_signal(handle, signal).is_err() {
            return self.finish_without_replay(media_unavailable());
        }
        let response = Response::SignalForwarded { request_id };
        let CallState::Active { signal_replays, .. } = &mut self.state else {
            unreachable!("active call was checked before forwarding its signal");
        };
        signal_replays.push_back(SignalReplay {
            call_id,
            request_id,
            signal_digest,
            response: response.clone(),
        });
        response
    }

    fn attach_media(&mut self, call_id: u64, request_id: u64) -> Response {
        let capability = match &self.state {
            CallState::Active {
                call_id: active_id,
                shared_key,
                ..
            } if *active_id == call_id => endpoint_capability(shared_key, call_id, request_id),
            _ => return invalid_state(),
        };
        if let Some(endpoint) = &self.endpoint {
            return if endpoint.request_id == request_id {
                Response::MediaAttached {
                    request_id,
                    capability: endpoint.capability,
                }
            } else {
                invalid_state()
            };
        }
        let Some(handle) = self.media.as_mut() else {
            return media_unavailable();
        };
        let Ok(pcm) = self.backend.attach_pcm(handle) else {
            return self.finish_without_replay(media_unavailable());
        };
        self.endpoint = Some(MediaEndpoint {
            request_id,
            capability,
            pcm,
        });
        Response::MediaAttached {
            request_id,
            capability,
        }
    }

    fn send_pcm(
        &mut self,
        call_id: u64,
        mut capability: [u8; PCM_CAPABILITY_BYTES],
        mut frame: Box<[u8; PCM_FRAME_BYTES]>,
    ) -> Response {
        if !matches!(&self.state, CallState::Active { call_id: active_id, .. } if *active_id == call_id)
        {
            capability.zeroize();
            frame.zeroize();
            return invalid_state();
        }
        let response = match (&mut self.backend, &mut self.endpoint) {
            (backend, Some(endpoint)) if endpoint.capability == capability => {
                if backend.send_pcm(&mut endpoint.pcm, frame.as_ref()).is_ok() {
                    Response::PcmSent
                } else {
                    media_unavailable()
                }
            }
            _ => invalid_state(),
        };
        capability.zeroize();
        frame.zeroize();
        if response == media_unavailable() {
            self.finish_without_replay(response)
        } else {
            response
        }
    }

    fn receive_pcm(
        &mut self,
        call_id: u64,
        mut capability: [u8; PCM_CAPABILITY_BYTES],
    ) -> Response {
        if !matches!(&self.state, CallState::Active { call_id: active_id, .. } if *active_id == call_id)
        {
            capability.zeroize();
            return invalid_state();
        }
        let response = match (&mut self.backend, &mut self.endpoint) {
            (backend, Some(endpoint)) if endpoint.capability == capability => {
                match backend.receive_pcm(&mut endpoint.pcm) {
                    Ok(Some(frame)) => Response::PcmReceived {
                        frame: Box::new(frame),
                    },
                    Ok(None) => Response::PcmPending,
                    Err(_) => media_unavailable(),
                }
            }
            _ => invalid_state(),
        };
        capability.zeroize();
        if response == media_unavailable() {
            self.finish_without_replay(response)
        } else {
            response
        }
    }

    fn close_media(
        &mut self,
        call_id: u64,
        mut capability: [u8; PCM_CAPABILITY_BYTES],
    ) -> Response {
        let valid = matches!(&self.state, CallState::Active { call_id: active_id, .. } if *active_id == call_id)
            && self
                .endpoint
                .as_ref()
                .is_some_and(|endpoint| endpoint.capability == capability);
        capability.zeroize();
        if !valid {
            return invalid_state();
        }
        self.teardown();
        Response::MediaClosed
    }

    fn hangup(&mut self, call_id: u64) -> Response {
        let active_id = match &self.state {
            CallState::Idle => return invalid_state(),
            CallState::CallerPrepared { call_id, .. }
            | CallState::RecipientPrepared { call_id, .. }
            | CallState::Active { call_id, .. } => *call_id,
        };
        if call_id != active_id {
            return invalid_state();
        }
        self.teardown();
        self.remember(Request::Hangup { call_id }, Response::HungUp)
    }

    fn expire(&mut self) {
        if self
            .state_created()
            .is_some_and(|created| created.elapsed() >= self.ttl)
        {
            self.teardown();
        }
        if self
            .recent
            .as_ref()
            .is_some_and(|replay| replay.expires <= Instant::now())
        {
            self.recent = None;
        }
    }

    fn state_created(&self) -> Option<Instant> {
        match &self.state {
            CallState::Idle => None,
            CallState::CallerPrepared { created, .. }
            | CallState::RecipientPrepared { created, .. }
            | CallState::Active { created, .. } => Some(*created),
        }
    }

    fn busy_or_invalid(&self, call_id: u64) -> Response {
        let active_id = match &self.state {
            CallState::Idle => return invalid_state(),
            CallState::CallerPrepared { call_id, .. }
            | CallState::RecipientPrepared { call_id, .. }
            | CallState::Active { call_id, .. } => *call_id,
        };
        if active_id == call_id {
            invalid_state()
        } else {
            Response::Error {
                code: ErrorCode::Busy,
            }
        }
    }

    fn finish_without_replay(&mut self, response: Response) -> Response {
        self.teardown();
        response
    }

    fn remember(&mut self, request: Request, response: Response) -> Response {
        self.recent = Some(Replay {
            request,
            response: response.clone(),
            expires: Instant::now() + self.ttl,
        });
        response
    }
}

impl<B: MediaBackend> Drop for VoiceWorker<B> {
    fn drop(&mut self) {
        self.teardown();
    }
}

fn endpoint_capability(
    shared_key: &SecretBytes,
    call_id: u64,
    request_id: u64,
) -> [u8; PCM_CAPABILITY_BYTES] {
    let mut hash = Sha256::new();
    hash.update(b"crossgram-voice-worker-pcm-v2");
    hash.update(shared_key.as_slice());
    hash.update(call_id.to_be_bytes());
    hash.update(request_id.to_be_bytes());
    hash.finalize().into()
}

const fn invalid_state() -> Response {
    Response::Error {
        code: ErrorCode::InvalidState,
    }
}
const fn crypto_error() -> Response {
    Response::Error {
        code: ErrorCode::Crypto,
    }
}
const fn media_unavailable() -> Response {
    Response::Error {
        code: ErrorCode::MediaUnavailable,
    }
}

#[cfg(any(test, feature = "test-fake"))]
#[derive(Default)]
pub struct FakeMediaBackend {
    started: Vec<u64>,
    stopped: Vec<u64>,
    forwarded_signals: usize,
    attached: usize,
    dropped_pcm_frames: usize,
}

#[cfg(any(test, feature = "test-fake"))]
impl FakeMediaBackend {
    #[must_use]
    pub fn started(&self) -> &[u64] {
        &self.started
    }
    #[must_use]
    pub fn stopped(&self) -> &[u64] {
        &self.stopped
    }
    #[must_use]
    pub const fn forwarded_signals(&self) -> usize {
        self.forwarded_signals
    }
    #[must_use]
    pub const fn attached(&self) -> usize {
        self.attached
    }
    #[must_use]
    pub const fn dropped_pcm_frames(&self) -> usize {
        self.dropped_pcm_frames
    }
}

#[cfg(any(test, feature = "test-fake"))]
impl MediaBackend for FakeMediaBackend {
    type Handle = u64;
    type Pcm = VecDeque<[u8; PCM_FRAME_BYTES]>;

    fn start(&mut self, call_id: u64) -> Result<Self::Handle, MediaError> {
        self.started.push(call_id);
        Ok(call_id)
    }
    fn forward_signal(
        &mut self,
        _handle: &mut Self::Handle,
        _signal: &[u8],
    ) -> Result<(), MediaError> {
        self.forwarded_signals += 1;
        Ok(())
    }
    fn attach_pcm(&mut self, _handle: &mut Self::Handle) -> Result<Self::Pcm, MediaError> {
        self.attached += 1;
        Ok(VecDeque::with_capacity(MAX_FAKE_PCM_QUEUE_FRAMES))
    }
    fn send_pcm(
        &mut self,
        pcm: &mut Self::Pcm,
        frame: &[u8; PCM_FRAME_BYTES],
    ) -> Result<(), MediaError> {
        while pcm.len() >= MAX_FAKE_PCM_QUEUE_FRAMES {
            let mut dropped = pcm.pop_front().expect("queue length was checked");
            dropped.zeroize();
            self.dropped_pcm_frames += 1;
        }
        pcm.push_back(*frame);
        Ok(())
    }
    fn receive_pcm(
        &mut self,
        pcm: &mut Self::Pcm,
    ) -> Result<Option<[u8; PCM_FRAME_BYTES]>, MediaError> {
        Ok(pcm.pop_front())
    }
    fn close_pcm(&mut self, mut pcm: Self::Pcm) {
        for frame in &mut pcm {
            frame.zeroize();
        }
    }
    fn stop(&mut self, handle: Self::Handle) {
        self.stopped.push(handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared_pair() -> (
        VoiceWorker<FakeMediaBackend>,
        VoiceWorker<FakeMediaBackend>,
        [u8; 256],
        [u8; 256],
        i64,
    ) {
        let mut caller = VoiceWorker::new(FakeMediaBackend::default());
        let mut recipient = VoiceWorker::new(FakeMediaBackend::default());
        let Response::CallerPrepared { ga_hash } =
            caller.handle(Request::PrepareCaller { call_id: 44 })
        else {
            panic!("caller must prepare")
        };
        let Response::RecipientPrepared { gb } = recipient.handle(Request::PrepareRecipient {
            call_id: 44,
            ga_hash,
        }) else {
            panic!("recipient must prepare")
        };
        let Response::CallerCompleted { ga, fingerprint } =
            caller.handle(Request::CompleteCaller { call_id: 44, gb })
        else {
            panic!("caller must complete")
        };
        (caller, recipient, ga, gb, fingerprint)
    }

    #[test]
    fn caller_and_recipient_complete_the_same_handshake() {
        let (caller, mut recipient, ga, _, fingerprint) = prepared_pair();
        assert_eq!(
            recipient.handle(Request::CompleteRecipient {
                call_id: 44,
                ga,
                expected_fingerprint: fingerprint
            }),
            Response::RecipientCompleted { fingerprint }
        );
        assert!(caller.is_active());
        assert!(recipient.is_active());
        assert_eq!(recipient.active_fingerprint(), Some(fingerprint));
    }

    #[test]
    fn recipient_binds_commitment_and_checks_fingerprint_before_media() {
        let mut caller = VoiceWorker::new(FakeMediaBackend::default());
        let mut recipient = VoiceWorker::new(FakeMediaBackend::default());
        let Response::CallerPrepared { mut ga_hash } =
            caller.handle(Request::PrepareCaller { call_id: 1 })
        else {
            panic!("caller must prepare")
        };
        ga_hash[0] ^= 1;
        let Response::RecipientPrepared { gb } = recipient.handle(Request::PrepareRecipient {
            call_id: 1,
            ga_hash,
        }) else {
            panic!("recipient must prepare")
        };
        let Response::CallerCompleted { ga, fingerprint } =
            caller.handle(Request::CompleteCaller { call_id: 1, gb })
        else {
            panic!("caller must complete")
        };
        assert_eq!(
            recipient.handle(Request::CompleteRecipient {
                call_id: 1,
                ga,
                expected_fingerprint: fingerprint
            }),
            crypto_error()
        );
        assert!(!recipient.is_active());
        assert_eq!(recipient.backend().started(), &[]);

        let (_, mut recipient, ga, _, fingerprint) = prepared_pair();
        assert_eq!(
            recipient.handle(Request::CompleteRecipient {
                call_id: 44,
                ga,
                expected_fingerprint: fingerprint + 1
            }),
            crypto_error()
        );
        assert_eq!(recipient.backend().started(), &[]);
    }

    #[test]
    fn recipient_discloses_gb_at_prepare_time() {
        let mut worker = VoiceWorker::new(FakeMediaBackend::default());
        let Response::RecipientPrepared { gb } = worker.handle(Request::PrepareRecipient {
            call_id: 1,
            ga_hash: [7; 32],
        }) else {
            panic!("recipient must prepare")
        };
        assert_ne!(gb, [0; 256]);
        assert!(!worker.is_active());
    }

    #[test]
    fn lifecycle_requests_replay_only_the_identical_public_input() {
        let mut worker = VoiceWorker::new(FakeMediaBackend::default());
        let first = worker.handle(Request::PrepareCaller { call_id: 1 });
        assert_eq!(worker.handle(Request::PrepareCaller { call_id: 1 }), first);
        assert_eq!(
            worker.handle(Request::PrepareRecipient {
                call_id: 1,
                ga_hash: [0; 32]
            }),
            invalid_state()
        );
        assert_eq!(
            worker.handle(Request::Hangup { call_id: 1 }),
            Response::HungUp
        );
        assert_eq!(
            worker.handle(Request::Hangup { call_id: 1 }),
            Response::HungUp
        );
        assert_eq!(
            worker.handle(Request::PrepareCaller { call_id: 1 }),
            invalid_state()
        );
    }

    #[test]
    fn completion_replay_and_conflict_are_fail_closed() {
        let (mut caller, _, _, gb, _) = prepared_pair();
        let response = caller.handle(Request::CompleteCaller { call_id: 44, gb });
        assert_eq!(
            caller.handle(Request::CompleteCaller { call_id: 44, gb }),
            response
        );
        let mut conflicting_gb = gb;
        conflicting_gb[0] ^= 1;
        assert_eq!(
            caller.handle(Request::CompleteCaller {
                call_id: 44,
                gb: conflicting_gb
            }),
            invalid_state()
        );
    }

    #[test]
    fn ttl_and_hangup_zeroize_call_state() {
        let mut worker = VoiceWorker::with_ttl(FakeMediaBackend::default(), Duration::ZERO);
        assert!(matches!(
            worker.handle(Request::PrepareCaller { call_id: 1 }),
            Response::CallerPrepared { .. }
        ));
        assert_eq!(
            worker.handle(Request::Hangup { call_id: 1 }),
            invalid_state()
        );
        assert!(!worker.is_active());

        let (mut caller, _, _, _, _) = prepared_pair();
        assert_eq!(
            caller.handle(Request::Hangup { call_id: 44 }),
            Response::HungUp
        );
        assert_eq!(caller.backend().stopped(), &[44]);
    }

    #[test]
    fn unavailable_backend_never_becomes_active() {
        let mut caller = VoiceWorker::new(UnavailableMediaBackend);
        let mut recipient = VoiceWorker::new(FakeMediaBackend::default());
        let Response::CallerPrepared { ga_hash } =
            caller.handle(Request::PrepareCaller { call_id: 1 })
        else {
            panic!("caller must prepare")
        };
        let Response::RecipientPrepared { gb } = recipient.handle(Request::PrepareRecipient {
            call_id: 1,
            ga_hash,
        }) else {
            panic!("recipient must prepare")
        };
        assert_eq!(
            caller.handle(Request::CompleteCaller { call_id: 1, gb }),
            media_unavailable()
        );
        assert!(!caller.is_active());
    }

    #[test]
    fn pcm_endpoint_requires_active_media_replays_attach_and_revokes_terminal_capability() {
        let mut inactive = VoiceWorker::new(FakeMediaBackend::default());
        assert_eq!(
            inactive.handle(Request::AttachMedia {
                call_id: 44,
                request_id: 7,
            }),
            invalid_state()
        );

        let (mut caller, _, _, _, _) = prepared_pair();
        let Response::MediaAttached {
            capability,
            request_id,
        } = caller.handle(Request::AttachMedia {
            call_id: 44,
            request_id: 7,
        })
        else {
            panic!("active media must attach PCM")
        };
        assert_eq!(request_id, 7);
        assert_eq!(
            caller.handle(Request::AttachMedia {
                call_id: 44,
                request_id: 7,
            }),
            Response::MediaAttached {
                request_id: 7,
                capability,
            }
        );
        assert_eq!(caller.backend().attached(), 1);
        assert_eq!(
            caller.handle(Request::SendPcm {
                call_id: 44,
                capability,
                frame: Box::new([9; PCM_FRAME_BYTES]),
            }),
            Response::PcmSent
        );
        assert_eq!(
            caller.handle(Request::ReceivePcm {
                call_id: 44,
                capability,
            }),
            Response::PcmReceived {
                frame: Box::new([9; PCM_FRAME_BYTES])
            }
        );
        assert_eq!(
            caller.handle(Request::CloseMedia {
                call_id: 44,
                capability,
            }),
            Response::MediaClosed
        );
        assert_eq!(caller.backend().stopped(), &[44]);
        assert_eq!(
            caller.handle(Request::ReceivePcm {
                call_id: 44,
                capability,
            }),
            invalid_state()
        );
    }

    #[test]
    fn fake_pcm_queue_is_bounded_and_keeps_the_newest_frames() {
        let (mut caller, _, _, _, _) = prepared_pair();
        let Response::MediaAttached { capability, .. } = caller.handle(Request::AttachMedia {
            call_id: 44,
            request_id: 7,
        }) else {
            panic!("active media must attach PCM");
        };
        let initial_capacity = caller
            .endpoint
            .as_ref()
            .expect("attached endpoint must exist")
            .pcm
            .capacity();
        assert!(initial_capacity >= MAX_FAKE_PCM_QUEUE_FRAMES);

        let frame_count = MAX_FAKE_PCM_QUEUE_FRAMES + 32;
        for value in 0..u8::try_from(frame_count).unwrap() {
            assert_eq!(
                caller.handle(Request::SendPcm {
                    call_id: 44,
                    capability,
                    frame: Box::new([value; PCM_FRAME_BYTES]),
                }),
                Response::PcmSent
            );
        }

        let endpoint = caller
            .endpoint
            .as_ref()
            .expect("attached endpoint must exist");
        assert_eq!(endpoint.pcm.len(), MAX_FAKE_PCM_QUEUE_FRAMES);
        assert_eq!(endpoint.pcm.capacity(), initial_capacity);
        assert_eq!(
            caller.backend().dropped_pcm_frames(),
            frame_count - MAX_FAKE_PCM_QUEUE_FRAMES
        );

        for value in u8::try_from(frame_count - MAX_FAKE_PCM_QUEUE_FRAMES).unwrap()
            ..u8::try_from(frame_count).unwrap()
        {
            assert_eq!(
                caller.handle(Request::ReceivePcm {
                    call_id: 44,
                    capability,
                }),
                Response::PcmReceived {
                    frame: Box::new([value; PCM_FRAME_BYTES]),
                }
            );
        }
        assert_eq!(
            caller.handle(Request::ReceivePcm {
                call_id: 44,
                capability,
            }),
            Response::PcmPending
        );
    }

    #[test]
    fn terminal_cleanup_closes_and_zeroizes_queued_fake_pcm() {
        let (mut caller, _, _, _, _) = prepared_pair();
        let Response::MediaAttached { capability, .. } = caller.handle(Request::AttachMedia {
            call_id: 44,
            request_id: 7,
        }) else {
            panic!("active media must attach PCM");
        };
        assert_eq!(
            caller.handle(Request::SendPcm {
                call_id: 44,
                capability,
                frame: Box::new([9; PCM_FRAME_BYTES]),
            }),
            Response::PcmSent
        );
        assert_eq!(
            caller.handle(Request::CloseMedia {
                call_id: 44,
                capability,
            }),
            Response::MediaClosed
        );
        assert!(caller.endpoint.is_none());
        assert_eq!(caller.backend().stopped(), &[44]);
    }

    #[test]
    fn signal_retries_replay_once_and_conflicting_request_ids_fail_closed() {
        let (mut caller, _, _, _, _) = prepared_pair();
        let request = Request::Signal {
            call_id: 44,
            request_id: 7,
            signal: vec![4; 8],
        };
        assert_eq!(
            caller.handle(request.clone()),
            Response::SignalForwarded { request_id: 7 }
        );
        assert_eq!(
            caller.handle(request),
            Response::SignalForwarded { request_id: 7 }
        );
        assert_eq!(caller.backend().forwarded_signals(), 1);
        assert_eq!(
            caller.handle(Request::Signal {
                call_id: 44,
                request_id: 7,
                signal: vec![5; 8],
            }),
            invalid_state()
        );
        assert_eq!(caller.backend().forwarded_signals(), 1);
    }

    #[test]
    fn signal_replay_cache_caps_entries_and_retained_bytes() {
        let (mut caller, _, _, _, _) = prepared_pair();
        for request_id in 0..u64::try_from(MAX_SIGNAL_REPLAY_ENTRIES).unwrap() {
            assert_eq!(
                caller.handle(Request::Signal {
                    call_id: 44,
                    request_id,
                    signal: vec![4],
                }),
                Response::SignalForwarded { request_id }
            );
        }
        assert_eq!(
            caller.backend().forwarded_signals(),
            MAX_SIGNAL_REPLAY_ENTRIES
        );
        assert_eq!(
            caller.handle(Request::Signal {
                call_id: 44,
                request_id: u64::try_from(MAX_SIGNAL_REPLAY_ENTRIES).unwrap(),
                signal: vec![4],
            }),
            invalid_state()
        );
        let CallState::Active { signal_replays, .. } = &caller.state else {
            panic!("caller must remain active");
        };
        assert_eq!(signal_replays.len(), MAX_SIGNAL_REPLAY_ENTRIES);
        assert!(
            signal_replays.len() * core::mem::size_of::<SignalReplay>() <= MAX_SIGNAL_REPLAY_BYTES
        );
        assert_eq!(
            caller.backend().forwarded_signals(),
            MAX_SIGNAL_REPLAY_ENTRIES
        );
    }

    #[test]
    fn signal_replay_cache_expires_with_the_call() {
        let (mut caller, _, _, _, _) = prepared_pair();
        caller.ttl = Duration::from_millis(1);
        let request = Request::Signal {
            call_id: 44,
            request_id: 1,
            signal: vec![4],
        };
        assert_eq!(
            caller.handle(request.clone()),
            Response::SignalForwarded { request_id: 1 }
        );
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(caller.handle(request), invalid_state());
        assert_eq!(caller.backend().forwarded_signals(), 1);
        assert_eq!(caller.backend().stopped(), &[44]);
    }

    #[test]
    fn forwards_bounded_signals_only_while_active() {
        let (mut caller, _, _, _, _) = prepared_pair();
        assert_eq!(
            caller.handle(Request::Signal {
                call_id: 44,
                request_id: 1,
                signal: vec![4; 8]
            }),
            Response::SignalForwarded { request_id: 1 }
        );
        assert_eq!(caller.backend().forwarded_signals(), 1);
        assert_eq!(
            caller.handle(Request::Signal {
                call_id: 44,
                request_id: 2,
                signal: vec![4; MAX_SIGNAL_BYTES + 1]
            }),
            Response::Error {
                code: ErrorCode::InvalidRequest
            }
        );
    }
}
