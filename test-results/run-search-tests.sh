#!/bin/bash

# Comprehensive Search API Test Suite
# Tests all endpoints and parameter combinations

API_URL="http://localhost:37777"
RESULTS_DIR="test-results"

echo "🔍 Starting comprehensive search API tests..."
echo ""

# SEMANTIC QUERIES - Understanding how things work
echo "📚 Running semantic queries..."
curl -s "$API_URL/api/search?type=observations&query=worker%20service%20startup&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-01-worker-service-startup.json"
curl -s "$API_URL/api/search?type=observations&query=SQLite%20FTS5%20implementation&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-02-sqlite-fts5-implementation.json"
curl -s "$API_URL/api/search?type=observations&query=hook%20lifecycle%20flow&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-03-hook-lifecycle-flow.json"
curl -s "$API_URL/api/search?type=observations&query=build%20pipeline%20process&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-04-build-pipeline-process.json"
echo "✅ Semantic queries complete (4 tests)"

# DECISION QUERIES - Architectural choices
echo "⚖️  Running decision queries..."
curl -s "$API_URL/api/search?type=observations&obs_type=decision&query=PM2%20instead%20of%20direct%20process&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-05-pm2-decision.json"
curl -s "$API_URL/api/search?type=observations&obs_type=decision&query=search%20architecture%20guidelines&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-06-search-architecture-decision.json"
curl -s "$API_URL/api/search?type=observations&obs_type=decision&query=MCP%20as%20DRY%20source&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-07-mcp-dry-decision.json"
echo "✅ Decision queries complete (3 tests)"

# TROUBLESHOOTING QUERIES - Finding bugfixes
echo "🔴 Running troubleshooting queries..."
curl -s "$API_URL/api/search?type=observations&obs_type=bugfix&query=worker%20service%20debugging&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-08-worker-debugging.json"
curl -s "$API_URL/api/search?type=observations&query=hook%20timeout%20problems&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-09-hook-timeout.json"
curl -s "$API_URL/api/search?type=observations&query=database%20migration%20issues&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-10-database-migration.json"
echo "✅ Troubleshooting queries complete (3 tests)"

# FILE-SPECIFIC QUERIES - Tracking file changes
echo "📁 Running file-specific queries..."
curl -s "$API_URL/api/search?type=observations&files=search-server.ts&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-11-search-server-changes.json"
curl -s "$API_URL/api/search?type=observations&files=context-hook&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-12-context-hook-changes.json"
curl -s "$API_URL/api/search?type=observations&files=worker-service&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-13-worker-service-changes.json"
echo "✅ File-specific queries complete (3 tests)"

# CONCEPT-BASED QUERIES - Patterns, gotchas, discoveries
echo "🏷️  Running concept-based queries..."
curl -s "$API_URL/api/search?type=observations&concepts=pattern&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-14-patterns.json"
curl -s "$API_URL/api/search?type=observations&concepts=gotcha&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-15-gotchas.json"
curl -s "$API_URL/api/search?type=observations&concepts=discovery&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-16-discoveries.json"
echo "✅ Concept-based queries complete (3 tests)"

# TYPE-FILTERED QUERIES - Bugfixes, features, decisions
echo "🔖 Running type-filtered queries..."
curl -s "$API_URL/api/search?type=observations&obs_type=bugfix&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-17-all-bugfixes.json"
curl -s "$API_URL/api/search?type=observations&obs_type=feature&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-18-all-features.json"
curl -s "$API_URL/api/search?type=observations&obs_type=decision&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-19-all-decisions.json"
echo "✅ Type-filtered queries complete (3 tests)"

# SESSION QUERIES - Testing session search
echo "📝 Running session queries..."
curl -s "$API_URL/api/search?type=sessions&query=search%20architecture&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-20-session-search.json"
echo "✅ Session queries complete (1 test)"

# USER PROMPT QUERIES - Testing prompt search
echo "💬 Running user prompt queries..."
curl -s "$API_URL/api/search?type=prompts&query=build%20and%20deploy&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-21-prompt-search.json"
echo "✅ User prompt queries complete (1 test)"

# DEDICATED ENDPOINTS - Timeline and semantic shortcuts
echo "🎯 Running dedicated endpoint tests..."
curl -s "$API_URL/api/decisions?format=full&limit=5" > "$RESULTS_DIR/test-22-decisions-endpoint.json"
curl -s "$API_URL/api/changes?format=full&limit=5" > "$RESULTS_DIR/test-23-changes-endpoint.json"
curl -s "$API_URL/api/how-it-works?format=full&limit=5" > "$RESULTS_DIR/test-24-how-it-works-endpoint.json"
curl -s "$API_URL/api/contextualize?format=full" > "$RESULTS_DIR/test-25-contextualize-endpoint.json"
echo "✅ Dedicated endpoint tests complete (4 tests)"

# TIMELINE QUERY - Get context around a specific observation
echo "⏱️  Running timeline query..."
curl -s "$API_URL/api/timeline?anchor=10630&depth_before=3&depth_after=3&format=full" > "$RESULTS_DIR/test-26-timeline-around-observation.json"
echo "✅ Timeline query complete (1 test)"

# MULTI-PARAMETER COMBO - Test complex query combinations
echo "🎛️  Running multi-parameter combination tests..."
curl -s "$API_URL/api/search?type=observations&obs_type=decision&concepts=pattern&query=search&format=full&limit=5&orderBy=relevance" > "$RESULTS_DIR/test-27-multi-param-combo.json"
curl -s "$API_URL/api/search?type=observations&files=search-server&obs_type=feature&format=full&limit=5&orderBy=date_desc" > "$RESULTS_DIR/test-28-file-type-combo.json"
echo "✅ Multi-parameter tests complete (2 tests)"

echo ""
echo "✨ All tests complete! 28 total queries executed."
echo "📊 Results saved to $RESULTS_DIR/"
