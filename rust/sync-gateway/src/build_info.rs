//! Build metadata for the `/api/v1/health/info` surface (release 1.0.0).
//!
//! Version + git sha are embedded at COMPILE time (Cargo manifest version
//! via `CARGO_PKG_VERSION`; git short sha via build.rs, which falls back
//! to "unknown" for clean-tarball builds). Nothing from the runtime
//! environment is read here, so no env value or secret can ever appear in
//! an info response.

/// Short git sha of the commit this gateway was built from ("unknown" in
/// non-git source builds — see build.rs).
pub const GIT_SHA: &str = env!("CONCORD_GIT_SHA");

/// Build profile as reported by the compiler ("debug" or "release"; cargo
/// sets these cfgs — piped through the build script so the string form is
/// available at runtime).
pub const BUILD_PROFILE: &str = if cfg!(debug_assertions) {
    "debug"
} else {
    "release"
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_sha_is_short_and_safe() {
        // Either the 7+ hex short sha or the documented tarball fallback.
        if GIT_SHA != "unknown" {
            assert!(
                GIT_SHA.len() >= 7 && GIT_SHA.chars().all(|c| c.is_ascii_hexdigit()),
                "unexpected git sha shape: {GIT_SHA}"
            );
        }
    }

    #[test]
    fn build_profile_is_one_of_two() {
        assert!(matches!(BUILD_PROFILE, "debug" | "release"));
    }
}
