// Native test entry point.
#include "test_harness.hpp"

int main(int argc, char** argv) {
    std::string filter;
    if (argc > 1) {
        filter = argv[1];
    }
    return ::concord::testing::run_all(filter);
}
