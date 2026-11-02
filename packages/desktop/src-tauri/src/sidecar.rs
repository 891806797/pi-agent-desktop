use serde::Deserialize;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};
#[derive(Deserialize)]
struct Ready {
    #[serde(rename = "type")]
    kind: String,
    protocol: u32,
    url: String,
    version: String,
}
pub struct Sidecar {
    child: Child,
    pub url: String,
    pub token: String,
    _tree: ProcessTree,
}
impl Sidecar {
    pub async fn spawn(
        executable: &std::path::Path,
        data: &std::path::Path,
        resources: &std::path::Path,
        quitting: &std::sync::atomic::AtomicBool,
    ) -> Result<Self, String> {
        std::fs::create_dir_all(data.join("runtime")).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(data, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            std::fs::set_permissions(data.join("runtime"), std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let wasm = resources.join("photon_rs_bg.wasm");
        if wasm.exists() {
            std::fs::copy(wasm, data.join("runtime/photon_rs_bg.wasm"))
                .map_err(|e| e.to_string())?;
        }
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let mut command = Command::new(executable);
        command
            .current_dir(data.join("runtime"))
            .env("DATA_DIR", data)
            .env("HOST", "127.0.0.1")
            .env("PORT", "0")
            .env("PI_DESKTOP_TOKEN", &token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000004);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|e| format!("后端启动失败: {e}"))?;
        let mut tree = match ProcessTree::attach(&child) {
            Ok(t) => t,
            Err(e) => {
                let _ = child.kill().await;
                return Err(e);
            }
        };
        let errors = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        if let Some(mut stderr) = child.stderr.take() {
            let tail = errors.clone();
            tokio::spawn(async move {
                let mut chunk = [0u8; 1024];
                while let Ok(n) = stderr.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    let mut bytes = tail.lock().unwrap();
                    bytes.extend_from_slice(&chunk[..n]);
                    let remove = bytes.len().saturating_sub(4096);
                    bytes.drain(..remove);
                }
            });
        }
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                cleanup(&mut child, &mut tree).await;
                return Err("缺少后端握手管道".into());
            }
        };
        let handshake = tokio::time::timeout(Duration::from_secs(45), async {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                if quitting.load(std::sync::atomic::Ordering::SeqCst) {return Err("后端启动已取消".to_string());}
                let next=tokio::select! {line=lines.next_line()=>line,_=tokio::time::sleep(Duration::from_millis(50))=>continue};
                let Some(line)=next.map_err(|error|error.to_string())? else {return Err("后端未就绪即退出".to_string());};
                if line.len() > 65536 {
                    return Err("后端握手超限".into());
                }
                if let Ok(r) = serde_json::from_str::<Ready>(&line) {
                    if r.kind == "ready" {
                        return Ok((r, lines));
                    }
                }
            }
        })
        .await;
        let (ready, mut lines) = match handshake {
            Ok(Ok(v)) => v,
            failure => {
                cleanup(&mut child, &mut tree).await;
                let tail =
                    String::from_utf8_lossy(&errors.lock().unwrap()).replace(&token, "[redacted]");
                let reason = match failure {
                    Ok(Err(reason)) => reason,
                    _ => "后端握手超时".into(),
                };
                return Err(format!("{reason}。{tail}"));
            }
        };
        let url = match reqwest::Url::parse(&ready.url) {
            Ok(url) => url,
            Err(_) => {
                cleanup(&mut child, &mut tree).await;
                return Err("后端地址无效".into());
            }
        };
        if ready.protocol != 1
            || ready.version != env!("CARGO_PKG_VERSION")
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none()
            || url.path() != "/"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            cleanup(&mut child, &mut tree).await;
            return Err("后端握手协议不受支持".into());
        }
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        Ok(Self {
            child,
            url: ready.url.trim_end_matches('/').into(),
            token,
            _tree: tree,
        })
    }
    pub fn exited(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_some()
    }
    pub async fn shutdown(&mut self) {
        self._tree.snapshot();
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n").await;
            let _ = stdin.shutdown().await;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            tokio::select! { _=self.child.wait()=>break, _=tokio::time::sleep_until(deadline)=>{let _=self.child.kill().await;break;}, _=tokio::time::sleep(Duration::from_millis(100))=>self._tree.snapshot() }
        }
        self._tree.snapshot();
        self._tree.terminate();
        let _ = self.child.wait().await;
    }
}
async fn cleanup(child: &mut Child, tree: &mut ProcessTree) {
    tree.snapshot();
    let _ = child.start_kill();
    tree.snapshot();
    tree.terminate();
    let _ = child.wait().await;
}
#[cfg(windows)]
pub struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    pub fn attach(child: &Child) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(
                    job,
                    child.raw_handle().ok_or("missing child handle")? as _,
                ) == 0
            {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().to_string());
            }
            let snapshot =
                windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot(
                    windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPTHREAD,
                    0,
                );
            if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                CloseHandle(job);
                return Err("无法枚举受管进程线程".into());
            }
            let mut entry: windows_sys::Win32::System::Diagnostics::ToolHelp::THREADENTRY32 =
                std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let mut found = false;
            let mut next = windows_sys::Win32::System::Diagnostics::ToolHelp::Thread32First(
                snapshot, &mut entry,
            );
            while next != 0 {
                if Some(entry.th32OwnerProcessID) == child.id() {
                    let thread = windows_sys::Win32::System::Threading::OpenThread(
                        windows_sys::Win32::System::Threading::THREAD_SUSPEND_RESUME,
                        0,
                        entry.th32ThreadID,
                    );
                    if !thread.is_null() {
                        found =
                            windows_sys::Win32::System::Threading::ResumeThread(thread) != u32::MAX;
                        CloseHandle(thread);
                    }
                }
                next = windows_sys::Win32::System::Diagnostics::ToolHelp::Thread32Next(
                    snapshot, &mut entry,
                );
            }
            CloseHandle(snapshot);
            if !found {
                CloseHandle(job);
                return Err("无法恢复受管进程".into());
            }
            Ok(Self(job))
        }
    }
    pub fn snapshot(&mut self) {}
    pub fn terminate(&mut self) {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            TerminateJobObject(self.0, 1);
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                if QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ) == 0
                    || info.ActiveProcesses == 0
                    || std::time::Instant::now() >= deadline
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(unix)]
pub struct ProcessTree {
    root: sysinfo::Pid,
    start: u64,
    descendants: Vec<(sysinfo::Pid, u64)>,
}
#[cfg(unix)]
impl ProcessTree {
    pub fn attach(child: &Child) -> Result<Self, String> {
        let root = sysinfo::Pid::from_u32(child.id().ok_or("missing pid")?);
        let system = sysinfo::System::new_all().map_err(|e| e.to_string())?;
        let start = system
            .process(root)
            .ok_or("无法验证后端进程身份")?
            .start_time();
        Ok(Self {
            root,
            start,
            descendants: Vec::new(),
        })
    }
    pub fn snapshot(&mut self) {
        let Ok(system) = sysinfo::System::new_all() else {
            return;
        };
        let mut parents = Vec::new();
        if system
            .process(self.root)
            .is_some_and(|p| p.start_time() == self.start)
        {
            parents.push(self.root);
        }
        parents.extend(
            self.descendants
                .iter()
                .filter(|(pid, start)| {
                    system
                        .process(*pid)
                        .is_some_and(|p| p.start_time() == *start)
                })
                .map(|(pid, _)| *pid),
        );
        loop {
            let next = system
                .processes()
                .iter()
                .filter(|(pid, p)| {
                    p.parent().is_some_and(|parent| parents.contains(&parent))
                        && !parents.contains(pid)
                })
                .map(|(pid, _)| *pid)
                .collect::<Vec<_>>();
            if next.is_empty() {
                break;
            }
            parents.extend(next);
        }
        for pid in parents.into_iter().filter(|pid| *pid != self.root) {
            if let Some(process) = system.process(pid) {
                let identity = (pid, process.start_time());
                if !self.descendants.contains(&identity) {
                    self.descendants.push(identity);
                }
            }
        }
    }
    pub fn terminate(&mut self) {
        let Ok(system) = sysinfo::System::new_all() else {
            return;
        };
        for (pid, start) in self
            .descendants
            .iter()
            .rev()
            .copied()
            .chain(std::iter::once((self.root, self.start)))
        {
            if let Some(process) = system.process(pid) {
                if process.start_time() == start {
                    let _ = process.kill_with(sysinfo::Signal::Kill);
                }
            }
        }
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.snapshot();
        self.terminate();
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    #[tokio::test]
    #[ignore]
    async fn job_owner_helper() {
        let marker = std::env::var("PI_JOB_TEST_MARKER").unwrap();
        let script=format!("$c=Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-Command','Start-Sleep 120'; Set-Content -LiteralPath '{}' -Value \"$PID,$($c.Id)\"; Start-Sleep 120",marker.replace('\'',"''"));
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-Command", &script])
            .creation_flags(0x08000004)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().unwrap();
        let mut tree = ProcessTree::attach(&child).unwrap();
        if std::env::var("PI_JOB_TEST_GRACEFUL").as_deref() == Ok("1") {
            let mut line = String::new();
            let _ = BufReader::new(tokio::io::stdin())
                .read_line(&mut line)
                .await;
            tree.terminate();
        }
        let _ = child.wait().await;
    }
    #[tokio::test]
    async fn abrupt_owner_death_kills_real_nested_children() {
        verify_cleanup(false).await;
    }
    #[tokio::test]
    async fn graceful_owner_shutdown_kills_real_nested_children() {
        verify_cleanup(true).await;
    }
    async fn verify_cleanup(graceful: bool) {
        let marker = std::env::temp_dir().join(format!("pi-job-{}.txt", uuid::Uuid::new_v4()));
        let mut owner = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "sidecar::tests::job_owner_helper",
                "--nocapture",
            ])
            .env("PI_JOB_TEST_MARKER", &marker)
            .env("PI_JOB_TEST_GRACEFUL", if graceful { "1" } else { "" })
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !marker.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "nested process marker timeout"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let ids = loop {
            if let Ok(ids) = std::fs::read_to_string(&marker) {
                if ids.trim().split(',').count() == 2 {
                    break ids;
                }
            }
            assert!(std::time::Instant::now() < deadline, "marker read timeout");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let handles: Vec<_> = ids
            .trim()
            .split(',')
            .map(|s| {
                let pid = s.parse().unwrap();
                let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                assert!(!handle.is_null());
                handle
            })
            .collect();
        assert_eq!(handles.len(), 2);
        if graceful {
            owner
                .stdin
                .take()
                .unwrap()
                .write_all(b"shutdown\n")
                .await
                .unwrap();
        } else {
            owner.kill().await.unwrap();
        }
        tokio::time::timeout(Duration::from_secs(10), owner.wait())
            .await
            .unwrap()
            .unwrap();
        for handle in handles {
            assert_eq!(
                unsafe { WaitForSingleObject(handle, 10000) },
                0,
                "orphan survives owner death"
            );
            unsafe {
                CloseHandle(handle);
            }
        }
        std::fs::remove_file(marker).unwrap();
    }
}

