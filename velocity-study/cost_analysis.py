#!/usr/bin/env python3
"""
Token Velocity Study — Cost Analysis (Phase 3)

Reads metrics.csv, applies Claude API pricing to each session, and produces:
  1. cost_summary.txt   — Readable breakdown of costs
  2. cost_trajectory.png — Per-session cost over sequence number

Usage:
    uv run --with matplotlib velocity-study/cost_analysis.py
"""

import csv
import sys
from collections import defaultdict
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.ticker as ticker
except ImportError:
    print("ERROR: matplotlib is required. Install with:  pip install matplotlib")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
CSV_PATH = SCRIPT_DIR / "metrics.csv"
RESULTS_DIR = SCRIPT_DIR / "results"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Pricing — dollars per million tokens
# ---------------------------------------------------------------------------
PRICING_DOLLARS_PER_MTOK = {
    "claude-sonnet-4-6": {
        "input": 3.00,
        "output": 15.00,
        "cache_read": 0.30,
        "cache_write": 3.75,
    },
    "claude-opus-4-6": {
        "input": 15.00,
        "output": 75.00,
        "cache_read": 1.50,
        "cache_write": 18.75,
    },
    "claude-haiku-4-5-20251001": {
        "input": 0.80,
        "output": 4.00,
        "cache_read": 0.08,
        "cache_write": 1.00,
    },
}

OBSERVER_PROJECT_SUBSTRING = "observer-sessions"

