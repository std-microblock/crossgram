use std::env;
use std::fs;
use std::io::{self, BufReader, BufWriter};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

use nix::sys::socket::{getsockopt, sockopt};
use nix::unistd::Uid;

use crossgram_voice_worker::serve_connection;
#[cfg(feature = "test-fake")]
use crossgram_voice_worker::serve_fake_connection;
#[cfg(feature = "native-tgcalls-shim")]
use crossgram_voice_worker::tgcalls_backend::{
    ShimTgcallsMediaBackend, native_tgcalls_media_backend,
};
#[cfg(feature = "test-fake")]
use crossgram_voice_worker::worker::FakeMediaBackend;
#[cfg(any(not(feature = "native-tgcalls-shim"), test))]
use crossgram_voice_worker::worker::UnavailableMediaBackend;
use crossgram_voice_worker::worker::{MediaBackend, VoiceWorker};

const SOCKET_MODE: u32 = 0o600;
const PARENT_MODE: u32 = 0o700;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(feature = "native-tgcalls-shim")]
type ProductionMediaBackend = ShimTgcallsMediaBackend;
#[cfg(not(feature = "native-tgcalls-shim"))]
type ProductionMediaBackend = UnavailableMediaBackend;

#[cfg(feature = "native-tgcalls-shim")]
fn production_backend() -> ProductionMediaBackend {
    native_tgcalls_media_backend()
}

#[cfg(not(feature = "native-tgcalls-shim"))]
const fn production_backend() -> ProductionMediaBackend {
    UnavailableMediaBackend
}

fn main() -> io::Result<()> {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    match (arguments.next(), arguments.next()) {
        (None, None) => {
            let mut worker = VoiceWorker::new(production_backend());
            let mut input = BufReader::new(io::stdin().lock());
            let mut output = BufWriter::new(io::stdout().lock());
            serve_connection(&mut worker, &mut input, &mut output)
        }
        (Some(flag), Some(path)) if flag == "--unix" && arguments.next().is_none() => {
            serve_unix(Path::new(&path))
        }
        #[cfg(feature = "test-fake")]
        (Some(flag), Some(path)) if flag == "--unix-fake" && arguments.next().is_none() => {
            serve_unix_fake(Path::new(&path))
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: crossgram-voice-worker [--unix PATH]",
        )),
    }
}

fn serve_unix(path: &Path) -> io::Result<()> {
    serve_unix_with_backend(path, production_backend())
}

#[cfg(feature = "test-fake")]
fn serve_unix_fake(path: &Path) -> io::Result<()> {
    let listener = bind_unix(path)?;
    let mut worker = VoiceWorker::new(FakeMediaBackend::default());
    loop {
        serve_unix_fake_connection(&listener, &mut worker, CONNECTION_TIMEOUT)?;
    }
}

fn serve_unix_with_backend<B: MediaBackend>(path: &Path, backend: B) -> io::Result<()> {
    let listener = bind_unix(path)?;
    let mut worker = VoiceWorker::new(backend);
    loop {
        serve_unix_connection(&listener, &mut worker, CONNECTION_TIMEOUT)?;
    }
}

fn serve_unix_connection<B: MediaBackend>(
    listener: &UnixListener,
    worker: &mut VoiceWorker<B>,
    timeout: Duration,
) -> io::Result<()> {
    serve_unix_connection_with_verifier(listener, worker, timeout, verify_peer_uid)
}

#[cfg(feature = "test-fake")]
fn serve_unix_fake_connection(
    listener: &UnixListener,
    worker: &mut VoiceWorker<FakeMediaBackend>,
    timeout: Duration,
) -> io::Result<()> {
    serve_unix_connection_with_verifier_and_handler(
        listener,
        worker,
        timeout,
        verify_peer_uid,
        serve_fake_connection,
    )
}

