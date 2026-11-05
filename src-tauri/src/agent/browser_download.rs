//! Download in a native child webview: WebView2 / WKWebView / WebKitGTK.
use std::{path::PathBuf, sync::{Arc, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}}, time::Duration};
use tauri::{Manager, webview::DownloadEvent};
use super::{agent_loop::Turn, tools::ToolError};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
static BROWSERS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Notify>>>> = std::sync::LazyLock::new(Default::default);
pub(super) fn init(app: &tauri::AppHandle) { let _ = APP.set(app.clone()); }

#[tauri::command]
pub(crate) async fn close_browser(webview: tauri::Webview, label: String) -> Result<(), String> {
    if webview.label() != "main" { return Err("invalid browser host".into()); }
    if let Some(closed) = BROWSERS.lock().map_err(|e| e.to_string())?.get(&label) {
        closed.notify_one();
    }
    Ok(())
}

// Also closes the native window if the caller drops the download future.
struct Browser {
    app: tauri::AppHandle,
    label: String,
    directory: Option<tempfile::TempDir>,
    canceled: Arc<AtomicBool>,
}
impl Drop for Browser {
    fn drop(&mut self) {
        if let Ok(mut browsers) = BROWSERS.lock() {
            browsers.remove(&self.label);
        }
        self.canceled.store(true, Ordering::Relaxed);
        let app = self.app.clone();
        let label = self.label.clone();
        let directory = self.directory.take();
        let _ = self.app.run_on_main_thread(move || {
            if let Some(webview) = app.get_webview(&label) { let _ = webview.close(); }
            drop(directory);
        });
    }
}

