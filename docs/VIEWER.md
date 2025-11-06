# Viewer UI - Web-Based Memory Stream Visualization

## Overview

The Claude-Mem Viewer UI is a production-ready web interface that provides real-time visualization of your memory stream. Access it at **http://localhost:37777** while the claude-mem worker is running.

**Key Features:**
- 🔴 **Real-time Updates** - Server-Sent Events (SSE) stream new observations, sessions, and prompts instantly
- 📜 **Infinite Scroll** - Load historical data progressively with automatic pagination
- 🎯 **Project Filtering** - Focus on specific codebases with smart project selection
- 🎨 **Theme Toggle** - Light, dark, or system preference with persistent settings
- 💾 **Settings Persistence** - Sidebar state and project filters saved automatically
- 🔄 **Auto-Reconnection** - Exponential backoff ensures connection stability
- ⚡ **GPU Acceleration** - Smooth animations and transitions

## Architecture

### Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Framework** | React + TypeScript | Component-based UI with type safety |
| **Build System** | esbuild | Self-contained HTML bundle (no separate assets) |
| **Real-time** | Server-Sent Events (SSE) | Push-based updates from worker service |
| **State Management** | React hooks | Local state with custom hooks for SSE, pagination, settings |
| **Styling** | Inline CSS | No external stylesheets, fully self-contained |
| **Typography** | Monaspace Radon | Embedded monospace font for code aesthetics |

### File Structure

```
src/ui/viewer/
├── App.tsx                    # Main application component
├── types.ts                   # TypeScript interfaces
├── components/
│   ├── Header.tsx             # Top navigation with logo and theme toggle
│   ├── Sidebar.tsx            # Project filter and stats sidebar
│   ├── Feed.tsx               # Main feed with infinite scroll
│   ├── ThemeToggle.tsx        # Light/dark/system theme selector
│   └── cards/
│       ├── ObservationCard.tsx  # Displays individual observations
│       ├── SummaryCard.tsx      # Displays session summaries
│       ├── PromptCard.tsx       # Displays user prompts
│       └── SkeletonCard.tsx     # Loading placeholder
├── hooks/
│   ├── useSSE.ts              # Server-Sent Events connection
│   ├── usePagination.ts       # Infinite scroll logic
│   ├── useSettings.ts         # Settings persistence
│   ├── useStats.ts            # Database statistics
│   └── useTheme.ts            # Theme management
└── utils/
    ├── constants.ts           # Configuration constants
    ├── data.ts                # Data merging and deduplication
    └── formatters.ts          # Date/time formatting helpers
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Worker Service (port 37777)                                 │
│  - Express HTTP API                                         │
│  - SSE endpoint: /stream                                    │
│  - REST endpoints: /api/*                                   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Viewer UI (React App)                                       │
│  - useSSE hook: Real-time stream                           │
│  - usePagination hook: Historical data                     │
│  - useSettings hook: Persistent preferences                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Feed Component                                              │
│  - Merges real-time + paginated data                       │
│  - Deduplicates by ID                                       │
│  - Filters by selected project                             │
│  - Infinite scroll triggers pagination                     │
└─────────────────────────────────────────────────────────────┘
```

## Features In Detail

### Real-Time Updates (SSE)

The viewer uses Server-Sent Events to receive updates instantly:

```typescript
// SSE message format
{
  "type": "observation" | "summary" | "prompt" | "projects" | "processing",
  "data": { /* record data */ }
}
```

**Event Types:**
- `observation` - New observation created
- `summary` - Session summary generated
- `prompt` - User prompt captured
- `projects` - Project list updated
- `processing` - Session processing status changed

**Connection Management:**
- Auto-reconnect on disconnect with exponential backoff
- Visual connection status indicator in header
- Graceful degradation if SSE unavailable

### Infinite Scroll Pagination

The feed loads historical data progressively:

