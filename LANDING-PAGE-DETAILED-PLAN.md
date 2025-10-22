# Claude-Mem Landing Page - Detailed Implementation Plan

**Magic UI Component Integration Strategy**

This document outlines the complete implementation plan for the claude-mem landing page, integrating Magic UI components to create an intuitive, delightful, and effective storytelling experience.

---

## Executive Summary

**Goal**: Create a landing page that *shows* rather than *tells* - demonstrating claude-mem's value through interactive, visual storytelling.

**Approach**: Use Magic UI components strategically to:
- Make abstract concepts (memory, persistence) tangible
- Create moments of delight that mirror the product's value
- Guide users through an intuitive understanding journey
- Reduce friction at conversion points

**Key Metrics**:
- Average section score: 43.5/50 (87%)
- Total delight factor: 85%
- Primary conversion point: Installation section (44/50)

---

## Section-by-Section Implementation

### Section 1: HERO - "Claude Never Forgets"

**Winning Concept**: "Fading Memory" Effect (Score: 42/50)

#### Layout
```
┌─────────────────────────────────────────────────────┐
│         [Grid Beams Background - Blue/Purple]        │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │     [Morphing Text - Main Headline]         │    │
│  │  "Claude Never Forgets" → "Claude Always    │    │
│  │   Remembers" → "Claude Learns Forever"      │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│            [Orbiting Circles Visualization]          │
│                 ┌──────────┐                        │
│            ○───│  Brain/  │───○                     │
│           ○    │ Database │    ○                    │
│            ○───│   Icon   │───○                     │
│                 └──────────┘                        │
│    Inner orbit: File icons (code files)             │
│    Middle orbit: Lightbulb icons (decisions)        │
│    Outer orbit: Bug icons (fixes)                   │
│                                                      │
│  ┌────────────────────────────────────────────┐    │
│  │   [Scratch To Reveal - Pain Point]          │    │
│  │   Scratch surface with grain texture        │    │
│  │   Reveals: "Every /clear wipes Claude's     │    │
│  │             memory. Until now."              │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│         [Pulsating Button - Main CTA]               │
│           "Give Claude a Memory"                     │
│                                                      │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Grid Beams** (Background)
- `gridSize`: 40
- `gridColor`: "rgba(100, 150, 255, 0.15)"
- `rayCount`: 12
- `rayOpacity`: 0.3
- `raySpeed`: 0.8
- `backgroundColor`: "#0a0f1e"
- Purpose: Creates "memory grid" tech aesthetic

**Morphing Text** (Headline)
- `texts`: ["Claude Never Forgets", "Claude Always Remembers", "Claude Learns Forever"]
- `duration`: 3000ms per text
- `className`: "text-6xl font-bold text-center"
- Purpose: Reinforces core value proposition from multiple angles

**Orbiting Circles** (Central Visualization)
```jsx
// Inner orbit - Files
<OrbitingCircles radius={120} duration={20} iconSize={24}>
  <FileIcon /> <FileIcon /> <FileIcon /> <FileIcon />
</OrbitingCircles>

// Middle orbit - Decisions
<OrbitingCircles radius={180} duration={30} iconSize={28} reverse>
  <LightbulbIcon /> <LightbulbIcon /> <LightbulbIcon />
</OrbitingCircles>

// Outer orbit - Bugs
<OrbitingCircles radius={240} duration={40} iconSize={32}>
  <BugIcon /> <BugIcon />
</OrbitingCircles>
```
- Purpose: Visually demonstrates what gets remembered

**Scratch To Reveal** (Pain Point)
- `width`: 600
- `height`: 150
- `minScratchPercentage`: 40
- `gradientColors`: ["#1a1a2e", "#16213e", "#0f3460"]
- Reveals text: "Every /clear wipes Claude's memory. Until now."
- Purpose: Makes pain point visceral and interactive

**Pulsating Button** (CTA)
- `pulseColor`: "59, 130, 246" (blue)
- `duration`: "1.5s"
- Text: "Give Claude a Memory"
- Purpose: Primary conversion action

#### Implementation Notes
- Hero should be full viewport height
- Orbiting circles animate automatically on load
- Scratch-to-reveal activates on first scroll or after 3 seconds
- Grid beams subtle enough to not distract from content
- Ensure accessibility: keyboard navigation for scratch-to-reveal

---

### Section 2: BEFORE/AFTER Comparison

**Winning Concept**: "Split Screen Wipe" (Score: 44/50)

#### Layout
```
┌────────────────────┬────────────────────┐
│      BEFORE        │       AFTER        │
│                    │                    │
│  [Safari Mockup]   │  [Safari Mockup]   │
│  ┌──────────────┐  │  ┌──────────────┐  │
│  │ Session 1:   │  │  │ Session 1:   │  │
│  │ "We use Redux"│ │  │ "We use Redux"│ │
│  │              │  │  │              │  │
│  │ [Fading...]  │  │  │ [Persists]   │  │
│  │ opacity: 0.3 │  │  │ ┌──Border──┐ │  │
│  │              │  │  │ │Beam glow │ │  │
│  └──────────────┘  │  │ └──────────┘ │  │
│                    │  │              │  │
│  [Safari Mockup]   │  [Safari Mockup]   │
│  ┌──────────────┐  │  ┌──────────────┐  │
│  │ Session 2:   │  │  │ Session 2:   │  │
│  │ "What state  │  │  │ Claude knows │  │
│  │  mgmt do you │  │  │ Redux setup  │  │
│  │  use?" ❌    │  │  │ already ✓    │  │
│  └──────────────┘  │  └──────────────┘  │
└────────────────────┴────────────────────┘
```

#### Component Specifications

**Safari** (Browser Mockups - 4 total)
- `width`: 500
- `height`: 350
- `mode`: "simple"
- `url`: "claude.ai/chat"
- Content: Rendered as children (conversation bubbles)

**Before Side Animations**:
```jsx
<TextAnimate
  animateType="line"
  animation="fadeIn"
  duration={0.8}
>
  Session 1 conversation
</TextAnimate>

// Then fade out
<div style={{ opacity: 0.3, transition: 'opacity 2s' }}>
  Previous session content
</div>
```

**After Side Animations**:
```jsx
<div className="relative">
  <TextAnimate
    animateType="line"
    animation="slideUp"
    duration={0.6}
  >
    Session 2 with context
  </TextAnimate>

  <BorderBeam
    duration={8}
    colorFrom="#3b82f6"
    colorTo="#8b5cf6"
  />
