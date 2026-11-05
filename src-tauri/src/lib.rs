use serde::Serialize;
use ssh2::{Channel, CheckResult, KeyboardInteractivePrompt, KnownHostFileKind, Prompt, Session};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// One SSH session per open machine. Its I/O thread owns the session and serves both
// the interactive shell (terminal) and app commands (remote_exec), so login/2FA happens once.

enum Req {
    Write(Vec<u8>),
    Resize(u32, u32),
    Exec(ExecReq, Sender<Result<ExecOut, String>>),
    Close,
}

struct ExecReq {
    command: String,
    stdin: Option<String>, // e.g. a whole script for `bash -s`; keeps secrets out of `ps`
    stream: bool,          // emit exec-data-{sid} chunks while it runs
}

#[derive(Serialize)]
struct ExecOut {
    out: String,
    code: i32,
}

static SESSIONS: LazyLock<Mutex<HashMap<u32, Sender<Req>>>> = LazyLock::new(Default::default);
/// Auth prompts waiting for the user's answer from the popup.
static PENDING: LazyLock<Mutex<HashMap<u64, Sender<Option<Vec<String>>>>>> = LazyLock::new(Default::default);
static REQ_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
struct AuthPrompt {
    req: u64,
    sid: u32,
    instructions: String,
    prompts: Vec<(String, bool)>, // (text, echo)
}

/// Shows the auth popup in the UI and blocks until it's answered (None = cancelled).
fn ask(app: &AppHandle, sid: u32, instructions: &str, prompts: Vec<(String, bool)>) -> Option<Vec<String>> {
    let req = REQ_ID.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = channel();
    PENDING.lock().unwrap().insert(req, tx);
    let msg = AuthPrompt { req, sid, instructions: instructions.trim().into(), prompts };
    let answer = app
        .emit("auth-prompt", msg)
        .ok()
        .and_then(|_| rx.recv_timeout(Duration::from_secs(120)).ok().flatten()); // ~sshd LoginGraceTime
    PENDING.lock().unwrap().remove(&req);
    answer
}

#[tauri::command]
fn auth_answer(req: u64, answers: Option<Vec<String>>) {
    if let Some(tx) = PENDING.lock().unwrap().remove(&req) {
        let _ = tx.send(answers);
    }
}

/// Keyboard-interactive: a lone password prompt gets the saved password (once); everything else
/// (2FA code, or the password again after a wrong saved one) goes to the popup.
struct Asker<'a> {
    app: &'a AppHandle,
    sid: u32,
    saved: Option<String>,
    retry: bool,
    cancelled: bool,
}

impl KeyboardInteractivePrompt for Asker<'_> {
    fn prompt<'b>(&mut self, _user: &str, instructions: &str, prompts: &[Prompt<'b>]) -> Vec<String> {
        if let [p] = prompts {
            if !p.echo && p.text.to_lowercase().contains("password") {
                if let Some(pw) = self.saved.take() {
                    return vec![pw];
                }
            }
        }
        let list = prompts.iter().map(|p| (p.text.trim().to_string(), p.echo)).collect();
        let note = if std::mem::take(&mut self.retry) { "Wrong password, try again." } else { instructions };
        ask(self.app, self.sid, note, list).unwrap_or_else(|| {
            self.cancelled = true;
            vec![String::new(); prompts.len()]
        })
    }
}

