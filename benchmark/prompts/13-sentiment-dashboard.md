---
id: "13-sentiment-dashboard"
title: "Sentiment Analysis Dashboard"
category: data
timeout_hint: "4h"
industry_baseline:
  source: none
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "homepage_loads"
    command: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
    expected: "status:200"
  - name: "upload_csv"
    command: "echo 'text,rating,date\n\"Great product!\",5,2024-01-15\n\"Terrible service\",1,2024-01-16' > /tmp/reviews.csv && curl -s -X POST http://localhost:3000/upload -F 'file=@/tmp/reviews.csv'"
    expected: "contains:sentiment"
---

# Sentiment Analysis Dashboard

Build a web application where users upload CSV files containing text reviews/feedback and see a dashboard with sentiment analysis scores, filters, and visualizations.

## Requirements

### Core Features
1. **CSV Upload**: Upload a CSV file with text content, optional rating, and optional date columns
2. **Sentiment Scoring**: Analyze each text entry and assign a sentiment score (positive/neutral/negative) using keyword-based or rule-based analysis (no external API required)
3. **Dashboard View**: Display:
   - Overall sentiment distribution (pie/donut chart)
   - Sentiment over time (line chart, if dates present)
   - Average sentiment score
   - Word cloud or top keywords by sentiment
4. **Filtering**: Filter by sentiment category, date range, and rating value
5. **Individual Results**: Click on a row to see the full text and its sentiment breakdown

### Technical Requirements
- Serves on **port 3000**
- Node.js backend
- Sentiment analysis: use a keyword/lexicon-based approach (e.g., AFINN lexicon, or a simple positive/negative word list). No external APIs.
- Charts rendered server-side (SVG) or client-side (Chart.js, D3, etc.)
- Handle CSVs up to 10,000 rows

### API Endpoints
- `GET /` — Dashboard page (with upload form if no data loaded)
- `POST /upload` — Upload CSV file
- `GET /results` — Get sentiment analysis results (JSON)
- `GET /results?sentiment=positive&from=2024-01-01&to=2024-03-01` — Filtered results
- `GET /stats` — Aggregate statistics

### Expected CSV Format
```csv
text,rating,date
"This product is amazing!",5,2024-01-15
"Worst experience ever",1,2024-01-16
"It was okay, nothing special",3,2024-01-17
```

Columns `rating` and `date` are optional. The `text` column is required.

### Sentiment Analysis Approach
- Positive words: "great", "amazing", "excellent", "love", "wonderful", "fantastic", "good", "best", etc.
- Negative words: "terrible", "awful", "worst", "hate", "horrible", "bad", "poor", "disappointing", etc.
- Score = (positive word count - negative word count) / total words, normalized to -1 to +1 range
- Classification: score > 0.05 = positive, score < -0.05 = negative, else neutral

## Testable Deliverables
- Server starts on port 3000
- CSV upload is accepted and parsed
- Sentiment scores are assigned to each text entry
- Dashboard shows charts and statistics
- Filters narrow results correctly
- Handles CSVs without rating/date columns gracefully
