//! Maintenance subsystem (P5-M016+): snapshot/compaction/retention job
//! orchestration. Rust owns I/O, scheduling, leases, and process
//! lifecycle; the native C++ worker owns CRDT semantics (DEC-038).

pub mod jobs;
pub mod pipeline;
pub mod recovery;
pub mod scheduler;

pub use jobs::{
    execute_snapshot_job, FailureClass, JobError, JobRepo, JobRow, MaintenanceLimits,
    SnapshotTriggerPolicy, TriggerInputs,
};
pub use pipeline::{PipelineError, SnapshotPipeline};
pub use recovery::{RecoverySelector, RecoverySource, SelectedRecovery, VerificationError};
pub use scheduler::{BoundedRunner, Scheduler};