fn serve_unix_connection_with_verifier<B: MediaBackend>(
    listener: &UnixListener,
    worker: &mut VoiceWorker<B>,
    timeout: Duration,
    verify: impl FnOnce(&UnixStream) -> io::Result<()>,
) -> io::Result<()> {
    serve_unix_connection_with_verifier_and_handler(
        listener,
        worker,
        timeout,
        verify,
        serve_connection,
    )
}

fn serve_unix_connection_with_verifier_and_handler<B: MediaBackend>(
    listener: &UnixListener,
    worker: &mut VoiceWorker<B>,
    timeout: Duration,
    verify: impl FnOnce(&UnixStream) -> io::Result<()>,
    serve: impl FnOnce(
        &mut VoiceWorker<B>,
        &mut BufReader<UnixStream>,
        &mut BufWriter<UnixStream>,
    ) -> io::Result<()>,
) -> io::Result<()> {
    let (stream, _) = listener.accept()?;
    if !accept_verified_peer(verify(&stream))? {
        return Ok(());
    }
    configure_connection_timeout(&stream, timeout)?;
    let read_stream = stream.try_clone()?;
    let mut reader = BufReader::new(read_stream);
    let mut writer = BufWriter::new(stream);
    match serve(worker, &mut reader, &mut writer) {
        Ok(()) => Ok(()),
        Err(error) if is_client_connection_error(error.kind()) => Ok(()),
        Err(error) => Err(error),
    }
}

fn accept_verified_peer(result: io::Result<()>) -> io::Result<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(false),
        Err(error) => Err(error),
    }
}

const fn is_client_connection_error(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::InvalidData
            | io::ErrorKind::TimedOut
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::WouldBlock
    )
}

fn bind_unix(path: &Path) -> io::Result<UnixListener> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Unix socket path has no parent",
            )
        })?;
    fs::create_dir_all(parent)?;
    fs::set_permissions(parent, fs::Permissions::from_mode(PARENT_MODE))?;
    if fs::symlink_metadata(path).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "refusing to replace an existing Unix socket path",
        ));
    }
    let listener = UnixListener::bind(path)?;
    if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(SOCKET_MODE)) {
        drop(listener);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(listener)
}

fn configure_connection_timeout(stream: &UnixStream, timeout: Duration) -> io::Result<()> {
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    getsockopt(stream, sockopt::PeerCredentials)
        .map(|credentials| credentials.uid())
        .map_err(|error| io::Error::other(format!("could not get Unix peer credentials: {error}")))
}

#[cfg(target_vendor = "apple")]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    getsockopt(stream, sockopt::LocalPeerCred)
        .map(|credentials| credentials.uid())
        .map_err(|error| io::Error::other(format!("could not get Unix peer credentials: {error}")))
}

