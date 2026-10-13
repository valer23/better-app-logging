//! Registry of long-running tool children (`idevicesyslog`, `adb logcat`).
//!
//! Why this exists: `kill_on_drop(true)` alone never fires in this app. Tauri
//! keeps its tokio runtime in a never-dropped static, so tasks (and the
//! `Child`s they own) are never dropped at exit. On top of that every exit path
//! skips normal teardown: Cmd+Q ends in the C `exit()` via `NSApp terminate:`,
//! closing the last window ends in tao's `process::exit`, and SIGTERM kills the
//! process instantly. Result: an orphaned child per app run.
//!
//! The registry OWNS the `Child` (not just its PID). An unreaped child's PID
//! cannot be recycled, so `kill_all` can never signal a stranger process.
//! `kill_all` is sync and never waits, so it is safe to call from the main
//! thread inside `RunEvent::Exit` or from a signal task.

use std::collections::BTreeMap; // const-constructible, so `GLOBAL` can be a plain static
use std::io;
use std::process::ExitStatus;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use tokio::process::{Child, ChildStderr, ChildStdout, Command};

pub struct Registry {
    inner: Mutex<Inner>,
}

struct Inner {
    shutting_down: bool,
    next_id: u64,
    children: BTreeMap<u64, Child>,
}

impl Registry {
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                shutting_down: false,
                next_id: 0,
                children: BTreeMap::new(),
            }),
        }
    }

    /// Poisoning is irrelevant here (no invariant spans a panic), and we must
    /// still be able to kill children during shutdown.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Atomically: refuse if shutting down, spawn, take the pipes, register.
    /// The lock is held across `cmd.spawn()` (fork/exec, ~ms, no `.await`) so
    /// `kill_all` can never miss an in-flight spawn.
    pub fn spawn(
        &'static self,
        cmd: &mut Command,
    ) -> io::Result<(Tracked, Option<ChildStdout>, Option<ChildStderr>)> {
        let mut g = self.lock();
        if g.shutting_down {
            return Err(io::Error::other("shutting down"));
        }
        let mut child = cmd.spawn()?;
        let (out, err) = (child.stdout.take(), child.stderr.take());
        let id = g.next_id;
        g.next_id += 1;
        g.children.insert(id, child);
        Ok((Tracked { reg: self, id }, out, err))
    }

    pub fn is_shutting_down(&self) -> bool {
        self.lock().shutting_down
    }

    /// Sync, idempotent, never awaits or waits. Signals (SIGKILL) every
    /// registered child and refuses further spawns. Returns how many were
    /// signalled; that count includes children that had already exited.
    pub fn kill_all(&self) -> usize {
        let mut drained: Vec<Child> = {
            let mut g = self.lock();
            g.shutting_down = true;
            std::mem::take(&mut g.children).into_values().collect()
        };
        for c in &mut drained {
            let _ = c.start_kill(); // ignore "already exited"
        }
        drained.len() // `drained` is dropped here, outside the lock
    }

    #[cfg(all(test, unix))]
    fn len(&self) -> usize {
        self.lock().children.len()
    }
}

pub static GLOBAL: Registry = Registry::new();

pub fn spawn(cmd: &mut Command) -> io::Result<(Tracked, Option<ChildStdout>, Option<ChildStderr>)> {
    GLOBAL.spawn(cmd)
}

pub fn kill_all() -> usize {
    GLOBAL.kill_all()
}

pub fn is_shutting_down() -> bool {
    GLOBAL.is_shutting_down()
}

/// Handle to a registered child. The registry owns the `Child` until the
/// handle takes it back to await on it.
pub struct Tracked {
    reg: &'static Registry,
    id: u64,
}

impl Tracked {
    /// `None` means `kill_all` already took (and killed) the child.
    fn take(&self) -> Option<Child> {
        self.reg.lock().children.remove(&self.id)
    }

    /// Kill + reap. No-op if `kill_all` already took the child.
    pub async fn kill_and_reap(self) {
        if let Some(mut c) = self.take() {
            let _ = c.kill().await;
        }
    }

    /// Waits for the child to exit WITHOUT taking it out of the registry, so
    /// `kill_all` still covers it: a child that stays alive after its stdout
    /// EOF (the window between EOF and reap) must not escape shutdown. Polls
    /// `try_wait` and never holds the lock across an `.await`.
    pub async fn wait(self) -> io::Result<ExitStatus> {
        loop {
            {
                let mut g = self.reg.lock();
                match g.children.get_mut(&self.id) {
                    // `kill_all` already took (and killed) it.
                    None => return Err(io::Error::other("killed during shutdown")),
                    Some(c) => {
                        if let Some(status) = c.try_wait()? {
                            g.children.remove(&self.id);
                            return Ok(status);
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Tracked {
    /// Keeps `kill_on_drop` semantics for early `?` returns: dropping the
    /// `Child` here triggers its own kill-on-drop.
    fn drop(&mut self) {
        drop(self.take());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;

    fn leaked() -> &'static Registry {
        Box::leak(Box::new(Registry::new()))
    }

    fn sleeper() -> Command {
        let mut cmd = Command::new("sleep");
        cmd.arg("30")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd
    }

    #[tokio::test]
    async fn kill_all_kills_registered_child() {
        let reg = leaked();
        let (_t, out, _err) = reg.spawn(&mut sleeper()).unwrap();
        let mut out = out.unwrap();

        assert_eq!(reg.kill_all(), 1);

        // stdout hits EOF only once the child is dead.
        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), out.read_to_end(&mut buf))
            .await
            .expect("child still alive after kill_all")
            .unwrap();
    }

    #[tokio::test]
    async fn spawn_refused_after_kill_all() {
        let reg = leaked();
        reg.kill_all();
        assert!(reg.is_shutting_down());
        assert!(reg.spawn(&mut sleeper()).is_err());
    }

    #[tokio::test]
    async fn dropping_tracked_unregisters() {
        let reg = leaked();
        let (t, out, _err) = reg.spawn(&mut sleeper()).unwrap();
        let mut out = out.unwrap();
        assert_eq!(reg.len(), 1);
        drop(t);
        assert_eq!(reg.len(), 0);

        // Dropping the Child fires kill_on_drop; stdout EOF proves it died.
        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), out.read_to_end(&mut buf))
            .await
            .expect("child still alive after Tracked dropped")
            .unwrap();
    }

    #[tokio::test]
    async fn kill_and_reap_after_kill_all_is_noop() {
        let reg = leaked();
        let (t, _out, _err) = reg.spawn(&mut sleeper()).unwrap();
        reg.kill_all();
        tokio::time::timeout(Duration::from_secs(2), t.kill_and_reap())
            .await
            .expect("kill_and_reap hung after kill_all");
    }

    #[tokio::test]
    async fn wait_returns_err_after_kill_all() {
        let reg = leaked();
        let (t, _out, _err) = reg.spawn(&mut sleeper()).unwrap();
        let waiter = tokio::spawn(t.wait());
        // Let the waiter enter its poll loop so it is waiting while we kill.
        tokio::time::sleep(Duration::from_millis(100)).await;

        reg.kill_all();

        let res = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("wait hung after kill_all")
            .unwrap();
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn wait_returns_status_for_normal_exit() {
        let reg = leaked();
        let (t, _out, _err) = reg.spawn(&mut Command::new("true")).unwrap();
        let status = tokio::time::timeout(Duration::from_secs(2), t.wait())
            .await
            .expect("wait hung on a child that already exited")
            .unwrap();
        assert!(status.success());
        assert_eq!(reg.len(), 0);
    }
}
