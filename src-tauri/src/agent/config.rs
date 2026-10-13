//! LLM endpoint configuration, and where it is kept.
//!
//! The key never reaches the renderer. The app's CSP forbids the frontend from
//! reaching the network at all (`connect-src 'self' ipc: http://ipc.localhost`),
//! so every model call is made here — which means a key in `localStorage` would
//! be a key in a place any script in the webview can read, for no benefit. It
//! lives in the app config directory instead, and what crosses the IPC boundary
//! is a view of the config with the secret replaced by a fingerprint.
//!
//! Plaintext on disk is a deliberate choice, not an oversight. The alternative —
//! an OS keychain — is a second dependency, a platform-specific unlock prompt on
//! a desktop app that has no login of its own, and a failure mode where a
//! locked keychain silently breaks the agent. A config file the user can read,
//! edit, and delete is honest about what it is.

use std::fs;
use std::path::{Path, PathBuf};

use notify::{Event, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// One endpoint plus the models it serves.
///
/// `name` is the endpoint's identity, not a display label: two entries cannot
/// share one. A user with an OpenAI key and an Ollama on localhost has two
/// endpoints with two names, and the name is what the settings list, the
/// dropdown, and the agent's own bookkeeping all agree on. Comparing names
/// exactly — no case folding — is deliberate: `Prod` and `prod` are two things
/// a person meant to write down differently, and silently merging them loses a
/// configuration nobody can find again.
///
/// The models are a list because one endpoint usually serves several, and which
/// of them answers is a choice made per prompt, not once at configuration time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
  pub url: String,
  pub api_key: String,
  pub name: String,
  pub models: Vec<String>,
}

/// Which model the agent is pointed at: an entry's name plus one of its models.
///
/// A pair rather than a name alone, because a name no longer says which model
/// answers; and a pair rather than an index, because deleting the second of
/// three entries must not silently repoint the agent at a different endpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveModel {
  pub name: String,
  pub model: String,
}

/// Every stored configuration, plus which model the agent is using.
///
/// The whole file is read and written as a unit rather than patched entry by
/// entry. The alternative — a JSON file edited per key — is how a config gets
/// half-written when the app is killed mid-save, and a config that parses as
/// garbage resets every endpoint to the default without saying so.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFile {
  #[serde(default)]
  configs: Vec<LlmConfig>,
  #[serde(default)]
  active: Option<ActiveModel>,
}

/// One entry as the renderer is allowed to see it. No `api_key`, ever.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmView {
  pub name: String,
  pub url: String,
  pub models: Vec<String>,
  /// A fingerprint of the stored key, enough to tell two keys apart.
  pub key_hint: String,
  /// Whether this entry could actually make a call.
  pub ready: bool,
  /// Whether the agent is currently pointed at one of this entry's models.
  pub active: bool,
  /// The model the agent is pointed at, when this entry is the active one.
  pub active_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
  pub configs: Vec<LlmView>,
}

/// One entry resolved to exactly one model — what the agent loop calls.
///
/// The stored entry holds a list; the loop holds this. Splitting the types
/// keeps "which model answers" a resolved fact rather than something every
/// call site re-derives.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
  pub url: String,
  pub api_key: String,
  pub name: String,
  pub model: String,
}

impl ResolvedModel {
  /// Whether the agent could actually make a call with this.
  pub fn is_ready(&self) -> bool {
    !self.url.trim().is_empty()
      && !self.api_key.trim().is_empty()
      && !self.model.trim().is_empty()
  }
}

impl LlmConfig {
  /// Whether this entry can actually make a call.
  ///
  /// Checked before the loop starts rather than at the first request, so a
  /// half-filled form produces a readable message instead of a 401.
  pub fn is_ready(&self) -> bool {
    !self.url.trim().is_empty()
      && !self.api_key.trim().is_empty()
      && self.models.iter().any(|m| !m.trim().is_empty())
  }