1. **Initial Load**: First 20 records loaded on mount
2. **Scroll Trigger**: When user scrolls to 80% of feed height
3. **Batch Load**: Next 20 records fetched via `/api/{type}?offset=X&limit=20`
4. **Deduplication**: Merges with real-time data, removes duplicates by ID
5. **Loading State**: Skeleton cards show while fetching

**Performance:**
- Requests debounced to prevent spam
- Only visible when scrolled near bottom
- Continues until no more records available

### Project Filtering

Filter memory stream by specific projects:

1. Projects extracted from observations, summaries, and prompts
2. Sidebar shows all unique project names with counts
3. Click project name to filter feed
4. Click "All Projects" to clear filter
5. Filter persisted to localStorage

**Project Detection:**
- Extracted from `projectPath` or `project` field in records
- Basename of path used as project name
- Empty/null projects shown as "(No Project)"

### Theme Toggle (v5.1.2)

Three theme modes available:

- **Light Mode**: Clean white background, dark text
- **Dark Mode**: Dark background, light text (default)
- **System**: Matches OS preference automatically

**Implementation:**
```typescript
// Theme preference stored in localStorage
localStorage.setItem('theme-preference', 'light' | 'dark' | 'system');

// CSS variables updated dynamically
document.documentElement.setAttribute('data-theme', resolvedTheme);
```

**CSS Variables:**
```css
:root[data-theme="light"] {
  --bg-primary: #ffffff;
  --text-primary: #1f2937;
  /* ... */
}

:root[data-theme="dark"] {
  --bg-primary: #111827;
  --text-primary: #f9fafb;
  /* ... */
}
```

### Settings Persistence

Settings automatically saved to worker service:

**Saved Settings:**
- `sidebarOpen` - Sidebar expanded/collapsed state
- `selectedProject` - Current project filter
- `theme` - Theme preference (light/dark/system)

**API Endpoints:**
- `GET /api/settings` - Retrieve saved settings
- `POST /api/settings` - Save settings (debounced 500ms)

**Local Fallback:**
- If API unavailable, settings stored in localStorage
- Synced back to API when connection restored

## Usage Guide

### Opening the Viewer

1. Ensure claude-mem worker is running (auto-starts with Claude Code)
2. Open browser to http://localhost:37777
3. Viewer loads automatically with recent records

### Navigating the Feed

**Cards Displayed:**
- **Observation Cards** (blue accent) - Tool usage observations with title, narrative, concepts, files
- **Summary Cards** (green accent) - Session summaries with request, completion, learnings
- **Prompt Cards** (purple accent) - Raw user prompts with timestamp and project

**Card Features:**
- Click to expand/collapse full details
- Type indicators (🔴 bugfix, 🟣 feature, 🔄 refactor, etc.)
- Concept tags (clickable for future filtering)
- File references with paths
- Timestamps in relative format ("2 hours ago")

### Using Project Filters

1. **Open Sidebar**: Click hamburger menu (☰) in top-left
2. **View Stats**: See total observations, sessions, prompts
3. **Select Project**: Click project name to filter
4. **View Counts**: Numbers show records per project
5. **Clear Filter**: Click "All Projects" to reset

### Changing Theme

1. **Open Theme Toggle**: Click theme icon in header
2. **Select Mode**:
   - ☀️ Light mode
   - 🌙 Dark mode
   - 💻 System (follows OS)
3. **Auto-Save**: Preference saved immediately
4. **Smooth Transition**: CSS transitions between themes

### Troubleshooting

**Viewer Not Loading:**
```bash
# Check worker status
npm run worker:logs

# Restart worker
npm run worker:restart

# Check if port 37777 is available
lsof -i :37777
```

**SSE Connection Issues:**
- Check browser console for connection errors
- Verify no proxy/firewall blocking EventSource
- Auto-reconnect attempts every 1-5s with exponential backoff

**Theme Not Persisting:**
- Check localStorage: `localStorage.getItem('theme-preference')`
- Verify `/api/settings` endpoint responding
- Clear browser cache if stale