fn verify_peer_uid(stream: &UnixStream) -> io::Result<()> {
    if peer_uid(stream)? != Uid::current().as_raw() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Unix socket peer has a different UID",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{ErrorKind, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::thread;

    use nix::sys::stat::{Mode, umask};

    use super::*;
    use crossgram_voice_worker::ipc::{
        EndpointKind, IpcError, MediaEndpoint, MediaStartConfig, PCM_FRAME_BYTES, PROTOCOL_VERSION,
        Request, Response, decode_response, encode_request, read_frame, write_frame,
    };
    use crossgram_voice_worker::worker::{MediaError, MediaStartConfig as WorkerMediaStartConfig};

    struct CountingMediaBackend(Arc<AtomicUsize>);

    impl MediaBackend for CountingMediaBackend {
        type Handle = ();
        type Pcm = ();

        fn start(&mut self, _config: WorkerMediaStartConfig) -> Result<Self::Handle, MediaError> {
            Ok(())
        }

        fn forward_signal(
            &mut self,
            _handle: &mut Self::Handle,
            _signal: &[u8],
        ) -> Result<(), MediaError> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn attach_pcm(&mut self, _handle: &mut Self::Handle) -> Result<Self::Pcm, MediaError> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        fn send_pcm(
            &mut self,
            _pcm: &mut Self::Pcm,
            _frame: &[u8; PCM_FRAME_BYTES],
        ) -> Result<(), MediaError> {
            Ok(())
        }
        fn receive_pcm(
            &mut self,
            _pcm: &mut Self::Pcm,
        ) -> Result<Option<[u8; PCM_FRAME_BYTES]>, MediaError> {
            Ok(None)
        }
        fn close_pcm(&mut self, _pcm: Self::Pcm) {}
        fn stop(&mut self, _handle: Self::Handle) {}
    }

    fn config() -> MediaStartConfig {
        MediaStartConfig {
            is_outgoing: true,
            initialization_timeout_ms: 1,
            receive_timeout_ms: 1,
            enable_p2p: false,
            allow_tcp: true,
            protocol_v1: true,
            enable_aec: true,
            enable_ns: true,
            enable_agc: true,
            endpoints: vec![MediaEndpoint {
                id: 1,
                ipv4: "127.0.0.1".into(),
                ipv6: String::new(),
                port: 443,
                kind: EndpointKind::UdpRelay,
                peer_tag: [1; 16],
            }],
            rtc_servers: vec![],
        }
    }

    fn umask_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn socket_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "crossgram-voice-worker-{name}-{}",
            std::process::id()
        ))
    }

    fn assert_listener_survives_client_error(name: &str, client_action: impl FnOnce(&Path)) {
        let parent = socket_path(name);
        let path = parent.join("worker.sock");
        let _ = fs::remove_dir_all(&parent);
        let listener = bind_unix(&path).unwrap();
        let server = thread::spawn(move || {
            let mut worker = VoiceWorker::new(UnavailableMediaBackend);
            for _ in 0..2 {
                serve_unix_connection(&listener, &mut worker, Duration::from_millis(25)).unwrap();
            }
        });

        client_action(&path);

        let mut client = UnixStream::connect(&path).unwrap();
        let request = encode_request(&Request::PrepareCaller { call_id: 1 }).unwrap();
        write_frame(&mut client, &request).unwrap();
        let response = read_frame(&mut client).unwrap().unwrap();
        assert!(matches!(
            decode_response(&response).unwrap(),
            Response::CallerPrepared { .. }
        ));

        server.join().unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn one_request_per_connection_prevents_listener_monopolization() {
        let parent = socket_path("one-request");
        let path = parent.join("worker.sock");
        let _ = fs::remove_dir_all(&parent);
        let listener = bind_unix(&path).unwrap();
        let server = thread::spawn(move || {
            let mut worker = VoiceWorker::new(UnavailableMediaBackend);
            for _ in 0..2 {
                serve_unix_connection(&listener, &mut worker, Duration::from_secs(1)).unwrap();
            }
        });

        let mut first = UnixStream::connect(&path).unwrap();
        write_frame(
            &mut first,
            &encode_request(&Request::PrepareCaller { call_id: 1 }).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            decode_response(&read_frame(&mut first).unwrap().unwrap()).unwrap(),
            Response::CallerPrepared { .. }
        ));

        let mut second = UnixStream::connect(&path).unwrap();
        second
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        write_frame(
            &mut second,
            &encode_request(&Request::PrepareCaller { call_id: 1 }).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            decode_response(&read_frame(&mut second).unwrap().unwrap()).unwrap(),
            Response::CallerPrepared { .. }
        ));

        server.join().unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn reconnect_replays_signal_without_forwarding_it_again() {
        let parent = socket_path("signal-replay");
        let path = parent.join("worker.sock");
        let _ = fs::remove_dir_all(&parent);
        let listener = bind_unix(&path).unwrap();
        let forwards = Arc::new(AtomicUsize::new(0));
        let mut worker = VoiceWorker::new(CountingMediaBackend(Arc::clone(&forwards)));
        let Response::CallerPrepared { ga_hash } =
            worker.handle(Request::PrepareCaller { call_id: 1 })
        else {
            panic!("caller must prepare");
        };
        let mut recipient = VoiceWorker::new(UnavailableMediaBackend);
        let Response::RecipientPrepared { gb } = recipient.handle(Request::PrepareRecipient {
            call_id: 1,
            ga_hash,
        }) else {
            panic!("recipient must prepare");
        };
        assert!(matches!(
            worker.handle(Request::CompleteCaller {
                call_id: 1,
                gb,
                config: config(),
            }),
            Response::CallerCompleted { .. }
        ));
        let server = thread::spawn(move || {
            for _ in 0..2 {
                serve_unix_connection(&listener, &mut worker, Duration::from_secs(1)).unwrap();
            }
        });
        let request = Request::Signal {
            call_id: 1,
            request_id: 9,
            signal: vec![4; 8],
        };

        let mut first = UnixStream::connect(&path).unwrap();
        write_frame(&mut first, &encode_request(&request).unwrap()).unwrap();
        let first_response = decode_response(&read_frame(&mut first).unwrap().unwrap()).unwrap();
        assert_eq!(first_response, Response::SignalForwarded { request_id: 9 });
        drop(first);

        let mut second = UnixStream::connect(&path).unwrap();
        write_frame(&mut second, &encode_request(&request).unwrap()).unwrap();
        assert_eq!(
            decode_response(&read_frame(&mut second).unwrap().unwrap()).unwrap(),
            first_response
        );

        server.join().unwrap();
        assert_eq!(forwards.load(Ordering::Relaxed), 1);
        fs::remove_file(path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn unix_pcm_attach_replays_once_and_revokes_after_terminal_close() {
        let parent = socket_path("pcm-attach");
        let path = parent.join("worker.sock");
        let _ = fs::remove_dir_all(&parent);
        let listener = bind_unix(&path).unwrap();
        let attached = Arc::new(AtomicUsize::new(0));
        let mut worker = VoiceWorker::new(CountingMediaBackend(Arc::clone(&attached)));
        let Response::CallerPrepared { ga_hash } =
            worker.handle(Request::PrepareCaller { call_id: 1 })
        else {
            panic!("caller must prepare");
        };
        let mut recipient = VoiceWorker::new(UnavailableMediaBackend);
        let Response::RecipientPrepared { gb } = recipient.handle(Request::PrepareRecipient {
            call_id: 1,
            ga_hash,
        }) else {
            panic!("recipient must prepare");
        };
        assert!(matches!(
            worker.handle(Request::CompleteCaller {
                call_id: 1,
                gb,
                config: config(),
            }),
            Response::CallerCompleted { .. }
        ));
        let server = thread::spawn(move || {
            for _ in 0..4 {
                serve_unix_connection(&listener, &mut worker, Duration::from_secs(1)).unwrap();
            }
        });
        let attach = Request::AttachMedia {
            call_id: 1,
            request_id: 9,
        };
        let exchange = |request: &Request| {
            let mut client = UnixStream::connect(&path).unwrap();
            write_frame(&mut client, &encode_request(request).unwrap()).unwrap();
            decode_response(&read_frame(&mut client).unwrap().unwrap()).unwrap()
        };
        let first = exchange(&attach);
        let Response::MediaAttached { capability, .. } = first.clone() else {
            panic!("active Unix worker must attach PCM");
        };
        assert_eq!(exchange(&attach), first);
        assert_eq!(
            exchange(&Request::CloseMedia {
                call_id: 1,
                capability,
            }),
            Response::MediaClosed
        );
        assert_eq!(
            exchange(&Request::ReceivePcm {
                call_id: 1,
                capability,
            }),
            Response::Error {
                code: crossgram_voice_worker::ipc::ErrorCode::InvalidState
            }
        );

        server.join().unwrap();
        assert_eq!(attached.load(Ordering::Relaxed), 1);
        fs::remove_file(path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn rejected_peer_does_not_stop_the_next_valid_client() {
        let parent = socket_path("rejected-peer");
        let path = parent.join("worker.sock");
        let _ = fs::remove_dir_all(&parent);
        let listener = bind_unix(&path).unwrap();
        let server = thread::spawn(move || {
            let mut worker = VoiceWorker::new(UnavailableMediaBackend);
            serve_unix_connection_with_verifier(
                &listener,
                &mut worker,
                Duration::from_secs(1),
                |_| Err(io::Error::from(ErrorKind::PermissionDenied)),
            )
            .unwrap();
            serve_unix_connection(&listener, &mut worker, Duration::from_secs(1)).unwrap();
        });

        let rejected = UnixStream::connect(&path).unwrap();
        let mut valid = UnixStream::connect(&path).unwrap();
        write_frame(
            &mut valid,
            &encode_request(&Request::PrepareCaller { call_id: 1 }).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            decode_response(&read_frame(&mut valid).unwrap().unwrap()).unwrap(),
            Response::CallerPrepared { .. }
        ));

        drop(rejected);
        server.join().unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn credential_query_errors_remain_fatal() {
        let error =
            accept_verified_peer(Err(io::Error::other("credential query failed"))).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Other);
    }

    #[test]
    fn unix_socket_is_private_under_umask_zero_and_refuses_stale_paths() {
        let _lock = umask_lock().lock().unwrap();
        let parent = socket_path("umask");
        let path = parent.join("worker.sock");
        let _ = fs::remove_dir_all(&parent);
        let previous = umask(Mode::empty());
        let listener = bind_unix(&path).unwrap();
        umask(previous);
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            PARENT_MODE
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            SOCKET_MODE
        );
        drop(listener);
        assert_eq!(
            bind_unix(&path).unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        fs::remove_file(path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn unix_connection_enforces_peer_and_read_timeout() {
        let parent = socket_path("timeout");
        let path = parent.join("worker.sock");
        let _ = fs::remove_dir_all(&parent);
        let listener = bind_unix(&path).unwrap();
        let client = UnixStream::connect(&path).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        verify_peer_uid(&server).unwrap();
        configure_connection_timeout(&server, Duration::from_millis(10)).unwrap();
        assert!(
            matches!(read_frame(&mut server), Err(IpcError::Io(error)) if error.kind() == ErrorKind::TimedOut || error.kind() == ErrorKind::WouldBlock)
        );
        drop(client);
        drop(listener);
        fs::remove_file(path).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn partial_header_timeouts_do_not_stop_the_listener() {
        for header_bytes in 1..=3 {
            assert_listener_survives_client_error("partial-header", |path| {
                let mut client = UnixStream::connect(path).unwrap();
                client.write_all(&vec![0; header_bytes]).unwrap();
                thread::sleep(Duration::from_millis(75));
            });
        }
    }

    #[test]
    fn short_payload_eof_does_not_stop_the_listener() {
        assert_listener_survives_client_error("short-payload-eof", |path| {
            let mut client = UnixStream::connect(path).unwrap();
            client.write_all(&2_u32.to_be_bytes()).unwrap();
            client.write_all(&[PROTOCOL_VERSION]).unwrap();
        });
    }

    #[test]
    fn oversize_frame_does_not_stop_the_listener() {
        assert_listener_survives_client_error("oversize-frame", |path| {
            let mut client = UnixStream::connect(path).unwrap();
            let length = u32::try_from(crossgram_voice_worker::ipc::MAX_FRAME_BYTES + 1).unwrap();
            client.write_all(&length.to_be_bytes()).unwrap();
        });
    }

    #[test]
    fn malformed_payload_does_not_stop_the_listener() {
        assert_listener_survives_client_error("malformed-payload", |path| {
            let mut client = UnixStream::connect(path).unwrap();
            write_frame(&mut client, &[PROTOCOL_VERSION, 0]).unwrap();
            let response = read_frame(&mut client).unwrap().unwrap();
            assert_eq!(
                decode_response(&response).unwrap(),
                Response::Error {
                    code: crossgram_voice_worker::ipc::ErrorCode::InvalidRequest
                }
            );
        });
    }
}