</div>
```

**Scratch To Reveal** (Optional - Before side)
- Applied over entire Before column
- Scratch to reveal the "forgetting" behavior
- Creates visceral understanding of the problem

#### Implementation Notes
- Use CSS Grid for split layout
- Before/After labels with subtle divider
- Conversations animate in sequence (Session 1, then Session 2)
- Border Beam pulses on After side every 3 seconds
- Consider responsive: stack vertically on mobile

---

### Section 3: REAL EXAMPLES - 3 Scenarios

**Winning Concept**: "Timeline Story" (Score: 44/50)

#### Layout
```
┌─────────────────────────────────────────────────────┐
│              [Arc Timeline - Horizontal]             │
│                                                      │
│    Mon        │         Wed        │       Fri      │
│    ●──────────┼─────────●─────────┼────────●       │
│  Context   Architecture      Bug Pattern            │
│   Across     Memory         Recognition             │
│  Sessions                                            │
│                                                      │
│  [Expanded Node View]                               │
│  ┌──────────────────────────────────────────────┐  │
│  │  [Orbiting Circles around active node]        │  │
│  │         ○                                     │  │
│  │    ○         ○   [Active Node]                │  │
│  │         ○                                     │  │
│  │                                               │  │
│  │  Files: store.ts, actions.ts                  │  │
│  │  Decisions: Redux for state                   │  │
│  │  Concepts: state-management, architecture     │  │
│  │                                               │  │
│  │  [Animated List - Claude Remembers]           │  │
│  │  ✓ Your store structure                       │  │
│  │  ✓ Redux patterns you prefer                  │  │
│  │  ✓ Async/await convention                     │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
│  [Highlighter on key phrases in examples]           │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Arc Timeline**
```jsx
const timelineData = [
  {
    time: 'Monday',
    title: 'Context Across Sessions',
    description: 'Redux state management discussion'
  },
  {
    time: 'Wednesday',
    title: 'Architectural Memory',
    description: 'API endpoint creation with remembered patterns'
  },
  {
    time: 'Friday',
    title: 'Bug Pattern Recognition',
    description: 'Similar issues recognized across weeks'
  }
];

<ArcTimeline
  data={timelineData}
  arcConfig={{
    circleWidth: 4000,
    angleBetweenMinorSteps: 0.4,
    lineCountFillBetweenSteps: 8,
    boundaryPlaceholderLinesCount: 40
  }}
  defaultActiveStep={{ time: 'Monday', stepIndex: 0 }}
/>
```

**Orbiting Circles** (Around Active Node)
```jsx
// File orbit
<OrbitingCircles radius={80} duration={15} iconSize={20}>
  <DocumentIcon /> <DocumentIcon />
</OrbitingCircles>

// Decision orbit
<OrbitingCircles radius={120} duration={20} iconSize={24} reverse>
  <LightbulbIcon />
</OrbitingCircles>

// Concept orbit
<OrbitingCircles radius={160} duration={25} iconSize={20}>
  <TagIcon /> <TagIcon />
</OrbitingCircles>
```

**Animated List** (Claude Remembers)
```jsx
<AnimatedList delay={500}>
  <li>✓ Your store structure</li>
  <li>✓ Redux patterns you prefer</li>
  <li>✓ Async/await convention</li>
  <li>✓ Auth middleware setup</li>
</AnimatedList>
```

**Highlighter** (Key Phrases)
```jsx
<Highlighter color="#3b82f6" action="underline" strokeWidth={2}>
  Your store structure
</Highlighter>
```

#### Implementation Notes
- Timeline is the central organizing element
- Click timeline node to expand that scenario
- Orbiting circles show related context types
- Animated list reveals sequentially (stagger 500ms)
- Highlight key remembered elements in blue
- Smooth transitions between scenarios

---

### Section 4: HOW IT WORKS - Pipeline

**Winning Concept**: "Layered Depth Model" (Score: 43/50)

#### Layout
```
┌─────────────────────────────────────────────────────┐
│         [Grid Beams Background - Subtle]             │
│                                                      │
│               [Morphing Text - State]                │
│          "Capturing" → "Compressing" →              │
│             "Storing" → "Retrieving"                │
│                                                      │
│  ┌─────────────────────────────────────────┐       │
│  │  [Layer 1 - Front] Magic Card            │       │
│  │  You code with Claude today              │       │
│  │  ┌─────────────────────────────────┐    │       │
│  │  │ [Particles flowing down]         │    │       │
│  └──│───────────────────────────────────│───┘       │
│     │                                    │           │
│   ┌─│─────────────────────────────────│─┐          │
│   │ │  [Layer 2 - Mid] Magic Card     │ │          │
│   │ └─────────────────────────────────┘ │          │
│   │  claude-mem captures & compresses   │          │
│   │  [Shine Border - Active]             │          │
│   └──────────────────────────────────────┘          │
│                                                      │
│     ┌─────────────────────────────────────┐        │
│     │  [Layer 3 - Back] Magic Card         │        │
│     │  Tomorrow, Claude starts with context│        │
│     └─────────────────────────────────────┘        │
│                                                      │
│            [Border Beam Arrows Between]             │
│                                                      │
│  [Highlighter on "Automatic. Zero effort."]         │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Grid Beams** (Background)
- `gridSize`: 50
- `gridColor`: "rgba(100, 100, 150, 0.08)"
- `rayCount`: 8
- `rayOpacity`: 0.2
- `backgroundColor`: "#0f0f1e"
- Purpose: Represents storage layer

**Morphing Text** (State Display)
```jsx
<MorphingText
  texts={["Capturing", "Compressing", "Storing", "Retrieving"]}
  className="text-3xl font-semibold text-center mb-12"
/>
```

**Magic Cards** (3 Layers with Z-depth)
```jsx
// Layer 1 - Front
<MagicCard
  className="z-30 transform perspective-1000 rotateX-5"
  gradientColor="#1a1a3e"
  gradientFrom="#3b82f6"
  gradientTo="#8b5cf6"
>
  <h3>You code with Claude today</h3>
  <p>Every tool use, every decision, every file change</p>
</MagicCard>

// Layer 2 - Middle (with Shine Border)
<div className="z-20 transform perspective-1000 rotateX-10 translateY-20">
  <ShineBorder
    color={["#3b82f6", "#8b5cf6"]}
    borderWidth={3}
    duration={12}
  >
    <MagicCard>
      <h3>claude-mem captures & compresses</h3>
      <p>AI-powered compression into structured memories</p>
    </MagicCard>
  </ShineBorder>
</div>

// Layer 3 - Back
<MagicCard
  className="z-10 transform perspective-1000 rotateX-15 translateY-40"
  gradientColor="#0f0f2e"
>
  <h3>Tomorrow, Claude starts with context</h3>
  <p>Full project history injected automatically</p>
</MagicCard>
```

**Particles** (Flowing Between Layers)
```jsx
<Particles
  className="absolute inset-0"
  quantity={50}
  color="#3b82f6"
  // Configure to flow downward
/>
```

**Border Beam** (Arrows/Connections)
- Between Layer 1 → Layer 2
- Between Layer 2 → Layer 3
- Animated flow showing data movement

**Highlighter**
```jsx
<Highlighter color="#10b981" action="highlight" strokeWidth={3}>
  Automatic. Zero effort. Always on.
</Highlighter>
```

#### Implementation Notes
- Use CSS `perspective` for 3D depth
- Cards slide into position on scroll
- Morphing text cycles continuously
- Particles subtle, not distracting
- Responsive: reduce z-depth on mobile
- Ensure cards remain readable with gradients

---

### Section 5: WHAT GETS REMEMBERED - Features

**Winning Concept**: "Memory Bank Slots" (Score: 41/50)

#### Layout
```
┌─────────────────────────────────────────────────────┐
│        [Aurora Text - Section Heading]               │
│          "What Gets Remembered"                      │
│                                                      │
│  ┌──────────┬──────────┬──────────┐                │
│  │ [Scratch │ [Scratch │ [Scratch │                 │
│  │   Card]  │   Card]  │   Card]  │                 │
│  │          │          │          │                 │
│  │ Decisions│   Bugs   │ Patterns │                 │
│  │   💡     │    🐛    │   📋     │                 │
│  └──────────┴──────────┴──────────┘                │
│                                                      │
│  ┌──────────┬──────────┬──────────┐                │
│  │ [Scratch │ [Scratch │ [Scratch │                 │
│  │   Card]  │   Card]  │   Card]  │                 │
│  │          │          │          │                 │
│  │  Files   │ Refactor │  Deps    │                 │
│  │   📄     │   🔄     │   📦     │                 │
│  └──────────┴──────────┴──────────┘                │
│                                                      │
│  [Revealed cards show Shine Border]                 │
│  [Orbiting circles appear around revealed cards]     │
│  [Pulsating indicators on high-value items]         │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Aurora Text** (Heading)
```jsx
<AuroraText
  colors={["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b"]}
  speed={1.5}
  className="text-5xl font-bold text-center mb-16"
>
  What Gets Remembered
</AuroraText>
```

