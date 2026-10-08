//! Where the build toolchain is, and whether that answer has changed.
//!
//! Two Windows facts make this more than a PATH walk, and both fail silently.
//! A command named `xelatex` on PATH is a file called `xelatex.exe` on disk, so
//! a lookup that stops at the literal name reports a working toolchain missing.
//! And the PATH this process inherited is a snapshot from launch, so a toolchain
//! installed afterwards stays invisible for as long as the app runs. Neither
//! surfaces as an error: the preview says "not found" and leaves Build disabled
//! on a machine where the command runs fine from a terminal.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::Emitter;

/// What the frontend listens for.
///
/// No payload: the frontend re-asks `build_plan` rather than being handed an
/// answer, because whether a project is buildable depends on the open project's
/// documents too, not only on PATH.
pub const CHANGED: &str = "toolchain:change";

/// How often the search path is re-read.
///
/// Short enough that installing a toolchain and watching the button come alive
/// feels immediate, long enough that two small registry reads every five seconds
/// never registers as work.
const POLL: Duration = Duration::from_secs(5);

/// Filename suffixes a bare command name may stand for.
///
/// Windows resolves `xelatex` to `xelatex.exe`, so a lookup that stops at the
/// literal name finds nothing on a machine where the toolchain is installed and
/// working. The bare name is tried last rather than omitted: a `.rg/build.json`
/// pointing at a file called exactly that must still match, and on the other
/// platforms the bare name is the only candidate there is.
#[cfg(windows)]
const SUFFIXES: &[&str] = &[".exe", ".cmd", ".bat", ""];

#[cfg(not(windows))]
const SUFFIXES: &[&str] = &[""];

/// The directories a toolchain is looked for in.
///
/// `std::env::var_os("PATH")` is what the OS handed this process at launch. A
/// toolchain installed afterwards is invisible to it for the life of the
/// process, and a desktop launcher inherits a smaller PATH than the shell the
/// user installs from — so on Windows the registry, which holds the
/// authoritative value, is read instead. The inherited value stays as the
/// fallback: it is what a Unix build uses, and on Windows it is still better
/// than reporting an empty PATH and a missing toolchain.
pub fn search_path() -> Vec<PathBuf> {
  #[cfg(windows)]
  if let Some(fresh) = registry_search_path() {
    return fresh;
  }
  inherited_search_path()
}

/// The PATH Windows will hand the next process, read from where Windows keeps it.
///
/// `None` when neither environment key can be read, which is the signal to fall
/// back to the inherited value rather than to report an empty PATH. Reading
/// `Path` as a string and joining the two the way Windows composes them keeps
/// the lookup honest about the order, which decides which of two installs wins.
#[cfg(windows)]
fn registry_search_path() -> Option<Vec<PathBuf>> {
  use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
  use winreg::{HKEY, RegKey};

  fn path_value(root: HKEY, subkey: &str) -> Option<String> {
    RegKey::predef(root)
      .open_subkey(subkey)
      .ok()?
      .get_value::<String, _>("Path")
      .ok()
  }

  let machine = path_value(
    HKEY_LOCAL_MACHINE,
    r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
  );
  let user = path_value(HKEY_CURRENT_USER, "Environment");
  if machine.is_none() && user.is_none() {
    return None;
  }
  let joined = machine.into_iter().chain(user).collect::<Vec<_>>().join(";");
  Some(std::env::split_paths(&joined).collect())
}

fn inherited_search_path() -> Vec<PathBuf> {
  std::env::var_os("PATH")
    .map(|path| std::env::split_paths(&path).collect())
    .unwrap_or_default()
}

/// Finds `command` in `entries`, or beside the project when it is a path.
///
/// The path list is a parameter rather than read from the environment so that
/// this is testable: a test cannot set `PATH` for itself without changing it for
/// every test running beside it.
pub fn which_in(entries: &[PathBuf], command: &str, cwd: &Path) -> Option<PathBuf> {
  if command.contains('/') {
    let direct = PathBuf::from(command);
    if direct.is_absolute() {
      return direct.is_file().then_some(direct);
    }
    let relative = cwd.join(command);
    return relative.is_file().then_some(relative);
  }
  for dir in entries {
    for suffix in SUFFIXES {
      let candidate = dir.join(format!("{command}{suffix}"));
      if candidate.is_file() {
        return Some(candidate);
      }
    }
  }
  None
}

/// `which_in` against the current search path.
pub fn which(command: &str, cwd: &Path) -> Option<PathBuf> {
  which_in(&search_path(), command, cwd)
}

