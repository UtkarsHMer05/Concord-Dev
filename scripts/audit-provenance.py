#!/usr/bin/env python3
"""Inventory baseline src/public paths against the current worktree.

Run from repository root; the TSV is evidence for docs/PROVENANCE.md,
not an automatic copyright or licensing determination.
"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAG = "antonio-original-baseline"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT).decode().splitlines()


def baseline():
    rows = {}
    for line in git("ls-tree", "-r", TAG, "--", "src", "public"):
        info, path = line.split("\t", 1)
        rows[path] = info.split()[-1]
    return rows


def main():
    original = baseline()
    current = set(git("ls-files", "--cached", "--others", "--exclude-standard", "--", "src", "public"))
    print("path\tbaseline_git_blob\tworktree_git_blob\tstate")
    for name in sorted(original.keys() | current):
        path = ROOT / name
        old = original.get(name, "-")
        if path.is_file():
            new = git("hash-object", "--", name)[0]
            state = "new" if old == "-" else "identical" if new == old else "changed"
        else:
            new = "-"
            state = "removed"
        print(f"{name}\t{old}\t{new}\t{state}")


if __name__ == "__main__":
    main()
