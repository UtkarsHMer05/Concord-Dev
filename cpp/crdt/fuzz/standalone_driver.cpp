// Standalone mutational fuzz driver.
//
// Used when a libFuzzer runtime is unavailable on the host (documented
// platform limitation on this macOS/Xcode combination: the fuzzer runtime
// library is absent from Apple's toolchain and the Homebrew runtime hangs at
// startup). Implements a deterministic, seeded mutational loop over a corpus
// so the same fuzz targets can smoke-run reproducibly anywhere.
//
// Usage: fuzz_<target>_standalone <corpus-dir> [runs] [seed]
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size);

namespace {

std::uint64_t rng_state = 0x9e3779b97f4a7c15ULL;

std::uint64_t next_random() {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 7;
    rng_state ^= rng_state << 17;
    return rng_state;
}

std::string mutate(const std::string& input) {
    if (input.empty()) {
        return std::string(1, static_cast<char>(next_random() & 0xff));
    }
    std::string out = input;
    const std::uint64_t choice = next_random() % 6;
    const std::size_t position = next_random() % out.size();
    switch (choice) {
        case 0:  // bit flip
            out[position] = static_cast<char>(out[position] ^ (1 << (next_random() % 8)));
            break;
        case 1:  // random byte
            out[position] = static_cast<char>(next_random() & 0xff);
            break;
        case 2:  // truncate
            out.resize(1 + position % out.size());
            break;
        case 3:  // insert byte
            out.insert(out.begin() + static_cast<std::ptrdiff_t>(position),
                       static_cast<char>(next_random() & 0xff));
            break;
        case 4:  // append bytes
            for (int i = 0; i < 4; ++i) {
                out.push_back(static_cast<char>(next_random() & 0xff));
            }
            break;
        default:  // splice with self
            out.insert(out.end(), input.begin(),
                       input.begin() + static_cast<std::ptrdiff_t>(position % input.size()));
            break;
    }
    if (out.size() > 8192) {
        out.resize(8192);
    }
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    std::vector<std::string> corpus;
    long runs = 20000;
    if (argc > 1) {
        // First non-flag argument: corpus directory contents are ignored by
        // this driver (files are enumerated by the shell harness); support
        // reading individual files passed as arguments.
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            if (arg.rfind("-", 0) == 0) {
                continue;
            }
            FILE* file = std::fopen(arg.c_str(), "rb");
            if (file != nullptr) {
                std::string contents;
                char buffer[4096];
                std::size_t read = 0;
                while ((read = std::fread(buffer, 1, sizeof(buffer), file)) > 0) {
                    contents.append(buffer, read);
                }
                std::fclose(file);
                corpus.push_back(contents);
            } else {
                runs = std::strtol(arg.c_str(), nullptr, 10);
            }
        }
    }
    if (corpus.empty()) {
        corpus.emplace_back(1, '\x01');  // minimal seed so mutation has input
    }
    if (const char* seed_env = std::getenv("FUZZ_SEED")) {
        rng_state = std::strtoull(seed_env, nullptr, 10) | 1u;
    }

    std::printf("standalone fuzz driver: %ld runs from %zu seeds\n", runs, corpus.size());
    for (long run = 0; run < runs; ++run) {
        std::string input = corpus[static_cast<std::size_t>(run) % corpus.size()];
        for (int depth = 0; depth < 3; ++depth) {
            input = mutate(input);
        }
        LLVMFuzzerTestOneInput(reinterpret_cast<const std::uint8_t*>(input.data()),
                               input.size());
    }
    std::printf("standalone fuzz driver: completed without crashes\n");
    return 0;
}