# Styling (matches plot.py)
COLOR_WITH_MEM = "#1f77b4"
COLOR_WITHOUT_MEM = "#999999"
INDIVIDUAL_ALPHA = 0.25
MEAN_LINEWIDTH = 2.5
FIGURE_SIZE = (12, 7)
DPI = 150
FONT_SIZE_TITLE = 15
FONT_SIZE_LABEL = 12
FONT_SIZE_LEGEND = 10
FONT_SIZE_TICK = 10


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def load_metrics_with_cost():
    """Load CSV, compute per-row cost, return list of dicts."""
    rows = []
    skipped_synthetic = 0
    with open(CSV_PATH, newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            model = row["model"]
            if model == "<synthetic>":
                skipped_synthetic += 1
                continue

            pricing = PRICING_DOLLARS_PER_MTOK.get(model)
            if pricing is None:
                print(f"WARNING: Unknown model '{model}', skipping row.")
                continue

            input_tokens = int(row["input_tokens"])
            output_tokens = int(row["output_tokens"])
            cache_creation_tokens = int(row["cache_creation_tokens"])
            cache_read_tokens = int(row["cache_read_tokens"])

            cost_dollars = (
                (input_tokens * pricing["input"] / 1_000_000)
                + (output_tokens * pricing["output"] / 1_000_000)
                + (cache_creation_tokens * pricing["cache_write"] / 1_000_000)
                + (cache_read_tokens * pricing["cache_read"] / 1_000_000)
            )

            row["sequence_num"] = int(row["sequence_num"])
            row["total_api_tokens"] = int(row["total_api_tokens"])
            row["input_tokens"] = input_tokens
            row["output_tokens"] = output_tokens
            row["cache_creation_tokens"] = cache_creation_tokens
            row["cache_read_tokens"] = cache_read_tokens
            row["has_claude_mem"] = row["has_claude_mem"].strip().lower() == "true"
            row["cost_dollars"] = cost_dollars
            rows.append(row)

    if skipped_synthetic:
        print(f"  Skipped {skipped_synthetic} <synthetic> rows.")
    return rows


def split_by_project(rows):
    """Return dict: project_id -> sorted list of rows."""
    projects = defaultdict(list)
    for row in rows:
        projects[row["project_id"]].append(row)
    for project_rows in projects.values():
        project_rows.sort(key=lambda r: r["sequence_num"])
    return dict(projects)


def is_observer_project(project_id):
    return OBSERVER_PROJECT_SUBSTRING in project_id


def project_majority_has_mem(project_rows):
    mem_count = sum(1 for r in project_rows if r["has_claude_mem"])
    return mem_count > len(project_rows) / 2


def short_project_label(project_id):
    parts = project_id.strip("-").split("-")
    if len(parts) > 3:
        return ".../" + "-".join(parts[-3:])
    return project_id


# ---------------------------------------------------------------------------
# Summary generation
# ---------------------------------------------------------------------------
def generate_cost_summary(all_projects, observer_project_rows):
    """Build the cost_summary.txt content and return it as a string."""
    lines = []
    lines.append("=" * 72)
    lines.append("TOKEN VELOCITY STUDY — COST ANALYSIS")
    lines.append("=" * 72)
    lines.append("")

    # --- Total cost across all sessions (including observer) ---
    all_rows = []
    for project_rows in all_projects.values():
        all_rows.extend(project_rows)
    if observer_project_rows:
        all_rows.extend(observer_project_rows)

    grand_total = sum(r["cost_dollars"] for r in all_rows)
    lines.append(f"Grand total cost (all {len(all_rows)} sessions): ${grand_total:.2f}")
    lines.append("")

    # --- Cost per project, sorted by total cost ---
    lines.append("-" * 72)
    lines.append("COST PER PROJECT (sorted by total cost, descending)")
    lines.append("-" * 72)

    project_totals = []
    all_project_data = dict(all_projects)
    if observer_project_rows:
        # Include observer in the per-project table
        observer_pid = observer_project_rows[0]["project_id"]
        all_project_data[observer_pid] = observer_project_rows

    for pid, project_rows in all_project_data.items():
        total_cost = sum(r["cost_dollars"] for r in project_rows)
        avg_cost = total_cost / len(project_rows) if project_rows else 0
        has_mem = project_majority_has_mem(project_rows)
        project_totals.append((pid, total_cost, avg_cost, len(project_rows), has_mem))

    project_totals.sort(key=lambda x: x[1], reverse=True)

    for pid, total_cost, avg_cost, session_count, has_mem in project_totals:
        mem_label = "mem" if has_mem else "no-mem"
        label = short_project_label(pid)
        lines.append(
            f"  ${total_cost:8.2f} total | ${avg_cost:6.4f}/session | "
            f"{session_count:4d} sessions | [{mem_label:6s}] {label}"
        )

    lines.append("")

    # --- Average cost per session: claude-mem vs no-claude-mem ---
    lines.append("-" * 72)
    lines.append("AVERAGE COST PER SESSION (claude-mem vs no-claude-mem)")
    lines.append("-" * 72)

    # Use user projects only (exclude observer) for the cohort comparison
    user_rows = []
    for pid, project_rows in all_projects.items():
        user_rows.extend(project_rows)

    mem_sessions = [r for r in user_rows if r["has_claude_mem"]]
    no_mem_sessions = [r for r in user_rows if not r["has_claude_mem"]]

    if mem_sessions:
        avg_mem = sum(r["cost_dollars"] for r in mem_sessions) / len(mem_sessions)
        lines.append(
            f"  claude-mem sessions:    ${avg_mem:.4f}/session  "
            f"({len(mem_sessions)} sessions)"
        )
    if no_mem_sessions:
        avg_no_mem = sum(r["cost_dollars"] for r in no_mem_sessions) / len(no_mem_sessions)
        lines.append(
            f"  no-claude-mem sessions: ${avg_no_mem:.4f}/session  "
            f"({len(no_mem_sessions)} sessions)"
        )

    if mem_sessions and no_mem_sessions:
        diff = avg_mem - avg_no_mem
        pct = (diff / avg_no_mem) * 100 if avg_no_mem > 0 else float("inf")
        direction = "more" if diff > 0 else "less"
        lines.append(
            f"  Difference: ${abs(diff):.4f}/session ({abs(pct):.1f}% {direction} with claude-mem)"
        )

    lines.append("")

    # --- Per-project paired comparison ---
    # Find projects that have BOTH claude-mem and non-claude-mem sessions
    lines.append("-" * 72)
    lines.append("PER-PROJECT COMPARISON (projects with both mem and no-mem sessions)")
    lines.append("-" * 72)

    paired_found = False
    for pid, project_rows in sorted(all_projects.items()):
        mem_rows = [r for r in project_rows if r["has_claude_mem"]]
        no_mem_rows = [r for r in project_rows if not r["has_claude_mem"]]
        if mem_rows and no_mem_rows:
            paired_found = True
            avg_m = sum(r["cost_dollars"] for r in mem_rows) / len(mem_rows)
            avg_n = sum(r["cost_dollars"] for r in no_mem_rows) / len(no_mem_rows)
            diff = avg_m - avg_n
            pct = (diff / avg_n) * 100 if avg_n > 0 else float("inf")
            direction = "more" if diff > 0 else "less"
            label = short_project_label(pid)
            lines.append(f"  {label}")
            lines.append(
                f"    mem: ${avg_m:.4f}/session ({len(mem_rows)} sessions)  |  "
                f"no-mem: ${avg_n:.4f}/session ({len(no_mem_rows)} sessions)"
            )
            lines.append(
                f"    Delta: ${abs(diff):.4f}/session ({abs(pct):.1f}% {direction} with claude-mem)"
            )
            lines.append("")

    if not paired_found:
        lines.append("  (No projects found with both claude-mem and non-claude-mem sessions)")
        lines.append("")

    # --- Headline finding ---
    lines.append("-" * 72)
    lines.append("HEADLINE FINDING")
    lines.append("-" * 72)

    # Calculate typical project size
    user_project_sizes = [len(v) for v in all_projects.values()]
    if user_project_sizes:
        median_size = sorted(user_project_sizes)[len(user_project_sizes) // 2]
    else:
        median_size = 0

    if mem_sessions and no_mem_sessions:
        # Recompute overall cohort percentage (the per-project loop may have
        # overwritten `pct` with the last paired project's value).
        overall_diff = avg_mem - avg_no_mem
        overall_pct = (overall_diff / avg_no_mem) * 100 if avg_no_mem > 0 else float("inf")
        if avg_mem > avg_no_mem:
            lines.append(
                f"  For a typical {median_size}-conversation project, claude-mem costs "
                f"approximately ${avg_mem:.4f} per session vs ${avg_no_mem:.4f} without "
                f"({abs(overall_pct):.1f}% more with claude-mem)."
            )
        elif avg_mem < avg_no_mem:
            lines.append(
                f"  For a typical {median_size}-conversation project, claude-mem costs "
                f"approximately ${avg_mem:.4f} per session vs ${avg_no_mem:.4f} without "
                f"({abs(overall_pct):.1f}% less with claude-mem)."
            )
        else:
            lines.append(
                f"  For a typical {median_size}-conversation project, claude-mem costs "
                f"are essentially identical at ~${avg_mem:.4f} per session."
            )
    else:
        lines.append("  Insufficient data for a paired comparison.")

    lines.append("")

    # --- Cost breakdown by model ---
    lines.append("-" * 72)
    lines.append("COST BREAKDOWN BY MODEL")
    lines.append("-" * 72)

    model_costs = defaultdict(lambda: {"total_cost": 0.0, "count": 0})
    for r in all_rows:
        m = r["model"]
        model_costs[m]["total_cost"] += r["cost_dollars"]
        model_costs[m]["count"] += 1

    for model_name, data in sorted(model_costs.items(), key=lambda x: -x[1]["total_cost"]):
        avg = data["total_cost"] / data["count"] if data["count"] else 0
        lines.append(
            f"  {model_name:35s}  ${data['total_cost']:8.2f} total | "
            f"${avg:.4f}/session | {data['count']} sessions"
        )

    lines.append("")
    lines.append("=" * 72)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Plot: cost trajectory
# ---------------------------------------------------------------------------
def compute_cohort_means(projects_by_mem_status, value_key):
    """Compute mean of value_key at each sequence_num for each cohort."""
    result = {}
    for has_mem, project_list in projects_by_mem_status.items():
        by_seq = defaultdict(list)
        for project_rows in project_list:
            for row in project_rows:
                by_seq[row["sequence_num"]].append(row[value_key])
        if not by_seq:
            continue
        sorted_seqs = sorted(by_seq.keys())
        means = [sum(by_seq[s]) / len(by_seq[s]) for s in sorted_seqs]
        result[has_mem] = (sorted_seqs, means)
    return result


def plot_cost_trajectory(user_projects, observer_session_count):
    """Plot per-session cost in dollars over sequence number."""
    fig, ax = plt.subplots(figsize=FIGURE_SIZE)

    cohort_projects = {True: [], False: []}
    for pid, project_rows in user_projects.items():
        majority_mem = project_majority_has_mem(project_rows)
        cohort_projects[majority_mem].append(project_rows)

        seqs = [r["sequence_num"] for r in project_rows]
        costs = [r["cost_dollars"] for r in project_rows]
        color = COLOR_WITH_MEM if majority_mem else COLOR_WITHOUT_MEM
        ax.plot(seqs, costs, color=color, alpha=INDIVIDUAL_ALPHA, linewidth=0.8)

    # Cohort means
    means = compute_cohort_means(
        {k: v for k, v in cohort_projects.items() if v}, "cost_dollars"
    )
    for has_mem, (seqs, mean_vals) in means.items():
        color = COLOR_WITH_MEM if has_mem else COLOR_WITHOUT_MEM
        label = "claude-mem (mean)" if has_mem else "no claude-mem (mean)"
        ax.plot(seqs, mean_vals, color=color, linewidth=MEAN_LINEWIDTH, label=label)

    ax.set_yscale("log")
    ax.set_xlabel("Conversation Sequence (#)", fontsize=FONT_SIZE_LABEL)
    ax.set_ylabel("Cost per Session (USD, log scale)", fontsize=FONT_SIZE_LABEL)
    ax.set_title("Per-Session Cost Over Time", fontsize=FONT_SIZE_TITLE)
    ax.tick_params(labelsize=FONT_SIZE_TICK)
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f"${x:.3f}"))
    ax.legend(fontsize=FONT_SIZE_LEGEND, loc="upper left")
    ax.grid(True, alpha=0.3, which="both")

    ax.annotate(
        f"Note: observer-sessions project ({observer_session_count:,} sessions) excluded.",
        xy=(0.5, -0.09), xycoords="axes fraction", ha="center",
        fontsize=8, color="#666666", style="italic",
    )

    fig.tight_layout(rect=[0, 0.03, 1, 1])
    out_path = RESULTS_DIR / "cost_trajectory.png"
    fig.savefig(out_path, dpi=DPI)
    plt.close(fig)
    return out_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f"Loading metrics from {CSV_PATH} ...")
    all_rows = load_metrics_with_cost()
    print(f"  {len(all_rows)} rows loaded (after excluding <synthetic>).")

    all_projects = split_by_project(all_rows)

    # Separate observer project
    observer_project_rows = []
    user_projects = {}
    for pid, project_rows in all_projects.items():
        if is_observer_project(pid):
            observer_project_rows = project_rows
            print(f"  Observer project: {pid} ({len(project_rows)} sessions)")
        else:
            user_projects[pid] = project_rows

    total_user_sessions = sum(len(v) for v in user_projects.values())
    print(f"  {len(user_projects)} user projects ({total_user_sessions} sessions)")
    print()

    # Generate summary
    summary_text = generate_cost_summary(user_projects, observer_project_rows)
    summary_path = RESULTS_DIR / "cost_summary.txt"
    with open(summary_path, "w") as fh:
        fh.write(summary_text + "\n")
    print(f"Saved {summary_path}")
    print()
    print(summary_text)
    print()

    # Generate cost trajectory plot
    observer_count = len(observer_project_rows)
    plot_path = plot_cost_trajectory(user_projects, observer_count)
    print(f"Saved {plot_path}")
    print()
    print("Done.")


if __name__ == "__main__":
    main()