/// Announces when the search path changes.
///
/// Installing a toolchain happens in a terminal, not in this window, so the
/// answer to "is xelatex there" goes stale while the app sits open — and the
/// preview would go on reporting a toolchain that is now installed. Windows
/// offers no notification for a registry value, so this reads it back on a timer
/// and emits once per real change rather than once per tick: the frontend's own
/// request is what decides whether the change matters for the open project.
pub fn init(app: &mut tauri::App) {
  let app = app.handle().clone();
  std::thread::spawn(move || {
    let mut previous = fingerprint(&search_path());
    loop {
      std::thread::sleep(POLL);
      let current = fingerprint(&search_path());
      if current == previous {
        continue;
      }
      previous = current;
      if let Err(err) = app.emit(CHANGED, ()) {
        log::warn!("{CHANGED} was not delivered: {err}");
      }
    }
  });
}

/// A value that differs exactly when the search path does.
///
/// The joined path rather than a hash of it: the entries are a few hundred
/// characters, and a difference in case or order is a difference Windows acts on
/// — which is not something a truncated digest should be trusted to notice.
fn fingerprint(entries: &[PathBuf]) -> String {
  entries
    .iter()
    .map(|entry| entry.to_string_lossy().into_owned())
    .collect::<Vec<_>>()
    .join("\n")
}

/// The suffix the host platform actually installs a command under, so a test can
/// create the file the platform would and assert the lookup finds it.
#[cfg(test)]
pub(crate) fn native_name(command: &str) -> String {
  SUFFIXES
    .iter()
    .find(|suffix| !suffix.is_empty())
    .map(|suffix| format!("{command}{suffix}"))
    .unwrap_or_else(|| command.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  struct Scratch(PathBuf);

  impl Scratch {
    fn new(name: &str) -> Scratch {
      let dir = std::env::temp_dir().join(format!("rg-toolchain-{name}"));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).unwrap();
      Scratch(dir)
    }

    fn tool(&self, command: &str) -> PathBuf {
      let path = self.0.join(native_name(command));
      fs::write(&path, b"x").unwrap();
      path
    }

    fn path(&self) -> &Path {
      &self.0
    }
  }

  /// The reason this module exists: on Windows the file on disk carries a suffix,
  /// and a lookup that stops at the literal name cannot see it.
  #[test]
  fn a_command_is_found_under_the_name_the_host_platform_gives_it() {
    let s = Scratch::new("suffix");
    let written = s.tool("xelatex");

    let found = which_in(&[s.path().to_path_buf()], "xelatex", s.path());

    assert_eq!(found.as_deref(), Some(written.as_path()));
  }

  /// An extension is not an invitation to match anything: a toolchain that is not
  /// installed must still read as missing, or the preview invents a command.
  #[test]
  fn a_command_that_is_not_there_is_still_reported_missing() {
    let s = Scratch::new("missing");

    assert!(which_in(&[s.path().to_path_buf()], "xelatex", s.path()).is_none());
  }

  /// Earlier entries win, which is the whole point of composing Machine before
  /// User: two installs of the same toolchain must resolve to the same one the
  /// shell would pick.
  #[test]
  fn the_first_directory_on_the_path_wins() {
    let first = Scratch::new("first");
    let second = Scratch::new("second");
    let wanted = first.tool("xelatex");
    second.tool("xelatex");

    let found = which_in(
      &[first.path().to_path_buf(), second.path().to_path_buf()],
      "xelatex",
      second.path(),
    );

    assert_eq!(found.as_deref(), Some(wanted.as_path()));
  }

  /// A `.rg/build.json` command is a path, not a PATH entry, and it is checked
  /// as written — which is why a real file with a suffix in it has to match.
  #[test]
  fn a_command_given_as_a_path_is_checked_as_written() {
    let s = Scratch::new("as-path");
    let written = s.tool("build-xelatex");
    let as_forward_slash = written.to_string_lossy().replace('\\', "/");

    let found = which_in(&[], &as_forward_slash, s.path());

    assert_eq!(found.as_deref(), Some(written.as_path()));
  }

  /// The build command in a `.rg/build.json` is usually `./build.sh`, and it
  /// resolves against the project rather than PATH.
  #[test]
  fn a_relative_command_is_resolved_against_the_project() {
    let s = Scratch::new("relative");
    let script = s.path().join("build.sh");
    fs::write(&script, b"#!/bin/sh\n").unwrap();

    let found = which_in(&[], "./build.sh", s.path());

    assert_eq!(found.as_deref(), Some(script.as_path()));
  }

  #[test]
  fn the_search_path_is_never_empty() {
    // Whichever source answers — the registry on Windows, the inherited value
    // elsewhere — an empty one would report every toolchain missing.
    assert!(!search_path().is_empty());
  }
}