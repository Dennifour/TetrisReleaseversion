# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository is a single-file Tetris implementation: `Tetris_version1.html`. There is no build system, package manager, or test suite — HTML, CSS, and JavaScript all live in this one file (~3,600 lines) and it runs by opening it directly in a browser.

**The file has a size budget: 150 KB was the target; it currently sits at ~156 KB** after a round of correctness fixes that cost more than the entire comment budget was worth (stripping *every* comment only reaches 151 KB). Getting back under 150 KB now means dropping a feature or flattening the source, so treat the number as a pressure, not a hard gate, and check `ls -l Tetris_version1.html` after any sizable addition.

That budget is why the in-file comments are terse one-liners and the CSS ships whitespace-collapsed. Long-form design rationale belongs *here*, in `CLAUDE.md`, not in the shipped file — this document is the archive for the "why", and the architecture sections below carry the reasoning that used to live in code comments.

## Development workflow

- **Run**: open `Tetris_version1.html` in a browser (or serve it with any static file server, e.g. `python3 -m http.server`, if testing features that need a non-`file://` origin such as fullscreen or WebRTC).
- **Test/lint**: none configured. Verify changes manually in a browser — check the DevTools console for errors and exercise the affected game mode.
- There is a single `<script>` block starting around line 556; everything before it is markup/CSS for the screens, HUD, and touch controls. The script is split into numbered sections (`/* 0 · SMALL UTILITIES */` … `/* 10 · LAYOUT */`); section 8 no longer exists and the numbering is deliberately left as-is.
- Line numbers drift constantly — search by symbol name rather than trusting any line reference in this document.

## Architecture

### Rendering & game loop
- `Game` (class) holds the state for one player's board: the well grid, active piece, bag, score, level, timers, etc. `Bag` implements the 7-bag randomizer with `mulberry32` as a seedable PRNG (used so both peers in a networked match see the same piece sequence).
- `render(g, opp)` draws a `Game` instance to `<canvas id="cv">`. `loop(t)` is the `requestAnimationFrame` driver that steps simulation and calls render each frame.
- Canvas layout is computed responsively via `computeLayout()`/`resizeCanvas()`/`solveWell()`, which size the well and side panels to fit the viewport, including space reserved for opponent boards in versus mode.

### Screen navigation (`.veil`/`.mi`)
- Every non-gameplay screen (Home, Play, Speed, Records, Lobby, Host, Join, Room, Settings) is a `.veil` element shown/hidden by `UI.show(id)`/`UI.back()`, which fades one screen out before the next in and consults the `PARENT` map for the back target; `afterScreen(fn)` (`EXIT_MS=100`) delays state cleanup (like nulling `G`) until a transition finishes.
- Navigation and mode buttons use the `.mi` class: bare lowercase text, no border or fill at rest. A `::after` pseudo-element draws a single white pill (`border-radius:999px;border:1.5px solid #fff`) that fades/scales in on hover, focus, `:active`, or a `.on`/`.lit` state class — this is the only pill-chrome in the UI, intentionally sparse to match the reference design (bold text list, one highlighted item).
- The Room screen's player cards (`.seat-row`) are the deliberate exception to "no borders": they're a status display, not navigation, so they keep a 1px `var(--line)` border.

### Responsive list+panel split (`.split`)
- Settings (`#v-set`) and the versus lobby (`#v-lobby`) share a `.split` component: a `.rail` list of items and a `.panel-area` with one `.panel` per item. `splitSelect(splitId, itemSel, groupAttr)` wires rail-item clicks to toggle the matching panel.
- Below 760px width the two stack sequentially — selecting a rail item hides the rail and shows `.panel-open`, revealing a `.panel-back` to return to the list. At 760px and up they render side-by-side (rail column + panel column) via a `min-width:760px` media query, mirroring the breakpoint pattern used elsewhere in the file.
- Settings tabs (general/video/audio/controls/online) and the lobby's server/P2P panels both use this component; `UI.openTab()` and `UI.doOnline()`/`refreshRooms()` drive it for each respectively.

