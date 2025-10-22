# Magic UI Components Catalog

Complete catalog of Magic UI components with descriptions and use cases.

## Animation Components

### 1. **Animated List**
- **Purpose**: Animates list items sequentially with delay
- **Use Case**: Showcasing events, notifications, feature lists
- **Key Props**: `delay` (ms between items)
- **Effect**: Staggered reveal animation

### 2. **Text Animate**
- **Purpose**: Sophisticated text animation effects
- **Animation Types**:
  - `blurIn` - Characters fade from blur
  - `slideUp` - Words slide up
  - `scaleUp` - Text scales up
  - `fadeIn` - Lines fade in
  - `slideLeft` - Characters slide from left
- **Animate By**: `character`, `word`, `text`, `line`
- **Use Case**: Hero headlines, feature announcements, storytelling
- **Customization**: Delay, duration, custom motion variants

### 3. **Flip Text**
- **Purpose**: Vertical flip animation for text
- **Key Props**: `duration`, `delayMultiple`, custom variants
- **Use Case**: Eye-catching headlines, call-to-actions

### 4. **Morphing Text**
- **Purpose**: Dynamic text transitions between multiple strings
- **Key Props**: `texts` array (strings to morph between)
- **Use Case**: Dynamic value propositions, rotating benefits

### 5. **Word Rotate**
- **Purpose**: Vertical rotation of words
- **Key Props**: `words` (string array), `duration` (2500ms default)
- **Use Case**: Rotating feature names, dynamic headlines

### 6. **Aurora Text**
- **Purpose**: Beautiful aurora text effect
- **Key Props**: `colors` array, `speed` multiplier
- **Default Colors**: `["#FF0080", "#7928CA", "#0070F3", "#38bdf8"]`
- **Use Case**: Premium headlines, brand emphasis

## Visual Effect Components

### 7. **Orbiting Circles**
- **Purpose**: Circles moving in orbit along circular paths
- **Key Props**:
  - `radius` (orbit size)
  - `duration` (animation speed)
  - `reverse` (direction)
  - `delay`, `path` (show orbit path)
  - `iconSize`, `speed`
- **Use Case**: Technology visualization, ecosystem diagrams, feature satellites

### 8. **Particles**
- **Purpose**: Animated particle background with depth and interactivity
- **Use Case**: Hero sections, immersive backgrounds

### 9. **Confetti**
- **Purpose**: Celebration confetti effect
- **Key Props**:
  - `particleCount`, `angle`, `spread`
  - `startVelocity`, `decay`, `gravity`
  - `colors`, `shapes` (square, circle, star)
  - `origin` point
- **Includes**: `ConfettiButton` wrapper component
- **Use Case**: Success states, milestones, achievements

### 10. **Border Beam**
- **Purpose**: Animated beam effect along borders
- **Key Props**: `reverse`, spring animations
- **Use Case**: Card highlights, section emphasis

### 11. **Shine Border**
- **Purpose**: Animated shining border effect
- **Key Props**: `color` array, `borderWidth`, `duration`
- **Use Case**: Premium cards, CTAs, feature boxes

