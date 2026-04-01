# Calibration Set

This directory will contain hand-scored example projects for LLM judge calibration.

## Structure

Each subdirectory is a calibration project:
```
calibration/
├── example-project-1/
│   ├── human-scores.json    # Human-assigned 4-dimension scores
│   ├── src/                 # Project source files
│   └── README.md           # Project description
└── example-project-2/
    └── ...
```

## human-scores.json format

```json
{
  "functionality": 7,
  "code_quality": 5,
  "ux": 6,
  "completeness": 7,
  "reasoning": {
    "functionality": "All core features work, minor edge case bugs",
    "code_quality": "Clean code, follows conventions, lacks tests",
    "ux": "Polished but some rough transitions",
    "completeness": "~90% of spec implemented"
  }
}
```

## Process

1. Phase 1 runs produce the first agent projects
2. Human reviewer scores 10-20 projects using the rubric
3. Calibration framework validates LLM judge against human scores
4. Must achieve >= 75% agreement before Phase 2 evaluation
