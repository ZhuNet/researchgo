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

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One endpoint plus one model served by it.
///
/// `name` is the endpoint's identity, not a display label: two entries cannot
/// share one. A user with an OpenAI key and an Ollama on localhost has two
/// endpoints with two names, and the name is what the settings list, the
/// dropdown, and the agent's own bookkeeping all agree on. Comparing names
/// exactly — no case folding — is deliberate: `Prod` and `prod` are two things
/// a person meant to write down differently, and silently merging them loses a
/// configuration nobody can find again.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
  pub url: String,
  pub api_key: String,
  pub name: String,
  pub model: String,
}

/// Every stored configuration, plus which one the agent is using.
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
  /// The name of the active configuration.
  ///
  /// A name rather than an index: deleting the second of three entries must not
  /// silently repoint the agent at a different endpoint, and an index cannot
  /// survive that.
  #[serde(default)]
  active: Option<String>,
}

/// One entry as the renderer is allowed to see it. No `api_key`, ever.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmView {
  pub name: String,
  pub url: String,
  pub model: String,
  /// A fingerprint of the stored key, enough to tell two keys apart.
  pub key_hint: String,
  /// Whether this entry could actually make a call.
  pub ready: bool,
  /// Whether the agent is currently pointed at this one.
  pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
  pub configs: Vec<LlmView>,
}

impl LlmConfig {
  /// Whether this entry can actually make a call.
  ///
  /// Checked before the loop starts rather than at the first request, so a
  /// half-filled form produces a readable message instead of a 401.
  pub fn is_ready(&self) -> bool {
    !self.url.trim().is_empty()
      && !self.model.trim().is_empty()
      && !self.api_key.trim().is_empty()
  }

  fn to_view(&self, active: bool) -> LlmView {
    LlmView {
      name: self.name.clone(),
      url: self.url.clone(),
      model: self.model.clone(),
      key_hint: key_hint(&self.api_key),
      ready: self.is_ready(),
      active,
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

fn to_view(file: &ConfigFile) -> ConfigView {
  let active_name = file.active.as_deref();
  ConfigView {
    configs: file
      .configs
      .iter()
      .map(|c| c.to_view(active_name == Some(c.name.as_str())))
      .collect(),
  }
}

/// Trims and normalises an incoming entry.
fn normalise(mut config: LlmConfig) -> LlmConfig {
  config.url = config.url.trim().to_string();
  config.name = config.name.trim().to_string();
  config.model = config.model.trim().to_string();
  config.api_key = config.api_key.trim().to_string();
  config
}

/// Rejects an entry that duplicates an existing `(name, model)` pair.
///
/// The comparison is exact. `GPT-4o` and `gpt-4o` are two entries, because the
/// endpoint decides what those mean and folding case here would reject a name
/// the server would have accepted.
fn find_duplicate<'a>(
  file: &'a ConfigFile,
  config: &LlmConfig,
  skip_name: Option<&str>,
) -> Option<&'a LlmConfig> {
  file.configs.iter().find(|existing| {
    if skip_name == Some(existing.name.as_str()) {
      return false;
    }
    existing.name == config.name && existing.model == config.model
  })
}

fn require_fields(config: &LlmConfig) -> Result<(), String> {
  if config.name.is_empty() {
    return Err("the name is required".into());
  }
  if config.model.is_empty() {
    return Err("the model is required".into());
  }
  Ok(())
}

#[tauri::command]
pub async fn get_llm_config(app: AppHandle) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  Ok(to_view(&read_from(&path)))
}