### 12. **Magic Card**
- **Purpose**: Spotlight effect following mouse cursor with border highlights
- **Key Props**:
  - `gradientSize` (200 default)
  - `gradientColor` (#262626 default)
  - `gradientOpacity` (0.8)
  - `gradientFrom`/`gradientTo` (border colors)
- **Use Case**: Interactive feature cards, pricing tables

## Background Components

### 13. **Grid Beams**
- **Purpose**: Dynamic grid background with animated light beams
- **Key Props**:
  - `gridSize` (40px default)
  - `gridColor` (rgba)
  - `rayCount` (15 default)
  - `rayOpacity` (0.35)
  - `raySpeed`, `rayLength` (45vh)
  - `gridFadeStart`/`gridFadeEnd` (%)
  - `backgroundColor`
- **Use Case**: Hero sections, feature backgrounds, immersive layouts

### 14. **Warp Background**
- **Purpose**: Warped perspective grid effect
- **Key Props**:
  - `perspective` (depth)
  - `beamsPerSide` (4 default)
  - `beamSize` (thickness)
  - `beamDuration` (speed)
  - `gridColor`
- **Use Case**: Futuristic hero sections, tech-focused pages

### 15. **Dot Pattern**
- **Purpose**: Customizable dotted background pattern (SVG)
- **Key Props**: `width`, `height`, `cx`, `cy`, `cr` (dot radius)
- **Effects**: Supports glow effects
- **Use Case**: Subtle backgrounds, section dividers

## Interactive Components

### 16. **Dock**
- **Purpose**: macOS-style dock with magnification effect
- **Key Props**:
  - `iconMagnification` (zoom amount)
  - `iconDistance` (hover range)
  - `direction` (middle, start, end)
- **Child Component**: `DockIcon`
- **Use Case**: Navigation, tool showcases, social links

### 17. **Scratch To Reveal**
- **Purpose**: Interactive scratch-off effect revealing hidden content
- **Key Props**:
  - `width`, `height`
  - `minScratchPercentage` (50 default, completion threshold)
  - `onComplete` callback
  - `gradientColors`
- **Use Case**: Interactive reveals, gamification, teasers

### 18. **Highlighter**
- **Purpose**: Animated text highlighting and underlining
- **Key Props**:
  - `color`
  - `strokeWidth`
  - `action` (underline, highlight)
  - `animationDuration`
  - `iterations`, `padding`
- **Use Case**: Emphasis on key phrases, call-outs

## Layout/Display Components

### 19. **Marquee**
- **Purpose**: Scrolling content (horizontal or vertical)
- **Key Props**:
  - `reverse` (direction)
  - `pauseOnHover`
  - `vertical` (orientation)
  - `repeat` (count)
- **Effects**: 3D perspective option
- **Use Case**: Testimonials, logo clouds, infinite scrollers

### 20. **Safari**
- **Purpose**: Safari browser mockup for showcasing
- **Key Props**:
  - `url` (address bar)
  - `imageSrc` or `videoSrc`
  - `width` (1203 default), `height` (753)
  - `mode` (default, simple)
- **Use Case**: Product demos, website previews

### 21. **Bento Grid**
- **Purpose**: Grid layout for organizing content
- **Use Case**: Feature showcases, portfolios

### 22. **Avatar Circles**
- **Purpose**: Overlapping circles of avatars
- **Key Props**: `numPeople` (99 default, shown in last circle)
- **Use Case**: Social proof, team displays, user counts

## Timeline Components

### 23. **Arc Timeline**
- **Purpose**: Curved timeline visualizing milestones
- **Key Props**:
  - `data` (array of {time, title})
  - `arcConfig`:
    - `circleWidth` (5000 default)
    - `angleBetweenMinorSteps` (0.35)
    - `lineCountFillBetweenSteps` (10)
    - `boundaryPlaceholderLinesCount` (50)
  - `defaultActiveStep` ({time, stepIndex})
- **Use Case**: Project roadmaps, product evolution, version history

## Button Components

### 24. **Shiny Button**
- **Purpose**: Button with shiny effect
- **Features**: Dark/light mode support
- **Use Case**: Primary CTAs, important actions

### 25. **Pulsating Button**
- **Purpose**: Button with pulsing wave animation
- **Key Props**: `pulseColor` (RGB), `duration`
- **Use Case**: Attention-grabbing CTAs, urgent actions

### 26. **Rainbow Button**
- **Purpose**: Rainbow gradient button effect
- **Variants**: Default, Outline
- **Use Case**: Premium CTAs, playful actions

## Theme Components

### 27. **Animated Theme Toggler**
- **Purpose**: Smooth animated light/dark mode toggle
- **Built With**: Tailwind CSS
- **Use Case**: Theme switching UI

---

## Installation

```bash
# Via CLI (recommended)
npx shadcn-ui@latest add [component-name]

# Manual installation
npm install magicui
# or
yarn add magicui
```

## Component Categories Summary

| Category | Components | Best For |
|----------|-----------|----------|
| **Text Animation** | Animated List, Text Animate, Flip Text, Morphing Text, Word Rotate, Aurora Text | Headlines, feature lists, dynamic content |
| **Visual Effects** | Orbiting Circles, Particles, Confetti, Border Beam, Shine Border, Magic Card | Visual interest, interactivity, emphasis |
| **Backgrounds** | Grid Beams, Warp Background, Dot Pattern | Hero sections, immersive layouts |
| **Interactive** | Dock, Scratch To Reveal, Highlighter | User engagement, gamification |
| **Layout** | Marquee, Safari, Bento Grid, Avatar Circles | Content organization, showcases |
| **Timeline** | Arc Timeline | Roadmaps, history, progression |
| **Buttons** | Shiny Button, Pulsating Button, Rainbow Button | CTAs, actions |
| **Utility** | Animated Theme Toggler | UI controls |

## Design Philosophy

Magic UI components focus on:
- **Delight**: Unexpected animations that create joy
- **Fluidity**: Smooth, natural motion
- **Performance**: Optimized for web performance
- **Flexibility**: Highly customizable via props
- **Modern**: Built with React, Tailwind CSS, Framer Motion

## Use Case Recommendations by Landing Page Section

### Hero Sections
- Grid Beams or Warp Background (background)
- Aurora Text or Morphing Text (headline)
- Pulsating Button or Rainbow Button (CTA)
- Orbiting Circles (tech visualization)

### Feature Showcases
- Bento Grid (layout)
- Magic Card (individual features)
- Animated List (feature details)
- Highlighter (emphasis)

### Social Proof
- Marquee (testimonials/logos)
- Avatar Circles (user counts)

### Product Demos
- Safari (browser mockups)
- Border Beam or Shine Border (emphasis)

### Roadmaps/Progress
- Arc Timeline (milestones)

### Interactive Elements
- Scratch To Reveal (teasers)
- Dock (navigation/tools)
- Confetti (celebrations)