**Bento Grid** (6 Cards Layout)
```jsx
<div className="grid grid-cols-3 gap-6">
  {memoryTypes.map((type, index) => (
    <ScratchCard key={index} type={type} />
  ))}
</div>
```

**Scratch To Reveal Cards** (6 Individual)
```jsx
const MemoryCard = ({ icon, title, description }) => {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="relative">
      <ScratchToReveal
        width={280}
        height={320}
        minScratchPercentage={50}
        gradientColors={['#1e293b', '#334155', '#475569']}
        onComplete={() => setRevealed(true)}
      >
        <MagicCard className="h-full p-6">
          <div className="text-6xl mb-4">{icon}</div>
          <h3 className="text-xl font-bold mb-2">{title}</h3>
          <p className="text-sm text-gray-300">{description}</p>
        </MagicCard>
      </ScratchToReveal>

      {revealed && (
        <>
          <ShineBorder color={["#3b82f6", "#8b5cf6"]} />
          <OrbitingCircles radius={60} duration={20}>
            <CheckIcon />
          </OrbitingCircles>
        </>
      )}
    </div>
  );
};
```

**Memory Types Data**
```javascript
const memoryTypes = [
  {
    icon: '💡',
    title: 'Decisions',
    description: 'Why did we choose this architecture? What trade-offs did we make?'
  },
  {
    icon: '🐛',
    title: 'Bugs Fixed',
    description: 'How did we solve this before? What was the root cause?'
  },
  {
    icon: '📋',
    title: 'Code Patterns',
    description: "What's our convention for this? How do we structure similar code?"
  },
  {
    icon: '📄',
    title: 'File Changes',
    description: 'What did we modify last session? Which files are related?'
  },
  {
    icon: '🔄',
    title: 'Refactorings',
    description: 'What was the old implementation? Why did we change it?'
  },
  {
    icon: '📦',
    title: 'Dependencies',
    description: 'Which libraries are we using? What versions? Why those?'
  }
];
```

**Pulsating Button** (High-value indicators)
- Applied to "Decisions" and "Bugs Fixed" cards
- Subtle pulse before scratching
- `pulseColor`: "59, 130, 246"
- `duration`: "2s"

#### Implementation Notes
- Cards arranged in 3x2 grid (responsive: 2x3 on tablet, 1x6 on mobile)
- Scratch surface has subtle grain texture
- Revealed cards get Shine Border animation
- Orbiting circles appear with checkmark icon after reveal
- Track which cards are revealed, celebrate when all revealed
- Consider adding a "Reveal All" button for impatient users
- Ensure scratch works on touch devices

---

### Section 6: POWERFUL SEARCH

**Winning Concept**: "Live Search Demo" (Score: 44/50)

#### Layout
```
┌─────────────────────────────────────────────────────┐
│              [Section Heading]                       │
│              Powerful Search                         │
│                                                      │
│  [Safari Browser Mockup - Search Interface]          │
│  ┌──────────────────────────────────────────────┐  │
│  │ 🔍 [Text Animate - Typing Query]              │  │
│  │    "Find all the database migrations we did" │  │
│  │                                               │  │
│  │  [Animated List - Results Appearing]          │  │
│  │  ┌────────────────────────────────────────┐  │  │
│  │  │ [Magic Card with Border Beam]           │  │  │
│  │  │ March 15: Added user_preferences table  │  │  │
│  │  │ [Highlighter on "user_preferences"]     │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  │                                               │  │
│  │  ┌────────────────────────────────────────┐  │  │
│  │  │ [Magic Card with Border Beam]           │  │  │
│  │  │ March 12: Migration for OAuth tokens    │  │  │
│  │  │ [Highlighter on "OAuth tokens"]         │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  │                                               │  │
│  │  ┌────────────────────────────────────────┐  │  │
│  │  │ [Magic Card]                            │  │  │
│  │  │ March 8: Index optimization on sessions │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
│  [Morphing Text - Search Types]                     │
│  "Migrations" → "Decisions" → "Patterns" → "Bugs"   │
│                                                      │
│  [7 Search Tools - Animated List]                   │
│  ✓ search_observations    ✓ find_by_concept         │
│  ✓ search_sessions        ✓ find_by_file            │
│  ✓ find_by_type          ✓ get_recent_context       │
│  ✓ advanced_search (Combined filters)               │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Safari** (Search Interface Mockup)
```jsx
<Safari
  url="claude.ai/chat"
  width={900}
  height={600}
  mode="default"
>
  <SearchDemoContent />
</Safari>
```

**Text Animate** (Typing Search Query)
```jsx
const queries = [
  "Find all the database migrations we did",
  "What decisions did we make about authentication?",
  "Show me bug fixes from last week"
];

<TextAnimate
  animateType="character"
  animation="blurIn"
  duration={0.05}
  className="text-lg font-mono"
>
  {currentQuery}
</TextAnimate>
```

**Animated List** (Search Results)
```jsx
<AnimatedList delay={800} className="space-y-4 mt-6">
  {results.map((result, index) => (
    <MagicCard key={index} className="p-4 relative">
      <BorderBeam
        duration={5 + index}
        delay={index * 0.5}
      />

      <div className="flex items-start gap-3">
        <CalendarIcon className="text-blue-400" />
        <div>
          <p className="font-semibold">
            {result.date}:
            <Highlighter
              color="#3b82f6"
              action="underline"
              strokeWidth={2}
            >
              {result.highlight}
            </Highlighter>
          </p>
          <p className="text-sm text-gray-400 mt-1">
            {result.description}
          </p>
        </div>
      </div>
    </MagicCard>
  ))}
</AnimatedList>
```

**Morphing Text** (Search Types Cycling)
```jsx
<MorphingText
  texts={["Migrations", "Decisions", "Patterns", "Bugs", "Files", "Refactors"]}
  className="text-2xl font-semibold text-center my-8"
/>
```

**Highlighter** (Matched Keywords in Results)
```jsx
<Highlighter
  color="#3b82f6"
  action="underline"
  strokeWidth={2}
  animationDuration={600}
>
  {matchedKeyword}
</Highlighter>
```

**Animated List** (7 Search Tools)
```jsx
<AnimatedList delay={400} className="grid grid-cols-2 gap-4 mt-8">
  <div className="flex items-center gap-2">
    <CheckIcon className="text-green-400" />
    <span>search_observations</span>
  </div>
  <div className="flex items-center gap-2">
    <CheckIcon className="text-green-400" />
    <span>find_by_concept</span>
  </div>
  {/* ... remaining 5 tools ... */}
