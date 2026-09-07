//! Maintenance subsystem (P5-M016+): snapshot/compaction/retention job
//! orchestration. Rust owns I/O, scheduling, leases, and process
//! lifecycle; the native C++ worker owns CRDT semantics (DEC-038).

pub mod pipeline;

pub use pipeline::{PipelineError, SnapshotPipeline};
