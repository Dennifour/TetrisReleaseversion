# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository is a single-file Tetris implementation: `Tetris_version1.html`. There is no build system, package manager, or test suite — HTML, CSS, and JavaScript all live in this one file (~4,500 lines) and it runs by opening it directly in a browser.

## Development workflow

- **Run**: open `Tetris_version1.html` in a browser (or serve it with any static file server, e.g. `python3 -m http.server`, if testing features that need a non-`file://` origin such as fullscreen or WebRTC).
- **Test/lint**: none configured. Verify changes manually in a browser — check the DevTools console for errors and exercise the affected game mode.
- There is a single `<script>` block starting around line 738; everything before it is markup/CSS for the screens, HUD, and touch controls.

## Architecture

### Rendering & game loop
- `Game` (class, ~line 1387) holds the state for one player's board: the well grid, active piece, bag, score, level, timers, etc. `Bag` implements the 7-bag randomizer with `mulberry32` (~line 1363) as a seedable PRNG (used so both peers in a networked match see the same piece sequence).
- `render(g, opp)` (~line 2151) draws a `Game` instance to `<canvas id="cv">`. `loop(t)` (~line 2828) is the `requestAnimationFrame` driver that steps simulation and calls render each frame.
- Canvas layout is computed responsively via `computeLayout()`/`resizeCanvas()`/`solveWell()` (~line 1764), which size the well and side panels to fit the viewport, including space reserved for opponent boards in versus mode.

### Screen navigation (`.veil`/`.mi`)
- Every non-gameplay screen (Home, Play, Speed, Records, Lobby, Host, Join, Room, Settings) is a `.veil` element shown/hidden by `UI.show(id)`/`UI.back()` (~line 3704), which cross-fades between screens and consults the `PARENT` map (~line 3691) for the back target; `afterScreen(fn)` (~line 3702, `EXIT_MS=430`) delays state cleanup (like nulling `G`) until a transition finishes.
- Navigation and mode buttons use the `.mi` class: bare lowercase text, no border or fill at rest. A `::after` pseudo-element draws a single white pill (`border-radius:999px;border:1.5px solid #fff`, or `#000` in light mode) that fades/scales in on hover, focus, `:active`, or a `.on`/`.lit` state class — this is the only pill-chrome in the UI, intentionally sparse to match the reference design (bold text list, one highlighted item).
- The Room screen's player cards (`.seat-card`) are the deliberate exception to "no borders": they're a status display, not navigation, so they keep a 1px `var(--line)` border.

### Responsive list+panel split (`.split`)
- Settings (`#v-set`) and the versus lobby (`#v-lobby`) share a `.split` component: a `.rail` list of items and a `.panel-area` with one `.panel` per item. `splitSelect(splitId, itemSel, groupAttr)` (~line 4015) wires rail-item clicks to toggle the matching panel.
- Below 760px width the two stack sequentially — selecting a rail item hides the rail and shows `.panel-open`, revealing a `.panel-back` to return to the list. At 760px and up they render side-by-side (rail column + panel column) via a `min-width:760px` media query, mirroring the breakpoint pattern used elsewhere in the file.
- Settings tabs (general/video/audio/controls/online) and the lobby's server/P2P panels both use this component; `UI.openTab()` and `UI.doOnline()`/`refreshRooms()` drive it for each respectively.

### Pause menu (`#pause-menu`)
- The in-game pause overlay is a standalone `.pause-menu` element, not a `.veil` — it sits above live gameplay instead of replacing a screen, so it stays out of `UI.show()`'s screen-navigation bookkeeping (`PARENT` map, `cur`, `afterScreen` cleanup) while reusing the same `.mi.nav`/`.card` look. `UI.togglePause()`/`openPauseMenu()`/`closePauseMenu()` (~line 3781) drive it; the `pause` input action (Escape, the pad's pause button, gamepad Start) calls it.
- Solo/sprint/speed actually set `G.paused` (so `Game.tick()` stops), with resume/restart/quit-to-menu options. Versus never sets `G.paused` — the match keeps ticking for the other seats while the local menu is up — and `.pause-menu.versus` hides the restart option, since a live match isn't something one player restarts locally; quitting it calls `UI.leaveRoom()` instead of nulling `G` directly.