fn login(
    app: &AppHandle,
    sid: u32,
    host: &str,
    port: u16,
    user: &str,
    key_path: &str,
    saved: Option<String>,
) -> Result<Session, Box<dyn std::error::Error>> {
    let addr = (host, port).to_socket_addrs()?.next().ok_or("cannot resolve host")?;
    // Retry only the TCP connect: auth/host-key failures must not repeat (lockouts, re-prompts).
    let mut retries = 0;
    let tcp = loop {
        match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
            Ok(t) => break t,
            Err(_) if retries < 3 => {
                retries += 1;
                std::thread::sleep(Duration::from_secs(2));
            }
            Err(e) => return Err(e.into()),
        }
    };
    let mut sess = Session::new()?;
    sess.set_timeout(30_000);
    sess.set_tcp_stream(tcp);
    sess.handshake()?;
    verify_host_key(&sess, host, port)?;

    let mut saved = saved;
    if !key_path.is_empty() {
        if !Path::new(key_path).is_file() {
            return Err(format!("private key file not found: {key_path}").into());
        }
        // With a key, the saved secret is its passphrase, not a login password.
        sess.userauth_pubkey_file(user, None, Path::new(key_path), saved.take().as_deref())?;
    }
    if !sess.authenticated() {
        let methods = sess.auth_methods(user)?.to_string();
        // A wrong password ends the round with a failure (no re-prompt), so retry via the popup
        // like OpenSSH's NumberOfPasswordPrompts=3. Cancelling the popup stops at once.
        let kbd = methods.contains("keyboard-interactive");
        let mut asker = Asker { app, sid, saved, retry: false, cancelled: false };
        for attempt in 0..3 {
            asker.retry = attempt > 0;
            let r = if kbd {
                sess.userauth_keyboard_interactive(user, &mut asker)
            } else {
                let pw = match asker.saved.take() {
                    Some(pw) => pw,
                    None => {
                        let note = if asker.retry { "Wrong password, try again." } else { "" };
                        ask(app, sid, note, vec![("Password:".into(), false)])
                            .and_then(|a| a.into_iter().next())
                            .ok_or("cancelled")?
                    }
                };
                sess.userauth_password(user, &pw)
            };
            if asker.cancelled {
                return Err("cancelled".into());
            }
            match r {
                Ok(()) => break,
                Err(e) if attempt == 2 => return Err(e.into()),
                Err(_) => {}
            }
        }
    }
    Ok(sess)
}

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    sid: u32,
    id: i64,
    host: String,
    port: u16,
    user: String,
    key_path: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let saved = secret(id)?.get_password().ok();
        let sess = login(&app, sid, &host, port, &user, &key_path, saved).map_err(|e| e.to_string())?;
        let mut shell = sess.channel_session().map_err(|e| e.to_string())?;
        shell
            .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
            .map_err(|e| e.to_string())?;
        shell.shell().map_err(|e| e.to_string())?;
        let (tx, rx) = channel();
        SESSIONS.lock().unwrap().insert(sid, tx);
        std::thread::spawn(move || io_loop(app, sid, sess, shell, rx));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ponytail: 10ms poll loop + execs run inline (shell output waits while one runs);
// fine for short setup commands, move to async (russh) if long-running jobs are needed.
fn io_loop(app: AppHandle, sid: u32, sess: Session, mut shell: Channel, rx: Receiver<Req>) {
    let mut buf = [0u8; 16384];
    'outer: loop {
        let mut idle = true;
        sess.set_blocking(false);
        loop {
            match shell.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app.emit(&format!("term-data-{sid}"), &buf[..n]);
                    idle = false;
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(_) => break 'outer,
            }
        }
        if shell.eof() {
            break;
        }
        sess.set_blocking(true);
        loop {
            match rx.try_recv() {
                Ok(Req::Write(d)) => {
                    if shell.write_all(&d).is_err() {
                        break 'outer;
                    }
                    idle = false;
                }
                Ok(Req::Resize(c, r)) => {
                    let _ = shell.request_pty_size(c, r, None, None);
                }
                Ok(Req::Exec(req, reply)) => {
                    let _ = reply.send(exec(&app, sid, &sess, &req).map_err(|e| e.to_string()));
                    idle = false;
                }
                Ok(Req::Close) | Err(TryRecvError::Disconnected) => break 'outer,
                Err(TryRecvError::Empty) => break,
            }
        }
        if idle {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    SESSIONS.lock().unwrap().remove(&sid);
    let _ = app.emit(&format!("term-exit-{sid}"), ());
}

