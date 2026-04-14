#!/usr/bin/env python3
"""SWE-bench Verified runner for Claude Code with claude-mem installed.

For each task instance this script:
  1. Clones the target repo at ``base_commit`` into an isolated workdir.
  2. Invokes the ``claude`` CLI in headless (``--print``) mode, feeding a
     prompt prefixed with the custom instructions:
         "use the /make-plan and /do skill to " + <problem_statement>
     claude-mem must already be installed as a plugin so its hooks and
     skills are active during the run.
  3. Captures the resulting ``git diff`` against ``base_commit`` as the
     ``model_patch`` and appends a prediction row to ``predictions.jsonl``
     in SWE-bench's standard prediction format.

The file this produces is the input to the standard SWE-bench evaluation
harness (see ``scripts/swebench/evaluate.sh``). This runner does NOT score
results; it only generates predictions.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

CUSTOM_PROMPT_PREFIX = "use the /make-plan and /do skill to "
DEFAULT_MODEL_NAME = "claude-mem"
DEFAULT_SPLIT = "test"
DEFAULT_DATASET = "princeton-nlp/SWE-bench_Verified"


@dataclass
class Instance:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str


def load_instances(dataset: str, split: str) -> list[Instance]:
    """Load SWE-bench instances via the HuggingFace ``datasets`` library."""
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError as exc:  # pragma: no cover - env bootstrap hint
        raise SystemExit(
            "Missing dependency 'datasets'. Install with: "
            "uv pip install datasets  (or pip install datasets)"
        ) from exc

    ds = load_dataset(dataset, split=split)
    out: list[Instance] = []
    for row in ds:
        out.append(
            Instance(
                instance_id=row["instance_id"],
                repo=row["repo"],
                base_commit=row["base_commit"],
                problem_statement=row["problem_statement"],
            )
        )
    return out


def filter_instances(
    instances: Iterable[Instance],
    ids: list[str] | None,
    max_tasks: int | None,
) -> list[Instance]:
    filtered = list(instances)
    if ids:
        id_set = set(ids)
        filtered = [i for i in filtered if i.instance_id in id_set]
    if max_tasks is not None:
        filtered = filtered[:max_tasks]
    return filtered


def already_predicted(predictions_path: Path) -> set[str]:
    if not predictions_path.exists():
        return set()
    done: set[str] = set()
    with predictions_path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            inst = row.get("instance_id")
            if isinstance(inst, str):
                done.add(inst)
    return done


def run(cmd: list[str], *, cwd: Path | None = None, timeout: int | None = None,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env={**os.environ, **(env or {})},
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def prepare_repo(instance: Instance, workdir: Path) -> Path:
    """Clone ``instance.repo`` at ``base_commit`` into ``workdir``."""
    repo_dir = workdir / "repo"
    if repo_dir.exists():
        shutil.rmtree(repo_dir)
    clone_url = f"https://github.com/{instance.repo}.git"
    res = run(["git", "clone", "--quiet", clone_url, str(repo_dir)])
    if res.returncode != 0:
        raise RuntimeError(f"git clone failed for {instance.repo}: {res.stderr}")
    res = run(
        ["git", "checkout", "--quiet", instance.base_commit],
        cwd=repo_dir,
    )
    if res.returncode != 0:
        raise RuntimeError(
            f"git checkout {instance.base_commit} failed for "
            f"{instance.instance_id}: {res.stderr}"
        )
    return repo_dir


def invoke_claude(
    claude_bin: str,
    repo_dir: Path,
    prompt: str,
    *,
    timeout: int,
    model: str | None,
    permission_mode: str,
) -> subprocess.CompletedProcess[str]:
    """Run Claude Code headlessly inside ``repo_dir``."""
    cmd = [
        claude_bin,
        "--print",
        "--permission-mode", permission_mode,
        "--output-format", "stream-json",
        "--verbose",
    ]
    if model:
        cmd += ["--model", model]
    cmd.append(prompt)
    return run(cmd, cwd=repo_dir, timeout=timeout)


def capture_diff(repo_dir: Path, base_commit: str) -> str:
    """Return a unified diff against ``base_commit`` for all tracked and
    untracked text changes."""
    # Stage everything (including untracked) so ``git diff --cached`` captures
    # new files; a temporary index keeps the worktree untouched.
    run(["git", "add", "-A"], cwd=repo_dir)
    res = run(
        ["git", "diff", "--cached", "--binary", base_commit],
        cwd=repo_dir,
    )
    if res.returncode != 0:
        # Fall back to worktree diff if cached diff fails (detached edge cases).
        res = run(["git", "diff", "--binary", base_commit], cwd=repo_dir)
    return res.stdout


def process_instance(
    instance: Instance,
    *,
    predictions_path: Path,
    workroot: Path,
    claude_bin: str,
    model_name: str,
    model: str | None,
    per_task_timeout: int,
    permission_mode: str,
    keep_workdirs: bool,
    lock: "ThreadLock",
) -> tuple[str, bool, str]:
    workdir = workroot / instance.instance_id
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        repo_dir = prepare_repo(instance, workdir)
        prompt = CUSTOM_PROMPT_PREFIX + instance.problem_statement
        proc = invoke_claude(
            claude_bin,
            repo_dir,
            prompt,
            timeout=per_task_timeout,
            model=model,
            permission_mode=permission_mode,
        )
        patch = capture_diff(repo_dir, instance.base_commit)
        row = {
            "instance_id": instance.instance_id,
            "model_name_or_path": model_name,
            "model_patch": patch,
        }
        with lock:
            with predictions_path.open("a") as fh:
                fh.write(json.dumps(row) + "\n")
        ok = proc.returncode == 0 and bool(patch.strip())
        detail = (
            f"rc={proc.returncode} patch_bytes={len(patch)} "
            f"stderr_tail={proc.stderr[-200:]!r}" if proc.stderr else
            f"rc={proc.returncode} patch_bytes={len(patch)}"
        )
        return instance.instance_id, ok, detail
    except subprocess.TimeoutExpired:
        return instance.instance_id, False, f"timeout after {per_task_timeout}s"
    except Exception as exc:  # noqa: BLE001 - surface any failure as row-level
        return instance.instance_id, False, f"error: {exc}"
    finally:
        if not keep_workdirs:
            shutil.rmtree(workdir, ignore_errors=True)


def iter_with_progress(it: Iterable, total: int) -> Iterator:
    start = time.time()
    for i, x in enumerate(it, 1):
        yield x
        elapsed = time.time() - start
        rate = i / elapsed if elapsed else 0
        eta = (total - i) / rate if rate else 0
        print(
            f"[{i}/{total}] elapsed={elapsed:.0f}s eta={eta:.0f}s",
            file=sys.stderr,
            flush=True,
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=DEFAULT_DATASET,
                    help=f"HF dataset id (default: {DEFAULT_DATASET})")
    ap.add_argument("--split", default=DEFAULT_SPLIT,
                    help=f"Dataset split (default: {DEFAULT_SPLIT})")
    ap.add_argument("--predictions", type=Path,
                    default=Path("scripts/swebench/out/predictions.jsonl"),
                    help="Output JSONL path (appended to; --resume-aware)")
    ap.add_argument("--workroot", type=Path,
                    default=Path(tempfile.gettempdir()) / "claude-mem-swebench",
                    help="Root directory for per-task clones")
    ap.add_argument("--claude-bin", default=os.environ.get("CLAUDE_BIN", "claude"),
                    help="Path to the Claude Code CLI (default: 'claude')")
    ap.add_argument("--model", default=os.environ.get("CLAUDE_MODEL"),
                    help="Model id passed to claude --model (optional)")
    ap.add_argument("--model-name", default=DEFAULT_MODEL_NAME,
                    help=f"model_name_or_path written to predictions "
                         f"(default: {DEFAULT_MODEL_NAME})")
    ap.add_argument("--permission-mode", default="bypassPermissions",
                    choices=["bypassPermissions", "acceptEdits", "default"],
                    help="Claude Code permission mode for unattended runs")
    ap.add_argument("--per-task-timeout", type=int, default=45 * 60,
                    help="Per-task wall-clock timeout in seconds (default 45m)")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="Number of tasks to run in parallel (default 1)")
    ap.add_argument("--max-tasks", type=int, default=None,
                    help="Stop after N instances (for smoke tests)")
    ap.add_argument("--instance-id", action="append", default=None,
                    help="Run only this instance id (repeatable)")
    ap.add_argument("--no-resume", action="store_true",
                    help="Do not skip instances already present in predictions")
    ap.add_argument("--keep-workdirs", action="store_true",
                    help="Keep per-task clones on disk (debugging)")
    args = ap.parse_args()

    if shutil.which(args.claude_bin) is None and not Path(args.claude_bin).exists():
        print(f"error: claude CLI not found at {args.claude_bin!r}. "
              "Install Claude Code or pass --claude-bin.", file=sys.stderr)
        return 2

    args.predictions.parent.mkdir(parents=True, exist_ok=True)
    args.workroot.mkdir(parents=True, exist_ok=True)

    print(f"Loading dataset {args.dataset} split={args.split} ...", file=sys.stderr)
    instances = load_instances(args.dataset, args.split)
    instances = filter_instances(instances, args.instance_id, args.max_tasks)
    if not args.no_resume:
        done = already_predicted(args.predictions)
        if done:
            print(f"Resuming: skipping {len(done)} already-predicted instances",
                  file=sys.stderr)
            instances = [i for i in instances if i.instance_id not in done]

    total = len(instances)
    print(f"Running {total} instance(s) with concurrency={args.concurrency}",
          file=sys.stderr)
    if total == 0:
        return 0

    import threading
    lock = threading.Lock()

    if args.concurrency <= 1:
        for inst in iter_with_progress(instances, total):
            inst_id, ok, detail = process_instance(
                inst,
                predictions_path=args.predictions,
                workroot=args.workroot,
                claude_bin=args.claude_bin,
                model_name=args.model_name,
                model=args.model,
                per_task_timeout=args.per_task_timeout,
                permission_mode=args.permission_mode,
                keep_workdirs=args.keep_workdirs,
                lock=lock,
            )
            print(f"  {inst_id}: {'ok' if ok else 'FAIL'} — {detail}",
                  file=sys.stderr, flush=True)
    else:
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            futures = {
                pool.submit(
                    process_instance,
                    inst,
                    predictions_path=args.predictions,
                    workroot=args.workroot,
                    claude_bin=args.claude_bin,
                    model_name=args.model_name,
                    model=args.model,
                    per_task_timeout=args.per_task_timeout,
                    permission_mode=args.permission_mode,
                    keep_workdirs=args.keep_workdirs,
                    lock=lock,
                ): inst
                for inst in instances
            }
            done_count = 0
            for fut in as_completed(futures):
                done_count += 1
                inst_id, ok, detail = fut.result()
                print(f"[{done_count}/{total}] {inst_id}: "
                      f"{'ok' if ok else 'FAIL'} — {detail}",
                      file=sys.stderr, flush=True)

    print(f"\nWrote predictions to {args.predictions}", file=sys.stderr)
    return 0


# Typing shim so the dataclass hint above is happy at import time.
class ThreadLock:  # pragma: no cover - typing only
    def __enter__(self): ...
    def __exit__(self, *a): ...


if __name__ == "__main__":
    sys.exit(main())
