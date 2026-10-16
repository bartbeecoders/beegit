//! CLI errors and exit codes (PLAN 6.15: 0 ok, 1 error, 2 usage, 3 conflicts, 4 dirty refusal).

use beegit_core::{BeeGitError, ErrorCode};
use beegit_wc::WorkingCopy;

/// Exit code: success.
pub(crate) const EXIT_OK: i32 = 0;
/// Exit code: any other error.
pub(crate) const EXIT_ERROR: i32 = 1;
/// Exit code: usage error.
pub(crate) const EXIT_USAGE: i32 = 2;
/// Exit code: merge conflicts (rebase paused, unresolved conflicts).
pub(crate) const EXIT_CONFLICTS: i32 = 3;
/// Exit code: refused because of dirty files.
pub(crate) const EXIT_DIRTY: i32 = 4;

/// A failed command.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CliError {
    /// A BeeGit error (from the server or the working-copy library).
    #[error("{0}")]
    BeeGit(#[from] BeeGitError),
    /// Bad command-line usage detected after parsing.
    #[error("{0}")]
    Usage(String),
    /// A client-side failure that has no SPEC error code.
    #[error("{0}")]
    Local(String),
}

pub(crate) type CliResult<T> = Result<T, CliError>;

impl CliError {
    /// PLAN 6.15 exit code.
    pub(crate) fn exit_code(&self) -> i32 {
        match self {
            CliError::Usage(_) => EXIT_USAGE,
            CliError::Local(_) => EXIT_ERROR,
            CliError::BeeGit(e) => beegit_exit_code(e),
        }
    }

    /// `(code, subcode)` for the error envelope.
    pub(crate) fn code(&self) -> (String, Option<String>) {
        match self {
            CliError::Usage(_) => ("USAGE".to_owned(), None),
            CliError::Local(_) => ("LOCAL".to_owned(), None),
            CliError::BeeGit(e) => (e.code.as_str().to_owned(), e.subcode().map(str::to_owned)),
        }
    }

    /// Human message: `CODE[/subcode]: message`.
    pub(crate) fn human(&self) -> String {
        match self {
            CliError::Usage(m) => format!("usage: {m}"),
            CliError::Local(m) => m.clone(),
            CliError::BeeGit(e) => match e.subcode() {
                Some(s) => format!("{}/{s}: {}", e.code.as_str(), e.message),
                None => format!("{}: {}", e.code.as_str(), e.message),
            },
        }
    }

    /// The message alone.
    pub(crate) fn message(&self) -> String {
        match self {
            CliError::Usage(m) | CliError::Local(m) => m.clone(),
            CliError::BeeGit(e) => e.message.clone(),
        }
    }
}

/// Exit code of a BeeGit error (PLAN 6.15).
pub(crate) fn beegit_exit_code(e: &BeeGitError) -> i32 {
    if e.code == ErrorCode::MergeConflict {
        return EXIT_CONFLICTS;
    }
    match e.subcode() {
        Some(s) if s == WorkingCopy::SUBCODE_DIRTY => EXIT_DIRTY,
        Some(s)
            if s == WorkingCopy::SUBCODE_UNRESOLVED || s == WorkingCopy::SUBCODE_MARKERS_REMAIN =>
        {
            EXIT_CONFLICTS
        }
        _ => EXIT_ERROR,
    }
}

/// A local error.
pub(crate) fn local(msg: impl Into<String>) -> CliError {
    CliError::Local(msg.into())
}

/// A usage error.
pub(crate) fn usage(msg: impl Into<String>) -> CliError {
    CliError::Usage(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes() {
        assert_eq!(usage("x").exit_code(), EXIT_USAGE);
        assert_eq!(local("x").exit_code(), EXIT_ERROR);
        let c = CliError::from(BeeGitError::new(ErrorCode::MergeConflict, "c"));
        assert_eq!(c.exit_code(), EXIT_CONFLICTS);
        let d = CliError::from(BeeGitError::invalid(WorkingCopy::SUBCODE_DIRTY, "d"));
        assert_eq!(d.exit_code(), EXIT_DIRTY);
        assert_eq!(
            d.code(),
            (
                "INVALID_ARGUMENT".into(),
                Some(WorkingCopy::SUBCODE_DIRTY.into())
            )
        );
        let m = CliError::from(BeeGitError::invalid(
            WorkingCopy::SUBCODE_MARKERS_REMAIN,
            "m",
        ));
        assert_eq!(m.exit_code(), EXIT_CONFLICTS);
        let u = CliError::from(BeeGitError::invalid(WorkingCopy::SUBCODE_UNRESOLVED, "u"));
        assert_eq!(u.exit_code(), EXIT_CONFLICTS);
        let n = CliError::from(BeeGitError::not_found("n"));
        assert_eq!(n.exit_code(), EXIT_ERROR);
        assert!(n.human().starts_with("NOT_FOUND: "));
    }
}