fn exec(app: &AppHandle, sid: u32, sess: &Session, req: &ExecReq) -> Result<ExecOut, Box<dyn std::error::Error>> {
    // Builds can be quiet for minutes: no read timeout while a command runs.
    // ponytail: a hung command blocks this machine's session; add a cancel button if that bites.
    sess.set_timeout(0);
    let r = exec_inner(app, sid, sess, req);
    sess.set_timeout(30_000);
    r
}

fn exec_inner(app: &AppHandle, sid: u32, sess: &Session, req: &ExecReq) -> Result<ExecOut, Box<dyn std::error::Error>> {
    let mut ch = sess.channel_session()?;
    ch.handle_extended_data(ssh2::ExtendedData::Merge)?; // stderr into stdout, in order
    ch.exec(&req.command)?;
    if let Some(input) = &req.stdin {
        ch.write_all(input.as_bytes())?;
    }
    ch.send_eof()?;
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = ch.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if req.stream {
            let _ = app.emit(&format!("exec-data-{sid}"), &buf[..n]);
        }
        out.extend_from_slice(&buf[..n]);
    }
    ch.wait_close()?;
    Ok(ExecOut { out: String::from_utf8_lossy(&out).into_owned(), code: ch.exit_status()? })
}

fn send(sid: u32, req: Req) -> Result<(), String> {
    SESSIONS
        .lock()
        .unwrap()
        .get(&sid)
        .ok_or("not connected")?
        .send(req)
        .map_err(|_| "not connected".to_string())
}

#[tauri::command]
fn term_write(sid: u32, data: String) -> Result<(), String> {
    send(sid, Req::Write(data.into_bytes()))
}

#[tauri::command]
fn term_resize(sid: u32, cols: u32, rows: u32) {
    let _ = send(sid, Req::Resize(cols, rows));
}

/// Runs a command on the machine over the already-authenticated session.
#[tauri::command]
async fn remote_exec(sid: u32, command: String, stdin: Option<String>, stream: Option<bool>) -> Result<ExecOut, String> {
    let (tx, rx) = channel();
    send(sid, Req::Exec(ExecReq { command, stdin, stream: stream.unwrap_or(false) }, tx))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|_| "disconnected".to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn ssh_disconnect(sid: u32) {
    if let Some(tx) = SESSIONS.lock().unwrap().remove(&sid) {
        let _ = tx.send(Req::Close);
    }
}

/// Same policy as `ssh -o StrictHostKeyChecking=accept-new`: trust on first use, reject changed keys.
fn verify_host_key(sess: &Session, host: &str, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let file = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".ssh").join("known_hosts"))
        .ok_or("no home dir")?;
    let mut kh = sess.known_hosts()?;
    if file.exists() {
        kh.read_file(&file, KnownHostFileKind::OpenSSH)?;
    }
    let (key, kind) = sess.host_key().ok_or("no host key")?;
    match kh.check_port(host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => {
            let name = if port == 22 { host.to_string() } else { format!("[{host}]:{port}") };
            kh.add(&name, key, "", kind.into())?;
            std::fs::create_dir_all(file.parent().unwrap())?;
            kh.write_file(&file, KnownHostFileKind::OpenSSH)?;
            Ok(())
        }
        CheckResult::Mismatch => Err("HOST KEY CHANGED - possible MITM, check ~/.ssh/known_hosts".into()),
        CheckResult::Failure => Err("host key check failed".into()),
    }
}

/// Password / key passphrase lives in the OS credential store, never in sqlite.
fn secret(id: i64) -> Result<keyring::Entry, String> {
    keyring::Entry::new("sun-curved", &format!("conn-{id}")).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_secret(id: i64, secret_value: String) -> Result<(), String> {
    if secret_value.is_empty() {
        return del_secret(id);
    }
    secret(id)?.set_password(&secret_value).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_secret(id: i64) -> Result<String, String> {
    match secret(id)?.get_password() {
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        r => r.map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn del_secret(id: i64) -> Result<(), String> {
    match secret(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_disconnect,
            term_write,
            term_resize,
            remote_exec,
            auth_answer,
            set_secret,
            get_secret,
            del_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