### Game modes
Selected via `data-go`/`data-speed` buttons on the Home/Play/Speed screens, which call `startGame(mode)` and set `Game.mode` to `"solo"` (marathon), `"sprint"` (40-line), `"speed"`, or `"versus"`. Personal bests are kept in `REC` (~line 851: `marathon`, `sprint`, `speed` per difficulty, `wins`) and persisted through `store` (~line 753, a thin `localStorage` wrapper, keys prefixed `tfx:`). `noteRun(g, won, secs)` (~line 864) updates records at the end of a run; the Records screen renders them via `UI.renderRecords()`.

### Multiplayer (versus mode)
Two connection paths, both peer-to-peer over WebRTC `RTCPeerConnection`/`DataChannel` (no game server for actual gameplay data):
- **Server-assisted**: `Room` (~line 3184, `MAX_SEATS=4`) uses a Firebase Realtime Database URL (Settings → Online) as a multi-seat lobby — the lobby's Server panel lists open rooms (name + occupancy) with a "Create room" action, leading to the Room screen.
- **P2P**: `Net` (~line 3467) manages direct `RTCPeerConnection`/`DataChannel` setup where SDP offer/answer codes are swapped by hand (copy/paste) via the Host/Join screens, plus ready state (`READY_P2P`) and win tracking (`WINS_P2P`).
- `Who` (~line 3419) tracks per-peer identity/presence. Opponent boards are mirrored into `FOES` and rendered alongside the local board; the board state synced over the DataChannel is run-length encoded rather than sent cell-by-cell.
- The Room screen (`UI.renderRoom()`) draws a `.seat-grid` of up to `MAX_SEATS` `.seat-card`s (name, win count, ready state) and a `READY?` toggle. Chat has no persistent log: `UI.renderChat()` matches an incoming `Room.chat`/P2P message to the sender's `.seat-card[data-pid]` and shows it as a `.chat-bubble` positioned above that card, auto-hiding after a few seconds; a chat icon reveals an inline compose input rather than a separate screen.

### Theming & visuals
- `THEMES` (~line 769) and `NES_PALETTES` (~line 1301) define the in-game board's color/font sets; `applyTheme()`/`palFor(g)` select the active one. `CELLS`/`OUTLINE` (~line 1249/1292) precompute per-piece cell shapes and outlines via `traceOutline()`.
- `CFG.uiTheme` (~line 776: `light`/`dark`/`system`) and `applyUiTheme()` (~line 840) independently control the *page's* light/dark mode via a `data-ui-theme` attribute on `<html>`, driving the `--bg`/`--surface`/`--fg` custom properties — separate from `THEMES`, which only affects the canvas. Settings → Video exposes this as Light/Dark/System pills.
- `#bg` is a fixed-position backdrop layer separate from the canvas; see the CSS comments near the top of the file for why it uses `isolation: isolate` and a negative `z-index`.

### Internationalization
- `LANGS = ["en","ko"]` with all strings in `I18N` (~line 903), keyed by string id with `[en, ko]` tuples. `T(key, vars)` (~line 1121) looks up the current-language string with variable interpolation (falling back to the key itself if missing); `EN(key, vars)` (~line 1131) is an English-pinned variant used for banners that shouldn't localize. `applyLang()` (~line 1138) re-renders all `[data-i18n]` elements and re-invokes `UI.renderRecords()`/`renderRoom()`/`openTab()` so dynamically-built screens pick up the new language. Add new strings to `I18N` with both languages, not just a default.

### Audio
- `Sfx` (~line 1156) is a self-contained sound-effect module (WebAudio-based, no asset files) — check it before adding new sounds rather than creating a separate audio path.

## Conventions in this file

- Comments are used sparingly and mostly to explain *why* (a CSS stacking-context choice, a layout tradeoff, a network encoding decision) — follow that style rather than restating *what* the code does.
- Config/tunable constants (speeds, kick tables, combo tables, timing constants like `LOCK_MS`, `CLEAR_MS`) are grouped near the top of the script as named `const`s — prefer adding new tunables there over inlining magic numbers.
- UI chrome stays bare-text-first: new nav/mode buttons should be `.mi` elements (no border/fill except the shared hover/selected pill), not bordered cards or filled buttons — reserve borders for status displays like `.seat-card`.
