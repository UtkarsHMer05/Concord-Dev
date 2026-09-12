//! Build script for the sync-gateway build-info surface (release 1.0.0).
//!
//! Emits DEP_*-free cargo directives only: the crate version (already
//! provided by CARGO_PKG_VERSION at compile time — no duplication) and a
//! GIT_SHA short hash resolved from `git rev-parse --short HEAD`.
//!
//! Design constraints:
//!   - Clean-tarball safety: when git metadata is absent (e.g. a source
//!     tarball release), the script still succeeds — GIT_SHA falls back to
//!     "unknown" so the build never fails for lack of a VCS history.
//!   - No environment values are read into build output beyond the git sha
//!     itself; nothing from the environment is embedded, so no secret can
//!     leak into the binary through this path.

use std::process::Command;

fn main() {
    // Rebuild when the workspace manifest's version changes so the embedded
    // version stays current without a clean rebuild.
    println!("cargo:rerun-if-changed=../Cargo.toml");

    let sha = git_short_sha().unwrap_or_else(|| "unknown".to_owned());
    println!("cargo:rustc-env=CONCORD_GIT_SHA={sha}");
}

/// Short HEAD hash, or None outside a git work tree / without git installed.
fn git_short_sha() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}
