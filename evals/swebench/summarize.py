#!/usr/bin/env python3
"""Summarize SWE-bench evaluation run results.

Walks the SWE-bench harness output directory, tallies resolved/unresolved/error
counts, and emits a markdown summary. Optionally diffs against another run.
"""

import argparse
import json
import sys
from pathlib import Path


def load_expected_instance_ids(predictions_path: Path) -> list[str]:
    """Read instance_ids from a predictions.jsonl file (one JSON object per line)."""
    instance_ids: list[str] = []
    if not predictions_path.exists():
        print(
            f"warning: predictions file not found: {predictions_path}",
            file=sys.stderr,
        )
        return instance_ids
    with predictions_path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            stripped = raw_line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError as exc:
                print(
                    f"warning: could not parse predictions line {line_number}: {exc}",
                    file=sys.stderr,
                )
                continue
            instance_id = record.get("instance_id")
            if instance_id:
                instance_ids.append(instance_id)
    return instance_ids


def load_run_results(
    run_id: str,
    model_name: str,
    expected_instance_ids: list[str],
    repo_root: Path,
) -> dict:
    """Walk logs/run_evaluation/<run_id>/<model_name>/*/report.json and tally results.

    Returns a dict:
      {
        "per_instance": {instance_id: {"resolved": bool|None, "notes": str}},
        "resolved_count": int,
        "unresolved_count": int,
        "error_count": int,
      }
    """
    run_logs_root = repo_root / "logs" / "run_evaluation" / run_id / model_name
    per_instance: dict[str, dict] = {}
    resolved_count = 0
    unresolved_count = 0
    error_count = 0

    for instance_id in expected_instance_ids:
        report_path = run_logs_root / instance_id / "report.json"
        if not report_path.exists():
            per_instance[instance_id] = {
                "resolved": None,
                "notes": "missing report.json",
            }
            error_count += 1
            continue
        try:
            with report_path.open("r", encoding="utf-8") as handle:
                report_data = json.load(handle)
        except (json.JSONDecodeError, OSError) as exc:
            per_instance[instance_id] = {
                "resolved": None,
                "notes": f"failed to parse report.json: {exc}",
            }
            error_count += 1
            continue

        # SWE-bench harness typically nests per-instance data under the
        # instance_id key; fall back to the top-level dict for flexibility.
        inner = report_data.get(instance_id, report_data)
        resolved_value = inner.get("resolved")
        if resolved_value is True:
            per_instance[instance_id] = {"resolved": True, "notes": ""}
            resolved_count += 1
        elif resolved_value is False:
            notes_parts: list[str] = []
            tests_status = inner.get("tests_status")
            if isinstance(tests_status, dict):
                fail_to_pass = tests_status.get("FAIL_TO_PASS", {})
                if isinstance(fail_to_pass, dict):
                    failed = fail_to_pass.get("failure", []) or []
                    if failed:
                        notes_parts.append(f"FAIL_TO_PASS failures: {len(failed)}")
            per_instance[instance_id] = {
                "resolved": False,
                "notes": "; ".join(notes_parts),
            }
            unresolved_count += 1
        else:
            per_instance[instance_id] = {
                "resolved": None,
                "notes": "report.json missing 'resolved' field",
            }
            error_count += 1

    return {
        "per_instance": per_instance,
        "resolved_count": resolved_count,
        "unresolved_count": unresolved_count,
        "error_count": error_count,
    }


def format_resolved_cell(resolved: bool | None) -> str:
    if resolved is True:
        return "yes"
    if resolved is False:
        return "no"
    return "error"


def render_summary_markdown(run_id: str, results: dict) -> str:
    total = (
        results["resolved_count"]
        + results["unresolved_count"]
        + results["error_count"]
    )
    resolved = results["resolved_count"]
    resolve_rate = (resolved / total * 100.0) if total > 0 else 0.0

    lines: list[str] = []
    lines.append(f"# Run {run_id}")
    lines.append(f"- Total: {total}")
    lines.append(f"- Resolved: {resolved} ({resolve_rate:.2f}%)")
    lines.append(f"- Unresolved: {results['unresolved_count']}")
    lines.append(f"- Errors: {results['error_count']}")
    lines.append("")
    lines.append("## Per-instance")
    lines.append("| instance_id | resolved | notes |")
    lines.append("|---|---|---|")
    for instance_id, record in results["per_instance"].items():
        resolved_cell = format_resolved_cell(record["resolved"])
        notes_cell = record.get("notes", "") or ""
        # Escape pipe chars in notes to avoid breaking markdown tables.
        notes_cell = notes_cell.replace("|", "\\|")
        lines.append(f"| {instance_id} | {resolved_cell} | {notes_cell} |")
    lines.append("")
    return "\n".join(lines)


