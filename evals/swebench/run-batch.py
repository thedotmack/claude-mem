#!/usr/bin/env python3
"""
Batch orchestrator for SWE-bench evaluation of Claude Code + claude-mem.

Iterates a list of SWE-bench Verified instances, launches a per-instance Docker
container (`claude-mem/swebench-agent:latest`) that runs the two-turn
ingest/fix protocol, and collects all resulting diffs into a single
`predictions.jsonl` compatible with the upstream SWE-bench harness.

Usage:
    python evals/swebench/run-batch.py \
        --run-id claude-mem-baseline-001 \
        --limit 3 \
        --max-concurrent 2

Rate-limit note: Anthropic API rate limits can bite quickly. The default
`--max-concurrent` is 4, but it is safer to START WITH 2 and raise the cap
only after observing no 429s in the logs.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable

from datasets import load_dataset


# Hidden-from-agent fields per the plan. We MUST NOT pass these to the agent
# container — they are evaluator-only ground truth.
HIDDEN_AGENT_FIELDS = (
    "patch",
    "test_patch",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "environment_setup_commit",
    "version",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the claude-mem SWE-bench agent on a batch of instances.",
    )
    parser.add_argument(
        "--instance-ids",
        nargs="+",
        default=None,
        help="Optional explicit list of instance_ids to run.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="If set, process only the first N instances after filtering.",
    )
    parser.add_argument(
        "--max-concurrent",
        type=int,
        default=4,
        help="Max concurrent agent containers (default 4; start with 2 and raise after observing no 429s).",
    )
    parser.add_argument(
        "--run-id",
        type=str,
        required=True,
        help="Run identifier; used for output paths.",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=None,
        help="Path to predictions.jsonl (default: evals/swebench/runs/<run_id>/predictions.jsonl).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=1800,
        help="Per-instance timeout in seconds (default 1800, matches upstream harness).",
    )
    parser.add_argument(
        "--image",
        type=str,
        default="claude-mem/swebench-agent:latest",
        help="Agent Docker image tag.",
    )
    return parser.parse_args()


def select_instances(
    dataset: Iterable[dict[str, Any]],
    instance_ids: list[str] | None,
    limit: int | None,
) -> list[dict[str, Any]]:
    """Filter dataset rows by instance_ids (if given) and apply limit."""
    rows: list[dict[str, Any]] = list(dataset)
    if instance_ids:
        wanted = set(instance_ids)
        rows = [r for r in rows if r["instance_id"] in wanted]
        missing = wanted - {r["instance_id"] for r in rows}
        if missing:
            print(
                f"WARN: {len(missing)} requested instance_ids not found in dataset: "
                f"{sorted(missing)[:5]}{'...' if len(missing) > 5 else ''}",
                file=sys.stderr,
            )
    if limit is not None:
        rows = rows[:limit]
    return rows


def append_prediction_row(
    predictions_path: Path,
    instance_id: str,
    model_patch: str,
    model_name_or_path: str,
    lock: threading.Lock,
) -> None:
    """Append one JSONL prediction row under a lock (appends are NOT atomic across threads)."""
    row = {
        "instance_id": instance_id,
        "model_patch": model_patch,
        "model_name_or_path": model_name_or_path,
    }
    line = json.dumps(row, ensure_ascii=False) + "\n"
    with lock:
        with predictions_path.open("a", encoding="utf-8") as fp:
            fp.write(line)


def copy_log_if_exists(src: Path, dst: Path) -> None:
    """Copy a log file from the shared scratch volume into the run-log directory, if present."""
    if src.exists() and src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def run_one_instance(
    instance: dict[str, Any],
    image: str,
    predictions_path: Path,
    predictions_dir: Path,
    run_dir: Path,
    timeout: int,
    predictions_lock: threading.Lock,
    model_name_or_path: str,
) -> tuple[str, str]:
    """
    Run the agent container for a single instance.

    Returns a (status, instance_id) tuple where status is one of:
    "succeeded", "failed", "timed_out".

    On ANY non-success (timeout, non-zero exit, missing diff), a prediction
    row with model_patch="" is still appended — the plan requires we never
    silently drop an instance.
    """
    instance_id: str = instance["instance_id"]
    repo: str = instance["repo"]
    base_commit: str = instance["base_commit"]
    problem_statement: str = instance["problem_statement"]

    instance_log_dir = run_dir / instance_id
    instance_log_dir.mkdir(parents=True, exist_ok=True)
    stderr_log_path = instance_log_dir / "stderr.log"

    # Per-instance scratch dir — MUST NOT be shared across containers.
    scratch_dir = Path(tempfile.mkdtemp(prefix=f"swebench-{instance_id}-"))
    problem_file = scratch_dir / "problem.txt"
    problem_file.write_text(problem_statement, encoding="utf-8")

    status: str = "failed"
    model_patch: str = ""

    try:
        # The orchestrator owns JSONL writes under `predictions_lock` to avoid
        # racy concurrent appends across containers — so we DO NOT mount the
        # predictions directory into the container. Instead, the agent writes
        # its authoritative diff to /scratch/model_patch.diff (via
        # CLAUDE_MEM_OUTPUT_DIR), plus ingest/fix logs to the same dir. The
        # 5th CLI arg to run-instance.sh is only used in standalone smoke-test
        # mode; here we point it at a throwaway path inside the container.
        cmd = [
            "docker",
            "run",
            "--rm",
            "-e",
            "ANTHROPIC_API_KEY",
            "-e",
            "CLAUDE_MEM_OUTPUT_DIR=/scratch",
            "-v",
            f"{scratch_dir}:/scratch",
            image,
            instance_id,
            repo,
            base_commit,
            "/scratch/problem.txt",
            "/scratch/ignored-predictions.jsonl",
        ]

        try:
            completed = subprocess.run(
                cmd,
                timeout=timeout,
                capture_output=True,
                text=True,
                check=False,
            )
            # Persist stderr so post-mortem is possible even on success.
            stderr_log_path.write_text(
                f"=== STDOUT ===\n{completed.stdout}\n=== STDERR ===\n{completed.stderr}\n",
                encoding="utf-8",
            )

            if completed.returncode == 0:
                # Read the diff the agent wrote to the shared predictions volume.
                # The container writes its own prediction line; we prefer to
                # write our own authoritative row here from the diff file the
                # agent left in /scratch. If the agent wrote a diff file, use
                # it; otherwise fall back to empty patch.
                diff_file = scratch_dir / "model_patch.diff"
                if diff_file.exists():
                    diff_text = diff_file.read_text(encoding="utf-8")
                    if diff_text.strip():
                        model_patch = diff_text
                        status = "succeeded"
                    else:
                        status = "failed"  # empty diff
                else:
                    # Container did not leave a diff file — treat as failure
                    # but still emit an empty-patch row below.
                    status = "failed"
            else:
                status = "failed"

        except subprocess.TimeoutExpired as exc:
            status = "timed_out"
            stderr_log_path.write_text(
                f"TIMEOUT after {timeout}s\n"
                f"=== STDOUT (partial) ===\n{exc.stdout or ''}\n"
                f"=== STDERR (partial) ===\n{exc.stderr or ''}\n",
                encoding="utf-8",
            )

        # Copy per-turn logs left by the agent in the shared scratch volume.
        copy_log_if_exists(scratch_dir / "ingest.jsonl", instance_log_dir / "ingest.jsonl")
        copy_log_if_exists(scratch_dir / "fix.jsonl", instance_log_dir / "fix.jsonl")

        # Always write a row — never silently drop an instance.
        append_prediction_row(
            predictions_path=predictions_path,
            instance_id=instance_id,
            model_patch=model_patch,
            model_name_or_path=model_name_or_path,
            lock=predictions_lock,
        )

    except Exception as exc:  # pragma: no cover — defensive
        status = "failed"
        try:
            stderr_log_path.write_text(
                f"ORCHESTRATOR EXCEPTION: {exc!r}\n",
                encoding="utf-8",
            )
        except OSError:
            pass
        append_prediction_row(
            predictions_path=predictions_path,
            instance_id=instance_id,
            model_patch="",
            model_name_or_path=model_name_or_path,
            lock=predictions_lock,
        )
    finally:
        # Per-instance scratch must not leak across containers.
        shutil.rmtree(scratch_dir, ignore_errors=True)

    return status, instance_id


def main() -> int:
    args = parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if args.out:
        predictions_path = Path(args.out).resolve()
    else:
        predictions_path = (
            repo_root
            / "evals"
            / "swebench"
            / "runs"
            / args.run_id
            / "predictions.jsonl"
        )

    predictions_dir = predictions_path.parent
    run_dir = predictions_dir  # logs land in evals/swebench/runs/<run_id>/<instance_id>/
    predictions_dir.mkdir(parents=True, exist_ok=True)
    # Truncate any existing predictions file for this run so re-runs are clean.
    predictions_path.write_text("", encoding="utf-8")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ERROR: ANTHROPIC_API_KEY is not set in the environment.",
            file=sys.stderr,
        )
        return 1

    print(f"Loading dataset princeton-nlp/SWE-bench_Verified (split=test)...", file=sys.stderr)
    dataset = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")

    instances = select_instances(dataset, args.instance_ids, args.limit)
    total = len(instances)
    if total == 0:
        print("No instances selected; nothing to do.", file=sys.stderr)
        return 0

    # Scrub hidden-from-agent fields defensively. The agent container only
    # receives instance_id/repo/base_commit/problem_statement via CLI args +
    # the per-instance problem file — the hidden fields never leave this
    # process. This loop makes that invariant explicit.
    for row in instances:
        for key in HIDDEN_AGENT_FIELDS:
            row.pop(key, None)

    model_name_or_path = "claude-opus-4-7+claude-mem"

    print(
        f"Launching {total} instance(s) with max_concurrent={args.max_concurrent}, "
        f"timeout={args.timeout}s, image={args.image}",
        file=sys.stderr,
    )

    predictions_lock = threading.Lock()
    succeeded = 0
    failed = 0
    timed_out = 0

    with ThreadPoolExecutor(max_workers=args.max_concurrent) as executor:
        future_to_id = {
            executor.submit(
                run_one_instance,
                instance=instance,
                image=args.image,
                predictions_path=predictions_path,
                predictions_dir=predictions_dir,
                run_dir=run_dir,
                timeout=args.timeout,
                predictions_lock=predictions_lock,
                model_name_or_path=model_name_or_path,
            ): instance["instance_id"]
            for instance in instances
        }

        for future in as_completed(future_to_id):
            instance_id = future_to_id[future]
            try:
                status, _ = future.result()
            except Exception as exc:  # pragma: no cover — defensive
                status = "failed"
                print(
                    f"[{instance_id}] orchestrator future raised: {exc!r}",
                    file=sys.stderr,
                )

            if status == "succeeded":
                succeeded += 1
            elif status == "timed_out":
                timed_out += 1
            else:
                failed += 1

            print(
                f"[{instance_id}] {status} "
                f"({succeeded + failed + timed_out}/{total} done)",
                file=sys.stderr,
            )

    print(
        f"{total} total, {succeeded} succeeded, {failed} failed, {timed_out} timed out",
    )
    # Per plan: exit 0 even if some instances failed.
    return 0


if __name__ == "__main__":
    sys.exit(main())
