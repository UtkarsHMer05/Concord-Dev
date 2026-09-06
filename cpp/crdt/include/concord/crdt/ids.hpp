// Strong identity and clock types for the Concord CRDT core.
//
// Identities mix freely as integers are a classic CRDT correctness bug; these
// types make cross-kind assignment a compile error and centralize validation.
//
// See docs/PROTOCOL.md §1 (normative definitions) and DEC-023.
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>

namespace concord::crdt {

// ---------------------------------------------------------------------------
// ReplicaId: nonzero unsigned 64-bit. Zero is never a valid replica.
// ---------------------------------------------------------------------------
class ReplicaId final {
public:
    constexpr explicit ReplicaId(std::uint64_t value) noexcept : value_(value) {}

    [[nodiscard]] static constexpr ReplicaId from_u64(std::uint64_t value) noexcept {
        return ReplicaId{value};
    }

    [[nodiscard]] static constexpr bool is_valid(std::uint64_t value) noexcept {
        return value != 0;
    }

    [[nodiscard]] constexpr std::uint64_t value() const noexcept { return value_; }

    friend constexpr bool operator==(ReplicaId, ReplicaId) = default;
    friend constexpr auto operator<=>(ReplicaId, ReplicaId) = default;

private:
    std::uint64_t value_;
};

// ---------------------------------------------------------------------------
// Counter: per-replica monotonic operation counter. Range [1, 2^63-1] leaves
// headroom so protocol versions can reserve the top bit for future flags.
// ---------------------------------------------------------------------------
class Counter final {
public:
    static constexpr std::uint64_t kMin = 1;
    static constexpr std::uint64_t kMax = (1ULL << 63) - 1;

    constexpr explicit Counter(std::uint64_t value) noexcept : value_(value) {}

    [[nodiscard]] static constexpr bool is_valid(std::uint64_t value) noexcept {
        return value >= kMin && value <= kMax;
    }

    [[nodiscard]] static constexpr Counter first() noexcept { return Counter{kMin}; }

    // Advance by one; returns nullopt at overflow (a surfaced programming
    // error per PROTOCOL §5 — generation must stop, never wrap).
    [[nodiscard]] constexpr std::optional<Counter> next() const noexcept {
        if (value_ >= kMax) {
            return std::nullopt;
        }
        return Counter{value_ + 1};
    }

    [[nodiscard]] constexpr std::uint64_t value() const noexcept { return value_; }

    friend constexpr bool operator==(Counter, Counter) = default;
    friend constexpr auto operator<=>(Counter, Counter) = default;

private:
    std::uint64_t value_;
};

// ---------------------------------------------------------------------------
// OpId: identity of an operation / of the item an insert creates. Total order
// is lexicographic (ReplicaId, Counter) — stable across all replicas.
// ---------------------------------------------------------------------------
struct OpId final {
    ReplicaId replica{0};
    Counter counter{0};

    [[nodiscard]] static constexpr bool is_valid_counter_pair(std::uint64_t replica,
                                                              std::uint64_t counter) noexcept {
        return ReplicaId::is_valid(replica) && Counter::is_valid(counter);
    }

    [[nodiscard]] constexpr bool is_valid() const noexcept {
        return ReplicaId::is_valid(replica.value()) && Counter::is_valid(counter.value());
    }

    // The zero/invalid id — used as a "no item" sentinel inside containers.
    static constexpr OpId null() noexcept { return OpId{ReplicaId{0}, Counter{0}}; }
    [[nodiscard]] constexpr bool is_null() const noexcept { return !is_valid(); }

    friend constexpr bool operator==(const OpId&, const OpId&) = default;
    friend constexpr auto operator<=>(const OpId&, const OpId&) = default;
};

// ---------------------------------------------------------------------------
// Lamport clock: logical time for attribute register ordering. Range
// [1, 2^63-1]; generation refuses to wrap.
// ---------------------------------------------------------------------------
class Lamport final {
public:
    static constexpr std::uint64_t kMin = 1;
    static constexpr std::uint64_t kMax = (1ULL << 63) - 1;

    constexpr explicit Lamport(std::uint64_t value) noexcept : value_(value) {}

    [[nodiscard]] static constexpr bool is_valid(std::uint64_t value) noexcept {
        return value >= kMin && value <= kMax;
    }

    [[nodiscard]] static constexpr Lamport first() noexcept { return Lamport{kMin}; }

    [[nodiscard]] constexpr std::uint64_t value() const noexcept { return value_; }

    friend constexpr bool operator==(Lamport, Lamport) = default;
    friend constexpr auto operator<=>(Lamport, Lamport) = default;

private:
    std::uint64_t value_;
};

// Deterministic hash for OpId (used only for hash-map lookups; container
// iteration order never influences CRDT state — see CONSISTENCY_MODEL §2.3).
struct OpIdHash final {
    [[nodiscard]] std::size_t operator()(const OpId& id) const noexcept {
        std::uint64_t mixed = mix(id.replica.value());
        mixed = mix(mixed ^ id.counter.value());
        return static_cast<std::size_t>(mixed);
    }

private:
    static constexpr std::uint64_t mix(std::uint64_t v) noexcept {
        v ^= v >> 33;
        v *= 0xff51afd7ed558ccdULL;
        v ^= v >> 33;
        v *= 0xc4ceb9fe1a85ec53ULL;
        v ^= v >> 33;
        return v;
    }
};

// ---------------------------------------------------------------------------
// Deterministic little-endian byte helpers shared by serialization. These
// make encodings host-endianness independent (PROTOCOL §7).
// ---------------------------------------------------------------------------
inline void put_u64_le(std::string& out, std::uint64_t value) {
    for (int shift = 0; shift < 64; shift += 8) {
        out.push_back(static_cast<char>((value >> shift) & 0xffu));
    }
}

inline void put_u8(std::string& out, std::uint8_t value) {
    out.push_back(static_cast<char>(value));
}

inline void put_u32_le(std::string& out, std::uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) {
        out.push_back(static_cast<char>((value >> shift) & 0xffu));
    }
}

[[nodiscard]] inline bool get_u32_le(const std::string& bytes, std::size_t& offset,
                                     std::uint32_t& out) {
    if (bytes.size() < offset + 4) {
        return false;
    }
    std::uint32_t value = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        value |= static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[offset + i])) << (8u * i);
    }
    offset += 4;
    out = value;
    return true;
}

[[nodiscard]] inline bool get_u64_le(const std::string& bytes, std::size_t& offset,
                                     std::uint64_t& out) {
    if (bytes.size() < offset + 8) {
        return false;
    }
    std::uint64_t value = 0;
    for (std::size_t i = 0; i < 8; ++i) {
        value |= static_cast<std::uint64_t>(static_cast<unsigned char>(bytes[offset + i])) << (8u * i);
    }
    offset += 8;
    out = value;
    return true;
}

[[nodiscard]] inline bool get_u8(const std::string& bytes, std::size_t& offset, std::uint8_t& out) {
    if (bytes.size() < offset + 1) {
        return false;
    }
    out = static_cast<std::uint8_t>(bytes[offset]);
    offset += 1;
    return true;
}

[[nodiscard]] inline std::string op_id_to_string(const OpId& id) {
    return "(" + std::to_string(id.replica.value()) + "," + std::to_string(id.counter.value()) + ")";
}

}  // namespace concord::crdt

// std::hash support so OpId works in unordered containers.
template <>
struct std::hash<concord::crdt::OpId> {
    [[nodiscard]] std::size_t operator()(const concord::crdt::OpId& id) const noexcept {
        return concord::crdt::OpIdHash{}(id);
    }
};
