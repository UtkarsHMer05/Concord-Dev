//! Maintenance subsystem (P5-M016+): snapshot/compaction/retention job
//! orchestration. Rust owns I/O, scheduling, leases, and process
//! lifecycle; the native C++ worker owns CRDT semantics (DEC-038).

pub mod compaction;
pub mod history;
pub mod jobs;
pub mod pipeline;
pub mod recovery;
pub mod retention;
pub mod scheduler;

pub use compaction::{
    dry_run, get_floor, prune_to_boundary, CompactionError, CompactionFloor, DryRun,
};
pub use history::{
    HistoricalState, HistoryError, RestoreMechanism, RestoreOutcome, RevisionInfo, RevisionService,
    RevisionSummary, MAX_REVISIONS_LIMIT,
};
pub use jobs::{
    execute_snapshot_job, FailureClass, JobError, JobRepo, JobRow, MaintenanceLimits,
    SnapshotTriggerPolicy, TriggerInputs,
};
pub use pipeline::{PipelineError, SnapshotPipeline};
pub use recovery::{RecoverySelector, RecoverySource, SelectedRecovery, VerificationError};
pub use retention::{
    mark_superseded_unreferenced, purge_unreferenced, storage_accounting, RetentionError,
    StorageAccounting,
};
pub use scheduler::{BoundedRunner, Scheduler};