  fn to_view(&self, active: bool, active_model: Option<String>) -> LlmView {
    LlmView {
      name: self.name.clone(),
      url: self.url.clone(),
      models: self.models.clone(),
      key_hint: key_hint(&self.api_key),
      ready: self.is_ready(),
      active,
      active_model,
    }
  }
}

/// "sk-ab…9f2c" — enough to tell two keys apart, not enough to use one.
fn key_hint(key: &str) -> String {
  let key = key.trim();
  if key.is_empty() {
    return String::new();
  }
  let chars: Vec<char> = key.chars().collect();
  if chars.len() <= 10 {
    return "••••".to_string();
  }
  let head: String = chars[..6].iter().collect();
  let tail: String = chars[chars.len() - 4..].iter().collect();
  format!("{head}…{tail}")
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_config_dir()
    .map_err(|e| format!("no config directory available: {e}"))?;
  fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
  Ok(dir.join("llm.json"))
}

/// The event the host emits when `llm.json` changes on disk.
///
/// Settings is one writer of that file; a text editor is the other, and the
/// config is deliberately a plain file so that editing it by hand is possible.
/// The renderer listens for this and re-reads, so a hand edit shows up without
/// a restart.
pub const CONFIG_CHANGE: &str = "llm:change";

/// Owns the config-file watcher for the life of the app.
///
/// A `notify` watcher stops watching when dropped, so it has to live
/// somewhere that outlives `init` — managed state is that somewhere, and it
/// is exactly as long-lived as the app.
///
/// The field is never read, and that is the point: owning it is the whole
/// job. The leading underscore says so to the reader and to `dead_code`.
struct ConfigWatch {
  _watcher: Box<notify::RecommendedWatcher>,
}

/// Watches the directory that holds `llm.json`.
///
/// The directory rather than the file: every save replaces the file by an
/// atomic rename, and a watch on the file itself goes stale at the moment the
/// file it named ceases to exist. The directory sees the rename as an event
/// naming `llm.json`, which is the thing to react to.
pub fn init(app: &AppHandle) {
  let Ok(path) = config_path(app) else {
    return;
  };
  let Some(dir) = path.parent().map(Path::to_path_buf) else {
    return;
  };
  let handle = app.clone();

  let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
    match res {
      Ok(event) => {
        // The atomic save renames `llm.json.tmp` over `llm.json`, so the
        // event may name either path — or both. Either way it ends with an
        // `llm.json` that differs from what the renderer last read.
        if event
          .paths
          .iter()
          .any(|p| p.file_name().is_some_and(|name| name == "llm.json"))
        {
          let _ = handle.emit(CONFIG_CHANGE, ());
        }
      }
      Err(err) => log::warn!("config watcher error: {err}"),
    }
  });

  match watcher {
    Ok(mut watcher) => match watcher.watch(&dir, RecursiveMode::NonRecursive) {
      Ok(()) => {
        app.manage(ConfigWatch {
          _watcher: Box::new(watcher),
        });
      }
      Err(err) => log::warn!("cannot watch {}: {}", dir.display(), err),
    },
    Err(err) => log::warn!("cannot start a config watcher: {err}"),
  }
}

fn read_from(path: &Path) -> ConfigFile {
  // A config that cannot be parsed falls back to empty rather than refusing to
  // start: the settings panel can rewrite it, and an app that cannot be opened
  // to fix its own config is a worse failure than a lost endpoint.
  fs::read_to_string(path)
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_default()
}

