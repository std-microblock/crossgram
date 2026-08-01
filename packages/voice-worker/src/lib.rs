//! Native voice-worker foundations with local IPC and no production media backend.

pub mod crypto;
pub mod ipc;
#[cfg(feature = "tgcalls-backend")]
pub mod tgcalls_backend;
pub mod worker;

use std::io::{self, Read, Write};

use ipc::{ErrorCode, Request, Response, decode_request, encode_response, read_frame, write_frame};
#[cfg(feature = "test-fake")]
use worker::FakeMediaBackend;
use worker::{MediaBackend, VoiceWorker};
use zeroize::Zeroize;

/// Serves at most one framed local IPC request against a caller-owned worker.
/// Keeping ownership outside this function preserves idempotent replies across a
/// same-UID reconnect after a lost response.
pub fn serve_connection<B: MediaBackend>(
    worker: &mut VoiceWorker<B>,
    reader: &mut impl Read,
    writer: &mut impl Write,
) -> io::Result<()> {
    serve_connection_with(reader, writer, |request| worker.handle(request))
}

#[cfg(feature = "test-fake")]
pub fn serve_fake_connection(
    worker: &mut VoiceWorker<FakeMediaBackend>,
    reader: &mut impl Read,
    writer: &mut impl Write,
) -> io::Result<()> {
    serve_connection_with(reader, writer, |request| match request {
        Request::TestTakeCapture { call_id } => worker.take_fake_capture(call_id),
        Request::TestInjectPlayout { call_id, frame } => worker.inject_fake_playout(call_id, frame),
        Request::TestStats { call_id } => worker.fake_stats(call_id),
        request => worker.handle(request),
    })
}

fn serve_connection_with(
    reader: &mut impl Read,
    writer: &mut impl Write,
    handle: impl FnOnce(Request) -> Response,
) -> io::Result<()> {
    let Some(mut frame) = read_frame(reader).map_err(ipc_error)? else {
        return Ok(());
    };
    let mut response = match decode_request(&frame) {
        Ok(request) => handle(request),
        Err(_) => Response::Error {
            code: ErrorCode::InvalidRequest,
        },
    };
    frame.zeroize();
    let mut output = encode_response(&response).map_err(ipc_error)?;
    zero_response(&mut response);
    let result = write_frame(writer, &output).map_err(ipc_error);
    output.zeroize();
    result
}

fn zero_response(response: &mut Response) {
    match response {
        Response::MediaAttached { capability, .. } => capability.zeroize(),
        Response::PcmReceived { frame } => frame.zeroize(),
        Response::Event {
            event: ipc::WorkerEvent::OutboundSignal(signal),
            ..
        } => signal.zeroize(),
        Response::CallerPrepared { .. }
        | Response::RecipientPrepared { .. }
        | Response::CallerCompleted { .. }
        | Response::RecipientCompleted { .. }
        | Response::SignalForwarded { .. }
        | Response::HungUp
        | Response::PcmSent
        | Response::PcmPending
        | Response::MediaClosed
        | Response::Event {
            event: ipc::WorkerEvent::NativeError,
            ..
        }
        | Response::EventPending
        | Response::EventAcknowledged { .. }
        | Response::Error { .. } => {}
        #[cfg(feature = "test-fake")]
        Response::TestStats { .. } => {}
    }
}

fn ipc_error(error: ipc::IpcError) -> io::Error {
    match error {
        ipc::IpcError::Io(error) => error,
        ipc::IpcError::FrameTooLarge
        | ipc::IpcError::Malformed
        | ipc::IpcError::UnsupportedVersion => {
            io::Error::new(io::ErrorKind::InvalidData, "invalid local IPC frame")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{Request, decode_response, encode_request, read_frame};
    use crate::worker::FakeMediaBackend;

    fn response(worker: &mut VoiceWorker<FakeMediaBackend>, request: &Request) -> Response {
        let mut input = Vec::new();
        write_frame(&mut input, &encode_request(request).unwrap()).unwrap();
        let mut output = Vec::new();
        serve_connection(worker, &mut input.as_slice(), &mut output).unwrap();
        decode_response(&read_frame(&mut output.as_slice()).unwrap().unwrap()).unwrap()
    }

    #[test]
    fn reconnect_replays_a_lost_prepare_response() {
        let mut worker = VoiceWorker::new(FakeMediaBackend::default());
        let request = Request::PrepareCaller { call_id: 1 };
        let first = response(&mut worker, &request);
        assert_eq!(response(&mut worker, &request), first);
    }

    #[test]
    fn connection_serves_only_one_framed_request() {
        let mut worker = VoiceWorker::new(FakeMediaBackend::default());
        let mut input = Vec::new();
        write_frame(&mut input, &[2, 0]).unwrap();
        write_frame(
            &mut input,
            &encode_request(&Request::PrepareCaller { call_id: 1 }).unwrap(),
        )
        .unwrap();
        let mut output = Vec::new();
        serve_connection(&mut worker, &mut input.as_slice(), &mut output).unwrap();
        let mut responses = output.as_slice();
        assert_eq!(
            decode_response(&read_frame(&mut responses).unwrap().unwrap()).unwrap(),
            Response::Error {
                code: ErrorCode::InvalidRequest
            }
        );
        assert!(read_frame(&mut responses).unwrap().is_none());
    }

    #[test]
    fn readme_protocol_version_matches_the_implementation() {
        let readme = include_str!("../README.md");
        assert!(readme.contains(&format!("protocol version (`{}`)", ipc::PROTOCOL_VERSION)));
    }
}
