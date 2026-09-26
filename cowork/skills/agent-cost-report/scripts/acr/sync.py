"""Phase 7.2: copy + checksum sync of the skill (SKILL.md, CHECKSUMS.txt and every file under scripts/)
from the plugin dir (source of truth) to the house copy and the four mirror plugins (G2: mirrors carry
the skill as byte copies, tracked in git). `sync-check` reports drift and exits 1; `--write` copies
plugin -> destinations and re-checks. Destinations live in one place (DESTINATIONS) and can be
overridden with --dest. Nothing outside that list is ever written.
"""
import hashlib
import os
import shutil

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))     # plugin/skills/agent-cost-report
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SKILL_DIR)))                      # the checkout holding plugin/
MIRRORS = ("claude-mem-cursor", "claude-mem-grok-bot", "cowork", "openclaw")
HOUSE_COPY = os.path.expanduser("~/agent-data/workflows/agent-cost-report")
CHECKSUMS = "CHECKSUMS.txt"
SKIP_DIRS = {"__pycache__", ".chrome-profile"}
SKIP_FILES = {CHECKSUMS}


def destinations(repo_root=REPO_ROOT, house=HOUSE_COPY):
    return [house] + [os.path.join(repo_root, m, "skills", "agent-cost-report") for m in MIRRORS]


def shipped_files(root=SKILL_DIR):
    """Relative paths of every shipped file: SKILL.md plus scripts/** (no caches, no checksum file)."""
    out = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and (dirpath != root or d == "scripts"))
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(dirpath, f), root)
            if dirpath == root and f not in ("SKILL.md",): continue
            if f in SKIP_FILES or f.endswith(".pyc"): continue
            out.append(rel)
    return out


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""): h.update(chunk)
    return h.hexdigest()


def write_checksums(root=SKILL_DIR):
    """sha256sum-compatible CHECKSUMS.txt next to SKILL.md so drift shows in git diffs."""
    lines = [f"{sha256(os.path.join(root, rel))}  {rel}" for rel in shipped_files(root)]
    with open(os.path.join(root, CHECKSUMS), "w") as fh: fh.write("\n".join(lines) + "\n")
    return lines


def compare(src, dst, files):
    """Per-file status: same | differs | missing."""
    rows = []
    for rel in files + [CHECKSUMS]:
        a, b = os.path.join(src, rel), os.path.join(dst, rel)
        if not os.path.exists(b): rows.append((rel, "missing"))
        elif sha256(a) != sha256(b): rows.append((rel, "differs"))
        else: rows.append((rel, "same"))
    return rows


def copy_tree(src, dst, files):
    for rel in files + [CHECKSUMS]:
        d = os.path.join(dst, rel); os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copyfile(os.path.join(src, rel), d)


def run(write=False, dests=None, src=SKILL_DIR, out=print):
    files = shipped_files(src)
    write_checksums(src)
    dests = list(dests) if dests else destinations()
    drift = 0
    for d in dests:
        if write: copy_tree(src, d, files)
        rows = compare(src, d, files); bad = [r for r in rows if r[1] != "same"]
        drift += len(bad)
        out(f"{'ok   ' if not bad else 'DRIFT'} {d}: {len(rows) - len(bad)}/{len(rows)} files identical" + (f"; {len(bad)} {'still ' if write else ''}differ: " + ", ".join(f"{r} ({s})" for r, s in bad[:6]) if bad else ""))
    return drift
