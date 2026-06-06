#!/usr/bin/env bash
set -uo pipefail

# child master plan-label   (one row per child)
read -r -d '' ROWS <<'EOF'
2766 2778 plan-01
2765 2778 plan-01
2722 2778 plan-01
2709 2778 plan-01
2707 2778 plan-01
2721 2778 plan-01
2776 2779 plan-02
2762 2779 plan-02
2757 2779 plan-02
2755 2779 plan-02
2716 2779 plan-02
2715 2779 plan-02
2714 2779 plan-02
2708 2779 plan-02
2706 2779 plan-02
2754 2780 plan-03
2747 2780 plan-03
2740 2780 plan-03
2726 2780 plan-03
2720 2780 plan-03
2703 2780 plan-03
2723 2781 plan-04
2772 2782 plan-09
2769 2782 plan-09
2767 2782 plan-09
2729 2782 plan-09
2705 2782 plan-09
2730 2783 plan-10
2758 2784 plan-11
2749 2784 plan-11
2738 2784 plan-11
2736 2785 plan-12
2711 2785 plan-12
2704 2785 plan-12
2702 2785 plan-12
2690 2785 plan-12
2645 2785 plan-12
2566 2785 plan-12
2522 2785 plan-12
2513 2785 plan-12
2498 2785 plan-12
2467 2785 plan-12
2463 2785 plan-12
2423 2785 plan-12
2418 2785 plan-12
2773 2786 plan-13
2750 2786 plan-13
EOF

ok=0; fail=0
while read -r child master plan; do
  [ -z "$child" ] && continue
  comment="Consolidating into #${master} (${plan}). The root cause and fix sequencing are tracked there alongside the rest of the cluster — please follow that issue for progress."
  if gh issue comment "$child" --body "$comment" >/dev/null 2>&1 \
     && gh issue close "$child" --reason "not planned" >/dev/null 2>&1; then
    echo "OK   #$child -> #$master ($plan)"
    ok=$((ok+1))
  else
    echo "FAIL #$child -> #$master ($plan)"
    fail=$((fail+1))
  fi
done <<< "$ROWS"

echo ""
echo "Closed OK: $ok  Failed: $fail"