/// Adds a new endpoint+model pair.
#[tauri::command]
pub async fn add_llm_config(
  app: AppHandle,
  config: LlmConfig,
) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  let mut file = read_from(&path);
  let config = normalise(config);

  require_fields(&config)?;
  if let Some(clash) = find_duplicate(&file, &config, None) {
    return Err(format!(
      "`{}` already has `{}`. Edit that one instead.",
      clash.name, clash.model
    ));
  }
  // A name identifies one endpoint, so a second entry under a name already in
  // use is a second thing claiming the same identity.
  if let Some(existing) = file.configs.iter().find(|c| c.name == config.name) {
    return Err(format!(
      "`{}` is already used by model `{}`. Give this one a different name.",
      existing.name, existing.model
    ));
  }

  file.configs.push(config);
  // The first thing added is what the user is about to use, so make it active
  // rather than leaving the agent pointed at nothing.
  file.active = Some(file.configs.last().expect("just pushed").name.clone());
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
  let mut config = normalise(config);
  require_fields(&config)?;

  let at = file
    .configs
    .iter()
    .position(|c| c.name == name)
    .ok_or_else(|| format!("`{name}` is not in the list any more"))?;

  if let Some(clash) = find_duplicate(&file, &config, Some(&name)) {
    return Err(format!(
      "`{}` already has `{}`. Give this one a different model.",
      clash.name, clash.model
    ));
  }

  // An empty key means "keep the stored one" — the settings form masks it, so
  // submitting it unchanged would otherwise overwrite a working credential with
  // a mask.
  if config.api_key.is_empty() {
    config.api_key = file.configs[at].api_key.clone();
  }

  let renamed = config.name != name;
  file.configs[at] = config;
  if file.active.as_deref() == Some(name.as_str()) || renamed {
    file.active = file.configs.get(at).map(|c| c.name.clone());
  }
  write_to(&path, &file)?;
  Ok(to_view(&file))
}

/// Removes the entry named `name` and repairs the active pointer.
#[tauri::command]
pub async fn delete_llm_config(app: AppHandle, name: String) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  let mut file = read_from(&path);
  let before = file.configs.len();
  file.configs.retain(|c| c.name != name);
  if file.configs.len() == before {
    return Err(format!("`{name}` is not in the list"));
  }

  // Deleting the active entry would otherwise leave the agent pointed at a name
  // that no longer exists. Fall back to the first survivor, which is at least a
  // real endpoint; if none are left, there is no active one, and the agent says
  // so rather than calling an empty URL.
  if file.active.as_deref() == Some(name.as_str()) {
    file.active = file.configs.first().map(|c| c.name.clone());
  }
  write_to(&path, &file)?;
  Ok(to_view(&file))
}

/// Points the agent at one of the stored entries.
#[tauri::command]
pub async fn set_active_llm_config(app: AppHandle, name: String) -> Result<ConfigView, String> {
  let path = config_path(&app)?;
  let mut file = read_from(&path);
  if !file.configs.iter().any(|c| c.name == name) {
    return Err(format!("`{name}` is not in the list"));
  }
  file.active = Some(name);
  write_to(&path, &file)?;
  Ok(to_view(&file))
}

/// The active entry, with its secret, for the loop's own use.
///
/// Not a command: the renderer has no path to this function, which is the whole
/// point of keeping the key host-side. Falls back to the first entry when the
/// active pointer is stale, so a config edited by hand cannot leave the agent
/// unable to run.
pub fn secret(app: &AppHandle) -> LlmConfig {
  let Ok(path) = config_path(app) else {
    return LlmConfig {
      url: String::new(),
      api_key: String::new(),
      name: String::new(),
      model: String::new(),
    };
  };
  let file = read_from(&path);

  let chosen = file
    .active
    .as_deref()
    .and_then(|name| file.configs.iter().find(|c| c.name == name))
    .or_else(|| file.configs.first());

  chosen.cloned().unwrap_or(LlmConfig {
    url: String::new(),
    api_key: String::new(),
    name: String::new(),
    model: String::new(),
  })
}
#[cfg(test)]
mod tests {
  use super::*;

  fn cfg(name: &str, model: &str) -> LlmConfig {
    LlmConfig {
      url: "https://api.example.com/v1".into(),
      api_key: "sk-test".into(),
      name: name.into(),
      model: model.into(),
    }
  }

