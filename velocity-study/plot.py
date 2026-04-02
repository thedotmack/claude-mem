#!/usr/bin/env python3
"""
Token Velocity Study — Visualization

Generates 3 publication-quality plots from metrics.csv:
  1. token_trajectory.png   — Token usage per conversation over sequence
  2. context_utilization.png — Context window utilization over sequence
  3. cumulative_tokens.png  — Cumulative token consumption (breakeven)

Usage:
    python velocity-study/plot.py
"""

import csv
import os
import sys
from collections import defaultdict
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")  # non-interactive backend for saving files
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

# The observer-sessions project is the claude-mem tool itself, not a user
# project.  It has 1010 sessions and would dominate every plot, so we
# exclude it from the main visualisations and note its existence instead.
OBSERVER_PROJECT_SUBSTRING = "observer-sessions"

# ---------------------------------------------------------------------------
# Styling constants
# ---------------------------------------------------------------------------
COLOR_WITH_MEM = "#1f77b4"       # matplotlib default blue
COLOR_WITHOUT_MEM = "#999999"    # neutral gray
INDIVIDUAL_ALPHA = 0.25
MEAN_LINEWIDTH = 2.5
FIGURE_SIZE = (12, 7)
DPI = 150
FONT_SIZE_TITLE = 15
FONT_SIZE_LABEL = 12
FONT_SIZE_LEGEND = 10
FONT_SIZE_TICK = 10


def load_metrics():
    """Load CSV into a list of dicts with numeric conversions."""
    with open(CSV_PATH, newline="") as fh:
        reader = csv.DictReader(fh)
        rows = []
        for row in reader:
            row["sequence_num"] = int(row["sequence_num"])
            row["total_api_tokens"] = int(row["total_api_tokens"])
            row["context_utilization"] = float(row["context_utilization"])
            row["observation_count"] = int(row["observation_count"])
            row["has_claude_mem"] = row["has_claude_mem"].strip().lower() == "true"
            rows.append(row)
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
    """Return True if the majority of sessions in the project have claude-mem."""
    mem_count = sum(1 for r in project_rows if r["has_claude_mem"])
    return mem_count > len(project_rows) / 2


def short_project_label(project_id):
    """Shorten long path-style project IDs for legend readability."""
    parts = project_id.strip("-").split("-")
    # Take the last meaningful segments
    if len(parts) > 3:
        return ".../" + "-".join(parts[-3:])
    return project_id


def compute_cohort_means(projects_by_mem_status, value_key):
    """
    For each cohort (True/False), compute mean of `value_key` at each
    sequence_num across all projects in the cohort.

    Returns dict: bool -> (list_of_seq_nums, list_of_means)
    """
    result = {}
    for has_mem, project_list in projects_by_mem_status.items():
        # Gather all (seq, value) pairs grouped by sequence number
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


# ---------------------------------------------------------------------------
# Plot 1: Token trajectory
# ---------------------------------------------------------------------------
def plot_token_trajectory(projects, observer_session_count):
    fig, ax = plt.subplots(figsize=FIGURE_SIZE)

    # Group projects by majority mem status for cohort means
    cohort_projects = {True: [], False: []}
    for pid, project_rows in projects.items():
        majority_mem = project_majority_has_mem(project_rows)
        cohort_projects[majority_mem].append(project_rows)

        # Individual project trajectory (color each row by its own mem status)
        seqs = [r["sequence_num"] for r in project_rows]
        vals = [r["total_api_tokens"] for r in project_rows]
        # Use the project's majority status for the line color
        color = COLOR_WITH_MEM if majority_mem else COLOR_WITHOUT_MEM
        ax.plot(seqs, vals, color=color, alpha=INDIVIDUAL_ALPHA, linewidth=0.8)

    # Cohort means
    means = compute_cohort_means(
        {k: v for k, v in cohort_projects.items() if v}, "total_api_tokens"
    )
    for has_mem, (seqs, mean_vals) in means.items():
        color = COLOR_WITH_MEM if has_mem else COLOR_WITHOUT_MEM
        label = "claude-mem (mean)" if has_mem else "no claude-mem (mean)"
        ax.plot(seqs, mean_vals, color=color, linewidth=MEAN_LINEWIDTH, label=label)

    ax.set_yscale("log")
    ax.set_xlabel("Conversation Sequence (#)", fontsize=FONT_SIZE_LABEL)
    ax.set_ylabel("Total API Tokens (log scale)", fontsize=FONT_SIZE_LABEL)
    ax.set_title("Token Usage Per Conversation Over Time", fontsize=FONT_SIZE_TITLE)
    ax.tick_params(labelsize=FONT_SIZE_TICK)
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f"{x:,.0f}"))
    ax.legend(fontsize=FONT_SIZE_LEGEND, loc="upper left")
    ax.grid(True, alpha=0.3, which="both")

    # Footnote about excluded observer project
    ax.annotate(
        f"Note: observer-sessions project ({observer_session_count:,} sessions, no claude-mem) excluded — it is the claude-mem tool itself.",
        xy=(0.5, -0.09), xycoords="axes fraction", ha="center",
        fontsize=8, color="#666666", style="italic",
    )

    fig.tight_layout(rect=[0, 0.03, 1, 1])
    out_path = RESULTS_DIR / "token_trajectory.png"
    fig.savefig(out_path, dpi=DPI)
    plt.close(fig)
    return out_path


