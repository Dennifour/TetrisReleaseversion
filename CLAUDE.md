# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository is a single-file Tetris implementation: `Tetris_version1.html`. There is no build system — HTML, CSS, and JavaScript all live in this one file and it runs by opening it directly in a browser. There *is* now a test suite: see **Tests** below.

**The file has a size budget: 150 KB was the target; it currently sits at ~172 KB** after a round of correctness fixes that cost more than the entire comment budget was worth (stripping *every* comment only reaches 151 KB). Getting back under 150 KB now means dropping a feature or flattening the source, so treat the number as a pressure, not a hard gate, and check `ls -l Tetris_version1.html` after any sizable addition.

That budget is why the in-file comments are terse one-liners and the CSS ships whitespace-collapsed. Long-form design rationale belongs *here*, in `CLAUDE.md`, not in the shipped file — this document is the archive for the "why", and the architecture sections below carry the reasoning that used to live in code comments.

## Development workflow

- **Run**: open `Tetris_version1.html` in a browser (or serve it with any static file server, e.g. `python3 -m http.server`, if testing features that need a non-`file://` origin such as fullscreen or WebRTC).
- **Test**: `npm test` (node's built-in runner plus Playwright). See **Tests** below. Still worth a manual pass in a browser for anything visual.
- There is a single `<script>` block; everything before it is markup/CSS for the screens, HUD, and touch controls. The numbered section banners this file used to describe (`/* 0 · SMALL UTILITIES */` …) are not present in this build — do not go looking for them.
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
Two connection paths, and they are **not** the same technology — an easy thing to get wrong:
- **Server-assisted ("room")**: plain REST plus Server-Sent Events against a Firebase Realtime Database URL (Settings → Online). No WebRTC, and deliberately no Firebase SDK — the SDK's `onDisconnect()` would be the textbook presence fix but costs ~200 KB against a 150 KB budget and breaks the open-from-disk model.
- **P2P**: `Net` manages direct `RTCPeerConnection`/`DataChannel` setup where SDP offer/answer codes are swapped by hand (copy/paste) via the Host/Join screens, plus ready state (`READY_P2P`) and win tracking (`WINS_P2P`).

Room mode is four units with one-way dependencies, replacing a single `Room` object that mixed all four concerns and was mutated from six-plus code paths:
- **`Sig`** — transport only. `stream(path,cb)` over `EventSource`; `get/put/patch/del` **awaited with bounded retry**; `cas(path,fn)` doing `X-Firebase-ETag` → `if-match`, retried on 412. The old `FB` made every state-carrying write fire-and-forget with a swallowed catch, which is what made the room unreliable: a dropped death publication left a round with *no winner at all*, because every client waited out `TIE_CAP` and then called `lose()`.
- **`RoomState`** — a pure reducer, the single writer of room state. `apply(ev)` then `view(nowMs)`. No I/O, no DOM, no timers, so it is testable on its own.
- **`RoomClient`** — lifecycle, heartbeat, round management, garbage delivery. The only mutable session state.
- **`RoomView`** — rendering, with a signature check because it now runs on every stream event rather than once per poll.

Data model (`live` is split from `seat` so board frames do not churn the node the lobby and seat list read):

```
/lobby/{id}                   {n, t, c}          t refreshed by ANY occupant, not just the host
/rooms/{id}/meta              {h, r}
/rooms/{id}/seat/{pid}        {n, j, hb, rdy, spec, w}
/rooms/{id}/live/{pid}        {b, p, o, ms}
/rooms/{id}/go                {s, r, at, roster}
/rooms/{id}/gb/{pid}/{msgId}  n
/chat/{id}/{key}              {n, m}
```

- **The host freezes `roster` into `/go`.** Every client then judges round membership from one agreed list. Previously each client derived membership from its own snapshot taken at its own instant, which is what made `inRound`/`dropped` drift and spectating sticky.
- **Garbage is idempotent by `msgId`**, with a local `seen` set. The old code applied a packet *before* its delete landed, so a redelivery applied it twice.
- **Win counts go through `Sig.cas`.** They were a read-modify-write on a stale poll snapshot, so concurrent wins lost increments.
- **Room-ness is `RoomClient.on`, everywhere.** `Net.mode` is only for the P2P status display. When both were consulted they could disagree, and a room entered without `doMakeRoom` published no deaths at all.
- Chat streams on its own path, so there is no `cq` marker any more.
- Opponent boards are mirrored into `FOES` (`mirrorFoes()`) and rendered alongside the local board; the board state synced over the wire is run-length encoded (`Grid.enc`/`Grid.dec`) rather than sent cell-by-cell — ~200 cells become ~60 chars.
- The Room screen (`UI.renderRoom()`) is a dashboard of three `.dash-panel` cards: a `.seat-grid` of up to `MAX_SEATS` `.seat-row`s (name, win count, ready/battling/spectating state), a match panel (rule picker + `READY?`/`SPECTATE` toggles), and a chat panel. Chat *does* keep a log — `UI.renderChat()` draws `RoomClient.chat` into `#chat-log` as `.msg` bubbles with an always-visible `#chatbar` compose form. Whose line it is comes off the message key (`say()` ends it with the speaker's pid), never the display name, which is chosen and not unique.
- There is no presence/invite system. An earlier `Who` module (a `/who` heartbeat feeding an invite list) was removed as dead code — it was never started, so it only cost bytes. Don't reintroduce a `/who` node without UI to consume it.
- **Deciding the round**: `resolveRound()` calls the attack-rule match, from the loop rather than from a poll so it also covers P2P and so its timers run on their own clock. A player still alive wins by being last standing; a player who tops out does *not* get a result card immediately (`G.pending`) — two wells that stop in the same instant would otherwise each see the other as alive and record two losses for a round that had a winner. Instead each well publishes how long it lasted (`Game.lasted()`, a duration measured on one machine, so no clock is shared) alongside its death, and every client sorts the same published numbers to name the same winner — ties by pid in a room, by `Net.role` in P2P, where both ends call each other "peer". A win is only awarded on complete information: a duration that never arrives becomes a loss rather than a guess, since two clients guessing differently would each publish a win. `TIE_SETTLE`/`TIE_CAP` bound the wait (a loss card lands ~0.8s after topping out).
- **Per-seat state that must land together goes in one PATCH**, not a sequence of writes: `publishDeath()` sends the death and its duration together, since a death seen without its duration is judged as a loss.
- **Bandwidth**: the poll loop is gone — the room is a subscription, so nothing is re-read on a timer and the old `ROOM_IDLE_MS`/`ROOM_RELIST` rate juggling went with it. What remains true is that `/rooms/<id>` is streamed in full, so anything constant living there is still paid for on every change beneath it; chat stays at `/chat/<id>`, outside the room, on its own subscription. `ROOM_MS` now only paces how often a board frame is published. Before adding a field to the room node, check whether every peer really needs to see it change.

### Ghost rooms
A room you created and left used to stay in the room list. Three independent guarantees now prevent it, and all three matter — each alone has a hole:
1. `RoomClient.leave()` **awaits** its deletes (capped by `LEAVE_TIMEOUT_MS` so a dead network cannot trap the player), and the last occupant re-reads the seat map rather than trusting its snapshot, so two players leaving at once cannot each conclude the other is still there.
2. `pagehide` fires a `keepalive` delete for a closed tab.
3. `RoomClient.listRooms()` is **strictly read-only**, filtering on `LOBBY_TTL`. The old `Net.listRooms` ran destructive GC as a side effect of a read, from every client sitting on the lobby screen — and judged staleness by a timestamp only the host refreshed, so a room whose host had one failing write got deleted out from under live players, chat and all.

### Theming & visuals
- `THEMES` carries font/board-color/background fields (`applyTheme()` resolves the active one into `THEME`/`CANVAS_FONT`/`INK`); per-piece tile color lives separately in `PIECE_COLOR`, a flat `{I,O,T,S,Z,J,L,G}` map. `CELLS`/`OUTLINE` precompute per-piece-shape (not per-theme) cell offsets and outline polygons via `traceOutline()`.
- `block(x,y,s,type,alpha)` is the single choke point every tile draw goes through (locked stack, active piece, hold/next previews, opponent boards) — it fills flat from `PIECE_COLOR`, or `drawImage()`s a per-piece texture from `PIECE_TILE[type]` when the player has uploaded one. Custom tiles are set in Settings → Video ("Tetromino tiles"): an upload is square-cropped and downscaled to a fixed 128×128 canvas, stored as a JPEG data URL per piece type under `CFG.tiles`/`store` — deliberately small and per-key (rather than one shared image) since `store.set()` swallows `localStorage` quota errors silently.
- The page chrome is dark-only — there is no light/system mode toggle. `--bg`/`--surface`/`--fg` etc. are plain `:root` custom properties; `THEMES`/`PIECE_COLOR`/`PIECE_TILE` only affect the canvas.
- `#bg` is a fixed-position backdrop layer separate from the canvas; see the CSS comments near the top of the file for why it uses `isolation: isolate` and a negative `z-index`.

### Internationalization
- `LANGS = ["en","ko"]` with all strings in `I18N`, keyed by string id with `[en, ko]` tuples. `T(key, vars)` looks up the current-language string with variable interpolation (falling back to the key itself if missing); `EN(key, vars)` is an English-pinned variant used for banners that shouldn't localize. `applyLang()` re-renders all `[data-i18n]` elements and re-invokes `UI.renderRecords()`/`renderRoom()`/`openTab()` so dynamically-built screens pick up the new language. Add new strings to `I18N` with both languages, not just a default.

### Audio
- **There is no audio.** The `Sfx` module and all 54 of its call sites were removed; Settings → Audio reads "to be updated". Several of those call sites had the side effect in the *condition* (`if(!G.paused && G.rotate(1)) Sfx.rotate()`), so deleting such a line outright breaks the action — that is why the removal rewrote them rather than stripping them.

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
- **A listing must never delete**: room GC belongs to clients *inside* the room. A read that mutates, run by every lobby viewer at once, deletes live rooms.
- **Never null `/gb` in the round reset**: `startMatch()` clears only this seat's own `live` node. The old reset PATCHed `g:null`, erasing garbage that arrived between the go signal and the reset.
- **Never `|0` a millisecond timestamp**: `Date.now()` overflows int32, and `hb|0` made every seat read as permanently stale. Use `+x||0`. Small counters like `w` are fine.
- **One source of truth for room-ness**: check `RoomClient.on`, never a parallel mode flag.
- **Anything drawn under a fractional `ctx.translate` loses `block()`'s pixel alignment.** `block()` rounds to device pixels in the space *before* the board-give translate, so a fractional give shifted every tile back off-pixel and seamed them on hard drop. `FX.bob` is quantised at the translate for that reason.
- **A result card must not outlive its run**: `goTimer` is gated on the well it was armed for and cleared by `startGame`, exactly like `boardDrop`. The card also tears the board down behind itself, so leaving it cannot reveal the old well.
- **`store.set` reports failure**: `Presets.save` checks the return value and rolls back, because a blown localStorage quota is otherwise swallowed silently. Tile images are the bulk of what fills it.
- **An import is validated whole before anything is written** (`Backup.check` then `Backup.apply`), so a bad file cannot leave settings and records disagreeing.

## Tests
`npm test` runs `node --test` over `test/*.test.mjs`. There is no test framework beyond node's built-in runner and Playwright.
- `test/mock-rtdb.js` reproduces the Firebase REST surface the game uses — subtree get/put, one-level patch merge, null-as-delete with empty-node pruning, content-scoped ETags with `if-match`, and `text/event-stream`. It means the whole protocol is verified offline, with no credentials and no writes to a live database.
- `test/serve.js` serves the file over localhost, because `EventSource` needs a real origin — `file://` will not do.
- `test/harness.mjs` opens N browser clients, seeds `tfx:fbUrl` before any script runs, and prefixes each client's console output with its name.
- Tests reach into the page with `page.evaluate` and name script-scope bindings directly (`RoomClient`, `RoomState`, `Sig`). This works because a top-level `const` in a classic script lands in the global lexical scope, which is why the shipped file needs no test hooks. Do not add any.
- `test/match.test.mjs` is the end-to-end one: three clients through create → join → chat → ready → match → deaths → result → leave.

### Input
- Every control path (keyboard, gamepad, on-screen pad, swipe gestures) funnels through `Input.press`/`Input.release` — that single door is where the countdown and a finished run are locked out. Don't call `Game` methods directly from a new input source.
- `Pad.poll()` is driven from the frame loop *and* from a slow `setInterval` that covers the menus; the loop only runs while a well exists, so without that interval a gamepad rebind row would wait forever for a button it never read.
- DAS/ARR live in `Input.tick`; `CFG.arr<=0` means instant shift to the wall.
- **A device is not a gamepad just because it is listed as one.** Some bluetooth keyboards enumerate through the Gamepad API. `Pad.vet()` adopts a device only once it has actually produced input, prefers `mapping==="standard"`, and treats the axis values seen on first sight as that device's zero — a resting offset past the deadzone otherwise latches a direction on forever. Never go back to "first connected gamepad wins".
- `LastDevice.kind` (`"key"`/`"pad"`/`"touch"`) is what the UI keys off to match the player's hardware.
- `MenuNav` drives every menu from arrows or the d-pad. It reuses the `.mi` pill through a `navfocus` class because `:focus-visible` does not fire for gamepad-driven focus. While a menu is up, `Pad.poll` sends to the menu and not the piece.
- **Swipe gestures are measured against `SWIPE_REF_PX`, never the rendered cell.** Tying them to `L.cell` made a smaller board proportionally twitchier — a 240px drag moved 10 cells at one size and 30 at another. The listeners live on the whole window, not `#screen`, which is exactly the canvas box and shrank the touch area with the board.

## Conventions in this file

- **Comments are terse one-liners, and only for the genuinely non-obvious** (a device-pixel rounding rule, a network ordering constraint, a CSS stacking-context choice). This is a size constraint, not a style preference — see the 150 KB budget above. If a decision needs a paragraph to justify, that paragraph goes in `CLAUDE.md` and the code gets one line pointing at the constraint. Never restate *what* the code does.
- Config/tunable constants (speeds, kick tables, combo tables, timing constants like `LOCK_MS`, `CLEAR_MS`) are grouped near the top of the script as named `const`s — prefer adding new tunables there over inlining magic numbers.
- UI chrome stays bare-text-first: new nav/mode buttons should be `.mi` elements (no border/fill except the shared hover/selected pill), not bordered cards or filled buttons — reserve borders for status displays like `.seat-row`.