/// Writes atomically.
///
/// A half-written config would parse as garbage and reset the user's endpoints,
/// so the new content goes to a sibling file and replaces the old one in one
/// step.
fn write_to(path: &Path, file: &ConfigFile) -> Result<(), String> {
  let body = serde_json::to_string_pretty(file)
    .map_err(|e| format!("cannot serialise config: {e}"))?;
  let temp = path.with_extension("json.tmp");
  fs::write(&temp, body).map_err(|e| format!("cannot write {}: {e}", temp.display()))?;
  fs::rename(&temp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

/// The entry and model the agent would actually call.
///
/// A valid pair is honoured exactly. A pair that no longer matches the file —
/// which only a hand edit can produce, the commands keep it consistent —
/// lands on the nearest model rather than on nothing: the entry's own first
/// model when the entry survives, else the first entry that has one. Stranding
/// the agent on a stale pair would be a nuisance; silently calling a model
/// from the same entry, or the first real one, is the honest middle.
fn resolve_active(file: &ConfigFile) -> Option<(usize, String)> {
  if let Some(pair) = file.active.as_ref() {
    if let Some(at) = file.configs.iter().position(|c| c.name == pair.name) {
      if let Some(model) = file
        .configs[at]
        .models
        .iter()
        .find(|m| *m == &pair.model)
        .or_else(|| file.configs[at].models.first())
      {
        return Some((at, model.clone()));
      }
    }
  }
  let at = file.configs.iter().position(|c| !c.models.is_empty())?;
  Some((at, file.configs[at].models[0].clone()))
}

fn to_view(file: &ConfigFile) -> ConfigView {
  let resolved = resolve_active(file);
  ConfigView {
    configs: file
      .configs
      .iter()
      .enumerate()
      .map(|(i, c)| {
        let (active, active_model) = match resolved.as_ref() {
          Some((at, model)) if *at == i => (true, Some(model.clone())),
          _ => (false, None),
        };
        c.to_view(active, active_model)
      })
      .collect(),
  }
}

/// Trims and normalises an incoming entry.
fn normalise(mut config: LlmConfig) -> LlmConfig {
  config.url = config.url.trim().to_string();
  config.name = config.name.trim().to_string();
  config.api_key = config.api_key.trim().to_string();
  // Blank rows are dropped rather than rejected: an empty row in the form is
  // the artefact of clicking "add", not a model anyone meant.
  config.models = config
    .models
    .iter()
    .map(|m| m.trim().to_string())
    .filter(|m| !m.is_empty())
    .collect();
  config
}

/// Rejects a model listed twice under one name.
///
/// The comparison is exact, as it is everywhere in this file: `GPT-4o` and
/// `gpt-4o` are two models, because the endpoint decides what those mean and
/// folding case here would reject an id the server would have accepted.
fn duplicate_model(config: &LlmConfig) -> Option<&str> {
  config
    .models
    .iter()
    .enumerate()
    .find(|(i, m)| config.models[..*i].contains(m))
    .map(|(_, m)| m.as_str())
}

fn require_fields(config: &LlmConfig) -> Result<(), String> {
  if config.name.is_empty() {
    return Err("the name is required".into());
  }
  if config.models.is_empty() {
    return Err("at least one model is required".into());
  }
  Ok(())
}

/// Adds an entry to a file in memory. The commands wrap this with IO.
fn add_entry(file: &mut ConfigFile, config: LlmConfig) -> Result<(), String> {
  let config = normalise(config);
  require_fields(&config)?;
  if let Some(dup) = duplicate_model(&config) {
    return Err(format!("`{dup}` is listed twice under `{}`.", config.name));
  }
  // A name identifies one endpoint, so a second entry under a name already in
  // use is a second thing claiming the same identity.
  if let Some(existing) = file.configs.iter().find(|c| c.name == config.name) {
    return Err(format!(
      "`{}` is already used. Give this one a different name.",
      existing.name
    ));
  }

  // No active is written here: with nothing stored, resolution falls back to
  // the first entry — this one, on a fresh config — and a later add does not
  // steal a selection that exists. Which model answers is chosen, not
  // accumulated.
  file.configs.push(config);
  Ok(())
}

/// Replaces the entry named `name` in memory, keeping its position in the list.
fn update_entry(file: &mut ConfigFile, name: &str, config: LlmConfig) -> Result<(), String> {
  let mut config = normalise(config);
  require_fields(&config)?;
  if let Some(dup) = duplicate_model(&config) {
    return Err(format!("`{dup}` is listed twice under `{}`.", config.name));
  }

  let at = file
    .configs
    .iter()
    .position(|c| c.name == name)
    .ok_or_else(|| format!("`{name}` is not in the list any more"))?;

  // An empty key means "keep the stored one" — the settings form masks it, so
  // submitting it unchanged would otherwise overwrite a working credential with
  // a mask.
  if config.api_key.is_empty() {
    config.api_key = file.configs[at].api_key.clone();
  }

  // The active pair follows the entry through a rename, and survives an edit
  // that keeps the model listed. An edit that drops the active model lands on
  // the neighbour — the model that took its place, else the one before it —
  // so the agent is never stranded and never further from the choice than it
  // has to be.
  if let Some(pair) = file.active.clone() {
    if pair.name == name {
      let model = if config.models.contains(&pair.model) {
        pair.model
      } else {
        let was_at = file.configs[at].models.iter().position(|m| *m == pair.model);
        neighbour_model(&config.models, was_at)
      };
      file.active = Some(ActiveModel {
        name: config.name.clone(),
        model,
      });
    }
  }

  file.configs[at] = config;
  Ok(())
}

/// The model that takes a removed one's place: the next in the list, else the
/// one before it. A `was_at` of `None` means the pair was already stale before
/// the edit, so there is no place to be near and the first model is the
/// landing spot.
fn neighbour_model(models: &[String], was_at: Option<usize>) -> String {
  match was_at {
    Some(at) => models
      .get(at)
      .cloned()
      .unwrap_or_else(|| models.last().expect("at least one model").clone()),
    None => models[0].clone(),
  }
}

/// Removes an entry in memory and repairs the active pointer.
fn delete_entry(file: &mut ConfigFile, name: &str) -> Result<(), String> {
  let at = file
    .configs
    .iter()
    .position(|c| c.name == name)
    .ok_or_else(|| format!("`{name}` is not in the list"))?;
  let was_active = file.active.as_ref().is_some_and(|a| a.name == name);
  file.configs.remove(at);

  // Deleting the active entry lands on the neighbour — the entry that takes
  // its place, else the one before it — rather than on nothing or on a jump
  // to the top of the list. An entry with no models is not a landing spot.
  if was_active {
    file.active = neighbour_entry(file, at);
  }
  Ok(())
}

/// The first model of the entry at `at`, else of the nearest one before it.
fn neighbour_entry(file: &ConfigFile, at: usize) -> Option<ActiveModel> {
  for entry in file
    .configs
    .iter()
    .skip(at)
    .chain(file.configs.iter().take(at).rev())
  {
    if let Some(model) = entry.models.first() {
      return Some(ActiveModel {
        name: entry.name.clone(),
        model: model.clone(),
      });
    }
  }
  None
}

/// Points a file at one model of one entry, in memory.
fn set_active_entry(file: &mut ConfigFile, name: &str, model: &str) -> Result<(), String> {
  let entry = file
    .configs
    .iter()
    .find(|c| c.name == name)
    .ok_or_else(|| format!("`{name}` is not in the list"))?;
  if !entry.models.iter().any(|m| m.as_str() == model) {
    return Err(format!("`{model}` is not one of `{name}`'s models"));
  }
  file.active = Some(ActiveModel {
    name: name.to_string(),
    model: model.to_string(),
  });
  Ok(())
}

#[tauri::command]
pub async fn get_llm_config(app: AppHandle) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  Ok(to_view(&read_from(&path)))
}

/// Adds a new endpoint with its models.
#[tauri::command]
pub async fn add_llm_config(
  app: AppHandle,
  config: LlmConfig,
) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  let mut file = read_from(&path);
  add_entry(&mut file, config)?;
  write_to(&path, &file)?;
  Ok(to_view(&file))
}