**Infinite Scroll Not Triggering:**
- Scroll to 80% of feed height
- Check browser console for fetch errors
- Verify `/api/{type}` endpoints responding with data

## Development

### Building the Viewer

```bash
# Build viewer UI
npm run build

# Output: plugin/ui/viewer.html (self-contained)
```

### Adding New Features

**Example: Add a new card component**

1. Create component:
```typescript
// src/ui/viewer/components/cards/MyCard.tsx
export function MyCard({ data }: { data: MyData }) {
  return (
    <div className="card">
      <div className="card-header">{data.title}</div>
      <div className="card-body">{data.content}</div>
    </div>
  );
}
```

2. Add to Feed component:
```typescript
// src/ui/viewer/components/Feed.tsx
import { MyCard } from './cards/MyCard';

// In render:
{myData.map(item => <MyCard key={item.id} data={item} />)}
```

3. Rebuild:
```bash
npm run build
npm run sync-marketplace
npm run worker:restart
```

### Testing Changes

1. Make changes to `src/ui/viewer/`
2. Rebuild: `npm run build`
3. Restart worker: `npm run worker:restart`
4. Refresh browser (http://localhost:37777)
5. Check browser console for errors

## API Integration

The viewer consumes these worker service endpoints:

### Data Retrieval

```typescript
// Get paginated observations
GET /api/observations?offset=0&limit=20&project=myproject
Response: { observations: Observation[], hasMore: boolean }

// Get paginated summaries
GET /api/summaries?offset=0&limit=20&project=myproject
Response: { summaries: Summary[], hasMore: boolean }

// Get paginated prompts
GET /api/prompts?offset=0&limit=20&project=myproject
Response: { prompts: UserPrompt[], hasMore: boolean }

// Get database stats
GET /api/stats
Response: { totalObservations: number, totalSessions: number, ... }
```

### Real-Time Stream

```typescript
// Server-Sent Events stream
GET /stream

// Message format:
event: observation
data: {"type":"observation","data":{...}}

event: summary
data: {"type":"summary","data":{...}}
```

### Settings

```typescript
// Get settings
GET /api/settings
Response: { sidebarOpen: boolean, selectedProject: string, ... }

// Save settings
POST /api/settings
Body: { sidebarOpen: boolean, selectedProject: string, ... }
Response: { success: boolean }
```

## Performance Considerations

### Bundle Size
- Self-contained HTML: ~150KB (gzipped)
- No external dependencies loaded at runtime
- Monaspace Radon font embedded (subset)

### Memory Management
- Virtualization: Only renders visible cards
- Deduplication: Prevents duplicate records in memory
- Cleanup: Old records beyond pagination limit pruned

### Network Efficiency
- SSE: Single long-lived connection for real-time updates
- REST: Paginated requests (20 records per batch)
- Debouncing: Settings saves debounced 500ms

### Rendering Performance
- React.memo: Cards memoized to prevent unnecessary re-renders
- useMemo: Data merging/filtering memoized
- CSS transitions: GPU-accelerated for smooth animations

## Future Enhancements

Potential features for future versions:

- **Search**: Full-text search across observations, summaries, prompts
- **Export**: Download data as JSON, CSV, or markdown
- **Charts**: Visualize observation frequency, types, concepts over time
- **Keyboard Shortcuts**: Navigate feed, toggle sidebar, switch themes
- **Notifications**: Browser notifications for important observations
- **Dark/Light Auto-Schedule**: Auto-switch theme based on time of day
- **Custom Themes**: User-defined color schemes
- **Multi-Project Views**: Compare multiple projects side-by-side

## Resources

- **Source Code**: `src/ui/viewer/`
- **Built Output**: `plugin/ui/viewer.html`
- **Worker Service**: `src/services/worker-service.ts`
- **Build Script**: `scripts/build-viewer.js`
- **Documentation**: This file

---

**Built with React + TypeScript** | **Powered by Server-Sent Events** | **Self-Contained HTML Bundle**
