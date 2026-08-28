# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository is a single-file Tetris implementation: `Tetris_version1.html`. There is no build system, package manager, or test suite — HTML, CSS, and JavaScript all live in this one file (~5,250 lines) and it runs by opening it directly in a browser.

## Development workflow

- **Run**: open `Tetris_version1.html` in a browser (or serve it with any static file server, e.g. `python3 -m http.server`, if testing features that need a non-`file://` origin such as fullscreen or WebRTC).
- **Test/lint**: none configured. Verify changes manually in a browser — check the DevTools console for errors and exercise the affected game mode.
- There is a single `<script>` block starting around line 1039; everything before it is markup/CSS for the menu screens, HUD, and dialogs.

## Architecture

### Rendering & game loop
- `Game` (class, ~line 1769) holds the state for one player's board: the well grid, active piece, bag, score, level, timers, etc. `Bag` (~line 1755) implements the 7-bag randomizer with `mulberry32` as a seedable PRNG (used so both peers in a networked match see the same piece sequence).
- `render(g, opp)` (~line 2533) draws a `Game` instance to `<canvas id="cv">`. `loop(t)` (~line 3210) is the `requestAnimationFrame` driver that steps simulation and calls render each frame.
- Canvas layout is computed responsively via `computeLayout()`/`resizeCanvas()`/`solveWell()`, which size the well and side panels to fit the viewport, including space reserved for opponent boards (`FOE_BAND`) in versus mode.

### Game modes
Selected via `data-go` menu buttons (`solo`/marathon, `sprint` 40-line, `speed`, `versus`) and tracked on `Game.mode`. Personal bests are kept in `REC` (`marathon`, `sprint`, `speed` per difficulty, `wins`) and persisted through `store` (a thin `localStorage` wrapper, keys prefixed `tfx:`). `noteRun(g, won, secs)` (~line 1151) updates records at the end of a run.

### Multiplayer (versus mode)
Two connection paths, both peer-to-peer over WebRTC `RTCPeerConnection`/`DataChannel` (no game server for actual gameplay data):
- **Server-assisted**: uses a Firebase Realtime Database URL (configured under Settings → Online) purely for signaling (exchanging SDP offers/answers/ICE candidates), then falls back to a direct DataChannel.
- **P2P**: connection codes are swapped by hand (copy/paste) instead of a signaling database.
- `Net` (~line 3852) manages the `RTCPeerConnection`/`DataChannel` lifecycle, ready state (`READY_P2P`), and win tracking (`WINS_P2P`). Opponent boards are mirrored into `FOES` and rendered alongside the local board.
- The board state synced over the DataChannel is run-length encoded (see the comment near line 3535 about "already flat" boards) rather than sent cell-by-cell.

### Theming & visuals
- `THEMES` (~line 1070) and `NES_PALETTES` (~line 1683) define color/font sets; `applyTheme()`/`palFor(g)` select the active one. `CELLS`/`OUTLINE` (~line 1631/1674) precompute per-piece cell shapes and outlines via `traceOutline()`.
- `#bg` is a fixed-position backdrop layer separate from the canvas; see the CSS comments near the top of the file for why it uses `isolation: isolate` and a negative `z-index`.

### Internationalization
- `LANGS = ["en","ko"]` with all strings in `I18N` (~line 1190), keyed by string id with `[en, ko]` tuples. `T(key, vars)` looks up the current-language string with variable interpolation; `applyLang()` re-renders all `[data-i18n]` elements. Add new strings to `I18N` with both languages, not just a default.

### Audio
- `Sfx` (~line 1538) is a self-contained sound-effect module (likely WebAudio-based) — check it before adding new sounds rather than creating a separate audio path.

## Conventions in this file

- Comments are used sparingly and mostly to explain *why* (a CSS stacking-context choice, a layout tradeoff, a network encoding decision) — follow that style rather than restating *what* the code does.
- Config/tunable constants (speeds, kick tables, combo tables, timing constants like `LOCK_MS`, `CLEAR_MS`) are grouped near the top of the script as named `const`s — prefer adding new tunables there over inlining magic numbers.
