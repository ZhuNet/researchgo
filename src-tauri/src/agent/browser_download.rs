//! Download through an installed Chromium browser, including inline PDFs.
use std::{path::PathBuf, sync::Arc, time::Duration};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio_tungstenite::tungstenite::Message;
use super::{agent_loop::Turn, tools::ToolError};

fn browser_path() -> Result<PathBuf, ToolError> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("RESEARCHGO_BROWSER") { candidates.push(PathBuf::from(path)); }
    for base in ["PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(base) {
            for suffix in ["Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe"] {
                candidates.push(PathBuf::from(&base).join(suffix));
            }
        }
    }
    candidates.extend([
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ].map(PathBuf::from));
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| ToolError(
        "Chrome or Edge is required for PDF downloads; set RESEARCHGO_BROWSER to its executable path".into()))
}

pub(super) async fn download(url: &str, turn: &Arc<Turn>) -> Result<Vec<u8>, ToolError> {
    if turn.is_stopped() { return Err(ToolError(super::tools::STOPPED.into())); }
    let parsed = reqwest::Url::parse(url).map_err(|e| ToolError(e.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") { return Err(ToolError("PDF URL must use HTTP or HTTPS".into())); }
    let dir = tempfile::tempdir().map_err(|e| ToolError(e.to_string()))?;
    let profile = dir.path().join("profile");
    let downloads = dir.path().join("downloads");
    std::fs::create_dir_all(profile.join("Default")).map_err(|e| ToolError(e.to_string()))?;
    std::fs::create_dir_all(&downloads).map_err(|e| ToolError(e.to_string()))?;
    // Chromium otherwise displays inline application/pdf responses in its viewer.
    std::fs::write(profile.join("Default/Preferences"), json!({
        "plugins": { "always_open_pdf_externally": true },
        "download": { "prompt_for_download": false }
    }).to_string()).map_err(|e| ToolError(e.to_string()))?;
    let mut child = Command::new(browser_path()?)
        .arg(format!("--user-data-dir={}", profile.display()))
        .args(["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
            "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
            "--no-startup-window"])
        .kill_on_drop(true).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map_err(|e| ToolError(format!("cannot launch browser: {e}")))?;
    let operation = async {
        let endpoint = loop {
            if let Ok(text) = std::fs::read_to_string(profile.join("DevToolsActivePort")) {
                let mut lines = text.lines();
                if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                    break format!("ws://127.0.0.1:{port}{path}");
                }
            }
            if child.try_wait().map_err(|e| ToolError(e.to_string()))?.is_some() {
                return Err(ToolError("browser exited before starting download".into()));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        let (mut socket, _) = tokio_tungstenite::connect_async(endpoint).await.map_err(|e| ToolError(e.to_string()))?;
        socket.send(Message::Text(json!({"id":1,"method":"Browser.setDownloadBehavior","params":{
            "behavior":"allowAndName", "downloadPath":downloads, "eventsEnabled":true
        }}).to_string().into())).await.map_err(|e| ToolError(e.to_string()))?;
        let mut paper_target = None;
        while let Some(message) = socket.next().await {
            let message = message.map_err(|e| ToolError(e.to_string()))?;
            let Message::Text(text) = message else { continue };
            let event: Value = serde_json::from_str(&text).map_err(|e| ToolError(e.to_string()))?;
            if let Some(error) = event.get("error") { return Err(ToolError(format!("browser download: {error}"))); }
            let next = match event["id"].as_u64() {
                // Do not create an empty tab and navigate it afterwards. The
                // requested URL is the only target this browser session owns.
                // Subscribe before opening the page: attachment alone does not
                // enable targetDestroyed notifications on the browser socket.
                Some(1) => Some(json!({"id":5,"method":"Target.setDiscoverTargets","params":{"discover":true}})),
                Some(5) => Some(json!({"id":2,"method":"Target.createTarget","params":{"url":url}})),
                Some(2) => {
                    paper_target = event["result"]["targetId"].as_str().map(str::to_owned);
                    Some(json!({"id":3,"method":"Target.attachToTarget","params":{"targetId":event["result"]["targetId"],"flatten":true}}))
                },
                _ => None,
            };
            if let Some(next) = next {
                socket.send(Message::Text(next.to_string().into())).await.map_err(|e| ToolError(e.to_string()))?;
            }
            // Closing the visible paper window destroys its target. Treat that
            // as cancellation so the caller discards the result and reaps the
            // browser process immediately.
            if event["method"] == "Target.targetDestroyed"
                && paper_target.is_some()
                && event["params"]["targetId"].as_str() == paper_target.as_deref()
            {
                return Err(ToolError("PDF download canceled: browser window closed".into()));
            }
            if event["method"] == "Browser.downloadProgress" {
                match event["params"]["state"].as_str() {
                    Some("canceled") => return Err(ToolError("browser canceled PDF download".into())),
                    Some("completed") => {
                        let guid = event["params"]["guid"].as_str().ok_or_else(|| ToolError("missing browser download identifier".into()))?;
                        if guid.contains(['/', '\\']) { return Err(ToolError("invalid browser download identifier".into())); }
                        let path = downloads.join(guid);
                        let size = std::fs::metadata(&path).map_err(|e| ToolError(e.to_string()))?.len();
                        if size > 50 * 1024 * 1024 { return Err(ToolError("PDF exceeds 50 MiB limit".into())); }
                        let bytes = std::fs::read(path).map_err(|e| ToolError(e.to_string()))?;
                        if !bytes.starts_with(b"%PDF-") { return Err(ToolError("browser downloaded a file that is not a PDF".into())); }
                        return Ok(bytes);
                    }
                    _ => {}
                }
            }
        }
        Err(ToolError("browser connection closed before download completed".into()))
    };
    let result = tokio::select! {
        biased;
        _ = turn.stopped() => Err(ToolError(super::tools::STOPPED.into())),
        result = tokio::time::timeout(Duration::from_secs(180), operation) =>
            result.unwrap_or_else(|_| Err(ToolError("browser PDF download timed out after 180 seconds".into()))),
    };
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stopped_download_does_not_launch_browser() {
        let turn = Turn::detached();
        turn.stop();
        assert_eq!(download("https://example.org/paper.pdf", &turn).await.unwrap_err().0, super::super::tools::STOPPED);
    }

    #[tokio::test]
    async fn non_http_urls_are_rejected_before_browser_launch() {
        assert!(download("file:///paper.pdf", &Turn::detached()).await.unwrap_err().0.contains("HTTP"));
    }
    #[tokio::test]
    #[ignore = "launches an installed Chrome or Edge browser"]
    async fn browser_downloads_inline_pdf() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/paper", listener.local_addr().unwrap());
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop = done.clone();
        let server = std::thread::spawn(move || {
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut request = [0; 4096];
                    let _ = stream.read(&mut request);
                    let body = b"%PDF-1.4\n%%EOF\n";
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Disposition: inline\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(body);
                } else { std::thread::sleep(Duration::from_millis(20)); }
            }
        });
        let result = download(&url, &Turn::detached()).await;
        done.store(true, std::sync::atomic::Ordering::Relaxed);
        server.join().unwrap();
        assert_eq!(result.unwrap(), b"%PDF-1.4\n%%EOF\n");
    }
}