#[tauri::command]
pub(crate) async fn position_browser(app: tauri::AppHandle, webview: tauri::Webview, label: String, bounds: Option<[f64; 4]>) -> Result<(), String> {
    if webview.label() != "main" || !label.starts_with("paper-download-") { return Err("invalid browser host".into()); }
    let Some(browser) = app.get_webview(&label) else { return Ok(()); };
    if let Some([x, y, width, height]) = bounds {
        if ![x, y, width, height].iter().all(|n| n.is_finite()) || width <= 0.0 || height <= 0.0 { return Err("invalid browser bounds".into()); }
        browser.set_bounds(tauri::Rect { position: tauri::LogicalPosition::new(x, y).into(), size: tauri::LogicalSize::new(width, height).into() }).map_err(|e| e.to_string())?;
        browser.set_zoom(width / 1000.0).map_err(|e| e.to_string())?;
        browser.show().map_err(|e| e.to_string())?;
    } else {
        browser.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

enum BrowserEvent { Ready(String), Downloading(String), Finished(Result<PathBuf, String>) }

pub(super) async fn download(url: &str, turn: &Arc<Turn>, progress: &(dyn Fn(&str, bool) + Sync)) -> Result<Vec<u8>, ToolError> {
    if turn.is_stopped() { return Err(ToolError(super::tools::STOPPED.into())); }
    let url = tauri::Url::parse(url).map_err(|e| ToolError(e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") { return Err(ToolError("PDF URL must use HTTP or HTTPS".into())); }
    let app = APP.get().ok_or_else(|| ToolError("browser host unavailable".into()))?.clone();
    let dir = tempfile::tempdir().map_err(|e| ToolError(e.to_string()))?;
    let path = dir.path().join("paper.pdf");
    let profile = dir.path().join("profile");
    #[cfg(windows)]
    {
        // Keep inline PDFs on the download path, as with the previous Chromium
        // browser. Other engines retain their native PDF/download controls.
        let default = profile.join("EBWebView/Default");
        std::fs::create_dir_all(&default).map_err(|e| ToolError(e.to_string()))?;
        std::fs::write(default.join("Preferences"), r#"{"plugins":{"always_open_pdf_externally":true}}"#).map_err(|e| ToolError(e.to_string()))?;
    }
    let label = format!("paper-download-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let canceled = Arc::new(AtomicBool::new(false));
    let _browser = Browser { app: app.clone(), label: label.clone(), directory: Some(dir), canceled: canceled.clone() };
    let closed = Arc::new(tokio::sync::Notify::new());
    BROWSERS.lock().map_err(|e| ToolError(e.to_string()))?.insert(label.clone(), closed.clone());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<BrowserEvent>();
    let host = app.clone();
    let destination = path.clone();
    app.run_on_main_thread(move || {
        if canceled.load(Ordering::Relaxed) { return; }
        let result_tx = tx.clone();
        let claimed = AtomicBool::new(false);
        let popup_host = host.clone();
        let popup_label = label.clone();
        let download_label = label.clone();
        let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(url))
            .initialization_script("document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='html,body{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}';document.documentElement.appendChild(s)})")
            .data_directory(profile)
            .on_new_window(move |url, _| {
                // Keep ordinary target=_blank download links in this browser.
                if matches!(url.scheme(), "http" | "https" | "blob") {
                    if let Some(window) = popup_host.get_webview(&popup_label) {
                        let _ = window.navigate(url);
                    }
                }
                tauri::webview::NewWindowResponse::Deny
            })
            .on_download(move |_, event| {
                match event {
                    DownloadEvent::Requested { destination: target, .. } => {
                        if claimed.swap(true, Ordering::Relaxed) { return false; }
                        *target = destination.clone();
                        let _ = result_tx.send(BrowserEvent::Downloading(download_label.clone()));
                    },
                    DownloadEvent::Finished { success, .. } => {
                        // WKWebView doesn't supply the path in Finished. We
                        // already chose it in Requested on every platform.
                        let result = if success { Ok(destination.clone()) } else { Err("browser canceled PDF download".into()) };
                        let _ = result_tx.send(BrowserEvent::Finished(result));
                    },
                    _ => {},
                }
                true
            });
        let result = host.get_window("main").ok_or_else(|| "main window unavailable".to_string()).and_then(|window| {
            window.add_child(builder, tauri::LogicalPosition::new(-10000.0, -10000.0), tauri::LogicalSize::new(1000.0, 760.0)).map_err(|e| e.to_string())
        });
        match result {
            Ok(browser) => {
                let _ = browser.hide();
                let _ = tx.send(BrowserEvent::Ready(label));
            },
            Err(error) => { let _ = tx.send(BrowserEvent::Finished(Err(format!("cannot open browser: {error}")))); },
        }
    }).map_err(|e| ToolError(e.to_string()))?;
    let operation = async {
        let mut downloading = false;
        let path = loop {
            match rx.recv().await.ok_or_else(|| ToolError("browser connection closed before download completed".into()))? {
                BrowserEvent::Ready(label) => progress(&label, downloading),
                BrowserEvent::Downloading(label) => { downloading = true; progress(&label, true); },
                BrowserEvent::Finished(result) => break result.map_err(ToolError)?,
            }
        };
        let size = std::fs::metadata(&path).map_err(|e| ToolError(e.to_string()))?.len();
        if size > 50 * 1024 * 1024 { return Err(ToolError("PDF exceeds 50 MiB limit".into())); }
        let bytes = std::fs::read(path).map_err(|e| ToolError(e.to_string()))?;
        if !bytes.starts_with(b"%PDF-") { return Err(ToolError("browser downloaded a file that is not a PDF".into())); }
        Ok(bytes)
    };
    tokio::select! {
        biased;
        _ = turn.stopped() => Err(ToolError(super::tools::STOPPED.into())),
        _ = closed.notified() => Err(ToolError("PDF download canceled: browser closed".into())),
        result = tokio::time::timeout(Duration::from_secs(180), operation) =>
            result.unwrap_or_else(|_| Err(ToolError("browser PDF download timed out after 180 seconds".into()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stopped_download_does_not_launch_browser() {
        let turn = Turn::detached();
        turn.stop();
        assert_eq!(download("https://example.org/paper.pdf", &turn, &|_, _| {}).await.unwrap_err().0, super::super::tools::STOPPED);
    }
    #[tokio::test]
    async fn non_http_urls_are_rejected_before_browser_launch() {
        assert!(download("file:///paper.pdf", &Turn::detached(), &|_, _| {}).await.unwrap_err().0.contains("HTTP"));
    }
}
