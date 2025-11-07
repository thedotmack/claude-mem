# Plan: Display Complete Observation Data in Viewer UI

## Current State Analysis

### What's Currently Shown (5 fields)
- ✅ **type** - Displayed as chip/badge (e.g., "discovery", "bugfix")
- ✅ **project** - Shown in card header
- ✅ **title** - Main card title (shows "Untitled" if null)
- ✅ **subtitle** - Optional subheading
- ✅ **id + created_at** - Metadata line (e.g., "#1 • 2 hours ago")

### What's Hidden (10+ fields)
- ❌ **narrative** - Detailed explanation text (MOST IMPORTANT)
- ❌ **facts** - JSON array of key facts (structured bullet points)
- ❌ **concepts** - JSON array of concept tags (e.g., "problem-solution", "gotcha")
- ❌ **files_read** - JSON array of file paths that were read
- ❌ **files_modified** - JSON array of file paths that were modified
- ❌ **text** - Legacy unstructured text field (deprecated but still populated)
- ❌ **prompt_number** - Which user prompt triggered this observation
- ❌ **sdk_session_id** - Session identifier

### Database Schema (Actual Structure)

```sql
observations table:
- id (INTEGER PRIMARY KEY)
- sdk_session_id (TEXT)
- project (TEXT)
- type (TEXT: decision, bugfix, feature, refactor, discovery, change)
- created_at (TEXT ISO timestamp)
- created_at_epoch (INTEGER milliseconds)
- prompt_number (INTEGER nullable)
- title (TEXT nullable)
- subtitle (TEXT nullable)
- narrative (TEXT nullable) -- Rich detailed explanation
- text (TEXT nullable) -- Legacy field
- facts (TEXT nullable) -- JSON array of key facts
- concepts (TEXT nullable) -- JSON array of concept tags
- files_read (TEXT nullable) -- JSON array of file paths
- files_modified (TEXT nullable) -- JSON array of file paths
```

### Issues Found

1. **Type Definition Mismatch**: Three different type definitions exist:
   - Actual database schema (most complete)
   - `worker-types.ts` Observation interface (flattened, has wrong field names)
   - `viewer/types.ts` Observation interface (minimal subset)

2. **Data Loss**: Rich fields are stored in DB but not transmitted to UI:
   - narrative, facts, files_read, files_modified all missing from API

