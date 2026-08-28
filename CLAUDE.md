# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository is a single-file Tetris implementation: `Tetris_version1.html`. There is no build system, package manager, or test suite — HTML, CSS, and JavaScript all live in this one file (~3,230 lines) and it runs by opening it directly in a browser.

**There is currently no menu, lobby, or settings UI.** All of that was deliberately deleted (screens, styling, and the DOM-wiring code) to rebuild from scratch. What's left is the game engine itself — rendering, input, the game loop, audio, i18n, theming, and the peer-to-peer/Firebase networking — all intact and working, just with nothing on screen that calls into it yet. Opening the file today shows a blank page with only a fullscreen toggle; call `startGame("solo")` (or `"sprint"`, `"speed"`, `"versus"`) from the DevTools console to see the board render and play.

## Development workflow

- **Run**: open `Tetris_version1.html` in a browser (or serve it with any static file server, e.g. `python3 -m http.server`, if testing features that need a non-`file://` origin such as fullscreen or WebRTC).
- **Test/lint**: none configured. Verify changes manually in a browser — check the DevTools console for errors and exercise the affected game mode.
- There is a single `<script>` block starting around line 215; everything before it is markup/CSS for the board, touch controls, and the top-right fullscreen/pause icons — the only chrome that survived the menu deletion.

## Architecture

### Rendering & game loop
- `Game` (class, ~line 680) holds the state for one player's board: the well grid, active piece, bag, score, level, timers, etc. `Bag` (~line 666) implements the 7-bag randomizer with `mulberry32` as a seedable PRNG (used so both peers in a networked match see the same piece sequence).
- `render(g, opp)` (~line 1444) draws a `Game` instance to `<canvas id="cv">`. `loop(t)` (~line 2121) is the `requestAnimationFrame` driver that steps simulation and calls render each frame.
- Canvas layout is computed responsively via `layout()`/`resizeCanvas()`/`solve()`, which size the well and side panels to fit the viewport, including space reserved for opponent boards in versus mode.

### Game modes
`startGame(mode)` (~line 2105) takes `"solo"` (marathon), `"sprint"` (40-line), `"speed"`, or `"versus"` and sets `Game.mode`. Nothing in the UI calls this yet — it's the entry point whatever gets built next should wire up. Personal bests are kept in `REC` (`marathon`, `sprint`, `speed` per difficulty, `wins`) and persisted through `store` (a thin `localStorage` wrapper, keys prefixed `tfx:`). `noteRun(g, won, secs)` (~line 341) updates records at the end of a run.

### Multiplayer (versus mode)
Two connection paths, both peer-to-peer over WebRTC `RTCPeerConnection`/`DataChannel` (no game server for actual gameplay data):
- **Server-assisted**: uses a Firebase Realtime Database URL (`CFG.fbUrl`) purely for signaling (exchanging SDP offers/answers/ICE candidates), then falls back to a direct DataChannel.
- **P2P**: connection codes are swapped by hand (copy/paste) instead of a signaling database.
- `Net` (~line 2760) manages the `RTCPeerConnection`/`DataChannel` lifecycle, ready state (`READY_P2P`), and win tracking (`WINS_P2P`); `Room` (~line 2477) is the Firebase-backed multi-seat room. Both call into `UI` (~line 2985) — now a minimal object of state hooks (`tallied`, `peerJoined`, `roomGone`, etc.) with the DOM work stripped out, kept so this code still runs without throwing. There is currently no lobby UI to actually open a room or swap codes through.
- Opponent boards are mirrored into `FOES` and rendered alongside the local board. The board state synced over the DataChannel is run-length encoded rather than sent cell-by-cell.

### Theming & visuals
- `THEMES` (~line 246) and `NES_PALETTES` (~line 594) define color/font sets; `applyTheme()`/`palFor(g)` select the active one. `CELLS`/`OUTLINE` precompute per-piece cell shapes and outlines via `traceOutline()`.
- `CFG.uiTheme` (`light`/`dark`/`system`) and `applyUiTheme()` control the page's own light/dark via a `data-ui-theme` attribute on `<html>` — independent of `THEMES`, which is the board's own canvas palette. Also has nothing driving it from the UI yet.
- `#bg` is a fixed-position backdrop layer separate from the canvas; see the CSS comments near the top of the file for why it uses `isolation: isolate` and a negative `z-index`.

### Internationalization
- `LANGS = ["en","ko"]` with strings in `I18N` (~line 380), keyed by string id with `[en, ko]` tuples. `T(key, vars)` looks up the current-language string with variable interpolation (falling back to the key itself if missing); `applyLang()` re-renders all `[data-i18n]` elements. The table only holds the handful of keys still in use (in-game HUD labels, banner text, the pause/fullscreen buttons, and a few networking error strings) — add new UI back in with both languages, not just a default.

### Audio
- `Sfx` (~line 449) is a self-contained sound-effect module (WebAudio-based, no asset files) — check it before adding new sounds rather than creating a separate audio path.

## Conventions in this file

- Comments are used sparingly and mostly to explain *why* (a CSS stacking-context choice, a layout tradeoff, a network encoding decision) — follow that style rather than restating *what* the code does.
- Config/tunable constants (speeds, kick tables, combo tables, timing constants like `LOCK_MS`, `CLEAR_MS`) are grouped near the top of the script as named `const`s — prefer adding new tunables there over inlining magic numbers.
