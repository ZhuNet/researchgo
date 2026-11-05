//! Download in a native browser window: WebView2 / WKWebView / WebKitGTK.
use std::{path::PathBuf, sync::{Arc, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}}, time::Duration};
use tauri::{Manager, webview::DownloadEvent};
use super::{agent_loop::Turn, tools::ToolError};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
pub(super) fn init(app: &tauri::AppHandle) { let _ = APP.set(app.clone()); }

// Also closes the native window if the caller drops the download future.
struct Browser {
    app: tauri::AppHandle,
    label: String,
    directory: Option<tempfile::TempDir>,
    canceled: Arc<AtomicBool>,
}
impl Drop for Browser {
    fn drop(&mut self) {
        self.canceled.store(true, Ordering::Relaxed);
        let app = self.app.clone();
        let label = self.label.clone();
        let directory = self.directory.take();
        let _ = self.app.run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window(&label) { let _ = window.destroy(); }
            drop(directory);
        });
    }
}

pub(super) async fn download(url: &str, turn: &Arc<Turn>) -> Result<Vec<u8>, ToolError> {
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
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<PathBuf, String>>();
    let host = app.clone();
    let destination = path.clone();
    app.run_on_main_thread(move || {
        if canceled.load(Ordering::Relaxed) { return; }
        let result_tx = tx.clone();
        let claimed = AtomicBool::new(false);
        let popup_host = host.clone();
        let popup_label = label.clone();
        let builder = tauri::WebviewWindowBuilder::new(&host, &label, tauri::WebviewUrl::External(url))
            .title("PDF download")
            .inner_size(1000.0, 760.0)
            .data_directory(profile)
            .on_new_window(move |url, _| {
                // Keep ordinary target=_blank download links in this browser.
                if matches!(url.scheme(), "http" | "https" | "blob") {
                    if let Some(window) = popup_host.get_webview_window(&popup_label) {
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
                    },
                    DownloadEvent::Finished { success, .. } => {
                        // WKWebView doesn't supply the path in Finished. We
                        // already chose it in Requested on every platform.
                        let result = if success { Ok(destination.clone()) } else { Err("browser canceled PDF download".into()) };
                        let _ = result_tx.send(result);
                    },
                    _ => {},
                }
                true
            });
        match builder.build() {
            Ok(window) => {
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        let _ = tx.send(Err("PDF download canceled: browser window closed".into()));
                    }
                });
            },
            Err(error) => { let _ = tx.send(Err(format!("cannot open browser: {error}"))); },
        }
    }).map_err(|e| ToolError(e.to_string()))?;
    let operation = async {
        let path = rx.recv().await.ok_or_else(|| ToolError("browser connection closed before download completed".into()))?.map_err(ToolError)?;
        let size = std::fs::metadata(&path).map_err(|e| ToolError(e.to_string()))?.len();
        if size > 50 * 1024 * 1024 { return Err(ToolError("PDF exceeds 50 MiB limit".into())); }
        let bytes = std::fs::read(path).map_err(|e| ToolError(e.to_string()))?;
        if !bytes.starts_with(b"%PDF-") { return Err(ToolError("browser downloaded a file that is not a PDF".into())); }
        Ok(bytes)
    };
    tokio::select! {
        biased;
        _ = turn.stopped() => Err(ToolError(super::tools::STOPPED.into())),
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
        assert_eq!(download("https://example.org/paper.pdf", &turn).await.unwrap_err().0, super::super::tools::STOPPED);
    }
    #[tokio::test]
    async fn non_http_urls_are_rejected_before_browser_launch() {
        assert!(download("file:///paper.pdf", &Turn::detached()).await.unwrap_err().0.contains("HTTP"));
    }
}