def render_diff_markdown(
    current_run_id: str,
    other_run_id: str,
    current_results: dict,
    other_results: dict,
) -> str:
    def resolve_rate(results: dict) -> tuple[int, float]:
        total = (
            results["resolved_count"]
            + results["unresolved_count"]
            + results["error_count"]
        )
        rate = (results["resolved_count"] / total * 100.0) if total > 0 else 0.0
        return total, rate

    current_total, current_rate = resolve_rate(current_results)
    other_total, other_rate = resolve_rate(other_results)
    rate_delta = current_rate - other_rate

    lines: list[str] = []
    lines.append(f"# Diff vs {other_run_id}")
    lines.append(
        f"- {current_run_id}: {current_results['resolved_count']}/{current_total} "
        f"({current_rate:.2f}%)"
    )
    lines.append(
        f"- {other_run_id}: {other_results['resolved_count']}/{other_total} "
        f"({other_rate:.2f}%)"
    )
    lines.append(f"- Delta: {rate_delta:+.2f} percentage points")
    lines.append("")
    lines.append("## Per-instance status changes")
    lines.append(f"| instance_id | {other_run_id} | {current_run_id} |")
    lines.append("|---|---|---|")

    all_instance_ids = set(current_results["per_instance"].keys()) | set(
        other_results["per_instance"].keys()
    )
    changes_found = False
    for instance_id in sorted(all_instance_ids):
        current_record = current_results["per_instance"].get(instance_id)
        other_record = other_results["per_instance"].get(instance_id)
        current_status = (
            format_resolved_cell(current_record["resolved"])
            if current_record
            else "absent"
        )
        other_status = (
            format_resolved_cell(other_record["resolved"])
            if other_record
            else "absent"
        )
        if current_status != other_status:
            lines.append(f"| {instance_id} | {other_status} | {current_status} |")
            changes_found = True
    if not changes_found:
        lines.append("| (no status changes) | | |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Summarize SWE-bench evaluation run results."
    )
    parser.add_argument(
        "--run-id",
        required=True,
        help="Run identifier used in logs/run_evaluation/<run_id>/ and evals/swebench/runs/<run_id>/.",
    )
    parser.add_argument(
        "--compare",
        metavar="OTHER_RUN_ID",
        default=None,
        help="Optional other run_id to diff resolve rates and per-instance status changes against.",
    )
    parser.add_argument(
        "--model-name",
        default="claude-opus-4-7+claude-mem",
        help="Model name directory inside logs/run_evaluation/<run_id>/.",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output path for the markdown summary (default: evals/swebench/runs/<run_id>/summary.md).",
    )
    args = parser.parse_args()

    # Resolve repo root from this script's location: evals/swebench/summarize.py
    script_path = Path(__file__).resolve()
    repo_root = script_path.parent.parent.parent

    current_predictions_path = (
        repo_root / "evals" / "swebench" / "runs" / args.run_id / "predictions.jsonl"
    )
    current_instance_ids = load_expected_instance_ids(current_predictions_path)
    current_results = load_run_results(
        run_id=args.run_id,
        model_name=args.model_name,
        expected_instance_ids=current_instance_ids,
        repo_root=repo_root,
    )

    summary_markdown = render_summary_markdown(args.run_id, current_results)

    if args.compare:
        other_predictions_path = (
            repo_root
            / "evals"
            / "swebench"
            / "runs"
            / args.compare
            / "predictions.jsonl"
        )
        other_instance_ids = load_expected_instance_ids(other_predictions_path)
        other_results = load_run_results(
            run_id=args.compare,
            model_name=args.model_name,
            expected_instance_ids=other_instance_ids,
            repo_root=repo_root,
        )
        diff_markdown = render_diff_markdown(
            current_run_id=args.run_id,
            other_run_id=args.compare,
            current_results=current_results,
            other_results=other_results,
        )
        summary_markdown = summary_markdown + "\n" + diff_markdown

    if args.out:
        output_path = Path(args.out)
        if not output_path.is_absolute():
            output_path = (Path.cwd() / output_path).resolve()
    else:
        output_path = (
            repo_root
            / "evals"
            / "swebench"
            / "runs"
            / args.run_id
            / "summary.md"
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(summary_markdown, encoding="utf-8")

    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