</AnimatedList>
```

#### Implementation Notes
- Safari mockup shows actual search interface
- Query types out character by character (realistic typing)
- Results appear sequentially with stagger (800ms delay)
- Each result card has Border Beam animation
- Highlight matched keywords in blue
- Morphing text cycles to show different search types
- Consider interactive: let user click different query types
- Show "Instant recall. Full project history." tagline

---

### Section 7: THE NUMBERS - Metrics

**Winning Concept**: "Progress Bar Transformation" (Score: 45/50) ⭐ HIGHEST

#### Layout
```
┌─────────────────────────────────────────────────────┐
│              [Section Heading]                       │
│                 The Numbers                          │
│                                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │ [Magic Card with Shine Border]                │  │
│  │                                               │  │
│  │  Context repetition                           │  │
│  │  ──────────────────────────────────────       │  │
│  │  BEFORE: ████████████████████ Every session  │  │
│  │          [Red bar - 100%]                     │  │
│  │                                               │  │
│  │  AFTER:  [Green bar - 0%]     Never          │  │
│  │          [Morphing animation]                 │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
│  [4 more Magic Cards with progress transformations] │
│                                                      │
│  [Morphing Text - Cycling Metrics]                  │
│  "Context" → "Onboarding" → "Bugs" → "Questions"    │
│                                                      │
│  [Pulsating Button - "See the Difference"]          │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Magic Cards** (5 Metrics)
```jsx
const metrics = [
  {
    name: 'Context repetition',
    before: { value: 100, label: 'Every session', color: '#ef4444' },
    after: { value: 0, label: 'Never', color: '#10b981' }
  },
  {
    name: 'Onboarding time',
    before: { value: 75, label: '5-10 min per session', color: '#f59e0b' },
    after: { value: 0, label: '0 seconds', color: '#10b981' }
  },
  {
    name: 'Bug re-investigation',
    before: { value: 80, label: 'Common', color: '#ef4444' },
    after: { value: 10, label: 'Rare', color: '#10b981' }
  },
  {
    name: 'Architectural questions',
    before: { value: 90, label: '"What did we decide?"', color: '#f59e0b' },
    after: { value: 5, label: 'Claude already knows', color: '#10b981' }
  },
  {
    name: 'Code pattern consistency',
    before: { value: 60, label: 'Manual enforcement', color: '#f59e0b' },
    after: { value: 95, label: 'Automatic', color: '#10b981' }
  }
];

{metrics.map((metric, index) => (
  <MagicCard key={index} className="p-6 mb-4">
    <ShineBorder
      color={["#10b981", "#3b82f6"]}
      borderWidth={2}
      duration={15}
    >
      <h3 className="text-xl font-bold mb-4">{metric.name}</h3>

      {/* Before Progress Bar */}
      <div className="mb-2">
        <div className="flex justify-between text-sm mb-1">
          <span className="text-gray-400">BEFORE:</span>
          <span>{metric.before.label}</span>
        </div>
        <div className="h-8 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full transition-all duration-1000"
            style={{
              width: `${metric.before.value}%`,
              backgroundColor: metric.before.color
            }}
          />
        </div>
      </div>

      {/* After Progress Bar */}
      <div>
        <div className="flex justify-between text-sm mb-1">
          <span className="text-gray-400">AFTER:</span>
          <span className="text-green-400 font-semibold">
            {metric.after.label}
          </span>
        </div>
        <div className="h-8 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full transition-all duration-1000 delay-500"
            style={{
              width: `${metric.after.value}%`,
              backgroundColor: metric.after.color
            }}
          />
        </div>
      </div>
    </ShineBorder>
  </MagicCard>
))}
```

**Morphing Text** (Cycling Metric Names)
```jsx
<MorphingText
  texts={["Context", "Onboarding", "Bugs", "Questions", "Consistency"]}
  className="text-3xl font-bold text-center my-8"
/>
```

**Pulsating Button** (CTA)
```jsx
<PulsatingButton
  pulseColor="16, 185, 129" // Green
  duration="1.8s"
  className="mx-auto mt-8"
>
  See the Difference
</PulsatingButton>
```

#### Animation Sequence
1. Cards appear with stagger (200ms between each)
2. "Before" bars animate in first (duration: 1000ms)
3. "After" bars animate in with delay (delay: 500ms, duration: 1000ms)
4. Shine Border pulses continuously
5. Morphing text cycles through metric names
6. On hover: card spotlights activate

#### Implementation Notes
- Progress bars use CSS transitions for smooth animation
- Color coding: Red/Orange for "before", Green for "after"
- Bars animate on scroll into view (IntersectionObserver)
- Consider adding count-up animation for percentages
- Ensure high contrast for accessibility
- Mobile: Stack bars vertically if needed

---

### Section 8: INSTALLATION - Quick Start

**Winning Concept**: "Copy-Paste Delight" (Score: 44/50)

#### Layout
```
┌─────────────────────────────────────────────────────┐
│              [Section Heading]                       │
│         Installation - 2 Minutes                     │
│                                                      │
│  [Safari Terminal Mockup]                            │
│  ┌──────────────────────────────────────────────┐  │
│  │ $ [Text Animate - Typing Command]             │  │
│  │   git clone https://github.com/...            │  │
│  │                                               │  │
│  │   [Shiny Button - Copy] 📋                    │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
│  [Animated List - 3 Steps with Checkmarks]          │
│  ┌─────────────────────────────────────────────┐   │
│  │ ✓ [Step 1] Clone and install                 │   │
│  │   git clone + cd claude-mem                  │   │
│  │                                               │   │
│  │ ○ [Step 2] Add to Claude Code                │   │
│  │   /plugin marketplace add .claude-plugin/... │   │
│  │                                               │   │
│  │ ○ [Step 3] Install                           │   │
│  │   /plugin install claude-mem                 │   │
│  └─────────────────────────────────────────────┘   │
│                                                      │
│  [Highlighter on "2 minutes"]                        │
│  [Confetti when all steps complete]                 │
│                                                      │
│  [Pulsating Button - "Get Started"]                 │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Safari** (Terminal Mockup)
```jsx
<Safari
  url="terminal"
  width={800}
  height={400}
  mode="simple"
  className="mb-8"
>
  <TerminalContent />
</Safari>
```

**Text Animate** (Typing Commands)
```jsx
const commands = [
  "git clone https://github.com/thedotmack/claude-mem.git",
  "cd claude-mem",
  "/plugin marketplace add .claude-plugin/marketplace.json",
  "/plugin install claude-mem"
];

<TextAnimate
  animateType="character"
  animation="slideUp"
  duration={0.03}
  className="font-mono text-green-400"
>
  $ {currentCommand}
</TextAnimate>
```

**Shiny Button** (Copy Button)
```jsx
<ShinyButton
  onClick={handleCopy}
  className="absolute top-2 right-2"
>
  <CopyIcon /> Copy
</ShinyButton>
```

**Animated List** (3 Steps)
```jsx
<AnimatedList delay={600} className="space-y-6">
  {steps.map((step, index) => (
    <div
      key={index}
      className={`flex items-start gap-4 p-4 rounded-lg transition-all ${
        step.completed ? 'bg-green-900/20' : 'bg-gray-800/50'
      }`}
    >
      <div className="text-3xl">
        {step.completed ? '✓' : '○'}
      </div>
      <div className="flex-1">
        <h4 className="text-lg font-semibold mb-2">
          {step.title}
        </h4>
        <code className="text-sm text-gray-300 block bg-gray-900 p-2 rounded">
          {step.command}
        </code>
      </div>
      {step.completed && <CheckIcon className="text-green-400" />}
    </div>
  ))}
</AnimatedList>
```

**Highlighter** ("2 minutes")
```jsx
<Highlighter
  color="#10b981"
  action="highlight"
  strokeWidth={3}
  className="inline"
>
  2 minutes
</Highlighter>
```

**Confetti** (Completion Celebration)
```jsx
{allStepsComplete && (
  <Confetti
    particleCount={100}
    angle={90}
    spread={70}
    origin={{ x: 0.5, y: 0.6 }}
    colors={['#10b981', '#3b82f6', '#8b5cf6']}
  />
)}
```

**Pulsating Button** (Get Started CTA)
```jsx
<PulsatingButton
  pulseColor="59, 130, 246"
  duration="1.5s"
  className="mx-auto mt-8 text-lg px-8 py-4"
  onClick={scrollToTop}
>
  Get Started Now
