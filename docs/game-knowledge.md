# Game knowledge export

`data/game-knowledge/<build>/` holds what the game itself knows about its Pokémon, moves and items, written as JSON
by `node scripts/export-knowledge.ts` (library: `src/knowledge/`). Build `mwsewi0r` (0.10.26) is exported.

Nothing in these files is typed by hand and nothing is taken from `mirror/data/*.json` directly (that is only generic
reference data: species, 919 generic moves, learnsets, type chart, item names). The game-specific numbers live in the
bundle's code, so they are read from the **running game**: from tables its chunks export, from three of its own
lookup functions, and from the player object of a run it started. Where the game has no data for something because
the logic is code, the dataset says so in `header.gaps` instead of carrying an invented value.

## 1. How it is read

- The export boots the headless game through the environment (`createEnvironment()`), so the account is the unlocked
  preset and the offline guard is in force. It **plays nothing**: no simulation step is taken.
- **Tables** are found among the exports of the loaded chunks by their shape, with the rule of
  `src/environment/profile.ts`: each must match exactly one export, otherwise the export stops ("the game build has
  changed"). `src/knowledge/registries.ts` lists its 28 tables and the test each must pass (the League, Lab, shop, map, form,
  friendship and shiny tables come from `profile.ts`); every header names the chunk and export each one was found in
  (`header.source`).
