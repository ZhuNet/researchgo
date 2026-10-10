mod content;
mod dirindex;
mod fsops;
mod search;
mod toolchain;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      dirindex::init(app);
      watcher::init(app);
      toolchain::init(app);
      if cfg!(debug_assertions) {
        log::info!("ResearchGO ready");
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
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
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}