### Pause menu (`#pause-menu`)
- The in-game pause overlay is a standalone `.pause-menu` element, not a `.veil` — it sits above live gameplay instead of replacing a screen, so it stays out of `UI.show()`'s screen-navigation bookkeeping (`PARENT` map, `cur`, `afterScreen` cleanup) while reusing the same `.mi.nav`/`.card` look. `UI.togglePause()`/`openPauseMenu()`/`closePauseMenu()` drive it; the `pause` input action (Escape, the pad's pause button, gamepad Start) calls it.
- Solo/sprint/speed actually set `G.paused` (so `Game.tick()` stops), with resume/restart/quit-to-menu options. Versus never sets `G.paused` — the match keeps ticking for the other seats while the local menu is up — and `.pause-menu.versus` hides the restart option, since a live match isn't something one player restarts locally; quitting it calls `UI.leaveRoom()` instead of nulling `G` directly.

### Game modes
Selected via `data-go`/`data-speed` buttons on the Home/Play/Speed screens, which call `startGame(mode)` and set `Game.mode` to `"solo"` (marathon), `"sprint"` (40-line), `"speed"`, or `"versus"`. Personal bests are kept in `REC` (`marathon`, `sprint`, `speed` per difficulty, `wins`) and persisted through `store` (a thin `localStorage` wrapper, keys prefixed `tfx:`). `noteRun(g, won, secs)` updates records at the end of a run; the Records screen renders them via `UI.renderRecords()`.

### Multiplayer (versus mode)
Two connection paths, both peer-to-peer over WebRTC `RTCPeerConnection`/`DataChannel` (no game server for actual gameplay data):
- **Server-assisted**: `Room` (`MAX_SEATS=4`) uses a Firebase Realtime Database URL (Settings → Online) as a multi-seat lobby — the lobby's Server panel lists open rooms (name + occupancy) with a "Create room" action, leading to the Room screen.
- **P2P**: `Net` manages direct `RTCPeerConnection`/`DataChannel` setup where SDP offer/answer codes are swapped by hand (copy/paste) via the Host/Join screens, plus ready state (`READY_P2P`) and win tracking (`WINS_P2P`).
- Opponent boards are mirrored into `FOES` (`mirrorFoes()`) and rendered alongside the local board; the board state synced over the wire is run-length encoded (`Grid.enc`/`Grid.dec`) rather than sent cell-by-cell — ~200 cells become ~60 chars.
- The Room screen (`UI.renderRoom()`) is a dashboard of three `.dash-panel` cards: a `.seat-grid` of up to `MAX_SEATS` `.seat-row`s (name, win count, ready/battling/spectating state), a match panel (rule picker + `READY?`/`SPECTATE` toggles), and a chat panel. Chat *does* keep a log — `UI.renderChat()` draws `Room.chat` into `#chat-log` as `.msg` bubbles with an always-visible `#chatbar` compose form. Whose line it is comes off the message key (`say()` ends it with the speaker's pid), never the display name, which is chosen and not unique.
- There is no presence/invite system. An earlier `Who` module (a `/who` heartbeat feeding an invite list) was removed as dead code — it was never started, so it only cost bytes. Don't reintroduce a `/who` node without UI to consume it.
- **Deciding the round**: `resolveRound()` calls the attack-rule match, from the loop rather than from a poll so it also covers P2P and so its timers run on their own clock. A player still alive wins by being last standing; a player who tops out does *not* get a result card immediately (`G.pending`) — two wells that stop in the same poll window would otherwise each see the other as alive and record two losses for a round that had a winner. Instead each well publishes how long it lasted (`Game.lasted()`, a duration measured on one machine, so no clock is shared) alongside its death, and every client sorts the same published numbers to name the same winner — ties by pid in a room, by `Net.role` in P2P, where both ends call each other "peer". A win is only awarded on complete information: a duration that never arrives becomes a loss rather than a guess, since two clients guessing differently would each publish a win. `TIE_SETTLE`/`TIE_CAP` bound the wait (a loss card lands ~0.8s after topping out).
- Per-seat state that must land together goes through `Room.mark()` (one PATCH) rather than several `Room.set()` calls — the death and its duration, and the round-start reset (`d`/`ms`/`b`/`rdy`/`g`), are each a set rather than a sequence.
- **Bandwidth**: the room node is read several times a second for minutes at a time, so anything constant riding along in it is paid for again on every read — keep it out. Chat lives at `/chat/<id>`, *outside* the room, and is fetched only when the room's `cq` marker (the last message's key) changes; a board omits every field still at its default and carries the seat's heartbeat with it (`Room.board()`); the poll runs at `ROOM_MS` only during a live round or when someone is ready, and `ROOM_IDLE_MS` otherwise (`Room.rate()`); the host refreshes its lobby entry on `ROOM_RELIST`/occupancy change rather than every heartbeat. Measured on two clients: idle in a room went 4.6→1.5 KB/s, and a room with 40 chat lines went 36.6→1.6 KB/s idle and 39.0→6.3 KB/s in a match. Before adding a field to the room node, check whether it belongs in the per-tick read at all.