3. **PaginationHelper Query Bug**: Selects non-existent fields:
   - `session_db_id` (should be `sdk_session_id`)
   - `claude_session_id` (doesn't exist in observations table)
   - `files` (should be `files_read` + `files_modified`)

## Proposed Implementation Plan

### Phase 1: Fix Data Layer

#### 1.1 Update Viewer Type Definitions
**File**: `src/ui/viewer/types.ts`

```typescript
export interface Observation {
  id: number;
  sdk_session_id: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;          // NEW - detailed explanation
  text: string | null;               // Legacy field
  facts: string | null;              // NEW - JSON array of key facts
  concepts: string | null;           // NEW - JSON array of concept tags
  files_read: string | null;         // NEW - JSON array of file paths
  files_modified: string | null;     // NEW - JSON array of file paths
  prompt_number: number | null;      // NEW - which prompt triggered this
  created_at: string;
  created_at_epoch: number;
}
```

#### 1.2 Fix PaginationHelper SQL Query
**File**: `src/services/worker/PaginationHelper.ts` (around line 26)

**Current (BROKEN)**:
```typescript
const fields = 'id, session_db_id, claude_session_id, project, type, title, subtitle, text, concepts, files, prompt_number, created_at, created_at_epoch';
```

**Fixed**:
```typescript
const fields = 'id, sdk_session_id, project, type, title, subtitle, narrative, text, facts, concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch';
```

#### 1.3 Update Worker Service v2 Response Mapping
**File**: `src/services/worker-service-v2.ts`

Ensure the `/api/observations` endpoint properly maps all fields from database to response. May need to parse JSON fields (facts, concepts, files_read, files_modified) if they're stored as JSON strings.

### Phase 2: Redesign UI Component

#### 2.1 Update ObservationCard Component
**File**: `src/ui/viewer/components/ObservationCard.tsx`

**New Structure**:
```
┌─────────────────────────────────────────┐
│ [type badge]              [project]     │  ← Header (always visible)
├─────────────────────────────────────────┤
│ Title                                   │  ← Always visible
│ Subtitle (if present)                   │  ← Always visible
│ #123 • 2 hours ago              [▼ More]│  ← Metadata + Expand button
├─────────────────────────────────────────┤
│                                         │
│ ┌─ EXPANDED CONTENT (when opened) ───┐ │
│ │                                     │ │
│ │ 📝 Narrative                        │ │
│ │ ─────────────────────────────────── │ │
│ │ Detailed explanation text...        │ │
│ │                                     │ │
│ │ 📌 Key Facts                        │ │
│ │ ─────────────────────────────────── │ │
│ │ • Fact 1                            │ │
│ │ • Fact 2                            │ │
│ │ • Fact 3                            │ │
│ │                                     │ │
│ │ 🏷️ Concepts                          │ │
│ │ ─────────────────────────────────── │ │
│ │ [problem-solution] [discovery]      │ │
│ │                                     │ │
│ │ 📁 Files                            │ │
│ │ ─────────────────────────────────── │ │
│ │ 📖 Read:                            │ │
│ │    src/hooks/save-hook.ts           │ │
│ │    src/services/worker.ts           │ │
│ │ ✏️ Modified:                         │ │
│ │    src/hooks/save-hook.ts           │ │
│ │                                     │ │
│ │ 🔗 Session Info                     │ │
│ │ ─────────────────────────────────── │ │
│ │ Prompt #5 • Session: abc123...      │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

**Component Logic**:
```typescript
const ObservationCard = ({ observation }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Parse JSON fields
  const facts = observation.facts ? JSON.parse(observation.facts) : [];
  const concepts = observation.concepts ? JSON.parse(observation.concepts) : [];
  const filesRead = observation.files_read ? JSON.parse(observation.files_read) : [];
  const filesModified = observation.files_modified ? JSON.parse(observation.files_modified) : [];

  return (
    <div className={`card ${isExpanded ? 'card-expanded' : ''}`}>
      {/* Header - always visible */}
      <div className="card-header">
        <span className={`card-type type-${observation.type}`}>
          {observation.type}
        </span>
        <span className="card-project">{observation.project}</span>
      </div>

      {/* Title/Subtitle - always visible */}
      <div className="card-title">{observation.title || 'Untitled'}</div>
      {observation.subtitle && (
        <div className="card-subtitle">{observation.subtitle}</div>
      )}

      {/* Metadata + Expand button - always visible */}
      <div className="card-meta">
        <span>#{observation.id} • {formatDate(observation.created_at_epoch)}</span>
        <button
          className="expand-toggle"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? '▲ Less' : '▼ More'}
        </button>
      </div>

      {/* Expanded content - conditional */}
      {isExpanded && (
        <div className="card-expanded-content">

          {/* Narrative Section */}
          {observation.narrative && (
            <div className="card-section">
              <div className="section-header">📝 Narrative</div>
              <div className="section-content narrative">
                {observation.narrative}
              </div>
            </div>
          )}

          {/* Facts Section */}
          {facts.length > 0 && (
            <div className="card-section">
              <div className="section-header">📌 Key Facts</div>
              <ul className="section-content facts-list">
                {facts.map((fact, i) => (
                  <li key={i}>{fact}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Concepts Section */}
          {concepts.length > 0 && (
            <div className="card-section">
              <div className="section-header">🏷️ Concepts</div>
              <div className="section-content concepts">
                {concepts.map((concept, i) => (
                  <span key={i} className="concept-tag">{concept}</span>
                ))}
              </div>
            </div>
          )}

          {/* Files Section */}
          {(filesRead.length > 0 || filesModified.length > 0) && (
            <div className="card-section">
              <div className="section-header">📁 Files</div>
              <div className="section-content files">
                {filesRead.length > 0 && (
                  <div className="file-group">
                    <div className="file-group-label">📖 Read:</div>
                    {filesRead.map((file, i) => (
                      <div key={i} className="file-path">{file}</div>
                    ))}
                  </div>
                )}
                {filesModified.length > 0 && (
                  <div className="file-group">
                    <div className="file-group-label">✏️ Modified:</div>
                    {filesModified.map((file, i) => (
                      <div key={i} className="file-path">{file}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Session Info Section */}
          <div className="card-section">
            <div className="section-header">🔗 Session Info</div>
            <div className="section-content session-info">
              {observation.prompt_number && (
                <span>Prompt #{observation.prompt_number}</span>
              )}
              {observation.sdk_session_id && (
                <span className="session-id">
                  Session: {observation.sdk_session_id.substring(0, 8)}...
                </span>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
};
```

### Phase 3: Style Enhancements

#### 3.1 Update Styles
**File**: `src/ui/viewer/styles.css`

**New CSS Classes Needed**:
```css
/* Expanded card state */
.card-expanded {
  /* Maybe increase shadow or border when expanded */
}

/* Expand toggle button */
.expand-toggle {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}
.expand-toggle:hover {
  background: var(--bg-secondary);
}

/* Expanded content container */
.card-expanded-content {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
  animation: expandDown 0.2s ease-out;
}

@keyframes expandDown {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Section styling */
.card-section {
  margin-bottom: 16px;
}
.card-section:last-child {
  margin-bottom: 0;
}

.section-header {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-content {
  padding-left: 20px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

/* Narrative styling */
.narrative {
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-wrap: break-word;
}

/* Facts list styling */
.facts-list {
  list-style: disc;
  margin: 0;
  padding-left: 20px;
}
.facts-list li {
  margin-bottom: 4px;
}

/* Concepts tags */
.concepts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.concept-tag {
  background: var(--accent-bg);
  color: var(--accent-text);
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
}

/* File paths */
.file-group {
  margin-bottom: 8px;
}
.file-group:last-child {
  margin-bottom: 0;
}
.file-group-label {
  font-weight: 500;
  margin-bottom: 4px;
  color: var(--text-primary);
}
.file-path {
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  padding: 4px 8px;
  background: var(--code-bg);
  border-radius: 4px;
  margin-bottom: 2px;
  overflow-x: auto;
  white-space: nowrap;
}

/* Session info */
.session-info {
  display: flex;
  gap: 16px;
  font-size: 12px;
}
.session-id {
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  color: var(--text-tertiary);
}
```

## Implementation Steps (In Order)

1. **Fix PaginationHelper query** (src/services/worker/PaginationHelper.ts)
   - Update SQL SELECT to use correct field names
   - Test with `npm run worker:restart:v2`

2. **Update viewer type definitions** (src/ui/viewer/types.ts)
   - Add all missing fields to Observation interface

3. **Verify worker service v2 mapping** (src/services/worker-service-v2.ts)
   - Ensure `/api/observations` returns all fields
   - Test API response with curl or browser

4. **Update ObservationCard component** (src/ui/viewer/components/ObservationCard.tsx)
   - Add expand/collapse state
   - Add all new sections (narrative, facts, concepts, files, session)
   - Add expand toggle button

5. **Update styles** (src/ui/viewer/styles.css)
   - Add all new CSS classes for expanded content
   - Add animations for smooth expand/collapse
   - Style sections, lists, tags, file paths

6. **Build and test**
   ```bash
   npm run build
   npm run sync-marketplace
   npm run worker:restart:v2
   ```

7. **Manual testing**
   - Open http://localhost:37777
   - Click expand button on observations
   - Verify all fields display correctly
   - Test light/dark mode
   - Test with observations that have missing fields (graceful fallback)

## Success Criteria

- [ ] All database fields are fetched in API query
- [ ] All fields are properly typed in TypeScript interfaces
- [ ] ObservationCard shows all data in expanded view
- [ ] Expand/collapse animations work smoothly
- [ ] File paths are formatted in monospace font
- [ ] Concepts display as tag pills
- [ ] Facts display as bulleted list
- [ ] Narrative text wraps properly with scroll for long content
- [ ] No console errors
- [ ] Works in both light and dark themes

## Optional Enhancements (Future)

- [ ] Remember expanded state in localStorage (persist across page refresh)
- [ ] Keyboard shortcuts (Space to expand/collapse focused card)
- [ ] Click file paths to copy to clipboard
- [ ] Search/filter by concepts or files
- [ ] Syntax highlighting for code in narrative
- [ ] Link session_id to session detail view
