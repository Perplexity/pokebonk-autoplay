# Sandbox host: endpoints

One HTTP server on `http://localhost:8080` (loopback only).

| Prefix | What it is |
|---|---|
| `/` | The mirrored game: static files from `./mirror` |
| `/__api/*` | The mock game API (this document) |
| `/__sandbox/` | Dashboard. JSON feeds: `/__sandbox/api/journal`, `/api/status`, `/api/endpoints`, `/api/run/<id>` |

## How the game reaches the mock

The game's bundle calls its API by hostname (`https://api.pokebonk.com/...`). Inside the sandbox browser every
request is paused by the browser's request router (`src/cdp/browser.ts`):

- requests to `localhost:8080` continue;
- requests to the API hostname are answered by `/__api` on the sandbox host, same path, same method, same body;
- everything else is failed and listed in `data/logs/blocked-requests.log`.

The browser is also started with a resolver rule that makes every hostname except `localhost` unresolvable, so the
second rule cannot be bypassed by something the router does not see (WebSockets, WebRTC).

You can call the mock directly: `curl -X POST http://localhost:8080/__api/auth/guest`.

## Conventions

- JSON in, JSON out. Sessions are bearer tokens: `Authorization: Bearer <token>` from `POST /auth/guest`.
- Errors: `{ "error": "..." }` with 400 / 401 / 404 / 409 / 410.
- A path the mock does not implement answers 404 `{ "error": "Not available in the sandbox" }` and is listed in
  `data/logs/unhandled-api.log`. The game treats these as "feature unavailable".
- Nothing is validated the way a real service would: the mock stores what the client sends.

## Routes

Regenerate this table with `node scripts/endpoints.ts`.

| Method | Path | What the sandbox does |
|---|---|---|
| GET | `/status` | Service flags: no maintenance, open registration, no live events. |
| POST | `/auth/guest` | Issue a local guest session (the captcha field is ignored). |
| GET | `/auth/me` | Validate the bearer token of a local session. |
| POST | `/auth/logout` | No-op. |
| GET | `/auth/name` | Name availability (always free). |
| GET | `/profile` | The local profile plus server time. |
| PUT | `/profile/prefs` | Store settings and last picks. |
| POST | `/profile/starter` | Choose the starter of a new profile. |
| POST | `/dev/unlock` | The client's devUnlock call: replace the profile with the configured unlocked preset (404 unless the host of the mock set `unlockPreset`; the headless environment does). |
| POST | `/profile/actions` | Loadout toggles (stored, not validated). |
| GET | `/profile/stash` | Local key/value stash. |
| PUT | `/profile/stash/:key` | Write one stash entry. |
| POST | `/runs` | Issue a run ticket: random seed, mode config, mutation of the day. |
| POST | `/runs/:id/slots` | Uniform random draws for the in-run slot machine. |
| POST | `/runs/:id/checkpoint` | Append progress checkpoints to the run file. |
| PUT | `/runs/:id/save` | Store the suspend blob for a run (cloud save). |
| GET | `/runs/:id/save` | Return the stored suspend blob. |
| POST | `/runs/:id/suspend` | Mark the run as suspended ("save and quit"). |
| POST | `/runs/:id/resume` | Mark a suspended run as live again (resume). |
| POST | `/runs/:id/recover` | Mark a suspended run as live again (recover). |
| POST | `/runs/:id/discard` | Drop a suspended run and its save. |
| GET | `/runs/saved` | The account's suspended run, if any, so resume works. |
| POST | `/runs/:id/finish` | Accept the result, store it in the run journal, return the updated profile. |
| GET | `/news` | No news. |
| GET | `/mail` | Empty mailbox. |
| GET | `/friends` | No friends list. |
| GET | `/records` | No records. |
| GET | `/records/endless` | No records. |
| GET | `/leaderboard` | Empty board (nothing is ranked here). |
| GET | `/clans/board` | Empty board. |
| GET | `/leaderboard/pokemon` | Empty board. |
| GET | `/seasons/awards` | No season awards. |
| GET | `/clans/status` | No clan. |
| GET | `/clans/mates` | No clan. |
| GET | `/duels` | No duels. |
| GET | `/builds/rents` | No rentals. |
| GET | `/coop/invites` | No co-op. |
| GET | `/coop/seeking` | No co-op. |
| GET | `/coop/access` | Co-op is off in the sandbox. |
| GET | `/mutation` | Mutation of the day and an empty daily board. |
| POST | `/feedback` | Dropped. |
| POST | `/mail/read` | No-op. |

## The main shapes

**`GET /status`**
```json
{ "maintenance": { "on": false }, "registration": { "inviteOnly": false }, "events": [],
  "season": { "n": 0, "name": "Sandbox", "live": false, "ranked": false, "maps": [], "dust": 1 }, "now": 0, "sandbox": true }
```

**`POST /auth/guest`** → `{ "id": "...", "name": "Sandbox001", "guest": true, "token": "..." }`

**`GET /profile`** → `{ "profile": { ... }, "now": 1700000000000 }`. A new profile is minimal (`starter: 0`, empty
roster, `biomes: { forest: 0 }`); the client fills in defaults for every field it needs.

**`POST /runs`** — body `{ species, biome, tier, mode, boosts, key }`
```json
{ "id": "24 hex chars", "seed": 2320825447, "ranked": false, "boosts": [], "sandbox": true,
  "mutation": { "day": 20780, "key": "swift" } }
```
`mutation` is present for `mode: "mutation"` only. The same `key` returns the same ticket.

**`POST /runs/:id/checkpoint`** — body `{ cps: [{ t, stage, kills, level, damage, splits }], auto? }` → `{ "ok": true }`

**`PUT /runs/:id/save`** — body `{ hash, enc: "gz" | "raw", data: "<base64>" }`. Stored as sent, returned as sent by
`GET /runs/:id/save`. `GET /runs/saved` → `{ "saved": null }` or `{ "saved": { id, at, hash, blob, species, biome, tier, mode } }`.

**`POST /runs/:id/finish`** — body `{ result, cps }`, where `result` is the game's own end-of-run record (species,
biome, tier, mode, stage, time, kills, damage, level, victory, bosses, build, end, progress...).
```json
{ "profile": { ... }, "record": { "...result": "...", "id": "...", "ranked": false }, "stardust": 31, "forms": [], "tasks": [], "ranked": false }
```
The result goes to `data/runs/<id>.json` in full and one summary line is appended to `data/journal.jsonl`:
```json
{ "id": "...", "acc": "...", "at": 1700000000000, "mode": "standard", "species": 155, "biome": "forest", "tier": 0,
  "time": 199.5, "level": 12, "kills": 274, "stage": 1, "victory": false, "how": "died", "bosses": 0, "captures": 0, "shinies": 0 }
```

## Progression

`src/sandbox/progress.ts` folds a finished run into the local profile: captures join the roster (their evolution
family is unlocked), the counters the client reports are added up, a flat Stardust amount is credited, a cleared
map tier opens the next one, and the run is added to the profile's history. These rules are the sandbox's own
approximation, written so a practice profile moves forward; they are not the game service's rules.

## Local files

```
data/db.json              sessions and profiles
data/runs/<id>.json       ticket, request, checkpoints, result, status of one run
data/saves/<id>.json      the suspend blob of a run
data/journal.jsonl        one line per finished run (the dashboard reads this)
data/logs/                bot log, unhandled API paths, blocked requests, missing mirror files, dialogs seen
data/browser-profile/     the sandbox browser's own profile
```