### Theming & visuals
- `THEMES` carries font/board-color/background fields (`applyTheme()` resolves the active one into `THEME`/`CANVAS_FONT`/`INK`); per-piece tile color lives separately in `PIECE_COLOR`, a flat `{I,O,T,S,Z,J,L,G}` map. `CELLS`/`OUTLINE` precompute per-piece-shape (not per-theme) cell offsets and outline polygons via `traceOutline()`.
- `block(x,y,s,type,alpha)` is the single choke point every tile draw goes through (locked stack, active piece, hold/next previews, opponent boards) — it fills flat from `PIECE_COLOR`, or `drawImage()`s a per-piece texture from `PIECE_TILE[type]` when the player has uploaded one. Custom tiles are set in Settings → Video ("Tetromino tiles"): an upload is square-cropped and downscaled to a fixed 128×128 canvas, stored as a JPEG data URL per piece type under `CFG.tiles`/`store` — deliberately small and per-key (rather than one shared image) since `store.set()` swallows `localStorage` quota errors silently.
- The page chrome is dark-only — there is no light/system mode toggle. `--bg`/`--surface`/`--fg` etc. are plain `:root` custom properties; `THEMES`/`PIECE_COLOR`/`PIECE_TILE` only affect the canvas.
- `#bg` is a fixed-position backdrop layer separate from the canvas; see the CSS comments near the top of the file for why it uses `isolation: isolate` and a negative `z-index`.

### Internationalization
- `LANGS = ["en","ko"]` with all strings in `I18N`, keyed by string id with `[en, ko]` tuples. `T(key, vars)` looks up the current-language string with variable interpolation (falling back to the key itself if missing); `EN(key, vars)` is an English-pinned variant used for banners that shouldn't localize. `applyLang()` re-renders all `[data-i18n]` elements and re-invokes `UI.renderRecords()`/`renderRoom()`/`openTab()` so dynamically-built screens pick up the new language. Add new strings to `I18N` with both languages, not just a default.

### Audio
- `Sfx` is a self-contained sound-effect module (WebAudio-based, no asset files) — check it before adding new sounds rather than creating a separate audio path.

