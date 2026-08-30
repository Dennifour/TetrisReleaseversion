# Room multiplayer rewrite

Date: 2026-08-30
Status: approved, ready for implementation planning
Scope: batch 1 of 3 (see "Out of scope" for batches 2 and 3)

## Why

Server-assisted versus ("room" mode) is unreliable in ways that patching cannot
reach. The subsystem's defining decision — that **every state-carrying write is
fire-and-forget** — produces most of the observed symptoms, and the rest come
from state being written from many paths at once.

Confirmed defects in the current implementation:

| Defect | Site | Consequence |
| --- | --- | --- |
| All writes unawaited, errors swallowed | `Room.set/board/mark/pushRule/attack/say/callStart` | Any dropped write silently desynchronises the room |
| Dropped death publication | `drainEvents` "dead" → `Room.mark` | Every client waits out `TIE_CAP` and all call `lose()` — a round with no winner |
| Win count is read-modify-write on a stale snapshot | `resolveRound` (2093, 2103), `UI.tallied` (3181) | Concurrent wins lose increments |
| Garbage applied before its delete lands, no idempotence key | `Room.poll` (2626–2631) | Same garbage can apply twice |
| Round-reset PATCH nulls `g` | `startMatch` (2149) | Erases garbage sent between the go signal and the reset |
| Listing performs destructive GC as a side effect of a read | `Net.listRooms` (2813) | Every lobby viewer races to delete rooms; a room whose host has one failing PATCH is deleted out from under live players |
| `Room.stop()` never resets `this.host` | 2516 | A client that transiently became host then left deletes a room full of other people |
| Leave deletes are unawaited, then the lobby is re-read immediately | `UI.leaveRoom` (3154) | **Ghost rooms**: a room you created and left stays listed |
| Seat-limit check is TOCTOU | `Room.join` (2502–2504) | Two simultaneous joiners can both pass the `MAX_SEATS` gate |
| `Net.mode` left `"room"` after a failed join | `Net.openRoom/joinRoom` (2820, 2827) | All later P2P sends are silently dropped |
| `catch(e){}` swallows the whole poll body | `Room.poll` (2647) | Real bugs are invisible |
| `spec` never cleared at round start | `startMatch` (2149) | Spectating is stickier than intended and cannot be set before the first match |

Intended outcome: a room layer where a dropped write is retried rather than
lost, round membership is agreed rather than independently derived, and a room
that nobody is in cannot remain listed.

## Architecture

`Room` currently mixes transport, state, lifecycle, and rendering in one object.
It splits into four units with one-way dependencies:

### `Sig` — transport

No game semantics. Firebase RTDB REST plus its documented streaming support.

- `stream(path, onEvent)` — `EventSource` on `path.json`; handles `put`, `patch`,
  `keep-alive`, `cancel`, `auth_revoked`; reconnects with backoff.
- `get / put / patch / del` — **awaited**, bounded retry with jittered backoff,
  per-path single-flight so two writes to one path cannot invert.
- `cas(path, fn)` — GET with `X-Firebase-ETag: true`, apply `fn`, PUT with
  `if-match`; retry on 412. Used only for contended values.

### `RoomState` — pure reducer

`apply(event) -> view`. No I/O, no DOM, no timers. **Exactly one writer for room
state**, replacing today's six-plus mutation paths. Independently testable.

### `RoomClient` — lifecycle

create / join / leave, heartbeat, write outbox, round lifecycle, garbage
delivery. Owns the only mutable session state.

### `RoomView` — rendering

Subscribes to `RoomState`. Existing markup and CSS are kept as-is.

## Data model

Volatile data is separated from stable data so the stream stays cheap.

```
/lobby/{id}                   {n, t, c}          index; t refreshed by ANY occupant
/rooms/{id}/meta              {h, r}             host pid, rule
/rooms/{id}/seat/{pid}        {n, j, hb, rdy, spec, w}
/rooms/{id}/live/{pid}        {b, p, o}          board frames — high churn, isolated
/rooms/{id}/go                {s, r, at, roster} round start
/rooms/{id}/gb/{pid}/{msgId}  n                  garbage, idempotent by id
/chat/{id}/{key}              {n, m}
```

Four decisions carry most of the weight:

1. **The host writes `roster` into `/go`.** Today each client derives round
   membership from a snapshot taken at a different instant, which is the source
   of `inRound` / `dropped` drift and sticky spectate. One authoritative value
   removes the class.
2. **`live` is separate from `seat`**, so board frames stop churning the node the
   lobby and seat list read.
3. **Garbage carries a sender-generated `msgId`** and the receiver keeps a `seen`
   set. Double-apply is impossible even when the delete fails.
4. **`hb` is per seat**, so room liveness no longer depends on the host alone.

## Ghost rooms

Three independent guarantees, so no single failure reintroduces the bug:

1. **Leave awaits its writes.** Seat delete awaited; if this was the last
   occupant, room + lobby + chat deletes awaited too. The screen transitions only
   after, with a timeout so a dead network cannot trap the player.
2. **Unload** keeps the existing `keepalive` DELETE.
3. **Listing never deletes.** `listRooms` becomes strictly read-only, filtering
   entries whose `t` is older than a ~20 s TTL (comfortably above the heartbeat).
   Deletion happens only from a client inside the room, or from a sweep that
   first confirms zero live heartbeats.

Result: a room you leave disappears immediately; a crashed host's room
disappears within the TTL; no client can delete a room that still has live
players.

## Component behaviour

**Spectate** — kept. `spec` lives in the seat node and is excluded from the
roster at freeze time. Spectating deliberately persists across rounds; the
button becomes available before the first match, and spectators no longer
transmit board frames.

**Chat** — kept, now streamed over SSE on `/chat/{id}`. This removes the `cq`
marker and with it the two-unordered-writes hazard in `say()`. Also fixes: the
submit handler clearing its input before the `Room.on` guard (`:3287`), and
`_chatLogSig` blocking a re-render of `chat_empty` on language change (`:3145`).

**Round resolution** — the published-duration design is sound and is retained.
It gains the authoritative roster and an awaited-with-retry death publication, so
a dropped write cannot produce a winnerless round. Win counts go through
`Sig.cas`.

**Not touched** — the P2P copy-paste path, except for fixing the `Net.mode` leak
after a failed join.

## Verification

`test/mock-rtdb.js` — in-memory Firebase REST shape: GET/PUT/PATCH/DELETE on
`/path.json`, ETag and `if-match`, SSE `put`/`patch` events. Deterministic; no
credentials; runs offline.

`test/sim.mjs` — Playwright drives three headless clients through
create → join ×2 → chat → ready → match → deaths → result → leave, logging every
step and every mock request. Log output only, no screenshots.

Asserted:

- exactly one winner per round;
- garbage applied exactly once;
- lobby empty after the last player leaves;
- chat consistent across all clients;
- spectator excluded from the roster and from attack targets;
- no ghost room after create-then-leave.

## Constraints

- Single file, no build step, opens from disk. No new runtime dependencies; the
  Firebase JS SDK is specifically excluded (~200 KB against a 150 KB budget).
- The 150 KB budget is pressure, not a gate. Report `ls -l Tetris_version1.html`
  after the batch.
- Wire compatibility with the current protocol is explicitly not required.

## Out of scope

Batch 2 (input layer): keyboard-vs-controller detection, menu navigation by
keyboard/controller, touch swipe sensitivity.

Batch 3 (polish): tetromino skin presets, result-screen delay and board
teardown, versus chat/rule panel positions, hard-drop pixel gap, settings
import/export, removal of all sound effects.