# ---------------------------------------------------------------------------
# Plot 2: Context utilization
# ---------------------------------------------------------------------------
def plot_context_utilization(projects, observer_session_count):
    fig, ax = plt.subplots(figsize=FIGURE_SIZE)

    cohort_projects = {True: [], False: []}
    for pid, project_rows in projects.items():
        majority_mem = project_majority_has_mem(project_rows)
        cohort_projects[majority_mem].append(project_rows)

        seqs = [r["sequence_num"] for r in project_rows]
        vals = [r["context_utilization"] for r in project_rows]
        color = COLOR_WITH_MEM if majority_mem else COLOR_WITHOUT_MEM
        ax.plot(seqs, vals, color=color, alpha=INDIVIDUAL_ALPHA, linewidth=0.8)

    means = compute_cohort_means(
        {k: v for k, v in cohort_projects.items() if v}, "context_utilization"
    )
    for has_mem, (seqs, mean_vals) in means.items():
        color = COLOR_WITH_MEM if has_mem else COLOR_WITHOUT_MEM
        label = "claude-mem (mean)" if has_mem else "no claude-mem (mean)"
        ax.plot(seqs, mean_vals, color=color, linewidth=MEAN_LINEWIDTH, label=label)

    ax.set_ylim(-0.02, 1.02)
    ax.set_xlabel("Conversation Sequence (#)", fontsize=FONT_SIZE_LABEL)
    ax.set_ylabel("Context Utilization (0.0 – 1.0)", fontsize=FONT_SIZE_LABEL)
    ax.set_title("Context Window Utilization Over Time", fontsize=FONT_SIZE_TITLE)
    ax.tick_params(labelsize=FONT_SIZE_TICK)
    ax.yaxis.set_major_formatter(ticker.PercentFormatter(xmax=1.0))
    ax.legend(fontsize=FONT_SIZE_LEGEND, loc="upper left")
    ax.grid(True, alpha=0.3)

    ax.annotate(
        f"Note: observer-sessions project ({observer_session_count:,} sessions, no claude-mem) excluded — it is the claude-mem tool itself.",
        xy=(0.5, -0.09), xycoords="axes fraction", ha="center",
        fontsize=8, color="#666666", style="italic",
    )

    fig.tight_layout(rect=[0, 0.03, 1, 1])
    out_path = RESULTS_DIR / "context_utilization.png"
    fig.savefig(out_path, dpi=DPI)
    plt.close(fig)
    return out_path


# ---------------------------------------------------------------------------
# Plot 3: Cumulative tokens (breakeven analysis)
# ---------------------------------------------------------------------------
def plot_cumulative_tokens(projects, observer_session_count):
    fig, ax = plt.subplots(figsize=FIGURE_SIZE)

    for pid, project_rows in projects.items():
        majority_mem = project_majority_has_mem(project_rows)
        color = COLOR_WITH_MEM if majority_mem else COLOR_WITHOUT_MEM

        seqs = [r["sequence_num"] for r in project_rows]
        cumulative = []
        running_total = 0
        for row in project_rows:
            running_total += row["total_api_tokens"]
            cumulative.append(running_total)

        label_prefix = "mem" if majority_mem else "no-mem"
        label = f"{label_prefix}: {short_project_label(pid)}"
        ax.plot(
            seqs, cumulative, color=color, alpha=0.7, linewidth=1.4,
            label=label, marker="o", markersize=2,
        )

    ax.set_yscale("log")
    ax.set_xlabel("Conversation Sequence (#)", fontsize=FONT_SIZE_LABEL)
    ax.set_ylabel("Cumulative Total API Tokens (log scale)", fontsize=FONT_SIZE_LABEL)
    ax.set_title("Cumulative Token Consumption by Project", fontsize=FONT_SIZE_TITLE)
    ax.tick_params(labelsize=FONT_SIZE_TICK)
    ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f"{x:,.0f}"))

    # Put legend outside plot area to avoid clutter with many projects
    ax.legend(
        fontsize=8, loc="upper left", framealpha=0.9,
        borderpad=0.5, labelspacing=0.3,
    )
    ax.grid(True, alpha=0.3, which="both")

    ax.annotate(
        f"Note: observer-sessions project ({observer_session_count:,} sessions, no claude-mem) excluded — it is the claude-mem tool itself.",
        xy=(0.5, -0.09), xycoords="axes fraction", ha="center",
        fontsize=8, color="#666666", style="italic",
    )

    fig.tight_layout(rect=[0, 0.03, 1, 1])
    out_path = RESULTS_DIR / "cumulative_tokens.png"
    fig.savefig(out_path, dpi=DPI)
    plt.close(fig)
    return out_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f"Loading metrics from {CSV_PATH} ...")
    all_rows = load_metrics()
    print(f"  {len(all_rows)} rows loaded.")

    all_projects = split_by_project(all_rows)

    # Separate observer project
    observer_session_count = 0
    user_projects = {}
    for pid, project_rows in all_projects.items():
        if is_observer_project(pid):
            observer_session_count = len(project_rows)
            print(f"  Excluding observer project: {pid} ({observer_session_count} sessions)")
        else:
            user_projects[pid] = project_rows

    print(f"  {len(user_projects)} user projects remaining ({sum(len(v) for v in user_projects.values())} sessions)")
    print()

    # Generate plots
    path1 = plot_token_trajectory(user_projects, observer_session_count)
    print(f"  [1/3] Saved {path1}")

    path2 = plot_context_utilization(user_projects, observer_session_count)
    print(f"  [2/3] Saved {path2}")

    path3 = plot_cumulative_tokens(user_projects, observer_session_count)
    print(f"  [3/3] Saved {path3}")

    print()
    print("Done. All plots saved to velocity-study/results/")


if __name__ == "__main__":
    main()