/// Replaces the entry named `name`, keeping its position in the list.
#[tauri::command]
pub async fn update_llm_config(
  app: AppHandle,
  name: String,
  config: LlmConfig,
) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  let mut file = read_from(&path);
  update_entry(&mut file, &name, config)?;
  write_to(&path, &file)?;
  Ok(to_view(&file))
}

/// Removes the entry named `name` and repairs the active pointer.
#[tauri::command]
pub async fn delete_llm_config(app: AppHandle, name: String) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  let mut file = read_from(&path);
  delete_entry(&mut file, &name)?;
  write_to(&path, &file)?;
  Ok(to_view(&file))
}

/// Points the agent at one model of one stored entry.
#[tauri::command]
pub async fn set_active_llm_config(
  app: AppHandle,
  name: String,
  model: String,
) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  let mut file = read_from(&path);
  set_active_entry(&mut file, &name, &model)?;
  write_to(&path, &file)?;
  Ok(to_view(&file))
}

/// The active model, with its secret, for the loop's own use.
///
/// Not a command: the renderer has no path to this function, which is the whole
/// point of keeping the key host-side. Resolution is the same one the view
/// uses, so the model the panel shows is the model the loop calls — including
/// the fallbacks, so a hand-edited config cannot leave the agent unable to run.
pub fn secret(app: &AppHandle) -> ResolvedModel {
  let empty = ResolvedModel {
    url: String::new(),
    api_key: String::new(),
    name: String::new(),
    model: String::new(),
  };
  let Ok(path) = config_path(app) else {
    return empty;
  };
  let file = read_from(&path);
  match resolve_active(&file) {
    Some((at, model)) => {
      let entry = &file.configs[at];
      ResolvedModel {
        url: entry.url.clone(),
        api_key: entry.api_key.clone(),
        name: entry.name.clone(),
        model,
      }
    }
    None => empty,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn cfg(name: &str, models: &[&str]) -> LlmConfig {
    LlmConfig {
      url: "https://api.example.com/v1".into(),
      api_key: "sk-test".into(),
      name: name.into(),
      models: models.iter().map(|m| m.to_string()).collect(),
    }
  }

  fn pair(name: &str, model: &str) -> ActiveModel {
    ActiveModel {
      name: name.into(),
      model: model.into(),
    }
  }

  fn file(entries: Vec<LlmConfig>, active: Option<ActiveModel>) -> ConfigFile {
    ConfigFile { configs: entries, active }
  }

  #[test]
  fn names_differ_by_case_are_two_entries() {
    // Case folding here would silently merge two things a person deliberately
    // named differently, and one of them would vanish from the list.
    let store = file(vec![cfg("Prod", &["gpt-4o"])], None);
    let incoming = cfg("prod", &["gpt-4o"]);
    assert_ne!(store.configs[0].name, incoming.name);
  }

  #[test]
  fn a_model_listed_twice_under_one_name_is_caught() {
    assert_eq!(
      duplicate_model(&cfg("OpenAI", &["gpt-4o", "o3", "gpt-4o"])),
      Some("gpt-4o")
    );
    assert_eq!(duplicate_model(&cfg("OpenAI", &["gpt-4o", "o3"])), None);
    // Case matters here as everywhere: these are two models.
    assert_eq!(duplicate_model(&cfg("OpenAI", &["GPT-4o", "gpt-4o"])), None);
  }

  #[test]
  fn an_empty_name_or_model_list_is_rejected_before_anything_is_written() {
    assert!(require_fields(&cfg("", &["gpt-4o"])).is_err());
    assert!(require_fields(&cfg("OpenAI", &[])).is_err());
    assert!(require_fields(&cfg("OpenAI", &["gpt-4o"])).is_ok());
  }

  #[test]
  fn a_key_fingerprint_reveals_the_head_and_nothing_else() {
    let hint = key_hint("sk-abcdefghijklmnop");
    assert!(hint.starts_with("sk-abc"));
    assert!(hint.ends_with("mnop"));
    // Short keys are masked outright rather than shown in full.
    assert_eq!(key_hint("short"), "••••");
    assert_eq!(key_hint("   "), "");
  }

  #[test]
  fn readiness_requires_url_key_and_a_model() {
    let mut c = cfg("OpenAI", &["gpt-4o"]);
    assert!(c.is_ready());
    c.api_key = String::new();
    assert!(!c.is_ready(), "an endpoint with no key cannot be called");
    c.api_key = "sk-x".into();
    c.url = String::new();
    assert!(!c.is_ready());
    c.url = "https://x".into();
    c.models = vec!["  ".into()];
    assert!(!c.is_ready(), "a blank model id is no model at all");
  }

  #[test]
  fn normalise_trims_every_field_and_drops_blank_rows() {
    let n = normalise(LlmConfig {
      url: "  https://x/v1  ".into(),
      api_key: " sk-1 ".into(),
      name: " OpenAI ".into(),
      models: vec![" gpt-4o ".into(), " ".into(), "o3".into()],
    });
    assert_eq!(n.url, "https://x/v1");
    assert_eq!(n.api_key, "sk-1");
    assert_eq!(n.name, "OpenAI");
    assert_eq!(n.models, vec!["gpt-4o", "o3"]);
  }

  #[test]
  fn the_view_marks_exactly_the_active_model() {
    let store = file(
      vec![cfg("A", &["m1", "m2"]), cfg("B", &["m3"])],
      Some(pair("A", "m2")),
    );
    let view = to_view(&store);
    assert_eq!(view.configs.len(), 2);
    assert!(view.configs[0].active);
    assert_eq!(view.configs[0].active_model.as_deref(), Some("m2"));
    assert!(!view.configs[1].active);
    assert_eq!(view.configs[1].active_model, None);
    // The secret never crosses this boundary.
    assert_eq!(view.configs[0].key_hint, key_hint("sk-test"));
    assert!(!format!("{:?}", view).contains("sk-test"));
  }

  #[test]
  fn a_stale_pair_lands_on_the_entrys_first_model() {
    // A hand edit that drops the active model lands on the entry's own first
    // model: nearest, and still the endpoint that was chosen.
    let store = file(vec![cfg("A", &["m1", "m2"])], Some(pair("A", "gone")));
    assert_eq!(resolve_active(&store), Some((0, "m1".to_string())));
  }

  #[test]
  fn a_pair_naming_no_entry_lands_on_the_first_usable_one() {
    let store = file(
      vec![cfg("A", &["m1"]), cfg("B", &["m2"])],
      Some(pair("gone", "whatever")),
    );
    assert_eq!(resolve_active(&store), Some((0, "m1".to_string())));
    // And so does no active pointer at all, however many entries there are.
    let no_active = file(vec![cfg("A", &["m1"])], None);
    assert_eq!(resolve_active(&no_active), Some((0, "m1".to_string())));
  }

  #[test]
  fn an_entry_with_no_models_is_not_a_landing_spot() {
    let store = file(
      vec![cfg("empty", &[]), cfg("A", &["m1"])],
      Some(pair("empty", "gone")),
    );
    assert_eq!(resolve_active(&store), Some((1, "m1".to_string())));
  }

  #[test]
  fn adding_an_entry_stores_no_active_but_resolution_picks_it_up() {
    // On a fresh config the fallback is the entry just added, so the agent has
    // something to call without the file claiming a choice nobody made.
    let mut f = ConfigFile::default();
    add_entry(&mut f, cfg("OpenAI", &["gpt-4o", "o3"])).expect("adds");
    assert_eq!(f.active, None);
    assert_eq!(resolve_active(&f), Some((0, "gpt-4o".to_string())));
  }

  #[test]
  fn a_later_add_does_not_steal_the_selection() {
    let mut f = file(vec![cfg("OpenAI", &["gpt-4o"])], Some(pair("OpenAI", "gpt-4o")));
    add_entry(&mut f, cfg("Ollama", &["llama3"])).expect("adds");
    assert_eq!(f.active, Some(pair("OpenAI", "gpt-4o")));
  }

  #[test]
  fn a_name_cannot_be_reused_by_a_second_entry() {
    let mut f = file(vec![cfg("OpenAI", &["gpt-4o"])], None);
    assert!(add_entry(&mut f, cfg("OpenAI", &["o3"])).is_err());
  }

  #[test]
  fn an_edit_that_keeps_the_active_model_keeps_the_pair() {
    let mut f = file(vec![cfg("A", &["m1", "m2"])], Some(pair("A", "m2")));
    update_entry(&mut f, "A", cfg("A", &["m2", "m3"])).expect("updates");
    assert_eq!(f.active, Some(pair("A", "m2")));
  }

  #[test]
  fn an_edit_that_drops_the_active_model_lands_on_the_next_one() {
    // `m2` was the second of three; the model that takes its place is `m3`.
    let mut f = file(vec![cfg("A", &["m1", "m2", "m3"])], Some(pair("A", "m2")));
    update_entry(&mut f, "A", cfg("A", &["m1", "m3"])).expect("updates");
    assert_eq!(f.active, Some(pair("A", "m3")));
  }

  #[test]
  fn an_edit_that_drops_the_last_model_lands_on_the_one_before_it() {
    let mut f = file(vec![cfg("A", &["m1", "m2", "m3"])], Some(pair("A", "m3")));
    update_entry(&mut f, "A", cfg("A", &["m1", "m2"])).expect("updates");
    assert_eq!(f.active, Some(pair("A", "m2")));
  }

  #[test]
  fn a_rename_carries_the_active_pair_with_it() {
    let mut f = file(vec![cfg("A", &["m1"])], Some(pair("A", "m1")));
    update_entry(&mut f, "A", cfg("B", &["m1"])).expect("renames");
    assert_eq!(f.active, Some(pair("B", "m1")));
  }

  #[test]
  fn renaming_an_inactive_entry_does_not_activate_it() {
    let mut f = file(
      vec![cfg("A", &["m1"]), cfg("B", &["m2"])],
      Some(pair("A", "m1")),
    );
    update_entry(&mut f, "B", cfg("C", &["m2"])).expect("renames");
    assert_eq!(f.active, Some(pair("A", "m1")));
  }

  #[test]
  fn an_empty_key_on_update_keeps_the_stored_one() {
    let mut f = file(vec![cfg("A", &["m1"])], None);
    let mut incoming = cfg("A", &["m1"]);
    incoming.api_key = String::new();
    update_entry(&mut f, "A", incoming).expect("updates");
    assert_eq!(f.configs[0].api_key, "sk-test");
  }

  #[test]
  fn deleting_the_active_entry_lands_on_the_next_one() {
    let mut f = file(
      vec![cfg("A", &["m1"]), cfg("B", &["m2"]), cfg("C", &["m3"])],
      Some(pair("A", "m1")),
    );
    delete_entry(&mut f, "A").expect("deletes");
    assert_eq!(f.active, Some(pair("B", "m2")));
  }

  #[test]
  fn deleting_the_last_active_entry_lands_on_the_one_before_it() {
    let mut f = file(
      vec![cfg("A", &["m1"]), cfg("B", &["m2"])],
      Some(pair("B", "m2")),
    );
    delete_entry(&mut f, "B").expect("deletes");
    assert_eq!(f.active, Some(pair("A", "m1")));
  }

  #[test]
  fn deleting_the_last_model_overall_leaves_nothing_selected() {
    let mut f = file(vec![cfg("A", &["m1"])], Some(pair("A", "m1")));
    delete_entry(&mut f, "A").expect("deletes");
    assert_eq!(f.active, None);
  }

  #[test]
  fn deleting_an_inactive_entry_keeps_the_selection() {
    let mut f = file(
      vec![cfg("A", &["m1"]), cfg("B", &["m2"])],
      Some(pair("A", "m1")),
    );
    delete_entry(&mut f, "B").expect("deletes");
    assert_eq!(f.active, Some(pair("A", "m1")));
  }

  #[test]
  fn activating_requires_a_model_the_entry_actually_lists() {
    let mut f = file(vec![cfg("A", &["m1", "m2"])], None);
    assert!(set_active_entry(&mut f, "A", "m2").is_ok());
    assert_eq!(f.active, Some(pair("A", "m2")));
    assert!(set_active_entry(&mut f, "A", "nope").is_err());
    assert!(set_active_entry(&mut f, "gone", "m1").is_err());
  }
}
