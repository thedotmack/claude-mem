---
id: "15-text-similarity"
title: "Text Similarity Analyzer"
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
---

# Text Similarity Analyzer

Build a web application where users upload multiple text documents and see a visual similarity matrix showing how similar each pair of documents is. Clicking a pair shows a detailed side-by-side comparison.

## Requirements

### Core Features
1. **Document Upload**: Upload multiple text files (plain text, .txt) at once or add them one by one
2. **Similarity Calculation**: Compute pairwise similarity between all uploaded documents using TF-IDF cosine similarity or Jaccard similarity
3. **Similarity Matrix**: Display an interactive heatmap/matrix where each cell shows the similarity score (0.0 to 1.0) between two documents
4. **Pair Comparison**: Click a cell in the matrix to see a side-by-side view of the two documents with shared terms highlighted
5. **Top Similar Pairs**: List the most similar document pairs ranked by score
6. **Document Preview**: Click any document name to see its full content

### Technical Requirements
- Serves on **port 3000**
- Node.js backend
- TF-IDF implementation can be from scratch or using a library (natural, compromise, etc.)
- Similarity scores computed server-side
- Frontend: interactive matrix visualization (HTML table with color coding, or Canvas/SVG heatmap)
- Handle up to 50 documents of up to 10,000 words each

### API Endpoints
- `GET /` — Upload page and dashboard
- `POST /upload` — Upload one or more text documents
- `GET /documents` — List uploaded documents with metadata (name, word count)
- `GET /documents/:id` — Get full document content
- `GET /similarity` — Get full similarity matrix as JSON
- `GET /similarity/:id1/:id2` — Get detailed comparison between two documents

### Similarity Algorithm
1. **Tokenize** each document (lowercase, remove punctuation, split on whitespace)
2. **Remove stop words** (the, a, an, is, are, etc.)
3. **Compute TF-IDF vectors** for each document
4. **Calculate cosine similarity** between each pair of TF-IDF vectors
5. Score ranges from 0.0 (completely different) to 1.0 (identical)

### Comparison View
When comparing two documents side by side:
- Highlight words/phrases that appear in both documents
- Show the similarity score prominently
- Display shared top terms with their TF-IDF weights

## Testable Deliverables
- Server starts on port 3000
- Documents can be uploaded via the web interface
- Similarity matrix displays with correct scores
- Clicking a cell shows side-by-side comparison
- Identical documents show similarity of 1.0
- Completely different documents show near-zero similarity