</PulsatingButton>
```

#### Interactive Sequence
1. Terminal appears with first command typing
2. User clicks copy button → copied feedback
3. Shiny Button shows success state briefly
4. Animated list reveals steps sequentially
5. As user progresses (simulated or tracked), checkmarks appear
6. When final step completes → Confetti celebration
7. Pulsating button draws attention to next action

#### Implementation Notes
- Terminal has realistic command-line styling
- Copy buttons work with clipboard API
- Consider simulating installation progress (for demo)
- Track actual installation if possible (analytics)
- Confetti fires once, not repeatedly
- Ensure keyboard navigation for copy buttons
- Mobile: Reduce terminal size, keep copy buttons visible

---

### Section 9: UNDER THE HOOD - Architecture

**Winning Concept**: "Layered Stack" (Score: 44/50)

#### Layout
```
┌─────────────────────────────────────────────────────┐
│         [Warp Background - Depth Effect]             │
│                                                      │
│         [Morphing Text - Active Layer]               │
│    "Hooks" → "Worker" → "SQLite" → "MCP" → "Context"│
│                                                      │
│              [5 Layered Magic Cards]                 │
│                                                      │
│  ┌────────────────────────────────┐  [Layer 1]     │
│  │  Hooks (SessionStart, PostTool) │  ← Shine       │
│  │  📌 5 lifecycle hooks           │     Border     │
│  └─│──────────────────────────────┘                 │
│    │ [Particles flowing down]                       │
│  ┌─│────────────────────────────────┐ [Layer 2]    │
│  │ Worker Service                   │               │
│  │ ⚙️  Express.js + PM2             │               │
│  └─│────────────────────────────────┘               │
│    │                                                 │
│  ┌─│──────────────────────────────────┐ [Layer 3]  │
│  │ SQLite Database                    │             │
│  │ 💾 FTS5 Search + Sessions          │             │
│  └─│──────────────────────────────────┘             │
│    │                                                 │
│  ┌─│────────────────────────────────┐ [Layer 4]    │
│  │ MCP Server                       │               │
│  │ 🔍 7 Search Tools                │               │
│  └─│────────────────────────────────┘               │
│    │                                                 │
│  ┌─│──────────────────────────────────┐ [Layer 5]  │
│  │ Context Injection                  │             │
│  │ 🎯 Future Session Loading          │             │
│  └────────────────────────────────────┘             │
│                                                      │
│  [Highlighter on "Zero maintenance. Just works."]   │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Warp Background**
```jsx
<Warp
  perspective={1200}
  beamsPerSide={5}
  beamSize={4}
  beamDuration={3}
  gridColor="#1e293b"
  className="absolute inset-0 -z-10"
/>
```

**Morphing Text** (Active Layer Indicator)
```jsx
<MorphingText
  texts={["Hooks", "Worker Service", "SQLite Database", "MCP Server", "Context Injection"]}
  className="text-3xl font-bold text-center mb-12"
/>
```

**Layered Magic Cards** (5 Layers)
```jsx
const layers = [
  {
    title: 'Hooks',
    icon: '📌',
    description: '5 lifecycle hooks capture tool usage',
    details: 'SessionStart, UserPromptSubmit, PostToolUse, Summary, SessionEnd',
    zIndex: 50,
    transform: 'rotateX(5deg) translateY(0px)',
    shine: true
  },
  {
    title: 'Worker Service',
    icon: '⚙️',
    description: 'Express.js HTTP API managed by PM2',
    details: 'Processes observations, handles AI compression',
    zIndex: 40,
    transform: 'rotateX(10deg) translateY(60px)'
  },
  {
    title: 'SQLite Database',
    icon: '💾',
    description: 'FTS5 full-text search + structured storage',
    details: 'Sessions, observations, summaries with citations',
    zIndex: 30,
    transform: 'rotateX(15deg) translateY(120px)',
    highlight: true // Central piece
  },
  {
    title: 'MCP Server',
    icon: '🔍',
    description: '7 specialized search tools',
    details: 'search_observations, find_by_concept, find_by_type, etc.',
    zIndex: 20,
    transform: 'rotateX(20deg) translateY(180px)'
  },
  {
    title: 'Context Injection',
    icon: '🎯',
    description: 'Loads relevant context into future sessions',
    details: 'Automatic retrieval of last 3 session summaries',
    zIndex: 10,
    transform: 'rotateX(25deg) translateY(240px)'
  }
];

<div className="relative perspective-1000 h-[800px]">
  {layers.map((layer, index) => (
    <div
      key={index}
      className="absolute left-1/2 -translate-x-1/2 w-[600px]"
      style={{
        zIndex: layer.zIndex,
        transform: layer.transform
      }}
    >
      {layer.shine ? (
        <ShineBorder
          color={["#3b82f6", "#8b5cf6"]}
          borderWidth={3}
          duration={12}
        >
          <LayerCard layer={layer} />
        </ShineBorder>
      ) : (
        <MagicCard
          gradientColor={layer.highlight ? "#1e3a5f" : "#1a1a2e"}
          gradientFrom="#3b82f6"
          gradientTo="#8b5cf6"
        >
          <LayerCard layer={layer} />
        </MagicCard>
      )}
    </div>
  ))}

  <Particles
    className="absolute inset-0"
    quantity={30}
    color="#3b82f6"
  />
</div>
```

**Layer Card Component**
```jsx
const LayerCard = ({ layer }) => (
  <div className="p-6 bg-gray-900/80 backdrop-blur">
    <div className="flex items-center gap-3 mb-3">
      <span className="text-4xl">{layer.icon}</span>
      <h3 className="text-2xl font-bold">{layer.title}</h3>
    </div>
    <p className="text-lg text-gray-200 mb-2">{layer.description}</p>
    <p className="text-sm text-gray-400">{layer.details}</p>
  </div>
);
```

**Highlighter** (Tagline)
```jsx
<Highlighter
  color="#10b981"
  action="underline"
  strokeWidth={3}
  className="text-2xl text-center block mt-12"
>
  Zero maintenance. Runs in the background. Just works.
</Highlighter>
```

#### Animation Sequence
1. Warp background creates depth immediately
2. Cards slide in from top with stagger (150ms between)
3. Each card settles into z-position
4. Morphing text cycles through layer names
5. Shine Border on top layer (Hooks) pulses
6. Particles flow downward between layers
7. On scroll/hover: cards can expand slightly to show more detail

#### Implementation Notes
- Use CSS `perspective` and `transform` for 3D effect
- Cards stack with decreasing z-index
- Active layer (from morphing text) gets subtle highlight
- Particles subtle, flow from top to bottom
- Consider scroll interaction: layers separate as you scroll
- Responsive: reduce perspective on mobile, stack more vertically
- Ensure text remains readable at all angles

---

### Section 10: USE CASES - User Types

**Winning Concept**: "Role Selector" (Score: 46/50) ⭐ HIGHEST DELIGHT

#### Layout
```
┌─────────────────────────────────────────────────────┐
│              [Section Heading]                       │
│                 Use Cases                            │
│                                                      │
│         [Dock Component - Role Icons]                │
│  ┌────────────────────────────────────────────┐    │
│  │  👤     👥      🎓      🔧                  │    │
│  │  Solo   Team  Learning Refactor             │    │
│  └────────────────────────────────────────────┘    │
│                                                      │
│  [Expanded Magic Card - Selected Role]              │
│  ┌──────────────────────────────────────────────┐  │
│  │  [Spotlight Effect Active]                    │  │
│  │                                               │  │
│  │  Solo Developers                              │  │
│  │  [Avatar Circles - User Count]                │  │
│  │  +2,500                                       │  │
│  │                                               │  │
│  │  [Animated List - Benefits]                   │  │
│  │  ✓ Never lose context between sessions        │  │
│  │  ✓ Build on past decisions automatically      │  │
│  │  ✓ Remember why you made each choice          │  │
│  │                                               │  │
│  │  [Highlighter on key benefits]                │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
│  [Confetti when selecting "your" role]              │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Dock** (Role Selector)
```jsx
const roles = [
  { id: 'solo', icon: '👤', label: 'Solo Developers' },
  { id: 'team', icon: '👥', label: 'Team Projects' },
  { id: 'learning', icon: '🎓', label: 'Learning & Experiments' },
  { id: 'refactor', icon: '🔧', label: 'Large Refactors' }
];

