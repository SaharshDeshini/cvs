# Design direction (Phase 3)

Researched against the quality bar of LeetCode / CodeChef / Python Tutor (observations, not copies): a
two-pane workspace with a persistent control bar, current-line highlight, and a visualization that changes in
place. What those tools lack for our purpose: Python Tutor's output is small and static-looking; LeetCode's
chrome competes with the content. We want the **execution to be the hero**.

## Concept: "lab bench"

The program is a specimen under observation. The right pane is an instrument readout, not a dashboard:

- **Warm-dark graphite** surfaces (never pure black), a single hierarchy of three elevations.
- **Lime** = *where execution is now* (current line, current frame, active step). Lime means "now", nowhere else.
- **Cyan** = *what just changed* (a variable's value flashes cyan once when it changes). Cyan means "changed"; periwinkle is for pointers and arrows.
- **Coral** = problems (compile errors, crashes, leaks), orange = warnings. A deep teal-slate base for everything inert.
- Type: a serif wordmark ("CVis") against monospace code and data; the contrast gives the tool a voice without a
  web font download (system serif + system monospace stacks only; works offline).
- The call stack grows **upward**: the current frame is on top and raised (lime rule), callers sit below it and
  recede. Recursion reads as a tower.
- Motion only explains change: a value flash (opacity/background, 600 ms), frame cards entering with a short
  transform. `prefers-reduced-motion` turns it all off.

## Layout

```
┌ CVis ────────────────────────────────────────── status chip ┐
│  C++ editor (CodeMirror 6)   │  stack of frame cards        │
│  current line = lime band   │  ─────────────────────────   │
│  error lines = coral         │  output / errors             │
│  ▸ stdin (collapsible)       │                              │
├ ▶ Run │ ◀ │ ▶/⏸ │ ▶ │ ⟲ │ ━━━●━━━ scrubber │ step 4/12 │ speed ┤
```

Below 900 px the panes stack. Dark theme first (roadmap); a light theme is a token swap later.

## States designed on purpose

empty (hint + shortcut), loading (named phases of work, not a spinner alone), ready, compile error (list with line
numbers; lines marked in the editor), runtime error / timeout / truncated (banner naming the line, trace still
steppable), backend unreachable, stale (code edited after the run: highlights hidden, banner says so).

## Keyboard

`Ctrl/Cmd+Enter` run · `Alt+←/→` step (skipped when the editor already used the key, e.g. macOS word movement) · outside text fields: `←/→` step, `Space`
play/pause, `Home` reset.

## Accessibility

Real `<button>`s with labels, the status chip is the only `aria-live` region (the step readout is deliberately not:
at 8x it would announce every step), the scrubber is a labelled range input with `aria-valuetext`, visible focus
rings, motion respects `prefers-reduced-motion`. All program-derived text (variable names, values, stdout) is
rendered as React text nodes, never as HTML.

**Not verified:** colour contrast was chosen by eye in OKLCH and has **not** been measured against WCAG ratios
(the dim grey used for types and line numbers is the likeliest to fail); no real screen reader was used.