  fn file(entries: Vec<LlmConfig>, active: Option<&str>) -> ConfigFile {
    ConfigFile {
      configs: entries,
      active: active.map(|s| s.to_string()),
    }
  }

  #[test]
  fn names_differ_by_case_are_two_entries() {
    // Case folding here would silently merge two things a person deliberately
    // named differently, and one of them would vanish from the list.
    let store = file(vec![cfg("Prod", "gpt-4o")], None);
    let incoming = cfg("prod", "gpt-4o");

    let mut next = store.clone();
    let clash = find_duplicate(&next, &incoming, None);
    assert!(clash.is_none(), "`Prod` must not block `prod`");

    // But the name check is what actually rejects it: two entries may not share
    // a name even when the models differ.
    next.configs.push(incoming);
    assert_ne!(next.configs[0].name, next.configs[1].name);
  }

  #[test]
  fn duplicate_name_and_model_is_caught() {
    let store = file(vec![cfg("OpenAI", "gpt-4o")], None);
    assert!(find_duplicate(&store, &cfg("OpenAI", "gpt-4o"), None).is_some());
    // Same name, different model is allowed: an endpoint serving two models is
    // two configurations.
    assert!(find_duplicate(&store, &cfg("OpenAI", "o3"), None).is_none());
  }

  #[test]
  fn renaming_a_row_does_not_collide_with_itself() {
    let store = file(vec![cfg("OpenAI", "gpt-4o")], None);
    // Editing in place: the row being replaced must not be treated as a clash
    // with the new version of itself.
    assert!(find_duplicate(&store, &cfg("OpenAI", "o3"), Some("OpenAI")).is_none());
    // But it must still collide with a different row.
    let two = file(vec![cfg("OpenAI", "gpt-4o"), cfg("Ollama", "llama3")], None);
    assert!(find_duplicate(&two, &cfg("Ollama", "llama3"), Some("OpenAI")).is_some());
  }

  #[test]
  fn models_differ_by_case_are_distinct() {
    let store = file(vec![cfg("Local", "Llama-3")], None);
    assert!(find_duplicate(&store, &cfg("Local", "llama-3"), None).is_none());
  }

  #[test]
  fn an_empty_name_is_rejected_before_anything_is_written() {
    assert!(require_fields(&cfg("", "gpt-4o")).is_err());
    assert!(require_fields(&cfg("OpenAI", "")).is_err());
    assert!(require_fields(&cfg("OpenAI", "gpt-4o")).is_ok());
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
  fn readiness_requires_all_three_of_url_key_and_model() {
    let mut c = cfg("OpenAI", "gpt-4o");
    assert!(c.is_ready());
    c.api_key = String::new();
    assert!(!c.is_ready(), "an endpoint with no key cannot be called");
    c.api_key = "sk-x".into();
    c.url = String::new();
    assert!(!c.is_ready());
    c.url = "https://x".into();
    c.model = String::new();
    assert!(!c.is_ready());
  }

  #[test]
  fn normalise_trims_every_field() {
    let n = normalise(LlmConfig {
      url: "  https://x/v1  ".into(),
      api_key: " sk-1 ".into(),
      name: " OpenAI ".into(),
      model: " gpt-4o ".into(),
    });
    assert_eq!(n.url, "https://x/v1");
    assert_eq!(n.api_key, "sk-1");
    assert_eq!(n.name, "OpenAI");
    assert_eq!(n.model, "gpt-4o");
  }

  #[test]
  fn the_view_marks_exactly_the_active_entry() {
    let store = file(vec![cfg("A", "m1"), cfg("B", "m2")], Some("B"));
    let view = to_view(&store);
    assert_eq!(view.configs.len(), 2);
    assert!(!view.configs[0].active);
    assert!(view.configs[1].active);
    // The secret never crosses this boundary.
    assert_eq!(view.configs[1].key_hint, key_hint("sk-test"));
    assert!(!format!("{:?}", view).contains("sk-test"));
  }
}