<Dock
  iconMagnification={80}
  iconDistance={150}
  direction="middle"
  className="mb-12"
>
  {roles.map((role) => (
    <DockIcon
      key={role.id}
      onClick={() => selectRole(role.id)}
      className={selectedRole === role.id ? 'scale-125' : ''}
    >
      <div className="text-5xl">{role.icon}</div>
      <span className="text-xs mt-1">{role.label}</span>
    </DockIcon>
  ))}
</Dock>
```

**Magic Card** (Expanded Role Details)
```jsx
const useCases = {
  solo: {
    title: 'Solo Developers',
    userCount: 2500,
    gradient: { from: '#3b82f6', to: '#8b5cf6' },
    benefits: [
      'Never lose context between coding sessions',
      'Build on past decisions automatically',
      'Remember why you made each choice',
      'Track your learning journey over time'
    ]
  },
  team: {
    title: 'Team Projects',
    userCount: 1200,
    gradient: { from: '#10b981', to: '#3b82f6' },
    benefits: [
      'Share architectural knowledge across sessions',
      'Maintain consistency in code patterns',
      'Document decisions as they happen',
      'Onboard new team members with context'
    ]
  },
  learning: {
    title: 'Learning & Experiments',
    userCount: 1800,
    gradient: { from: '#f59e0b', to: '#ec4899' },
    benefits: [
      'Track what you tried and what worked',
      'Build a personal knowledge base',
      'Learn from past mistakes',
      'See your progress over time'
    ]
  },
  refactor: {
    title: 'Large Refactors',
    userCount: 900,
    gradient: { from: '#8b5cf6', to: '#ec4899' },
    benefits: [
      'Remember what you changed across multiple sessions',
      'Track progress on multi-day tasks',
      'Maintain context through interruptions',
      'Reference old implementations easily'
    ]
  }
};

<MagicCard
  className="max-w-2xl mx-auto p-8"
  gradientFrom={currentUseCase.gradient.from}
  gradientTo={currentUseCase.gradient.to}
  gradientSize={250}
>
  <h3 className="text-3xl font-bold mb-4">
    {currentUseCase.title}
  </h3>

  <AvatarCircles
    numPeople={currentUseCase.userCount}
    className="mb-6"
  />

  <AnimatedList delay={300} className="space-y-3">
    {currentUseCase.benefits.map((benefit, index) => (
      <div key={index} className="flex items-start gap-3">
        <CheckIcon className="text-green-400 flex-shrink-0 mt-1" />
        <p className="text-lg">
          <Highlighter
            color="#3b82f6"
            action="underline"
            strokeWidth={2}
          >
            {highlightKeyPhrase(benefit)}
          </Highlighter>
        </p>
      </div>
    ))}
  </AnimatedList>
</MagicCard>
```

**Confetti** (Selection Celebration)
```jsx
{justSelected && (
  <ConfettiButton
    options={{
      particleCount: 80,
      spread: 60,
      origin: { x: 0.5, y: 0.4 },
      colors: [
        currentUseCase.gradient.from,
        currentUseCase.gradient.to,
        '#ffffff'
      ]
    }}
  />
)}
```

#### Interactive Behavior
1. Dock icons magnify on hover (macOS-style)
2. Click icon → Card expands with selected role details
3. Magic Card spotlight follows cursor
4. Avatar Circles show user count for that role
5. Animated List reveals benefits sequentially
6. Key phrases highlighted in benefits
7. **Confetti celebration when role selected** (delight moment!)
8. Consider: "This is me!" button that triggers extra confetti

#### Implementation Notes
- Dock provides familiar, intuitive interface
- Smooth transitions between role selections (300ms)
- Avatar Circles update count with animation
- Confetti fires once per selection
- Consider adding a quiz: "Which role fits you?" → confetti on result
- Track which roles are most popular (analytics)
- Ensure dock works well on touch devices
- Mobile: Dock might need to be grid instead of horizontal

---

### Section 11: FAQ

**Winning Concept**: "Scratch to Answer" (Score: 42/50)

#### Layout
```
┌─────────────────────────────────────────────────────┐
│              [Section Heading]                       │
│                     FAQ                              │
│                                                      │
│  [Morphing Text - Common Concerns]                   │
│  "Cost?" → "Speed?" → "Privacy?" → "Storage?"        │
│                                                      │
│  ┌──────────────────┬──────────────────┐           │
│  │ [Scratch Card]   │ [Scratch Card]   │           │
│  │ ┌──────────────┐ │ ┌──────────────┐ │           │
│  │ │ Does this    │ │ │ How much does│ │           │
│  │ │ slow down    │ │ │ it cost?     │ │           │
│  │ │ Claude?      │ │ │              │ │           │
│  │ │              │ │ │ [Scratch to  │ │           │
│  │ │ [Scratch to  │ │ │  reveal]     │ │           │
│  │ │  reveal]     │ │ │              │ │           │
│  │ └──────────────┘ │ └──────────────┘ │           │
│  └──────────────────┴──────────────────┘           │
│                                                      │
│  [6 Question Cards Total - 2x3 Grid]                │
│                                                      │
│  [Revealed cards show Magic Card with Confetti]     │
│                                                      │
│  [Pulsating Button - "More Questions?"]             │
└─────────────────────────────────────────────────────┘
```

#### Component Specifications

**Morphing Text** (Common Concerns)
```jsx
<MorphingText
  texts={["Cost?", "Speed?", "Privacy?", "Storage?", "Search?", "Compatibility?"]}
  className="text-2xl font-semibold text-center mb-8 text-gray-400"
/>
```

**FAQ Data**
```javascript
const faqs = [
  {
    question: 'Does this slow down Claude?',
    answer: 'No. Memory processing happens in the background via PM2 worker service. Claude responds instantly. Zero impact on response time.',
    important: false
  },
  {
    question: 'How much does it cost?',
    answer: 'Minimal. Memory compression uses your chosen model (default: Sonnet 4.5). Typical cost: $0.01-0.05 per coding session.',
    important: false
  },
  {
    question: 'Where is data stored?',
    answer: 'Locally in ~/.claude-mem/claude-mem.db on your machine. Fully private. Never leaves your computer. You have complete control.',
    important: true, // Triggers confetti
    highlight: 'Fully private. Never leaves your computer.'
  },
  {
    question: 'Can I search my memories?',
    answer: 'Yes! 7 specialized search tools available through Claude. Search by file, concept, type, date range, or full-text query.',
    important: false
  },
  {
    question: 'Does it work with existing projects?',
    answer: 'Yes. claude-mem starts learning immediately when installed. No configuration needed. Works with any project.',
    important: false
  },
  {
    question: 'What if I want to forget something?',
    answer: 'Delete observations directly from the SQLite database, or start fresh by removing ~/.claude-mem/claude-mem.db.',
    important: false
  }
];
```

**Scratch To Reveal FAQ Cards**
```jsx
<div className="grid grid-cols-2 gap-6 max-w-4xl mx-auto">
  {faqs.map((faq, index) => (
    <div key={index} className="relative">
      <ScratchToReveal
        width={380}
        height={280}
        minScratchPercentage={45}
        gradientColors={['#1e293b', '#334155', '#475569']}
        onComplete={() => handleReveal(index, faq.important)}
      >
        <MagicCard className="h-full p-6">
          <h4 className="text-lg font-bold mb-4 text-blue-400">
            {faq.question}
          </h4>

          <p className="text-sm leading-relaxed text-gray-200">
            {faq.highlight ? (
              <Highlighter
                color="#10b981"
                action="highlight"
                strokeWidth={3}
              >
                {faq.highlight}
              </Highlighter>
            ) : (
              faq.answer
            )}
          </p>
        </MagicCard>
      </ScratchToReveal>

      {revealed[index] && faq.important && (
        <Confetti
          particleCount={60}
          angle={90}
          spread={50}
          origin={{ x: 0.5, y: 0.5 }}
          colors={['#10b981', '#3b82f6', '#ffffff']}
        />
      )}
    </div>
  ))}
