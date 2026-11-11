---
name: dashboard-chat-best-practices
description: Apply dashboard-grade chat UX patterns in the Eve chat template. Use when changing Next.js Cache Components/PPR behavior, static shell layout, Suspense bootstrap boundaries, theme hydration, auth display hydration, signed-in/signed-out static shell behavior, optimistic messages, streaming row identity, composer/sidebar interactions, thinking/tool rendering, responsive styling, visual polish, or Vercel dashboard chat comparisons.
---

# Dashboard Chat Best Practices

## Overview

Use this skill to keep the template's web chat feeling like a polished dashboard surface: stable, quiet, fast to first paint, and predictable under streaming state.

## Product Shape

- Build the actual chat surface, not a marketing page. The first screen should be a usable composer, sidebar, or chat route.
- Keep the aesthetic restrained and work-focused: dense but readable spacing, quiet borders, predictable controls, and minimal decoration.
- Prefer existing shadcn/Tailwind primitives and local components over new abstractions.
- Use icons for compact commands, with accessible labels/tooltips. Avoid explanatory in-app text for behavior that good controls can imply.

## Cache Components And PPR Basics

- Keep `cacheComponents: true` enabled in `next.config.ts`. Treat the chat route as a static shell with dynamic data streamed into Suspense boundaries.
- Keep the shell cheap and deterministic. Do not make `app/(chat)/layout.tsx` wait on auth, database, chat history, or per-chat data before rendering the shell.
- Pass cheap initial state into `AgentChatShell`: empty history, `initialNextCursor: null`, `viewer: null`, and `getInitialSetupStatus()`.
- Load expensive or request-bound data inside hidden Suspense children: `ResolvedChatBootstrap` for setup/viewer/sidebar history and `ExistingChat` for active chat data.
- Use sync components to hand resolved server data to the client shell. `AgentChatBootstrapSync` should update setup status, viewer, and history. `AgentChatRouteSync` should update the active chat for the current route.
- Keep Suspense fallbacks `null` for these sync boundaries when the visible shell already has stable placeholders. Do not add loading panels that push the chat frame around.
- Do not call `notFound()` until the dynamic boundary has enough real viewer/setup/chat data to prove the chat is inaccessible. The outer shell should still render while that decision is loading.
- Keep root and session routes visually distinct but structurally compatible. The root page can center the composer; the session page can pin it near the bottom. Both should live inside the same shell.
- Treat PPR/static shell work as a latency feature and a correctness feature. The goal is first paint without auth/database blocking, then precise data reconciliation after bootstrap.

## Static Shell And Hydration

- Preserve the shell-first strategy. `AgentChatShell` should paint the sidebar frame, top controls, and route body before auth, setup, or chat history finishes loading.
- Keep bootstrap data out of the blocking route path. Use hidden Suspense sync components to hydrate setup status, viewer, sidebar history, and active chat data.
- Preserve theme pre-hydration. Theme should be resolved before React paints so dark/light mode does not flash or mismatch.
- Preserve auth display pre-hydration. The `eve_logged_in` cookie is a display hint only; the head script sets `data-eve-auth-display` so CSS can hide the wrong signed-in/signed-out branch before viewer data resolves.
- Never treat the auth hint as authority. Server actions, chat loading, Eve auth, and rate limits must use the real Better Auth session.
- Keep `suppressHydrationWarning` only where it protects known pre-hydration document mutations such as theme/auth display hints.

## Same Route, Signed In Or Out

- Render one shared route shell for signed-in and signed-out states. Do not fork the page into separate auth routes just to show different controls.
- While bootstrap is loading, render both possible placeholders inside `AuthDisplayLoggedIn` and `AuthDisplayLoggedOut`; let the document dataset hide the wrong branch.
- For signed-out users, show the Sign in affordance immediately. For signed-in users, show a neutral user-menu placeholder instead of flashing Sign in.
- After bootstrap resolves, render from real `viewer` state: `viewer ? <UserMenu /> : <SidebarSignInButton />`.
- When a signed-out user submits text, save the draft to `sessionStorage`, open the auth modal, and restore the draft after sign-in.

## Optimistic Messaging And Row Identity

- Show an optimistic user bubble immediately on send, but keep persisted Eve events as the source of truth.
- Clear the optimistic user bubble only when the reduced event log contains the real latest user message.
- Keep live chat state centralized where possible. Avoid rendering from multiple competing sources in the same frame.
- Prefer stable row identities for streaming responses. A "thinking" or "streaming reply" row should become the assistant row without remounting into a different component path.
- Use a separate thinking presence only when there is no meaningful assistant text yet or a turn is still finalizing. Fade it out rather than abruptly removing it.
- Avoid letting final snapshot writes fight live state. During streaming, prefer the live source; after settle, reconcile with the canonical snapshot.

## Composer And Sidebar

- Keep `ChatComposer` controlled by the page: `value`, `onChange`, `onSubmit`, `disabled`, `disabledReason`, `isBusy`, and `isPreparing`.
- Enter should submit. Shift+Enter should insert a newline. Disabled states should expose actionable tooltip text.
- Busy state should show Stop. Preparing state should show a spinner. Empty or over-limit input should disable send without moving layout.
- Root and session pages can place the composer differently, but they should share the same component and control contract.
- Persist desktop sidebar open state in a cookie and write a pre-hydration document hint to avoid open-then-collapse flicker.
- Keep sidebar history cursor-paginated and optimistic. Use `touchChat`, `removeChat`, and title updates for sidebar state; do not make sidebar state the transcript source of truth.
- Keep mobile sidebar overlay behavior separate from desktop persistent state.

## Message Rendering

- Render user messages as compact right-aligned bubbles. Render assistant text as full-width left-aligned prose.
- Use Streamdown for assistant markdown. Keep code blocks, lists, and inline code readable in both themes.
- Group related dynamic tool parts into compact rows. Expand details only when there is useful input, output, error, or HITL control.
- Render reasoning as a collapsible block. Label active reasoning as "Thinking..." and settled reasoning as "Reasoning".
- Render connection authorization as a structured card, not prose embedded in assistant text.
- Keep text inside controls and cards from overflowing at mobile widths. Prefer stable dimensions for buttons, tool rows, counters, and composer controls.

## Styling Rules

- Use the existing token system: `background`, `foreground`, `muted`, `border`, `card`, `accent`, and local opacity patterns.
- Keep cards modest. Do not nest cards inside cards. Use cards for messages, modals, repeated items, or framed controls, not whole-page decoration.
- Keep radius consistent with the template. Avoid large pill shapes unless the local component already uses them.
- Avoid large decorative gradients, orbs, blobs, and marketing-style hero layouts in the chat app.
- Use lucide icons when an icon exists. Add `aria-label` for icon-only buttons and tooltip text where meaning is not obvious.
- Avoid layout shifts from loading, hover, or stream state. Reserve stable space for composer controls, sidebar rows, auth placeholders, and thinking/tool rows.

## Verification

- Run `pnpm typecheck` and `pnpm build` after UI or app-router changes.
- Manually check root signed-out, root signed-in, auth modal draft restore, first-message navigation, follow-up optimistic send, streaming assistant row, Connect/Skip auth cards, theme first paint, desktop sidebar cookie restore, and mobile sidebar overlay when touched.
- Use screenshots or browser checks for visual changes across desktop and mobile. Watch specifically for auth flicker, theme flash, composer jumps, sidebar jumps, and message remount flicker.
