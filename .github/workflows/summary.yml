name: Summarize new issues

on:
  issues:
    types: [opened]

jobs:
  summary:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      models: read
      contents: read

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Run AI inference
        id: inference
        uses: actions/ai-inference@v1
        with:
          prompt: |
            Summarize the following GitHub issue in one paragraph:
            Title: ${{ github.event.issue.title }}
            Body: ${{ github.event.issue.body }}

      - name: Comment with AI summary
        run: |
          gh issue comment $ISSUE_NUMBER --body '${{ steps.inference.outputs.response }}'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          RESPONSE: ${{ steps.inference.outputs.response }}