</div>
```

**Pulsating Button** (More Questions)
```jsx
<PulsatingButton
  pulseColor="139, 92, 246" // Purple
  duration="2s"
  className="mx-auto mt-12"
  onClick={() => window.location.href = 'https://github.com/thedotmack/claude-mem/issues'}
>
  More Questions? Ask on GitHub
</PulsatingButton>
```

#### Interactive Behavior
1. Questions visible on scratch surface
2. User scratches card to reveal answer
3. When 45% scratched → answer revealed
4. Revealed card shows Magic Card beneath with answer
5. **Important answers (privacy) trigger Confetti celebration**
6. Highlighter emphasizes critical information
7. Track which questions get scratched first (analytics)

#### Implementation Notes
- Scratch surfaces need good contrast for question text
- Answer text should be easily readable when revealed
- Confetti fires only for "important" questions (privacy, security)
- Consider adding a "Reveal All" button for accessibility
- Scratch works on touch and mouse
- Mobile: Single column layout
- Ensure keyboard navigation alternative to scratching
- Consider fade-in animation for revealed cards

---

## BONUS: Testimonials Section

**Concept**: "Social Proof Marquee"

#### Layout
```
┌─────────────────────────────────────────────────────┐
│         What Developers Say                          │
│                                                      │
│  [Marquee - 3D Mode - Continuous Scroll]             │
│  ┌────────────────────────────────────────────────┐ │
│  │                                                 │ │
│  │  [Magic Card 1]  [Magic Card 2]  [Magic Card 3]│ │
│  │  "I used to     "It's like      "The search is │ │
│  │   spend 10min   having a        incredible."   │ │
│  │   every morning teammate..."                    │ │
│  │   explaining"                                   │ │
│  │                                                 │ │
│  │  [Shine Border on featured testimonial]        │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  [Avatar Circles - Total Developers]                 │
│  +5,000                                              │
│                                                      │
│  [Highlighter on impactful quotes]                   │
└─────────────────────────────────────────────────────┘
```

#### Implementation
```jsx
<Marquee
  pauseOnHover={true}
  vertical={false}
  repeat={3}
  className="py-8"
>
  {testimonials.map((testimonial, index) => (
    <MagicCard
      key={index}
      className="w-80 p-6 mx-4"
      gradientFrom="#3b82f6"
      gradientTo="#8b5cf6"
    >
      {testimonial.featured && (
        <ShineBorder
          color={["#10b981", "#3b82f6"]}
          borderWidth={2}
        />
      )}

      <p className="text-lg italic mb-4">
        "<Highlighter color="#3b82f6" action="underline">
          {testimonial.highlight}
        </Highlighter> {testimonial.rest}"
      </p>

      <div className="flex items-center gap-3">
        <Avatar src={testimonial.avatar} />
        <div>
          <p className="font-semibold">{testimonial.name}</p>
          <p className="text-sm text-gray-400">{testimonial.role}</p>
        </div>
      </div>
    </MagicCard>
  ))}
</Marquee>

<AvatarCircles
  numPeople={5000}
  className="mx-auto mt-8"
/>
```

---

## Global Design System

### Color Palette
```javascript
const colors = {
  primary: {
    blue: '#3b82f6',
    purple: '#8b5cf6',
    indigo: '#6366f1'
  },
  success: {
    green: '#10b981',
    emerald: '#059669'
  },
  warning: {
    orange: '#f59e0b',
    amber: '#f59e0b'
  },
  error: {
    red: '#ef4444',
    rose: '#f43f5e'
  },
  neutral: {
    gray900: '#0a0f1e',
    gray800: '#1a1a2e',
    gray700: '#2a2a3e',
    gray600: '#3a3a4e',
    gray400: '#8a8a9e',
    gray200: '#cacade'
  }
};
```

### Typography
```javascript
const typography = {
  hero: 'text-6xl font-bold',
  h1: 'text-5xl font-bold',
  h2: 'text-4xl font-bold',
  h3: 'text-3xl font-bold',
  h4: 'text-2xl font-semibold',
  body: 'text-base leading-relaxed',
  small: 'text-sm',
  code: 'font-mono text-sm bg-gray-900 px-2 py-1 rounded'
};
```

### Spacing
```javascript
const spacing = {
  sectionPadding: 'py-20 px-6',
  cardPadding: 'p-6',
  cardGap: 'gap-6',
  stackSpacing: 'space-y-12'
};
```

### Animation Timings
```javascript
const animations = {
  fast: '200ms',
  normal: '300ms',
  slow: '500ms',
  stagger: '150ms',
  typing: '30-50ms per character',
  morphDuration: '2500-3000ms'
};
```

---

## Performance Optimization

### Lazy Loading Strategy
1. **Above the fold** (Hero): Load immediately
2. **Near viewport**: Preload when within 200px
3. **Below fold**: Lazy load on scroll
4. **Interactive elements**: Load on user interaction

### Component Loading Priority
```
Priority 1 (Immediate):
- Grid Beams (Hero background)
- Morphing Text (Hero headline)
- Orbiting Circles (Hero visualization)

Priority 2 (Fast):
- Safari mockups (Before/After)
- Text Animate (Typing effects)
- Border Beam (Highlights)

Priority 3 (Lazy):
- Scratch To Reveal (Load on viewport)
- Confetti (Load on demand)
- Particles (Load when section visible)
```

### Optimization Techniques
1. **Code splitting**: Load Magic UI components on demand
2. **Image optimization**: Use WebP, lazy load images
3. **Animation throttling**: Reduce motion for `prefers-reduced-motion`
4. **Intersection Observer**: Trigger animations on scroll
5. **Debounce**: Scratch events, hover effects

---

## Accessibility Guidelines

### WCAG 2.1 AA Compliance

**Keyboard Navigation**
- All interactive elements focusable
- Tab order logical
- Skip links for section navigation
- Escape key dismisses modals/overlays

**Screen Readers**
```jsx
// Scratch To Reveal alternative
<ScratchToReveal ariaLabel="Scratch to reveal answer">
  <div role="region" aria-live="polite">
    {answer}
  </div>
</ScratchToReveal>

// Animation alternatives
<MorphingText aria-label="Claude Never Forgets - permanent memory for Claude Code">
  {/* Visual morphing text */}
</MorphingText>
```

**Color Contrast**
- Minimum 4.5:1 for normal text
- Minimum 3:1 for large text
- Test with tools like axe, Lighthouse

**Motion Preferences**
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }

  /* Disable confetti, particles */
  .confetti, .particles {
    display: none;
  }
}
```

**Focus Indicators**
```css
:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 2px;
}
```

---

## Responsive Design Breakpoints

### Mobile First Approach

**Breakpoints**
```javascript
const breakpoints = {
  mobile: '0px',      // 0-640px
  tablet: '640px',    // 640-1024px
  desktop: '1024px',  // 1024-1536px
  wide: '1536px'      // 1536px+
};
```