- **Functions of the game that are called**, each identified by what its source does:

  | Function | What it is | How it is used |
  |---|---|---|
  | move definition (`moves-…js#m`) | the game's definition of a generic move id for the League member of the current run; null when the game does not implement the move | asked for all 919 ids in the run of every League member (it is a cached lookup) |
  | move plan (`buildshare-…js#Vr`) | the League screen's "moves this Pokémon can get": kit with unlock levels, level-up line with levels, moves it can borrow from other kits | called for every form of each member's evolution line |
  | upgrade roll (`moves-…js#y`) | which stats an upgrade improves and by how much at a rarity multiplier | called on **detached** move objects (built with the game's move class, never attached to a player) until every stat of every archetype came up at every rarity. It draws from `Math.random`; the amounts do not depend on the draw (the export fails if a stat ever shows two amounts) |
  | upgrade apply (`moves-…js#s`) | level + 1 | called once on a detached move object with no stat upgrades, to read what a level alone adds |

- **One run per League member** (138 resets, seed 1, first map of the season, tier 0; about 2 s each, 4.5–5.5 minutes
  in all). The per-species values are read from the game's own player and run objects right after `app.startRun()`:
  starting move, max HP, run stats, slots, uses, the next evolution. The move definition function is asked inside
  that run because the game defines a few moves differently for one member (see `memberVariants`).
- Two getters of the player object give the highest move and vitamin level; the map-point class's own source gives
  the interactable kinds it distinguishes.

The export reads and calls; it writes nothing into the game except the detached move objects it builds itself.

## 2. Files

Every file starts with a header:

```json
{ "dataset": "moves", "build": "mwsewi0r", "gameVersion": "0.10.26", "version": 1,
  "bundleSha256": "…", "language": "en", "profile": "unlocked-v3",
  "source": { "<fields>": "<where they came from>" }, "gaps": ["<what is not data>"] }
```

`version` is `KNOWLEDGE_VERSION` (`VOCAB_VERSION` for the vocabulary). `bundleSha256` is the value
`getMetadata().game.bundleSha256` reports. There is no timestamp: a second export gives byte-identical files (§4).
Names and descriptions are in the language the game loaded (`en`).

### species.json — 138 League members, plus the Pokédex

| Field | Content | Source |
|---|---|---|
| `id`, `role`, `rank`, `starter` | Pokédex number, the game's role name, rarity rank, whether it is a starter | League table |
| `key`, `name`, `types`, `reference.{stats, bst, legendary, mythical, baby}` | generic species data | the bundle's reference data |
| `passive.{id, name, desc, mods, hooks}` | the passive: its text, its stat modifiers `{stat, add \| mul}`, and the names of the code hooks it has (`tick`, `dmgTaken`, …) | passive table |
| `kit[]` | the four kit moves with the level each unlocks at (1, 2, 4, 7) | League table + move plan |
| `startingMoves[]` | what the player holds at second 0 (always the first kit move, level 1) | live player object |
| `moves.<form>.line[]` / `.shared[]` / `.any` | **the pool level-up offers draw from**, for the member and for every form of its evolution line: level-up moves with the level they open at; moves of other members' kits it may be offered, with the members they come from; for Mew, the list of every move it can learn | move plan |
| `evolution.{family, line, nextAtStart, evoLevels, altForms}` | the forms, the first evolution the game has scheduled at the start of a run, the League table's own level field, alternative (Johto) forms | reference data, live run, form table |
| `run.{maxHp, moveSlots, vitaminSlots, refreshes, skips, banishes, stats}` | the player's values at second 0 **under the account preset in the header** | live player and run objects |
| `ultimate.{names, descs, type, class, durations}` | per evolution tier | ultimate table |
| `signatureFusion` | key of the member's signature fusion | fusion table |
| `pokedex[]` | every species of the reference data (251): `id, key, name, types, family, legendary`. Enemies and evolved forms use these numbers | reference data |

Gaps: passive effects beyond `mods` are code (only their text is data) · ultimates have no numbers for damage or
shape · `run.*` are not base values of the species: they include the Lab and friendship of the preset and the
weather of seed 1 · evolution rules during a run (later thresholds, branch choices, stones) are code · the passives
and ultimates of alternative forms exist as tables keyed by form and are not joined here.

### moves.json — 759 moves, 165 fusions, 26 archetypes

| Field | Content |
|---|---|
| `moves[].{key, id, name, type, class, archetype}` | stable key (the generic move's key), numeric id (what level-up offers carry), display name, type, `physical` / `special`, and the archetype that decides how it behaves |
| `moves[].{damage, cooldown, count, area, speed, duration, pierce, status, statusChance, drain, critBonus, flinch, power}` | the definition's numbers (seconds, metres, metres per second) |
| `moves[].extra` | further fields a definition has (`weather`, `buff`, `pulses`, `spread`, `fx`) |
| `moves[].upgradeStats` | the stats an upgrade of this move can improve |
| `moves[].{kitOf, lineOf, sharedTo}` | League members that have it in their kit / in their level-up line in any form / can be offered it from another kit |
| `moves[].memberVariants[]` | where the game defines the move differently for one member: that member and the fields that differ (4 moves in this build, e.g. Earthquake is a `wave` for Wooper instead of a `nova`) |
| `moves[].fusions` | fusions this move is an ingredient of |
| `archetypes.<key>` | label, description, base numbers, `upgradeStats`, and `upgrades.<stat>.{values[5], labels[5]}`: the amount an upgrade adds at each of the five rarities, with the game's own text |
| `levelUp` | rarity names and multipliers, upgrades per offer by rarity (2, 2, 2, 3, 3), damage modifier per level (+0.08), start and highest move level (1, 8), highest vitamin level (10) |
| `fusions[]` | key, id, kind (`signature` 138, `type` 18, `reaction` 8, `glitch` 1), the member and ingredient moves or the pair of types, cooldown, power, hits, range, status, and the definition's numbers |

160 of the 919 generic moves have no definition in the game and are left out. 83 of the 759 defined ones are in
nobody's kit, line or shared pool and not in Mew's list either (537 are kit moves, 601 are in at least one line).

Gaps: behaviour beyond the archetype numbers is code · effective values in a run depend on stats, items and
passives through formulas in code · fusion upgrade options and the highest fusion level are code · the targeting
range is not a field of a definition.

### items.json

| Section | Count | Content |
|---|---|---|
| `vitamins` | 26 | key, name, stat, `perLevel`, `kind` (`add` / `mul`), text, extra stats, highest level |
| `heldItems` | 142 | key, name, rarity 0–4, the game's description, stat modifiers, tags (e.g. `type:fire`), `maxStack` (null where the table has none), `typeBoost` (the 18 type items), `unlockPriceStardust` (the 75 items of the Stardust shop) |
| `relics` | 47 | key, name, rarity, stat modifiers, passive name and text, the passive's numbers (`values`) |
| `runBoosts` | 9 | the consumable bag (not used by the environment: runs start with none) |
| `seals`, `overtimeOfferings` | 6, 6 | keys only |
| `overtime` | — | the game's overtime constants (round length, multipliers, ring, tide, the offerings' numbers) |
| `typeBlessings`, `powerups` | 18, 5 | per-type blessing modifiers; TM power-ups with their duration |
| `lab`, `friendship`, `shinyPerks` | 25, 8 perks, 5 | permanent upgrades: key, text, maximum, stat and amount per level |
| `stats`, `statuses`, `typeStatus`, `weather`, `types`, `difficultyTiers`, `maps` | 39, 13, … | stat definitions (`flat` / `mult` / `pctpts`), status names, the status each type applies, weather with boosted and weakened types, the type chart, the tier multiplier table, the 14 maps |

Gaps: item effects beyond `mods` are code (the description is the game's text) · in-run shop prices are computed
when a stock is drawn · seals and overtime offerings have no data beyond their keys (their rules are in
docs/game-mechanics.md §1 and §3) · blessings are generated per offer as `{label, mods, rarity}` and have no keys ·
relic passives are text plus numbers · pickup kinds are numbers without names.

### vocab.json — the index of every categorical key

`tables.<name>` maps a key to an integer. **Index 0 is reserved for "none / unknown"** in every table; keys are
sorted (numeric keys numerically, others by code unit) and numbered from 1, so an index depends only on the set of
keys. `test/knowledge/vocab.test.ts` pins the tables of this build (their hash, their sizes, sample indexes).

| Table | Keys | From |
|---|---|---|
| `species` | 251 | every species of the reference data, by number |
| `type`, `role`, `rank`, `passive` | 18, 136, 4, 214 | reference data; League table; passive table |
| `move`, `archetype`, `moveClass` | 924, 26, 2 | moves.json (moves and fusions) |
| `vitamin`, `item`, `relic`, `runBoost`, `seal`, `overtimeOffering` | 26, 142, 47, 9, 6, 6 | items.json |
| `stat`, `status`, `weather`, `map`, `rarity` | 39, 13, 7, 14, 5 | items.json |
| `offerKind`, `decisionKind`, `extraAction` | 4, 20, 10 | the environment's own names (`src/knowledge/vocab.ts`, `src/environment/types.ts`) |
| `enemyFlag`, `projectileFlag` | 24, 13 | the game's flag tables; the value is the bit position + 1 |
| `interactable` | 35 | the kinds the game's map-point class compares against in its own source |
| `entity` | 1441 | one table over `move:`, `vitamin:`, `item:`, `relic:`, `seal:`, `offering:`, `species:` and `stat:` keys, so that one embedding serves the build and the offers of a dialog |

Gaps: the game has no table of interactable kinds (a kind created elsewhere in its code would map to 0; four names
in the list belong to scenery) · `role` and `rarity` keys are display names in the export language · blessings and
trades have no keys (a blessing is encoded through the stat it changes).

## 3. Using it

`loadKnowledge(build)` (`src/knowledge/load.ts`) reads the four files, checks they belong to one export and to the
asked build, and gives the encoder its joins (types of a species, role of a member, key of a move id, kind of a
stat). The environment loads it only with `encode: true`.

## 4. Reproducibility

`node scripts/export-knowledge.ts --check` repeats the export in memory and compares with the files on disk.
Two full exports in two separate processes gave byte-identical files (sha256 in the stage report).
The files contain no time, no path and no random value; lists are sorted by key or id; the per-species runs use a
fixed seed.

## 5. When the game updates

The export is tied to the build on purpose (ADR 0001 §7). A new build gets a new folder: run the export, read the
errors (a table that no longer matches its shape stops it), re-validate `src/knowledge/registries.ts`, then compare
the new `vocab.json` with the old one. A changed vocabulary changes the observation layout's hash
(docs/observation.md), so a trained policy is tied to the vocabulary it was trained with.
