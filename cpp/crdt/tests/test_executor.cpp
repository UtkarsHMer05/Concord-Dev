// P2-M028: executor lifecycle and boundedness tests (TSan-clean by design).
#include "test_harness.hpp"

#include <atomic>
#include <chrono>
#include <thread>
#include <vector>

#include "concord/crdt/errors.hpp"
#include "concord/crdt/executor.hpp"

using namespace concord::crdt;

CONCORD_TEST(executor_runs_submitted_tasks) {
    TaskExecutor executor(2);
    std::atomic<int> counter{0};
    for (int i = 0; i < 100; ++i) {
        executor.submit([&counter](std::stop_token) { counter.fetch_add(1); });
    }
    // Bounded wait for completion (poll; no sleeps in assertions).
    for (int spin = 0; spin < 5000 && counter.load() < 100; ++spin) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK_EQ(counter.load(), 100);
}

CONCORD_TEST(executor_shutdown_discards_queued_and_ignores_late_submit) {
    TaskExecutor executor(1);
    executor.submit([](std::stop_token) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    });
    executor.shutdown();
    CHECK(executor.queued() == 0);
    CHECK_THROW(executor.submit([](std::stop_token) {}), CrdtError);
    executor.shutdown();  // idempotent
}

CONCORD_TEST(executor_rejects_bad_configuration) {
    CHECK_THROW(TaskExecutor(0), CrdtError);
    TaskExecutor executor(1);
    CHECK_THROW(executor.submit(nullptr), CrdtError);
    CHECK_EQ(executor.thread_count(), 1u);
}

CONCORD_TEST(executor_stop_token_cooperative_cancel) {
    TaskExecutor executor(1);
    std::atomic<bool> observed_stop{false};
    executor.submit([&observed_stop](std::stop_token stop) {
        for (int i = 0; i < 100 && !stop.stop_requested(); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        observed_stop = stop.stop_requested();
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    executor.shutdown();  // requests stop; destructor joins
    CHECK(observed_stop.load());
}

CONCORD_TEST(executor_bounded_queue_rejects_overflow) {
    TaskExecutor executor(1);
    // Block the worker until the test ends.
    std::atomic<bool> release{false};
    executor.submit([&release](std::stop_token) {
        while (!release.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });
    bool overflow_observed = false;
    std::exception_ptr last_error;
    for (int i = 0; i < 12000; ++i) {  // > kMaxQueue (10k)
        try {
            executor.submit([](std::stop_token) {});
        } catch (const CrdtError& error) {
            overflow_observed = true;
            last_error = std::current_exception();
            break;
        }
    }
    release = true;
    CHECK(overflow_observed);
    if (last_error != nullptr) {
        try {
            std::rethrow_exception(last_error);
        } catch (const CrdtError& error) {
            CHECK(error.code() == ErrorCode::PendingLimitExceeded);
        }
    }
    // Let the queue drain before the containment check.
    for (int spin = 0; spin < 10000 && executor.queued() > 0; ++spin) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(executor.queued() == 0);
    // Tasks that throw are contained; the worker survives.
    executor.submit([](std::stop_token) { throw std::runtime_error("contained"); });
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    executor.submit([](std::stop_token) {});  // still alive
}