### Section Adaptations

**Hero**
- Mobile: Stack vertically, reduce orbiting circles
- Tablet: Maintain layout, smaller circles
- Desktop: Full experience

**Before/After**
- Mobile: Stack vertically (Before on top, After below)
- Tablet: Side by side with smaller Safari mockups
- Desktop: Full side-by-side

**Real Examples (Timeline)**
- Mobile: Vertical timeline, tap to expand
- Tablet: Horizontal timeline, smaller orbits
- Desktop: Full arc timeline with orbits

**Installation**
- Mobile: Full-width terminal, stack steps
- Tablet: Maintain layout, smaller terminal
- Desktop: Full experience

**Use Cases (Dock)**
- Mobile: 2x2 grid instead of dock
- Tablet: Horizontal dock, smaller icons
- Desktop: Full dock with magnification

---

## Analytics & Tracking

### Key Metrics to Track

**Engagement**
- Section scroll depth
- Time spent per section
- Interactive element usage (scratch cards, dock clicks)
- Confetti trigger count

**Conversion**
- Installation section CTR
- Copy button clicks
- GitHub link clicks
- "Get Started" button clicks

**User Behavior**
- Which use case selected most
- Which FAQ questions scratched first
- Which examples viewed longest
- Search demo interaction rate

### Implementation
```javascript
// Example event tracking
const trackEvent = (category, action, label) => {
  if (typeof gtag !== 'undefined') {
    gtag('event', action, {
      event_category: category,
      event_label: label
    });
  }
};

// Usage
<PulsatingButton
  onClick={() => {
    trackEvent('CTA', 'click', 'Get Started Hero');
    // ... navigation
  }}
>
  Get Started
</PulsatingButton>
```

---

## Technical Implementation Notes

### Dependencies
```json
{
  "dependencies": {
    "react": "^18.0.0",
    "next": "^14.0.0",
    "magic-ui": "latest",
    "tailwindcss": "^3.4.0",
    "framer-motion": "^10.0.0"
  }
}
```

### Installation
```bash
# Install Magic UI
npm install magic-ui

# Install required components
npx shadcn-ui@latest add morphing-text
npx shadcn-ui@latest add orbiting-circles
npx shadcn-ui@latest add scratch-to-reveal
npx shadcn-ui@latest add safari
npx shadcn-ui@latest add arc-timeline
npx shadcn-ui@latest add grid-beams
npx shadcn-ui@latest add magic-card
npx shadcn-ui@latest add border-beam
npx shadcn-ui@latest add shine-border
npx shadcn-ui@latest add dock
npx shadcn-ui@latest add confetti
npx shadcn-ui@latest add pulsating-button
npx shadcn-ui@latest add aurora-text
npx shadcn-ui@latest add highlighter
npx shadcn-ui@latest add animated-list
npx shadcn-ui@latest add text-animate
npx shadcn-ui@latest add marquee
npx shadcn-ui@latest add avatar-circles
```

### File Structure
```
landing-page/
├── components/
│   ├── sections/
│   │   ├── Hero.tsx
│   │   ├── BeforeAfter.tsx
│   │   ├── RealExamples.tsx
│   │   ├── HowItWorks.tsx
│   │   ├── WhatGetsRemembered.tsx
│   │   ├── PowerfulSearch.tsx
│   │   ├── TheNumbers.tsx
│   │   ├── Installation.tsx
│   │   ├── UnderTheHood.tsx
│   │   ├── UseCases.tsx
│   │   └── FAQ.tsx
│   ├── ui/
│   │   └── [Magic UI components]
│   └── shared/
│       ├── SectionWrapper.tsx
│       └── Container.tsx
├── lib/
│   ├── constants.ts
│   ├── data.ts
│   └── utils.ts
├── public/
│   ├── images/
│   └── icons/
└── pages/
    └── index.tsx
```

---

## Testing Checklist

### Browser Testing
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Edge (latest)
- [ ] Mobile Safari (iOS)
- [ ] Chrome Mobile (Android)

### Device Testing
- [ ] iPhone (Safari)
- [ ] iPad (Safari)
- [ ] Android phone (Chrome)
- [ ] Android tablet (Chrome)
- [ ] Desktop (1920x1080)
- [ ] Desktop (2560x1440)

### Functionality Testing
- [ ] All animations trigger correctly
- [ ] Scratch-to-reveal works on touch and mouse
- [ ] Confetti fires on correct events
- [ ] Copy buttons work
- [ ] Dock magnification works
- [ ] Timeline navigation works
- [ ] All links functional
- [ ] Performance acceptable (<3s LCP)

### Accessibility Testing
- [ ] Keyboard navigation works
- [ ] Screen reader friendly
- [ ] Color contrast passes WCAG AA
- [ ] Focus indicators visible
- [ ] Reduced motion respected
- [ ] Alt text on all images

---

## Launch Checklist

### Pre-Launch
- [ ] Content finalized and proofread
- [ ] All components tested in isolation
- [ ] Full page tested on all browsers
- [ ] Performance optimized (Lighthouse score >90)
- [ ] SEO meta tags added
- [ ] Open Graph images created
- [ ] Analytics tracking implemented
- [ ] A/B testing variants prepared

### Launch Day
- [ ] Deploy to production
- [ ] Verify all links work
- [ ] Test on real devices
- [ ] Monitor analytics
- [ ] Check for console errors
- [ ] Social media announcements ready

### Post-Launch
- [ ] Monitor conversion rates
- [ ] Gather user feedback
- [ ] Iterate based on data
- [ ] Create marketing assets (screenshots, videos)
- [ ] Document learnings

---

## Summary: Why This Design Works

### Storytelling Through Interaction
Every section uses components to **demonstrate** rather than **describe**:
- **Hero**: Orbiting circles show what gets remembered
- **Before/After**: Fading vs persisting shows the difference
- **Examples**: Timeline shows progression across sessions
- **Pipeline**: Layered stack shows architecture hierarchy
- **Features**: Scratch-to-reveal makes discovery engaging
- **Search**: Live demo shows actual capability
- **Metrics**: Progress bars visualize transformation
- **Installation**: Typing effect shows realistic process
- **Architecture**: Depth shows layered system
- **Use Cases**: Dock lets users find themselves
- **FAQ**: Scratching makes learning fun

### Delight at Every Turn
- **Confetti** celebrates milestones (installation complete, finding your use case, revealing important answers)
- **Pulsating buttons** draw attention to actions
- **Magic cards** with spotlights make content feel premium
- **Border beams** guide attention
- **Morphing text** keeps content dynamic

### Intuitive Understanding
- **Familiar patterns** (Safari browser, dock, terminal)
- **Visual metaphors** (orbits for data flow, layers for architecture)
- **Progressive disclosure** (scratch to reveal, animated lists)
- **Clear hierarchy** (section headings, consistent spacing)

### Conversion Optimized
- **Low friction** (copy buttons, clear steps)
- **Social proof** (avatar circles, testimonials)
- **Value demonstration** (metrics, examples, search)
- **Multiple CTAs** (hero, installation, bottom)

---

**Total Component Count**: 17 unique Magic UI components
**Average Section Score**: 43.5/50 (87%)
**Highest Scoring Sections**:
1. Use Cases (46/50) - Highest delight
2. The Numbers (45/50) - Best storytelling
3. Before/After, Real Examples, Search, Installation, Under The Hood (all 44/50)

**Implementation Timeline**: 2-3 weeks for full build with polish
**Estimated Performance**: Lighthouse score 85-95 with optimizations
**Predicted Conversion Lift**: 30-50% vs plain text landing page
