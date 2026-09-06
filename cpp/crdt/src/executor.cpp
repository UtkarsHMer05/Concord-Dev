// Bounded task executor implementation (P2-M028).
#include "concord/crdt/executor.hpp"

namespace concord::crdt {

TaskExecutor::TaskExecutor(std::size_t thread_count) {
    if (thread_count == 0) {
        throw CrdtError(ErrorCode::InvalidArgument, "thread count must be >= 1");
    }
    workers_.reserve(thread_count);
    for (std::size_t i = 0; i < thread_count; ++i) {
        workers_.emplace_back([this](std::stop_token stop_token) {
            worker_loop(std::move(stop_token));
        });
    }
}

TaskExecutor::~TaskExecutor() {
    shutdown();
}

void TaskExecutor::submit(Task task) {
    if (!task) {
        throw CrdtError(ErrorCode::InvalidArgument, "null task");
    }
    {
        std::lock_guard lock(mutex_);
        if (shutting_down_) {
            throw CrdtError(ErrorCode::InvalidArgument, "executor is shutting down");
        }
        if (queue_.size() >= kMaxQueue) {
            throw CrdtError(ErrorCode::PendingLimitExceeded, "task queue is full");
        }
        queue_.push(std::move(task));
    }
    cv_.notify_one();
}

void TaskExecutor::shutdown() {
    {
        std::lock_guard lock(mutex_);
        if (shutting_down_) {
            return;
        }
        shutting_down_ = true;
        // Discard queued-but-unstarted tasks: deterministic shutdown, no
        // hidden work after the caller stops waiting.
        std::queue<Task> empty;
        queue_.swap(empty);
    }
    cv_.notify_all();
    for (auto& worker : workers_) {
        if (worker.joinable()) {
            worker.request_stop();
            worker.join();
        }
    }
    workers_.clear();
}

std::size_t TaskExecutor::queued() const {
    std::lock_guard lock(mutex_);
    return queue_.size();
}

void TaskExecutor::worker_loop(std::stop_token stop_token) {
    for (;;) {
        Task task;
        {
            std::unique_lock lock(mutex_);
            // libc++ has no stop_token-aware condition-variable overload; the
            // stop check is folded into the predicate instead.
            cv_.wait(lock, [this, &stop_token] {
                return shutting_down_ || !queue_.empty() || stop_token.stop_requested();
            });
            if (stop_token.stop_requested() && queue_.empty()) {
                return;
            }
            if (queue_.empty()) {
                // Shutdown discard path.
                continue;
            }
            task = std::move(queue_.front());
            queue_.pop();
        }
        // Exception containment: a throwing task must not kill the worker.
        try {
            task(stop_token);
        } catch (...) {
            // Tasks are expected to handle their own errors; containment is
            // the last line of defense. (Failures are surfaced through the
            // task's own result channels, not exceptions.)
        }
        if (stop_token.stop_requested()) {
            return;
        }
    }
}

}  // namespace concord::crdt
