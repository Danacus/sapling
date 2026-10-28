//! A one-shot loopback listener for OpenRouter's sign-in. This window has no
//! origin a callback can reach, so the system browser is sent back to
//! `http://localhost:<port>/callback` instead, and the code arrives here.
//! Tauri-free: `lib.rs` turns the answer into an event.

use std::io::{self, BufRead, BufReader, Write};
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(100);

const PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sapling</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #23261f; background: #f7f5ee; }
@media (prefers-color-scheme: dark) { body { color: #e9e7df; background: #1c1e1a; } }
</style>
</head>
<body>
<h1>Connected</h1>
<p>You can close this tab and return to Sapling.</p>
</body>
</html>
"#;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Callback {
    pub code: String,
    pub state: Option<String>,
}

pub struct Listener {
    sockets: Vec<TcpListener>,
    port: u16,
}

/// Binds `127.0.0.1` on a free port, and `::1` on the same one when it is free:
/// a browser may try either for `localhost`.
pub fn bind() -> io::Result<Listener> {
    let v4 = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = v4.local_addr()?.port();
    let mut sockets = vec![v4];
    if let Ok(v6) = TcpListener::bind((Ipv6Addr::LOCALHOST, port)) {
        sockets.push(v6);
    }
    for socket in &sockets {
        socket.set_nonblocking(true)?;
    }
    Ok(Listener { sockets, port })
}

impl Listener {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Answers requests until one is the callback, the deadline passes or
    /// `stop` says so. Each connection gets its own thread, so a browser's
    /// speculative connection that never sends anything holds nothing up.
    pub fn wait(&self, deadline: Instant, stop: impl Fn() -> bool) -> Option<Callback> {
        let (tx, rx) = mpsc::channel();
        loop {
            if let Ok(callback) = rx.try_recv() {
                return Some(callback);
            }
            if Instant::now() >= deadline || stop() {
                return None;
            }
            let mut idle = true;
            for socket in &self.sockets {
                if let Ok((stream, _)) = socket.accept() {
                    idle = false;
                    let tx = tx.clone();
                    thread::spawn(move || {
                        if let Some(callback) = serve(stream) {
                            let _ = tx.send(callback);
                        }
                    });
                }
            }
            if idle {
                thread::sleep(POLL);
            }
        }
    }
}

fn serve(stream: TcpStream) -> Option<Callback> {
    // An accepted socket inherits non-blocking on some platforms.
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    // Read the headers too, or closing with unread input resets the connection
    // under the reply.
    let mut header = String::new();
    for _ in 0..100 {
        header.clear();
        match reader.read_line(&mut header) {
            Ok(n) if header.trim_end().is_empty() || n == 0 => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let callback = callback_from(&request_line);
    let (status, body) = match callback {
        Some(_) => ("200 OK", PAGE),
        None => ("404 Not Found", "Not found"),
    };
    let mut stream = &stream;
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
    callback
}

/// `GET /callback?code=…&state=… HTTP/1.1` → the code and state; anything
/// else (a favicon, a callback without a code) is not the callback.
pub fn callback_from(request_line: &str) -> Option<Callback> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let (path, query) = parts.next()?.split_once('?').unwrap_or(("", ""));
    if path != "/callback" {
        return None;
    }
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "code" => code = percent_decode(value),
            "state" => state = percent_decode(value),
            _ => {}
        }
    }
    let code = code.filter(|code| !code.is_empty())?;
    Some(Callback { code, state })
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = text.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::SocketAddr;

    #[test]
    fn reads_the_code_and_state() {
        assert_eq!(
            callback_from("GET /callback?code=abc%2D1&state=x_y-z HTTP/1.1\r\n"),
            Some(Callback {
                code: "abc-1".into(),
                state: Some("x_y-z".into()),
            })
        );
        assert_eq!(
            callback_from("GET /callback?state=s&code=a+b HTTP/1.1"),
            Some(Callback {
                code: "a b".into(),
                state: Some("s".into()),
            })
        );
        assert_eq!(
            callback_from("GET /callback?code=c HTTP/1.1"),
            Some(Callback {
                code: "c".into(),
                state: None,
            })
        );
    }

    #[test]
    fn anything_else_is_not_the_callback() {
        assert_eq!(callback_from("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(callback_from("GET /callback HTTP/1.1"), None);
        assert_eq!(callback_from("GET /callback?code= HTTP/1.1"), None);
        assert_eq!(callback_from("GET /callback?code=%zz HTTP/1.1"), None);
        assert_eq!(callback_from("POST /callback?code=c HTTP/1.1"), None);
        assert_eq!(callback_from(""), None);
    }

    fn get(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).unwrap();
        write!(stream, "GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        reply
    }

    #[test]
    fn serves_until_the_callback_arrives() {
        let listener = bind().unwrap();
        let port = listener.port();
        let client = thread::spawn(move || {
            // A connection that never speaks must not hold up the real one.
            let _idle = TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).unwrap();
            let favicon = get(port, "/favicon.ico");
            let callback = get(port, "/callback?code=the-code&state=the-state");
            (favicon, callback)
        });
        let got = listener.wait(Instant::now() + Duration::from_secs(10), || false);
        let (favicon, callback) = client.join().unwrap();
        assert!(favicon.starts_with("HTTP/1.1 404"));
        assert!(callback.starts_with("HTTP/1.1 200"));
        assert!(callback.contains("return to Sapling"));
        assert_eq!(
            got,
            Some(Callback {
                code: "the-code".into(),
                state: Some("the-state".into()),
            })
        );
    }

    #[test]
    fn gives_up_at_the_deadline_or_when_stopped() {
        let listener = bind().unwrap();
        assert_eq!(listener.wait(Instant::now(), || false), None);
        assert_eq!(
            listener.wait(Instant::now() + Duration::from_secs(10), || true),
            None
        );
    }
}
