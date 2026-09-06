// Minimal deterministic test harness for Concord native tests.
// Zero dependencies; exact semantics asserted with CHECK/REQUIRE.
#pragma once

#include <cstdio>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace concord::testing {

struct TestCase {
    std::string name;
    std::function<void()> fn;
};

inline std::vector<TestCase>& registry() {
    static std::vector<TestCase> registry_;
    return registry_;
}

inline int& failures() {
    static int failures_ = 0;
    return failures_;
}

inline std::string& current_case() {
    static std::string current_;
    return current_;
}

struct Registrar {
    Registrar(std::string name, std::function<void()> fn) {
        registry().push_back({std::move(name), std::move(fn)});
    }
};

#define CONCORD_TEST(case_name)                                        \
    static void concord_test_##case_name();                            \
    static ::concord::testing::Registrar concord_reg_##case_name(      \
        #case_name, concord_test_##case_name);                         \
    static void concord_test_##case_name()

inline void report_failure(const char* file, int line, const std::string& message) {
    std::fprintf(stderr, "FAIL [%s] %s:%d %s\n", current_case().c_str(), file, line,
                 message.c_str());
    ++failures();
}

template <typename T>
std::string describe(const T& value) {
    if constexpr (std::is_convertible_v<std::decay_t<T>, std::string>) {
        return std::string(value);
    } else {
        return std::to_string(value);
    }
}

#define CONCORD_CHECK(expr)                                                    \
    do {                                                                       \
        if (!(expr)) {                                                         \
            ::concord::testing::report_failure(__FILE__, __LINE__,             \
                                               "CHECK failed: " #expr);        \
        }                                                                      \
    } while (0)

#define CONCORD_CHECK_EQ(a, b)                                                 \
    do {                                                                       \
        const auto& va_ = (a);                                                 \
        const auto& vb_ = (b);                                                 \
        if (!(va_ == vb_)) {                                                   \
            ::concord::testing::report_failure(                                \
                __FILE__, __LINE__,                                            \
                "CHECK_EQ failed: " #a " == " #b " (" +                        \
                    ::concord::testing::describe(va_) + " vs " +               \
                    ::concord::testing::describe(vb_) + ")");                  \
        }                                                                      \
    } while (0)

#define CONCORD_CHECK_THROW(expr, ex_type)                                     \
    do {                                                                       \
        bool threw_ = false;                                                   \
        try {                                                                  \
            (void)(expr);                                                      \
        } catch (const ex_type&) {                                             \
            threw_ = true;                                                     \
        } catch (...) {                                                        \
            threw_ = true;                                                     \
        }                                                                      \
        if (!threw_) {                                                         \
            ::concord::testing::report_failure(                                \
                __FILE__, __LINE__, "expected exception: " #ex_type);          \
        }                                                                      \
    } while (0)

// Short aliases used pervasively in test bodies.
#define CHECK CONCORD_CHECK
#define CHECK_EQ CONCORD_CHECK_EQ
#define CHECK_THROW CONCORD_CHECK_THROW

inline int run_all(std::string_view filter = {}) {
    for (const auto& test : registry()) {
        if (!filter.empty() && test.name.find(filter) == std::string::npos) {
            continue;
        }
        current_case() = test.name;
        try {
            test.fn();
        } catch (const std::exception& error) {
            report_failure(__FILE__, __LINE__,
                           std::string("uncaught exception: ") + error.what());
        } catch (...) {
            report_failure(__FILE__, __LINE__, "uncaught non-standard exception");
        }
    }
    const int failed = failures();
    std::printf("%zu tests, %d failed\n", registry().size(), failed);
    return failed == 0 ? 0 : 1;
}

}  // namespace concord::testing
