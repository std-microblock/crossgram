//! Versioned, local-only binary IPC. Responses never contain private exponents or shared keys.

use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u8 = 2;
pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_SIGNAL_BYTES: usize = 32_768;
pub const PCM_FRAME_BYTES: usize = 1_920;
pub const PCM_CAPABILITY_BYTES: usize = 32;
pub const DH_PUBLIC_BYTES: usize = 256;
pub const GA_HASH_BYTES: usize = 32;
pub const MAX_ENDPOINTS: usize = 16;
pub const MAX_HOST_BYTES: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EndpointKind {
    Inet = 0,
    Lan = 1,
    UdpRelay = 2,
    TcpRelay = 3,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaEndpoint {
    pub id: i64,
    pub ipv4: String,
    pub ipv6: String,
    pub port: u16,
    pub kind: EndpointKind,
    pub peer_tag: [u8; 16],
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaStartConfig {
    pub is_outgoing: bool,
    pub initialization_timeout_ms: u32,
    pub receive_timeout_ms: u32,
    pub enable_p2p: bool,
    pub allow_tcp: bool,
    pub protocol_v1: bool,
    pub enable_aec: bool,
    pub enable_ns: bool,
    pub enable_agc: bool,
    pub endpoints: Vec<MediaEndpoint>,
}

impl MediaStartConfig {
    pub fn validate(&self) -> Result<(), IpcError> {
        if self.initialization_timeout_ms == 0
            || self.receive_timeout_ms == 0
            || (self.endpoints.is_empty() && !self.enable_p2p)
            || self.endpoints.len() > MAX_ENDPOINTS
        {
            return Err(IpcError::Malformed);
        }
        if self.endpoints.iter().any(|endpoint| {
            endpoint.port == 0
                || endpoint.ipv4.len() > MAX_HOST_BYTES
                || endpoint.ipv6.len() > MAX_HOST_BYTES
                || endpoint.ipv4.contains('\0')
                || endpoint.ipv6.contains('\0')
                || (endpoint.ipv4.is_empty() && endpoint.ipv6.is_empty())
        }) {
            return Err(IpcError::Malformed);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    PrepareCaller {
        call_id: u64,
    },
    PrepareRecipient {
        call_id: u64,
        ga_hash: [u8; GA_HASH_BYTES],
    },
    CompleteCaller {
        call_id: u64,
        gb: [u8; DH_PUBLIC_BYTES],
        config: MediaStartConfig,
    },
    CompleteRecipient {
        call_id: u64,
        ga: [u8; DH_PUBLIC_BYTES],
        expected_fingerprint: i64,
        config: MediaStartConfig,
    },
    Signal {
        call_id: u64,
        request_id: u64,
        signal: Vec<u8>,
    },
    Hangup {
        call_id: u64,
    },
    AttachMedia {
        call_id: u64,
        request_id: u64,
    },
    SendPcm {
        call_id: u64,
        capability: [u8; PCM_CAPABILITY_BYTES],
        frame: Box<[u8; PCM_FRAME_BYTES]>,
    },
    ReceivePcm {
        call_id: u64,
        capability: [u8; PCM_CAPABILITY_BYTES],
    },
    CloseMedia {
        call_id: u64,
        capability: [u8; PCM_CAPABILITY_BYTES],
    },
    PollEvent {
        call_id: u64,
    },
    AckEvent {
        call_id: u64,
        event_id: u64,
    },
    #[cfg(feature = "test-fake")]
    TestTakeCapture {
        call_id: u64,
    },
    #[cfg(feature = "test-fake")]
    TestInjectPlayout {
        call_id: u64,
        frame: Box<[u8; PCM_FRAME_BYTES]>,
    },
    #[cfg(feature = "test-fake")]
    TestStats {
        call_id: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerEvent {
    OutboundSignal(Vec<u8>),
    NativeError,
}

impl Request {
    #[must_use]
    pub const fn call_id(&self) -> u64 {
        match self {
            Self::PrepareCaller { call_id }
            | Self::PrepareRecipient { call_id, .. }
            | Self::CompleteCaller { call_id, .. }
            | Self::CompleteRecipient { call_id, .. }
            | Self::Signal { call_id, .. }
            | Self::Hangup { call_id }
            | Self::AttachMedia { call_id, .. }
            | Self::SendPcm { call_id, .. }
            | Self::ReceivePcm { call_id, .. }
            | Self::CloseMedia { call_id, .. }
            | Self::PollEvent { call_id }
            | Self::AckEvent { call_id, .. } => *call_id,
            #[cfg(feature = "test-fake")]
            Self::TestTakeCapture { call_id }
            | Self::TestInjectPlayout { call_id, .. }
            | Self::TestStats { call_id } => *call_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    CallerPrepared {
        ga_hash: [u8; GA_HASH_BYTES],
    },
    RecipientPrepared {
        gb: [u8; DH_PUBLIC_BYTES],
    },
    CallerCompleted {
        ga: [u8; DH_PUBLIC_BYTES],
        fingerprint: i64,
    },
    RecipientCompleted {
        fingerprint: i64,
    },
    SignalForwarded {
        request_id: u64,
    },
    HungUp,
    MediaAttached {
        request_id: u64,
        capability: [u8; PCM_CAPABILITY_BYTES],
    },
    PcmSent,
    PcmReceived {
        frame: Box<[u8; PCM_FRAME_BYTES]>,
    },
    PcmPending,
    MediaClosed,
    Event {
        event_id: u64,
        event: WorkerEvent,
    },
    EventPending,
    EventAcknowledged {
        event_id: u64,
    },
    #[cfg(feature = "test-fake")]
    TestStats {
        captured_dropped: u32,
        playout_dropped: u32,
    },
    Error {
        code: ErrorCode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ErrorCode {
    InvalidRequest = 1,
    Busy = 2,
    InvalidState = 3,
    Crypto = 4,
    MediaUnavailable = 5,
}

#[derive(Debug)]
pub enum IpcError {
    Io(io::Error),
    FrameTooLarge,
    Malformed,
    UnsupportedVersion,
}

impl From<io::Error> for IpcError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn read_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, IpcError> {
    let mut header = [0_u8; 4];
    let read = reader.read(&mut header)?;
    if read == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[read..])?;
    let length = u32::from_be_bytes(header) as usize;
    if !(2..=MAX_FRAME_BYTES).contains(&length) {
        return Err(IpcError::FrameTooLarge);
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

pub fn write_frame(writer: &mut impl Write, payload: &[u8]) -> Result<(), IpcError> {
    if !(2..=MAX_FRAME_BYTES).contains(&payload.len()) {
        return Err(IpcError::FrameTooLarge);
    }
    let length = u32::try_from(payload.len()).map_err(|_| IpcError::FrameTooLarge)?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

pub fn decode_request(payload: &[u8]) -> Result<Request, IpcError> {
    let mut reader = PayloadReader::new(payload)?;
    let request = match reader.tag()? {
        1 => Request::PrepareCaller {
            call_id: reader.u64()?,
        },
        2 => Request::PrepareRecipient {
            call_id: reader.u64()?,
            ga_hash: reader.array()?,
        },
        3 => Request::CompleteCaller {
            call_id: reader.u64()?,
            gb: reader.array()?,
            config: reader.media_start_config()?,
        },
        4 => Request::CompleteRecipient {
            call_id: reader.u64()?,
            ga: reader.array()?,
            expected_fingerprint: reader.i64_le()?,
            config: reader.media_start_config()?,
        },
        5 => Request::Signal {
            call_id: reader.u64()?,
            request_id: reader.u64()?,
            signal: reader.bytes(MAX_SIGNAL_BYTES)?,
        },
        6 => Request::Hangup {
            call_id: reader.u64()?,
        },
        7 => Request::AttachMedia {
            call_id: reader.u64()?,
            request_id: reader.u64()?,
        },
        8 => Request::SendPcm {
            call_id: reader.u64()?,
            capability: reader.array()?,
            frame: Box::new(reader.array()?),
        },
        9 => Request::ReceivePcm {
            call_id: reader.u64()?,
            capability: reader.array()?,
        },
        10 => Request::CloseMedia {
            call_id: reader.u64()?,
            capability: reader.array()?,
        },
        11 => Request::PollEvent {
            call_id: reader.u64()?,
        },
        12 => Request::AckEvent {
            call_id: reader.u64()?,
            event_id: reader.u64()?,
        },
        #[cfg(feature = "test-fake")]
        13 => Request::TestTakeCapture {
            call_id: reader.u64()?,
        },
        #[cfg(feature = "test-fake")]
        14 => Request::TestInjectPlayout {
            call_id: reader.u64()?,
            frame: Box::new(reader.array()?),
        },
        #[cfg(feature = "test-fake")]
        15 => Request::TestStats {
            call_id: reader.u64()?,
        },
        _ => return Err(IpcError::Malformed),
    };
    reader.finish()?;
    Ok(request)
}

pub fn encode_request(request: &Request) -> Result<Vec<u8>, IpcError> {
    let mut writer = PayloadWriter::new(request_tag(request));
    match request {
        Request::PrepareCaller { call_id }
        | Request::Hangup { call_id }
        | Request::PollEvent { call_id } => writer.u64(*call_id),
        Request::AttachMedia {
            call_id,
            request_id,
        } => {
            writer.u64(*call_id);
            writer.u64(*request_id);
        }
        Request::SendPcm {
            call_id,
            capability,
            frame,
        } => {
            writer.u64(*call_id);
            writer.array(capability);
            writer.array(frame);
        }
        Request::ReceivePcm {
            call_id,
            capability,
        }
        | Request::CloseMedia {
            call_id,
            capability,
        } => {
            writer.u64(*call_id);
            writer.array(capability);
        }
        Request::PrepareRecipient { call_id, ga_hash } => {
            writer.u64(*call_id);
            writer.array(ga_hash);
        }
        Request::CompleteCaller {
            call_id,
            gb,
            config,
        } => {
            writer.u64(*call_id);
            writer.array(gb);
            writer.media_start_config(config)?;
        }
        Request::CompleteRecipient {
            call_id,
            ga,
            expected_fingerprint,
            config,
        } => {
            writer.u64(*call_id);
            writer.array(ga);
            writer.i64_le(*expected_fingerprint);
            writer.media_start_config(config)?;
        }
        Request::Signal {
            call_id,
            request_id,
            signal,
        } => {
            writer.u64(*call_id);
            writer.u64(*request_id);
            writer.bytes(signal, MAX_SIGNAL_BYTES)?;
        }
        Request::AckEvent { call_id, event_id } => {
            writer.u64(*call_id);
            writer.u64(*event_id);
        }
        #[cfg(feature = "test-fake")]
        Request::TestTakeCapture { call_id } => writer.u64(*call_id),
        #[cfg(feature = "test-fake")]
        Request::TestInjectPlayout { call_id, frame } => {
            writer.u64(*call_id);
            writer.array(frame);
        }
        #[cfg(feature = "test-fake")]
        Request::TestStats { call_id } => writer.u64(*call_id),
    }
    Ok(writer.finish())
}

pub fn decode_response(payload: &[u8]) -> Result<Response, IpcError> {
    let mut reader = PayloadReader::new(payload)?;
    let response = match reader.tag()? {
        0x81 => Response::CallerPrepared {
            ga_hash: reader.array()?,
        },
        0x82 => Response::RecipientPrepared {
            gb: reader.array()?,
        },
        0x83 => Response::CallerCompleted {
            ga: reader.array()?,
            fingerprint: reader.i64_le()?,
        },
        0x84 => Response::RecipientCompleted {
            fingerprint: reader.i64_le()?,
        },
        0x85 => Response::SignalForwarded {
            request_id: reader.u64()?,
        },
        0x86 => Response::HungUp,
        0x87 => Response::MediaAttached {
            request_id: reader.u64()?,
            capability: reader.array()?,
        },
        0x88 => Response::PcmSent,
        0x89 => Response::PcmReceived {
            frame: Box::new(reader.array()?),
        },
        0x8a => Response::PcmPending,
        0x8b => Response::MediaClosed,
        0x8c => Response::Event {
            event_id: reader.u64()?,
            event: match reader.u8()? {
                1 => WorkerEvent::OutboundSignal(reader.bytes(MAX_SIGNAL_BYTES)?),
                2 => WorkerEvent::NativeError,
                _ => return Err(IpcError::Malformed),
            },
        },
        0x8d => Response::EventPending,
        0x8e => Response::EventAcknowledged {
            event_id: reader.u64()?,
        },
        #[cfg(feature = "test-fake")]
        0x8f => Response::TestStats {
            captured_dropped: reader.u32()?,
            playout_dropped: reader.u32()?,
        },
        0xff => Response::Error {
            code: decode_error(reader.u8()?)?,
        },
        _ => return Err(IpcError::Malformed),
    };
    reader.finish()?;
    Ok(response)
}

pub fn encode_response(response: &Response) -> Result<Vec<u8>, IpcError> {
    let mut writer = PayloadWriter::new(response_tag(response));
    match response {
        Response::CallerPrepared { ga_hash } => writer.array(ga_hash),
        Response::RecipientPrepared { gb } => writer.array(gb),
        Response::CallerCompleted { ga, fingerprint } => {
            writer.array(ga);
            writer.i64_le(*fingerprint);
        }
        Response::RecipientCompleted { fingerprint } => writer.i64_le(*fingerprint),
        Response::SignalForwarded { request_id } => writer.u64(*request_id),
        Response::MediaAttached {
            request_id,
            capability,
        } => {
            writer.u64(*request_id);
            writer.array(capability);
        }
        Response::PcmReceived { frame } => writer.array(frame),
        Response::Event { event_id, event } => {
            writer.u64(*event_id);
            match event {
                WorkerEvent::OutboundSignal(signal) => {
                    writer.u8(1);
                    writer.bytes(signal, MAX_SIGNAL_BYTES)?;
                }
                WorkerEvent::NativeError => writer.u8(2),
            }
        }
        Response::EventAcknowledged { event_id } => writer.u64(*event_id),
        #[cfg(feature = "test-fake")]
        Response::TestStats {
            captured_dropped,
            playout_dropped,
        } => {
            writer.u32(*captured_dropped);
            writer.u32(*playout_dropped);
        }
        Response::Error { code } => writer.u8(*code as u8),
        Response::HungUp
        | Response::PcmSent
        | Response::PcmPending
        | Response::MediaClosed
        | Response::EventPending => {}
    }
    Ok(writer.finish())
}

const fn request_tag(request: &Request) -> u8 {
    match request {
        Request::PrepareCaller { .. } => 1,
        Request::PrepareRecipient { .. } => 2,
        Request::CompleteCaller { .. } => 3,
        Request::CompleteRecipient { .. } => 4,
        Request::Signal { .. } => 5,
        Request::Hangup { .. } => 6,
        Request::AttachMedia { .. } => 7,
        Request::SendPcm { .. } => 8,
        Request::ReceivePcm { .. } => 9,
        Request::CloseMedia { .. } => 10,
        Request::PollEvent { .. } => 11,
        Request::AckEvent { .. } => 12,
        #[cfg(feature = "test-fake")]
        Request::TestTakeCapture { .. } => 13,
        #[cfg(feature = "test-fake")]
        Request::TestInjectPlayout { .. } => 14,
        #[cfg(feature = "test-fake")]
        Request::TestStats { .. } => 15,
    }
}

const fn response_tag(response: &Response) -> u8 {
    match response {
        Response::CallerPrepared { .. } => 0x81,
        Response::RecipientPrepared { .. } => 0x82,
        Response::CallerCompleted { .. } => 0x83,
        Response::RecipientCompleted { .. } => 0x84,
        Response::SignalForwarded { .. } => 0x85,
        Response::HungUp => 0x86,
        Response::MediaAttached { .. } => 0x87,
        Response::PcmSent => 0x88,
        Response::PcmReceived { .. } => 0x89,
        Response::PcmPending => 0x8a,
        Response::MediaClosed => 0x8b,
        Response::Event { .. } => 0x8c,
        Response::EventPending => 0x8d,
        Response::EventAcknowledged { .. } => 0x8e,
        #[cfg(feature = "test-fake")]
        Response::TestStats { .. } => 0x8f,
        Response::Error { .. } => 0xff,
    }
}

fn decode_error(value: u8) -> Result<ErrorCode, IpcError> {
    match value {
        1 => Ok(ErrorCode::InvalidRequest),
        2 => Ok(ErrorCode::Busy),
        3 => Ok(ErrorCode::InvalidState),
        4 => Ok(ErrorCode::Crypto),
        5 => Ok(ErrorCode::MediaUnavailable),
        _ => Err(IpcError::Malformed),
    }
}

struct PayloadReader<'a> {
    input: &'a [u8],
    position: usize,
}

impl<'a> PayloadReader<'a> {
    fn new(input: &'a [u8]) -> Result<Self, IpcError> {
        if input.len() < 2 || input.len() > MAX_FRAME_BYTES || input[0] != PROTOCOL_VERSION {
            return Err(if input.first() == Some(&PROTOCOL_VERSION) {
                IpcError::Malformed
            } else {
                IpcError::UnsupportedVersion
            });
        }
        Ok(Self { input, position: 1 })
    }
    fn tag(&mut self) -> Result<u8, IpcError> {
        self.u8()
    }
    fn u8(&mut self) -> Result<u8, IpcError> {
        let value = *self.input.get(self.position).ok_or(IpcError::Malformed)?;
        self.position += 1;
        Ok(value)
    }
    fn u64(&mut self) -> Result<u64, IpcError> {
        Ok(u64::from_be_bytes(
            self.take(8)?.try_into().map_err(|_| IpcError::Malformed)?,
        ))
    }
    fn i64_le(&mut self) -> Result<i64, IpcError> {
        Ok(i64::from_le_bytes(
            self.take(8)?.try_into().map_err(|_| IpcError::Malformed)?,
        ))
    }
    fn u32(&mut self) -> Result<u32, IpcError> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().map_err(|_| IpcError::Malformed)?,
        ))
    }
    fn i64(&mut self) -> Result<i64, IpcError> {
        Ok(i64::from_be_bytes(
            self.take(8)?.try_into().map_err(|_| IpcError::Malformed)?,
        ))
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], IpcError> {
        self.take(N)?.try_into().map_err(|_| IpcError::Malformed)
    }
    fn bytes(&mut self, maximum: usize) -> Result<Vec<u8>, IpcError> {
        let length = usize::from(u16::from_be_bytes(
            self.take(2)?.try_into().map_err(|_| IpcError::Malformed)?,
        ));
        if length > maximum {
            return Err(IpcError::Malformed);
        }
        Ok(self.take(length)?.to_vec())
    }
    fn media_start_config(&mut self) -> Result<MediaStartConfig, IpcError> {
        let is_outgoing = self.u8()?;
        if is_outgoing > 1 {
            return Err(IpcError::Malformed);
        }
        let initialization_timeout_ms = self.u32()?;
        let receive_timeout_ms = self.u32()?;
        let flags = self.u8()?;
        if flags & !0x3f != 0 {
            return Err(IpcError::Malformed);
        }
        let endpoint_count = usize::from(self.u8()?);
        if endpoint_count > MAX_ENDPOINTS || (endpoint_count == 0 && flags & 1 == 0) {
            return Err(IpcError::Malformed);
        }
        let mut endpoints = Vec::with_capacity(endpoint_count);
        for _ in 0..endpoint_count {
            let id = self.i64()?;
            let port =
                u16::from_be_bytes(self.take(2)?.try_into().map_err(|_| IpcError::Malformed)?);
            let kind = match self.u8()? {
                0 => EndpointKind::Inet,
                1 => EndpointKind::Lan,
                2 => EndpointKind::UdpRelay,
                3 => EndpointKind::TcpRelay,
                _ => return Err(IpcError::Malformed),
            };
            let peer_tag = self.array()?;
            let ipv4 =
                String::from_utf8(self.bytes(MAX_HOST_BYTES)?).map_err(|_| IpcError::Malformed)?;
            let ipv6 =
                String::from_utf8(self.bytes(MAX_HOST_BYTES)?).map_err(|_| IpcError::Malformed)?;
            endpoints.push(MediaEndpoint {
                id,
                ipv4,
                ipv6,
                port,
                kind,
                peer_tag,
            });
        }
        let config = MediaStartConfig {
            is_outgoing: is_outgoing == 1,
            initialization_timeout_ms,
            receive_timeout_ms,
            enable_p2p: flags & 1 != 0,
            allow_tcp: flags & 2 != 0,
            protocol_v1: flags & 4 != 0,
            enable_aec: flags & 8 != 0,
            enable_ns: flags & 16 != 0,
            enable_agc: flags & 32 != 0,
            endpoints,
        };
        config.validate()?;
        Ok(config)
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8], IpcError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(IpcError::Malformed)?;
        let value = self
            .input
            .get(self.position..end)
            .ok_or(IpcError::Malformed)?;
        self.position = end;
        Ok(value)
    }
    fn finish(self) -> Result<(), IpcError> {
        if self.position == self.input.len() {
            Ok(())
        } else {
            Err(IpcError::Malformed)
        }
    }
}

struct PayloadWriter {
    output: Vec<u8>,
}

impl PayloadWriter {
    fn new(tag: u8) -> Self {
        Self {
            output: vec![PROTOCOL_VERSION, tag],
        }
    }
    fn u8(&mut self, value: u8) {
        self.output.push(value);
    }
    fn u64(&mut self, value: u64) {
        self.output.extend_from_slice(&value.to_be_bytes());
    }
    fn i64_le(&mut self, value: i64) {
        self.output.extend_from_slice(&value.to_le_bytes());
    }
    fn u32(&mut self, value: u32) {
        self.output.extend_from_slice(&value.to_be_bytes());
    }
    fn i64(&mut self, value: i64) {
        self.output.extend_from_slice(&value.to_be_bytes());
    }
    fn array<const N: usize>(&mut self, value: &[u8; N]) {
        self.output.extend_from_slice(value);
    }
    fn bytes(&mut self, value: &[u8], maximum: usize) -> Result<(), IpcError> {
        if value.len() > maximum || value.len() > usize::from(u16::MAX) {
            return Err(IpcError::Malformed);
        }
        let length = u16::try_from(value.len()).map_err(|_| IpcError::Malformed)?;
        self.output.extend_from_slice(&length.to_be_bytes());
        self.output.extend_from_slice(value);
        Ok(())
    }
    fn media_start_config(&mut self, config: &MediaStartConfig) -> Result<(), IpcError> {
        config.validate()?;
        self.u8(u8::from(config.is_outgoing));
        self.u32(config.initialization_timeout_ms);
        self.u32(config.receive_timeout_ms);
        self.u8(u8::from(config.enable_p2p)
            | (u8::from(config.allow_tcp) << 1)
            | (u8::from(config.protocol_v1) << 2)
            | (u8::from(config.enable_aec) << 3)
            | (u8::from(config.enable_ns) << 4)
            | (u8::from(config.enable_agc) << 5));
        self.u8(u8::try_from(config.endpoints.len()).map_err(|_| IpcError::Malformed)?);
        for endpoint in &config.endpoints {
            self.i64(endpoint.id);
            self.output.extend_from_slice(&endpoint.port.to_be_bytes());
            self.u8(endpoint.kind as u8);
            self.array(&endpoint.peer_tag);
            self.bytes(endpoint.ipv4.as_bytes(), MAX_HOST_BYTES)?;
            self.bytes(endpoint.ipv6.as_bytes(), MAX_HOST_BYTES)?;
        }
        Ok(())
    }
    fn finish(self) -> Vec<u8> {
        self.output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(is_outgoing: bool) -> MediaStartConfig {
        MediaStartConfig {
            is_outgoing,
            initialization_timeout_ms: 1,
            receive_timeout_ms: 1,
            enable_p2p: false,
            allow_tcp: true,
            protocol_v1: true,
            enable_aec: true,
            enable_ns: true,
            enable_agc: true,
            endpoints: vec![MediaEndpoint {
                id: 9,
                ipv4: "127.0.0.1".into(),
                ipv6: String::new(),
                port: 443,
                kind: EndpointKind::UdpRelay,
                peer_tag: [1; 16],
            }],
        }
    }

    #[test]
    fn request_round_trips_are_exact_for_v2() {
        let requests = vec![
            Request::PrepareCaller { call_id: 9 },
            Request::PrepareRecipient {
                call_id: 9,
                ga_hash: [1; GA_HASH_BYTES],
            },
            Request::CompleteCaller {
                call_id: 9,
                gb: [2; DH_PUBLIC_BYTES],
                config: config(true),
            },
            Request::CompleteRecipient {
                call_id: 9,
                ga: [3; DH_PUBLIC_BYTES],
                expected_fingerprint: -7,
                config: config(false),
            },
            Request::Signal {
                call_id: 9,
                request_id: 10,
                signal: vec![4; 3],
            },
            Request::Hangup { call_id: 9 },
            Request::AttachMedia {
                call_id: 9,
                request_id: 10,
            },
            Request::SendPcm {
                call_id: 9,
                capability: [5; PCM_CAPABILITY_BYTES],
                frame: Box::new([6; PCM_FRAME_BYTES]),
            },
            Request::ReceivePcm {
                call_id: 9,
                capability: [7; PCM_CAPABILITY_BYTES],
            },
            Request::CloseMedia {
                call_id: 9,
                capability: [8; PCM_CAPABILITY_BYTES],
            },
        ];
        for request in requests {
            let bytes = encode_request(&request).unwrap();
            assert_eq!(decode_request(&bytes).unwrap(), request);
        }
    }

    #[test]
    fn responses_are_public_only_and_exact() {
        let response = Response::CallerCompleted {
            ga: [8; DH_PUBLIC_BYTES],
            fingerprint: -7,
        };
        let bytes = encode_response(&response).unwrap();
        assert_eq!(decode_response(&bytes).unwrap(), response);
        assert_eq!(&bytes[bytes.len() - 8..], &(-7_i64).to_le_bytes());
        let recipient = Response::RecipientCompleted { fingerprint: 7 };
        assert_eq!(
            decode_response(&encode_response(&recipient).unwrap()).unwrap(),
            recipient
        );
        let negative_recipient = Response::RecipientCompleted { fingerprint: -7 };
        let recipient_bytes = encode_response(&negative_recipient).unwrap();
        assert_eq!(
            decode_response(&recipient_bytes).unwrap(),
            negative_recipient
        );
        assert_eq!(
            recipient_bytes,
            [2, 0x84, 0xf9, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
        );
        assert_eq!(
            encode_response(&Response::SignalForwarded { request_id: 9 }).unwrap(),
            [2, 0x85, 0, 0, 0, 0, 0, 0, 0, 9]
        );
        assert_eq!(encode_response(&Response::HungUp).unwrap(), vec![2, 0x86]);
        let attached = Response::MediaAttached {
            request_id: 9,
            capability: [7; PCM_CAPABILITY_BYTES],
        };
        assert_eq!(
            decode_response(&encode_response(&attached).unwrap()).unwrap(),
            attached
        );
        let pcm = Response::PcmReceived {
            frame: Box::new([6; PCM_FRAME_BYTES]),
        };
        assert_eq!(
            decode_response(&encode_response(&pcm).unwrap()).unwrap(),
            pcm
        );
        assert_eq!(decode_response(&[2, 0x8a]).unwrap(), Response::PcmPending);
    }

    #[test]
    fn allows_empty_endpoints_only_for_direct_p2p() {
        let mut direct = config(true);
        direct.enable_p2p = true;
        direct.endpoints.clear();
        assert_eq!(
            decode_request(
                &encode_request(&Request::CompleteCaller {
                    call_id: 9,
                    gb: [2; DH_PUBLIC_BYTES],
                    config: direct,
                })
                .unwrap()
            )
            .unwrap()
            .call_id(),
            9
        );

        let mut relay = config(true);
        relay.endpoints.clear();
        assert!(
            encode_request(&Request::CompleteCaller {
                call_id: 9,
                gb: [2; DH_PUBLIC_BYTES],
                config: relay,
            })
            .is_err()
        );
    }

    #[test]
    fn exact_lengths_have_no_v1_fields_or_trailing_data() {
        assert_eq!(
            encode_request(&Request::CompleteRecipient {
                call_id: 9,
                ga: [8; DH_PUBLIC_BYTES],
                expected_fingerprint: -7,
                config: config(false),
            })
            .unwrap()
            .len(),
            2 + 8 + DH_PUBLIC_BYTES + 8 + 1 + 4 + 4 + 1 + 1 + 8 + 2 + 1 + 16 + 2 + 9 + 2
        );
        assert_eq!(
            encode_request(&Request::Signal {
                call_id: 9,
                request_id: 10,
                signal: vec![8; 3],
            })
            .unwrap()
            .len(),
            2 + 8 + 8 + 2 + 3
        );
        assert_eq!(
            encode_response(&Response::CallerPrepared {
                ga_hash: [8; GA_HASH_BYTES]
            })
            .unwrap()
            .len(),
            2 + GA_HASH_BYTES
        );
        let mut payload = vec![PROTOCOL_VERSION, 1];
        payload.extend_from_slice(&9_u64.to_be_bytes());
        payload.push(0);
        assert!(matches!(decode_request(&payload), Err(IpcError::Malformed)));
    }

    #[test]
    fn rejects_v1_oversize_frames_and_signals() {
        assert!(matches!(
            decode_request(&[1, 1]),
            Err(IpcError::UnsupportedVersion)
        ));
        let mut frame = Vec::new();
        frame.extend_from_slice(&u32::try_from(MAX_FRAME_BYTES + 1).unwrap().to_be_bytes());
        assert!(matches!(
            read_frame(&mut frame.as_slice()),
            Err(IpcError::FrameTooLarge)
        ));
        assert!(matches!(
            encode_request(&Request::Signal {
                call_id: 1,
                request_id: 1,
                signal: vec![0; MAX_SIGNAL_BYTES + 1]
            }),
            Err(IpcError::Malformed)
        ));
    }

    #[test]
    fn rejects_truncated_and_trailing_payloads() {
        assert!(
            matches!(read_frame(&mut [0, 0].as_slice()), Err(IpcError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof)
        );
        assert!(matches!(
            decode_request(&[PROTOCOL_VERSION, 1, 0]),
            Err(IpcError::Malformed)
        ));
    }
}
