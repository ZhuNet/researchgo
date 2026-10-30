// Public so the integration test can drive the loop against a stand-in
// endpoint; nothing else reaches for these paths.
pub mod agent;
mod content;
mod dirindex;
mod fsops;
mod search;
mod toolchain;
mod watcher;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      dirindex::init(app);
      watcher::init(app);
      toolchain::init(app);
      agent::init(app);
      if cfg!(debug_assertions) {
        log::info!("ResearchGO ready");
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      agent::config::get_llm_config,
      agent::config::add_llm_config,
      agent::config::update_llm_config,
      agent::config::delete_llm_config,
      agent::config::set_active_llm_config,
      agent::config::get_openalex_config,
      agent::config::set_openalex_key,
      agent::agent_send,
      agent::agent_abort,
      agent::agent_status,
      agent::agent_clear,
      content::file_info,
      content::build_project,
      content::build_plan,
      content::read_artifact,
      fsops::list_dir_page,
      fsops::invalidate_dir,
      fsops::clear_dir_index,
      fsops::open_folder,
      fsops::read_file,
      fsops::write_file,
      fsops::path_kind,
      fsops::create_entry,
      fsops::can_write,
      fsops::rename_entry,
      fsops::remove_entry,
      fsops::copy_into,
      watcher::sync_watch,
      fsops::pick_directory,
      search::search_workspace,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|handle, event| {
    // The window is going away, so stop the agent rather than interrupting a
    // turn nobody is going to see the end of. No waiting: there is no panel left
    // to settle, and what is left behind — a shell command still running after
    // the window is gone — is exactly what this is here to prevent.
    if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } = event
      && label == "main" {
      agent::stop_without_waiting(&handle.state::<agent::agent_loop::AgentState>());
    }
  });
}