#[cfg(all(test, windows))]
mod startup_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    #[tokio::test]
    async fn quitting_cancels_never_ready_sidecar_and_reaps_nested_tree() {
        let root = std::env::temp_dir().join(format!("pi-startup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("fake.rs");
        let executable = root.join("fake.exe");
        std::fs::write(&source,r#"use std::{process::{Command,Stdio},io::Write,time::Duration};use std::os::windows::process::CommandExt;fn main(){let data=std::path::PathBuf::from(std::env::var("DATA_DIR").unwrap());let is_child=std::env::args().any(|a|a=="child");let mut child=if is_child{let more=std::path::PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32/more.com");Command::new(more).creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap()}else{Command::new(std::env::current_exe().unwrap()).arg("child").creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap()};let mut file=std::fs::OpenOptions::new().create(true).append(true).open(data.join("pids.txt")).unwrap();writeln!(file,"{}",std::process::id()).unwrap();if is_child{writeln!(file,"{}",child.id()).unwrap();}drop(file);std::thread::sleep(Duration::from_secs(90));let _=child.kill();}"#).unwrap();
        let compile = std::process::Command::new("rustc")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            compile.status.success(),
            "{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let quit = Arc::new(AtomicBool::new(false));
        let worker_root = root.clone();
        let worker_quit = quit.clone();
        let spawned = tokio::spawn(async move {
            match Sidecar::spawn(&executable, &worker_root, &worker_root, &worker_quit).await {
                Ok(mut sidecar) => {
                    sidecar.shutdown().await;
                    "unexpected ready".to_string()
                }
                Err(error) => error,
            }
        });
        let marker = root.join("pids.txt");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let ids = loop {
            if let Ok(contents) = std::fs::read_to_string(&marker) {
                let ids = contents
                    .lines()
                    .filter_map(|line| line.parse::<u32>().ok())
                    .collect::<Vec<_>>();
                if ids.len() == 3 {
                    break ids;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "fake tree marker timeout"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let handles = ids
            .into_iter()
            .map(|pid| unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) })
            .collect::<Vec<_>>();
        assert!(handles.iter().all(|h| !h.is_null()));
        let start = std::time::Instant::now();
        quit.store(true, Ordering::SeqCst);
        let finished = tokio::time::timeout(Duration::from_secs(3), spawned).await;
        assert!(
            finished.is_ok(),
            "cancelled startup must finish within 3s (elapsed {:?})",
            start.elapsed()
        );
        let error = finished.unwrap().unwrap();
        assert!(error.contains("启动已取消"), "{error}");
        for handle in handles {
            assert_eq!(
                unsafe { WaitForSingleObject(handle, 1000) },
                0,
                "startup cancellation left an owned process alive"
            );
            unsafe {
                CloseHandle(handle);
            }
        }
        assert!(start.elapsed() < Duration::from_secs(3));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, unix))]
mod unix_process_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    const FIXTURE: &str = r#"
use std::{process::{Command,Stdio},io::{Write,BufRead},time::Duration,os::unix::process::CommandExt};
unsafe extern "C" {fn setsid()->i32;}
fn main(){
 let data=std::path::PathBuf::from(std::env::var("DATA_DIR").unwrap());
 let child_mode=std::env::args().any(|arg|arg=="child");
 let mut command=if child_mode {let mut command=Command::new("/bin/sleep");command.arg("90");command}else{let mut command=Command::new(std::env::current_exe().unwrap());command.arg("child");command};
 unsafe{command.pre_exec(||if setsid()<0{Err(std::io::Error::last_os_error())}else{Ok(())});}
 let _child=command.stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();
 let mut marker=std::fs::OpenOptions::new().create(true).append(true).open(data.join("pids.txt")).unwrap();
 writeln!(marker,"{}",std::process::id()).unwrap();if child_mode{writeln!(marker,"{}",_child.id()).unwrap();}drop(marker);
 if child_mode {std::thread::sleep(Duration::from_secs(90));return;}
 while std::fs::read_to_string(data.join("pids.txt")).unwrap().lines().count()<3 {std::thread::sleep(Duration::from_millis(10));}
 let mode=std::fs::read_to_string(data.join("mode")).unwrap();
 if mode!="cancel" {let url=if mode=="invalid-url"{"invalid"}else{"http://127.0.0.1:12345"};let version=if mode=="version"{"wrong"}else{"@VERSION@"};println!("{{\"type\":\"ready\",\"protocol\":1,\"url\":\"{}\",\"version\":\"{}\"}}",url,version);}
 let mut line=String::new();let _=std::io::stdin().lock().read_line(&mut line);
}
"#;
    fn fixture(mode: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("pi-unix-tree-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("fake.rs");
        let exe = root.join("fake");
        std::fs::write(
            &source,
            FIXTURE.replace("@VERSION@", env!("CARGO_PKG_VERSION")),
        )
        .unwrap();
        std::fs::write(root.join("mode"), mode).unwrap();
        let result = std::process::Command::new("rustc")
            .arg(&source)
            .arg("-o")
            .arg(&exe)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        (root, exe)
    }
    async fn identities(root: &std::path::Path) -> Vec<(sysinfo::Pid, u64)> {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(marker) = std::fs::read_to_string(root.join("pids.txt")) {
                let pids = marker
                    .lines()
                    .filter_map(|s| s.parse::<u32>().ok())
                    .map(sysinfo::Pid::from_u32)
                    .collect::<Vec<_>>();
                if pids.len() == 3 {
                    let system = sysinfo::System::new_all().unwrap();
                    return pids
                        .into_iter()
                        .map(|pid| {
                            (
                                pid,
                                system
                                    .process(pid)
                                    .expect("fixture process disappeared")
                                    .start_time(),
                            )
                        })
                        .collect();
                }
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    async fn assert_gone(identities: &[(sysinfo::Pid, u64)]) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let system = sysinfo::System::new_all().unwrap();
            if identities.iter().all(|(pid, start)| {
                system
                    .process(*pid)
                    .is_none_or(|p| p.start_time() != *start)
            }) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "owned detached Unix processes survived cleanup"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    #[tokio::test]
    async fn normal_shutdown_reaps_detached_descendants() {
        let (root, exe) = fixture("ready");
        let quit = AtomicBool::new(false);
        let mut child = Sidecar::spawn(&exe, &root, &root, &quit).await.unwrap();
        let ids = identities(&root).await;
        child.shutdown().await;
        drop(child);
        assert_gone(&ids).await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cancel_handshake_reaps_detached_descendants() {
        let (root, exe) = fixture("cancel");
        let quit = Arc::new(AtomicBool::new(false));
        let worker = quit.clone();
        let data = root.clone();
        let task = tokio::spawn(async move { Sidecar::spawn(&exe, &data, &data, &worker).await });
        let ids = identities(&root).await;
        quit.store(true, Ordering::SeqCst);
        let result = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        assert_gone(&ids).await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn invalid_handshakes_reap_detached_descendants() {
        for mode in ["invalid-url", "version"] {
            let (root, exe) = fixture(mode);
            let quit = AtomicBool::new(false);
            assert!(Sidecar::spawn(&exe, &root, &root, &quit).await.is_err());
            let pids = std::fs::read_to_string(root.join("pids.txt")).unwrap();
            let pids = pids
                .lines()
                .map(|line| sysinfo::Pid::from_u32(line.parse().unwrap()))
                .collect::<Vec<_>>();
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                let system = sysinfo::System::new_all().unwrap();
                if pids.iter().all(|pid| system.process(*pid).is_none()) {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "invalid handshake left owned descendants alive"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