### Gameplay rules worth knowing before you touch them
- **Garbage**: `queueGarbage()` appends to `pendingGarbage`; `applyGarbage()` lands **at most 8 rows per piece and leaves the remainder queued**. Do not clear the whole queue after capping — that silently swallows an attack that already arrived (it was a real bug). Incoming garbage is cancelled by outgoing attack first, in `resolveClear()`.
- **180° spin**: `Game.rotate180()` is all-or-nothing — it reverts to the starting position unless *both* quarter turns land. Running `rotate(1)` twice as bare statements leaves the piece 90° over whenever the second turn is blocked (measured: 12.8% of legal positions on random stacks).
- **Lock**: `LOCK_MS=500` with 15 lock resets (`touchLockReset()`); past 15 the piece locks at half the delay. Lock-out is "no cell of the piece inside the visible well", checked before the piece is written to the board.
- **Clear animation**: the board collapses immediately so the next piece has real ground, but `clearing.board` holds a snapshot with only the cleared rows blanked, drawn for `CLEAR_MS` so the drop reads as a beat. Nothing reads it back — it is scenery.
- **Countdown**: `COUNT`/`startHoldEnd` are read off the wall clock, not frames, so a throttled tab can't stretch them; `G.startedAt` is held at "now" throughout, so `lasted()` measures play and not the wait.
- **Board give**: `FX.bump()`/`FX.thud()` drive two different springs (`BOB_STIFF`/`BOB_DAMP` for the fall, `BOB_UP_*` for the slower return) — the asymmetry is the point; a symmetric spring reads as a twitch. Measured in cells, so the feel is size-independent.

### Things that were broken once and are easy to break again
- **Lifecycle races**: `dropBoard()` holds its pending timer in `boardDrop` and checks the well it was armed for is still on screen; `startGame()` clears it. Without both, quitting and starting again inside `BOARD_FADE_MS` let the old timer null the *new* run and the board went blank.
- **Armed listeners**: a rebind row parks `BINDING`/`Pad.watching` on the next key or button. `UI.leaving()` (called from `show()` on every screen change) disarms them via `cancelBind()`. Left armed, the next key pressed anywhere — mid-game included — was silently rebound.
- **Anything off the wire is untrusted**: `queueGarbage()` caps a single message at `COLS*2` rows and `fitBoard()` cuts or pads a peer board to `COLS*VIS_ROWS`. A peer once queued a billion garbage lines.
- **User text needs `overflow-wrap`**: chat bubbles, seat names and room names all carry break/ellipsis rules. One 120-character run with no spaces used to push the room screen ~750px off the side of a phone.
- **Grid tracks need `minmax(0,1fr)`**: a plain `1fr` keeps its automatic minimum, so a long name widened the row instead of ellipsing inside it.
- **Canvas labels need room**: `solveWell()` sizes the gap between stacked opponent boards to fit the name drawn under each one, and `drawSide()` measures its available width from `rx`, not the whole column.
- **Scheduled sounds outlive their run**: `Sfx` gates its queued notes on a generation that `Sfx.hush()` bumps, called from `startGame()` and `dropBoard()`.

### Input
- Every control path (keyboard, gamepad, on-screen pad, swipe gestures) funnels through `Input.press`/`Input.release` — that single door is where the countdown and a finished run are locked out. Don't call `Game` methods directly from a new input source.
- `Pad.poll()` is driven from the frame loop *and* from a slow `setInterval` that covers the menus; the loop only runs while a well exists, so without that interval a gamepad rebind row would wait forever for a button it never read.
- DAS/ARR live in `Input.tick`; `CFG.arr<=0` means instant shift to the wall.

## Conventions in this file

- **Comments are terse one-liners, and only for the genuinely non-obvious** (a device-pixel rounding rule, a network ordering constraint, a CSS stacking-context choice). This is a size constraint, not a style preference — see the 150 KB budget above. If a decision needs a paragraph to justify, that paragraph goes in `CLAUDE.md` and the code gets one line pointing at the constraint. Never restate *what* the code does.
- Config/tunable constants (speeds, kick tables, combo tables, timing constants like `LOCK_MS`, `CLEAR_MS`) are grouped near the top of the script as named `const`s — prefer adding new tunables there over inlining magic numbers.
- UI chrome stays bare-text-first: new nav/mode buttons should be `.mi` elements (no border/fill except the shared hover/selected pill), not bordered cards or filled buttons — reserve borders for status displays like `.seat-row`.
