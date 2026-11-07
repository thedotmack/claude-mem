import { useEffect, useRef } from 'react'
import { CmemMark } from '@/components/brand'
import { SparklesCore } from '@/components/aceternity/sparkles'
import type { SetupTool } from '../setup-data'
import chatgptMark from '../assets/agents/chatgpt.webp'
import claudeMark from '../assets/agents/claude.webp'
import geminiMark from '../assets/agents/gemini.webp'
import { prefersReducedMotion } from '../format'

/** The launch tokens are brand images, as in PROTO: Claude Code flies in as the Claude mark, Codex CLI as the OpenAI mark. */
const TOKEN_IMAGES: Record<SetupTool['mark'], string> = { terminal: claudeMark, codex: chatgptMark, chatgpt: chatgptMark, claude: claudeMark, gemini: geminiMark }

/**
 * Step 7 (PROTO finish-setup.js `animateLaunch`, Web Animations): the picked tools gather at the brain's edges and are
 * drawn into its center, then the brain folds away. Reduced motion never mounts this step (the page skips to the workspace).
 */
export function LaunchScreen({ tools, onDone }: { tools: SetupTool[]; onDone: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const brainRef = useRef<HTMLSpanElement>(null)
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone })
  useEffect(() => {
    const stage = stageRef.current!
    const brain = brainRef.current!
    if (prefersReducedMotion()) { doneRef.current(); return }
    const radius = Math.min(stage.clientWidth * 0.38, 220)
    const tokens: HTMLImageElement[] = []
    const animations = tools.map((tool, index) => {
      const angle = (index / tools.length) * Math.PI * 2 - Math.PI / 2
      const [x, y, edgeX, edgeY] = [Math.cos(angle) * radius, Math.sin(angle) * radius, Math.cos(angle) * 72, Math.sin(angle) * 72]
      const token = document.createElement('img')
      token.className = 'launch-token'
      token.src = TOKEN_IMAGES[tool.mark]
      token.alt = ''
      stage.append(token)
      tokens.push(token)
      return token.animate([
        { opacity: 0, transform: `translate(-50%,-50%) translate(${x}px,${y}px) scale(.9)` },
        { opacity: 1, transform: `translate(-50%,-50%) translate(${edgeX}px,${edgeY}px) scale(1)`, offset: 0.65 },
        { opacity: 0, transform: 'translate(-50%,-50%) scale(0)' },
      ], { duration: 1500, delay: index * 80, easing: 'cubic-bezier(.22,.8,.2,1)', fill: 'forwards' })
    })
    animations.push(brain.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.12)', opacity: 1, offset: 0.7 }, { transform: 'scale(.3)', opacity: 0 }], { duration: 1950, easing: 'ease-in-out', fill: 'forwards' }))
    let cancelled = false
    Promise.all(animations.map((animation) => animation.finished)).then(() => { if (!cancelled) doneRef.current() }, () => {})
    return () => { cancelled = true; animations.forEach((animation) => animation.cancel()); tokens.forEach((token) => token.remove()) }
  }, [tools])
  return (
    <section aria-labelledby="launch-title">
      <h1 id="launch-title" className="sr-only" tabIndex={-1}>Opening your memory workspace</h1>
      <p className="sr-only" role="status" aria-live="polite">Bringing your tools and memory together.</p>
      <div ref={stageRef} className="launch-stage">
        {/* One sparkle field behind the brain while the tools gather; reduced motion never reaches this step. */}
        <SparklesCore className="launch-sparkles" background="transparent" particleColor="#5b57e6" minSize={0.6} maxSize={1.6} particleDensity={90} speed={2} />
        <span ref={brainRef} className="launch-brain"><CmemMark className="size-full" /></span>
      </div>
    </section>
  )
}
