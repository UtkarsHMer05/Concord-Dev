// Bounded task executor (P2-M027/M028): the only concurrency primitive in
// the native core.
//
// Concurrency decision (DEC-024): the CRDT Doc is single-writer by design —
// all replica mutation happens on one thread (the engine API is not
// synchronized). Offloading CPU-bound auxiliaries (state hashing over large
// snapshots, serialization, future compaction) uses this bounded worker pool:
// fixed thread count, bounded task queue, cooperative cancellation via
// stop tokens, clean join on shutdown, no detached threads.
#pragma once

#include <condition_variable>
#include <cstddef>
#include <functional>
#include <mutex>
#include <queue>
#include <stop_token>
#include <thread>
#include <vector>

#include "concord/crdt/errors.hpp"

namespace concord::crdt {

class TaskExecutor final {
public:
    using Task = std::function<void(std::stop_token)>;

    // Spawns `thread_count` workers (>= 1). Throws InvalidArgument for 0.
    explicit TaskExecutor(std::size_t thread_count);
    ~TaskExecutor();

    TaskExecutor(const TaskExecutor&) = delete;
    TaskExecutor& operator=(const TaskExecutor&) = delete;
    TaskExecutor(TaskExecutor&&) = delete;
    TaskExecutor& operator=(TaskExecutor&&) = delete;

    // Enqueues a task. Throws PendingLimitExceeded when the bounded queue is
    // full (never blocks, never grows unbounded). Throws InvalidArgument for
    // a null task.
    void submit(Task task);

    // Signals shutdown and joins all workers. Idempotent; the destructor
    // calls it. Tasks already dequeued run to completion; tasks still queued
    // at shutdown are discarded (submit-after-shutdown throws).
    void shutdown();

    [[nodiscard]] std::size_t queued() const;
    [[nodiscard]] std::size_t thread_count() const noexcept { return workers_.size(); }

private:
    void worker_loop(std::stop_token stop_token);

    std::vector<std::jthread> workers_;
    std::queue<Task> queue_;
    static constexpr std::size_t kMaxQueue = 10'000;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    bool shutting_down_ = false;
};

}  // namespace concord::crdt
