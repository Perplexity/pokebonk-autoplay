# The game, as far as the player and the environment need it

Game build `mwsewi0r` (version 0.10.26). Facts only. Every statement carries one of:

- **[V]** verified by running the game headless through the environment (`src/environment`);
- **[V\*]** verified with a probe that cheated to reach the situation (HP rewritten every step, teleport to map
  points, a guardian's HP set to 1). The probes are no longer in the repository; what is reported is what the game
  then did;
- **[C]** read in the game's code (`mirror/assets/*.js`, minified), not exercised;
- **[P]** measured in play by a probe or by stored runs of the player;
- **[U]** unknown.

Identifiers such as `showSeals` are the game's own method names. Names starting with `$` are minified and change with
every build. Sections 1 to 7 are the run's lifecycle, the dialogs and the account; section 8 is the numbers that
decide a run's ranked KOs. After a game update every **[C]** number in section 8 has to be read again (docs/game-updates.md).

The path of §1 is **[V]** end to end, although some of its statements still carry the **[V\*]** of the probe that
first found them: the player completes it without any cheat in nearly every run.

## 1. Run lifecycle in the standard mode (Classic and Ranked)

A run is one object (`Run`) with a state: `transition` (loading) → `play` ⇄ `modal` (a dialog is open) / `evolving` /
`cinematic` / `capturing` (scripted sequences, game time frozen) → `dead` (fainting, time at ¼ speed) → `over`.

1. **Start.** `app.startRun({ species, biome, tier, boosts, mode: 'standard', competitive? })`. The client asks the service for a
   ticket (`POST /runs` → `id`, `seed`), builds zone 1 and plays. **[V]**
2. **Zones 1–3.** Each zone is a separate generated map with its own clock (`stageTime`). Wild Pokémon spawn in growing numbers;
   the player's moves fire by themselves; KOs give experience, level-ups open a choice (§4). **[V]**
   - The zone guardian sleeps at an altar (map point of kind `boss`). Interact there → the Challenge Seals dialog → the guardian
     spawns. **[V\*]**
   - Killing it sets `stageCleared`, drops rewards and opens a portal (map point `portal`) at the place it fell. **[V\*]**
   - Interact at the portal → next zone (state `transition` while it loads). **[V\*]** If reward balls of the fight are still
     unopened the first press only warns and a second press goes through. **[C]**
   - **Zone clock at 600 s:** the director starts the *final swarm*; the number of live enemies climbs to the cap of 800 within about
     a minute and stays there. **[V\*]** (began at exactly 600.0 s; 800 alive from 720 s on)
   - **480 s after the final swarm began** (zone time 1080 s in zones 1–2; the table says 600 s later in zone 3) the *collapse*
     starts: the player loses HP every second, more each minute, until the portal is taken. **[V\*]** for zone 1 (drain began at
     1080.0 s at 2.2 HP/s of 200 max HP, 5.4 HP/s a minute later); zone 3's value **[C]**.
   - Nothing ends a zone by time alone: without the guardian's defeat the run stays in the zone until the player faints. **[V\*]**
3. **Portal of zone 3.** All ten maps of season 4 have a *sanctuary*, so the portal of zone 3 asks how to end the map
   (`showSanctuaryPath`) **[V\*]**:
   - **classic path** (`sanct`): zone 4 is the sanctuary arena with the map's legendary;
   - **direct** (`direct`): zone 4 without the legendary; overtime starts by itself 3 s after arrival. The map counts as cleared.
4. **Zone 4, the sanctuary.** No wild spawns, no final swarm, no zone timer effect (observed idle for 75 game minutes, nothing
   happened). **[V\*]** The only map point is `shrine`.
   - Interact at the shrine → Challenge Seals (legendary variant) → the legendary spawns (Mew on `forest`).
     **[V\*]**
   - Killing it sets `regionCleared` and opens the exit portal. 4.5 s later the shrine lights again: interact there → the overtime
     dialog (`showOvertime`). **[V\*]**
   - Interact at the portal instead → `showLeaveSanctuary`: go on to overtime, end the run now, or stay. **[V\*]** The
     first answer (`ot`) does not start overtime: the game opens the overtime dialog (`showOvertime`) of the relit shrine,
     and does nothing at all while the shrine has not relit yet. **[V]** (heuristic baseline, no cheats: at the portal
     3.6 s after the legendary fell the answer had no effect; 1.2 s later the same answer opened `showOvertime`, and
     `start` there made overtime live.)
5. **Overtime** (the game's "Prórroga"). **[V\*]** unless marked.
   - Rounds of 30 s. A horde spawns inside the arena (up to 350 bodies **[C]**; 128 alive at the start, about 390 by round 4
     observed), plus elite waves every 20 s **[C]**.
   - Each round has a multiplier: 1.25, 1.5, 2, 2.5, 3, 4, then +1 per round, **plus 0.1 per seal kept** in the run (at most 12
     seals count). Observed 2.45 in round 1 with 12 seals kept. The *bonus* is the sum over rounds of
     `KOs in the round × (multiplier − 1)`, rounded down; it is added to the run's KOs for the HUD goal and, by the game's own
     text, for the KO ranking. **[V\*]** values, **[C]** formula.
   - From 90 s the arena ring closes (to 40 % by 240 s) **[C]**; from 120 s the "tide" drains HP every second and healing fades
     **[C]** (the dialog text says "from minute 2").
   - Every second round (entering rounds 2, 4, 6 …) a *tide offering* is offered (`showOtOffer`): one of up to three modifiers,
     or none. **[V\*]**
   - **Cash:** interact at the portal at any time → overtime is cashed (`ot.cashed = true`) and the run ends as a victory.
     (Two presses half a second apart were needed in the probe; by the code the first one warns about unopened reward balls.)
   - **Fall:** fainting during overtime ends the run as a *victory* too, with `ot.cashed = false` (banner: "the victory is
     yours, without the overtime extra").
   - 24 rounds (12 minutes) is the maximum: then the arena "collapses", overtime is cashed and the run ends. **[C]**
6. **End of run.** `run.finish(victory)` sets state `over`, builds the result record and posts it (`POST /runs/:id/finish`);
   the end screen follows. **[V]** Ways a standard run ends:

   | Cause | `end.how` | `victory` | Status |
   |---|---|---|---|
   | fainted before the legendary fell (zones 1–4) | `died` | false | **[V]** |
   | portal out of the sanctuary without overtime (via `showLeaveSanctuary` → leave) | `won` | true | **[V\*]** |
   | portal during overtime (cash) | `won`, `ot.cashed: true` | true | **[V\*]** |
   | fainted during overtime | `won`, `ot.cashed: false` | true | **[V\*]** |
   | fainted after the legendary fell, outside overtime | `won` (revived to 1 HP, run closed) | true | **[C]** |
   | overtime round 24 over | `won`, cashed | true | **[C]** |
   | restart / quit from the pause menu, internal error | `restart`, `quit`, `retired`, `error` | false | **[C]** (`restart` is the path the environment's reset uses to close an open run) |

   "Victory" therefore means only: the map was cleared (legendary beaten, or the direct path taken). It says nothing about
   overtime.

   **[U] What the real service counts when overtime is lost.** The in-run banner says the victory stays without the extra;
   a tooltip in the profile's run history says of a lost overtime "its KOs are voided". Which KO figure a ranking would have
   used cannot be established offline. The record carries everything needed for either reading (`kills`, `ot.k0`, `ot.rounds`,
   `ot.cashed`).

## 2. What "Ranked" is in the client

- Ranked is not a mode. It is the run option **`competitive: true`** on the standard mode (or on `endless`, "Survival"),
  set by the Ranked map screen. **[C]**, and **[V]**: a run started with it has `run.mode === 'standard'` and
  `run.competitive === true`.
- **What it changes inside a run:** the flag is sent with `POST /runs`; the HUD's KO goal is labelled "Ranked"; the sanctuary
  path dialog shows which path counts for the time-trial board (only the classic one). Nothing in the simulation reads it:
  seals and overtime are enabled by `mode === 'standard' && !coop` alone. **[C]**; **[V]** for `run.seals.enabled === true`
  with and without the flag.
- **What it requires that Classic does not (menu gates only, all [C]):** a registered account (guests get "needs an
  account"); the account at least 3 days old with 20 finished runs (`rankedGate`); a live season with `ranked: true`; the map in
  the season's rotation (`season.maps`); backend of kind `http`. None of this is checked by `app.startRun`, which the
  environment calls directly. **Guests cannot start Ranked from the menu.**
- **What the service decides (all [U]):** whether a finished run is ranked (`ranked` in the finish reply), boards, rivals
  (`ticket.targets`), the anti-cheat review (the result's `end.env` / `end.fns` fields are the client's own environment
  report; headless they read 66 / 770).
- **Ticket fields the client reads [C]:** `id`, `seed`, `boosts`, `offline`, `mutation`, `exp`, `duel`, `party`,
  `wk` (when a number: makes shiny / classic encounter rolls a function of account and week instead of local randomness),
  `blk` (pre-drawn seeds for level-up rolls), `targets` (rivals shown on the HUD). The local stand-in sends none of the last
  three, so those rolls fall back to the client's own generators. The client never reads `ticket.ranked`.
- **Offline equivalent used here** (docs/environment.md §2): registered local account, `GET /status` reports a live ranked
  season with all ten maps, the run is started with `competitive: true`, the ticket and the finish reply carry `ranked: true`.
  Nothing is submitted anywhere.

## 3. Seals

Offered before every guardian and before the legendary when `mode === 'standard'` and not co-op, not mutation / duel / tower /
endless / expedition. **[C]** / **[V\*]**

- Three of the six seals are offered, chosen from run seed and zone (the legendary's offer excludes `fury`). **[C]**; seed 1
  zone 1 offered `swift, clock, echo` **[V\*]**. Any subset may be put on, including none; "not now" leaves the guardian asleep.
- `fury` enraged from the start · `swift` attacks 25 % faster, shorter warnings · `heal` player healing ×0.25 while it lives ·
  `horde` elite packs every 8 s · `clock` beat it before a timer or lose the prizes of all its seals · `echo` two elite copies
  at half HP. **[C]**
- Each seal kept until the kill: +1 Great Ball drop at the kill, Stardust, and +0.1 on every overtime round (cap 12). **[C]**;
  `seals.kept` reached 9 after three guardians with three seals each and 12 after the legendary **[V\*]**.

## 4. Dialogs

Every dialog is a call on the HUD object with the options and a callback; the run is in state `modal` until the callback
is called. "Env" says how the environment exposes it (docs/environment.md §4).

| HUD method | Opens when | Options → callback | Env | Status |
|---|---|---|---|---|
| `showLevelUp(run, offers, cb)` | a level is pending and nothing holds it | `cb(offer)` take · `cb(null,'reroll')` if `run.rerolls > 0` · `cb(null,'skip')` if `run.skips > 0` (gain Pokédollars) · `cb(offer,'banish')` if `run.banishes > 0` · `cb(offer,'banishKit')` for a `newMove` with `from`. Refresh and banish re-open the dialog with new offers. Offers: `{kind: newMove \| upMove \| newVit \| upVit …, key, id?, vit?, rarity, from?}` | full | **[V]** |
| `showBranch(run, forms, cb, {stay, stone, baby})` | an evolution is due and there is a choice (branches, Johto forms, Everstone, babies) | `cb(species)` · `cb(-1)` stay (only when `stay` is given; disabled when `stone === 'missing'`) | full | evolving **[V]** (Pichu → Pikachu → Raichu, heuristic baseline); stay **[C]** |
| `showItem(run, key, cb)` | a ball / chest gave one item | `cb(true)` take · `cb(false)` sell | full | **[V]** |
| `showItemChoice(run, keys, cb)` | a ball gave several | `cb(key)` · `cb(null)` none, gain Pokédollars | full | **[V]** |
| `showBlessing(run, title, offers, cb, sub)` | altars, dojo prizes | `cb(offer)`; one must be taken | full | **[V]** |
| `showSeals(run, {species, legendary, offers, kept}, cb)` | guardian altar / sanctuary shrine | `cb(subset of offers)` wake · `cb(null)` not now | full (8 subsets) | waking without seals **[V]**; with seals, not now **[V\*]** |
| `showSanctuaryPath(run, species, cb)` | portal of zone 3 | `cb('sanct')` · `cb('direct')` · `cb(null)` stay | full | `sanct` **[V]**; `direct`, stay **[V\*]** |
| `showLeaveSanctuary(run, cb)` | sanctuary portal while overtime is still on offer | `cb('ot')` opens `showOvertime` at the relit shrine (no effect before it relit) · `cb('leave')` · `cb(null)` | full; the decision says whether the shrine has relit | `ot` **[V]**, `leave` **[V\*]** |
| `showOvertime(run, cb)` | relit shrine after the legendary | `cb(true)` start · `cb(false)` | full | start **[V]**; not now **[V\*]** |
| `showOtOffer(run, keys, cb)` | entering every second overtime round | `cb(key)` · `cb(null)`. Keys: `dique`, `manantial`, `rompeolas` (hold) · `pleamar`, `cebo`, `corriente` (risk) | full | taking one **[V]** (`dique`, `manantial`); none **[V\*]** |
| `showTrade(run, {title, help, species, offers}, cb)` | fossil ruins, Porygon altar, trick-or-treat | `cb(offer.key)` unless `offer.off` · `cb(null)` | full | **[V]** (declined by the heuristic baseline; a fossil and a Porygon trade taken by the random policy) |
| `showShop(run, close)` | the shop map point (Meowth) | buy: `run.$sllbig(entry)`; restock: `run.$xet6eb()` (price `run.$b4guml()`); `close()`. Selling an owned item is done by the HUD's click handler: `player.removeItem(key)`, `run.$157oved(price)` with the price of the item's rarity (10 / 18 / 30 / 50 / 90 ₽ × zone, capped by a formula on run time), `run.econ.sold++`. | buy / restock / sell / leave | buy, restock, leave **[V]** (docs/baseline.md §7); sell **[V]** (§12: a rarity-4 item sold for 90 ₽ in zone 1) |
| `showDitto(run, cb)` | Ditto map point | `cb(itemKey)` copy an owned item · `cb(null)` | full | **[V]** |
| `showParty(run, ally, cb)` | an ally joins a full team | `cb(index)` release that one · `cb(-1)` newcomer leaves | full | **[C]** |
| `showShinySwap(run, old, new, …, cb)` | a second shiny partner | `cb(true)` swap · `cb(false)` | full | **[C]** |
| `relicChoice(run, cards, cb)` | rift relics | `cb(key, null)`; with three held `cb(key, slot)`; `cb(null, null)` | full | **[C]** |
| `showDojo(run, trials, stat, cb)` | dojo map point | `cb({trial, stat})` · `cb(null)`. Three trials are offered, one per belt (1–3), drawn from nine (`wave`, `rush`, `circle`, `chain`, `elites`, `statue`, `race`, `master`, `untouched`); the stat is one of the 21 blessings of that belt (HUD-side list, from an exported function). The trial is then played on the map: a goal within a time limit; failing closes the dojo. Winning gives the blessing. The point is marked used when the trial ends, won or lost. | trial, then prize | **[V]** (§12: `rush` taken and played to 27 of 28) |
| `showSlots(run, api, close)` | slot machine | The run hands over `api = { cost, spins, pity, cursed, spin, pay, plan, batch }`. A spin: `await api.spin()` (asks the service for the draw, `POST /runs/:id/slots`; takes the price, which rises 8 % per spin) → `{reels, prize, cost}`; then `api.pay(result)`. Prizes: `seven` 3 items (one epic or better) · `pikachu` a rare item · `berry` an item and +25 % HP · `meowth` ×2.5 the stake · `voltorb` an ambush · `gengar` a curse (+5 % enemies and difficulty) · none. After six spins without a prize the next miss pays a rare item. | spin / leave | **[V]** (§12: 15 spins, misses and item prizes) |
| `showForget(run, close)` | Hypno | Forget a move (pays level × 8 × zone ₽; not the last one) or a vitamin (level × 6 × zone ₽), through exported functions. Once per zone a lesson: three offers for a free move slot (one of the favourites if possible); taking one is `applyOffer`, `player.recompute()`, `run.lessonAt = 's<zone>'`, `run.stats.lessons++`. Forgetting a move while the lesson is unused opens the lesson at once. | forget / lesson / leave | **[V]** (§12: a lesson taken, a level-1 move forgotten for 8 ₽); forgetting a vitamin **[C]** |
| `$fvt0na(run, list, cb)` | Bill's fusion machine | `cb(index, 'fuse' \| 'link')` · `cb(null)`. `list` has one entry per pair of held moves: `ready` when both are at level 8; `fuse` replaces the two by a new move (a free slot results), `link` (only where the entry has a `boon`) keeps both firing as one slot. The machine is used up by one fusion. | fuse / link / leave | fuse **[V]** (§12: Psystrike + Psycho Boost → the signature fusion); link **[C]** |
| `showPact`, `showBadges`, `showExpInventory`, `showTraining`, `showRelayRecruit` | other modes (Survival, Tower, Expedition, Camp, Relay) | — | refused: error | **[C]** |
| pause menu (`$19rzrig`), `showMap` | Escape / P / M keys, loss of pointer lock | — | refused: error (the environment never presses those keys) | **[C]** |
| end-of-run screen (`$14lm659`) | after the result was posted | Again / Menu | not a decision: the episode is over | **[V]** |

Non-blocking HUD output (toasts, banners, first-run hints) needs no answer. **[V]**

## 5. Inputs

Read by the game from its input object (`press` / `release`, `hit` = key-down edge, `down` = held). **[C]** unless marked.

| Key | Effect | Used by the environment |
|---|---|---|
| W A S D | move, relative to the camera yaw (forward = (−sin yaw, −cos yaw)) | yes **[V]** |
| Space (edge) | jump; extra jumps in the air when the build has them | yes **[V]** |
| Shift (edge) | on the ground: dash (0.9 s cooldown); in the air above 1.2 m: dive | yes |
| R (edge, or held) | ultimate, when charged | yes |
| E (edge) | interact, first match of: rift entrance → throw Poké Ball at a weakened capture → Friend Ball on a fallen Alpha → call a rift wave → nearest map point (ball, altar, guardian altar, shrine, portal, shop …) | yes **[V]** / **[V\*]** |
| F (edge) | Max form: spends one charge when `forms.ready` (a charge is gained by standing in a Power Altar, at most 3; the form lasts 25 s after its intro). Which form (Mega X / Y, Dynamax) is the account setting `formPick`, default the first | yes **[V]** (§12 of docs/baseline.md) |
| C / X (edge) | burn 1 Incense to open a rift 8 m ahead / 3 Incense for a fused rift, when `rifts.useBlock(fused)` is null (not in a rift, none open, no boss fight, not in the sanctuary, no dojo trial, no Poké Ball waiting). A run starts with 1 Incense; Totems, Summoners, challenges, guardians and some Alphas drop more, up to 3. In the rift: E calls the next wave, the Alpha falls, a relic is chosen, the portal leads back | yes **[V]** (C: three rifts cleared; X: a fused rift entered) |
| Q, T, Y, G, H, M, Tab, Escape, P | aim mode, auto-run, auto-ultimate, dismiss ally, hide effects, map, pause | **no** |
| mouse | camera, target lock; aiming is automatic by default (`aimMode: 'auto'`) | **no** |

Paid Poké Balls cost `run.interactables.chestCost()` Pokédollars, one rising price for all of them. **[C]**

## 6. The unlocked profile

Built at run time from the registries of the running bundle (`src/environment/profile.ts`); the game's own profile object
confirms each part. **[V]** (the environment refuses to start otherwise; numbers below are from this build.)

| Part | Registry (export of `assets-…js`) | Profile field | Game's check | Count |
|---|---|---|---|---|
| League members (playable Pokémon) | `S`: `{id, start, role, passive, kit, rank, challenge}` | `league`, `unlocked` (families), `captured` | `meta.inLeague(id)` | 138 |
| Lab upgrades at maximum | `tt`: `{id, max, cost}` | `lab[id] = max` | `meta.lab(id) === max` | 25 |
| Stardust-shop items in the drop pool | `et`: `{key, price}` | `itemsOwned` | `meta.itemInPool(key)` | 75 |
| Maps at the top tier | `ni` (maps) ∩ `Xr.biomes` (season list) | `biomes[id] = 2` | `meta.biomeTier(id) === 2` | 10 maps, tiers 0–2 |
| Alternative forms (Johto evolutions) | `A`: `{form, member, from, at}` | `johtoForms` | `meta.hasForm(form)` | 11 |
| Friendship at the top level (20) | perks `Pr` and the level function `Vr` of `cosmetics-…js` | `friendship[member] = 35070` points, the fewest the game's own level function calls the maximum | `meta.friendship(id).max`, level 20 | 138 members |
| Research complete | species rules `ut` of `menus-…js` (`family`, `researchGoal`) | `research[family] = researchGoal(family)` | `meta.researchDone(family)`, `meta.researched().length` | 129 families |
| Shiny collection complete | perks `vt`, Pokédex range test `ei` (`assets-…js`); legendary-shiny list `Fn` (`buildshare-…js`); reference data `Va` (`moves-…js`) | `shinies` = every species the game's shiny rules can produce (below) | `meta.shinyPerks()` has all 5 tiers, `meta.hasShinyCharm()`, `meta.shinyBond() === 2`, `meta.shinyCount()`; no family left for the game's own "new family" test | 245 species |

The preset is versioned: `getMetadata().profile.preset` is **`unlocked-v3`** (v1: the first five rows; v2: + friendship and
research; v3: + the shiny collection, by the owner's decision).

In a run this shows as: 4 move slots, 5 vitamin slots, 4 level-up offers, 9 refreshes / 9 skips / 8 banishes, 183 max HP for
Cyndaquil (109 on the starter-only account, +64 from the Lab, +10 from friendship), 33 luck (30 Lab + 3 shiny), ×1.35 damage
(32 % Lab + 3 % shiny), ×1.39 experience (30 % Lab + 5 % friendship + 4 % shiny). **[V]**

What the three account systems outside the Lab do, and what the preset does with each (all three are at their maximum):

- **Friendship** (per League member, 20 levels). Perks by level: +10 max HP (3), +3 % speed (6), +1 refresh (8), +2 armor (11),
  +1 skip (13), ultimate charges 5 % faster (16), +1 banish (18), +5 % experience (20); level 5 opens the member's Max form.
  The run reads only the level (`run.friendLv`). **[V]**: `run.friend()` gives exactly these at level 20, and the ultimate's
  charge rate reads 1.25 (5 Lab levels × 4 % + 5 %). **Maxed.** The titles friendship levels award are cosmetics and are not
  added. The Max form (key F) is open but the environment does not expose that key.
- **Research** (per Pokédex family, a counter towards a goal of 3–97 KO points). It unlocks avatars and frames and nothing
  else: no run stat reads it **[C]** (the earlier statement here that it adds run stats was wrong). In a run the counter
  is clamped at its goal, so a complete account gains nothing more. **Maxed**, as the owner asked for everything;
  `meta.researched()` reports 129 of 129 and all 22 research looks **[V]**. The Pokédex `seen` list needs no entry from
  the preset: when the game adopts a profile it marks every species of an unlocked family as seen by itself (251 of 251
  **[V]**, already so in v1).
- **Shiny collection** (`profile.shinies`, a list of species). Perks by number of entries: +3 luck (2), +4 % experience (4),
  Shiny Charm: shinies 50 % more often and 150 s to flee (6), +3 % damage (10), shiny partner joins with Bond 2 (15).
  **Complete since v3** (owner's decision): all five tiers are active as the game computes them **[V]** (`meta.shinyPerks()`
  5 of 5, `hasShinyCharm()` true, `shinyBond()` 2, `shinyFlee()` 150 s, `shinyRate()` above 1; luck, damage and experience in
  the run as above).
  - *What "complete" is.* The game shows no total for the collection (the Pokédex says "N species" and the next perk), so
    the set comes from the two rules its code has. Wild shinies: its own eligibility test is "inside the season's Pokédex
    range, has an animated sprite, not legendary, not mythical" **[C]**; a caught shiny is recorded under its own species
    number, and zone pools hold evolved forms as well as base forms (45 evolved species in zone 1 of `cave` alone
    **[V]**), so every species passing the test is in: 240. Legendary shinies: only the five species of its
    legendary-shiny list (144, 145, 146, 150, 151) can appear shiny **[C]**: 5. Total **245**. The other six legendary or
    mythical species (243, 244, 245, 249, 250, 251) can be shiny by neither rule and are not in the collection. Every one
    of the 245 passes the test by the game's own functions; that each one can really be met as a wild shiny on some map
    was not established (the pools are built per zone and seed).
  - *What it changes in a run* **[C]**. The game decides "new or not" per family (base form): with a complete list no
    family is new (checked with its own expression: 0 left **[V]**). **Wild shinies still appear**: when nothing is new
    the spawn falls back to the whole zone pool, so every wild shiny is a repeat (it still joins as the shiny partner,
    now with Bond 2, and pays the smaller repeat Stardust). With the Charm they are rolled 50 % more often. A legendary
    shiny stays possible but rarer: for an owned one the game uses its base chance divided by the number of listed
    legendaries owned (5). The earlier statement here that a complete list means no shiny encounter at all was a
    misreading of that fallback and is withdrawn.
  - Shiny skins the collection would make available are cosmetics and are not applied.

Also left at the fresh-account value: Stardust, run history and counters, quests, cosmetics, and the consumable bag (run
boosts such as Rare Candy; runs start with `boosts: []`). The four other entries of the map registry (`graveyard`, `wilds`,
`safari`, `newisland`) are arenas of other modes; the game reports them as not selectable whatever the profile says. **[V]**

The client's `devUnlock` call (`POST /dev/unlock` → `{profile}`, then `meta.adopt`) is how the preset reaches the game. What
the real service would return for it is **[U]**.

## 7. Things that make an episode depend on more than its seed (and what is done about each)

- The ticket `id` is hashed into level-up and drop rolls together with the seed. **[V]** (Stage 0) → pinned from the seed.
- `Math.random` is one stream for gameplay and effects. **[V]** → restarted per episode and per zone.
- The game has a second generator, a module-level object seeded once per page load from the clock and `Math.random`, used for
  weather, spawn positions and many rolls. Its state survives across runs. **[V]** (same seed gave rain, clear, rain in three
  resets before it was handled) → its state field is set per episode and per zone.
- Sound code draws from `Math.random` in two places: when a voice really starts (which depends on what played before),
  and, before that, for every move sound its per-sound rate limiter lets through (the limiter reads the audio clock and
  lives as long as the process). **[V]** → the audio context is kept suspended, so no voice ever starts, and its clock
  is kept running, so the limiter behaves the same in every episode (docs/fidelity.md D3).
- Loading draws a different number of random values when sprite sheets are already in the process (48,000 fewer on a second
  run). **[V]** → the streams are restarted when loading ends.
- Legendary capture encounters: whether 144, 145, 146, 150 or 151 is "pending" for a run is a hash of the account id,
  the species and `profile.hunt[species].k` (a counter the game raises after every run) compared with a small chance
  that grows with misses. **[C]** for the formula, **[V]** for the effect (a random account id made the same seed differ
  between processes) → fixed account id, counter set from the episode seed. The profile reader caps `k` and `m` at
  1,000,000 (`Math.min(1e6, …)`). **[C]**, and **[V]**: a counter of 1,000,001 came back as 1,000,000.
- The sprite-sheet loader caches per process and queues four loads at a time, so a species met for the first time in a
  process gets its sheet a tick later than one met before. **[V]** → sheets are delivered synchronously.
- `run.realTime` counts loading frames too, and loading takes more or fewer frames depending on the process's caches;
  play code compares it with thresholds. **[V]** (a 5-frame offset moved a kill by one hit after 512 s) → set back to
  its pre-loading value when loading ends.
- three.js draws four values from `Math.random` for the UUID of every object, texture, material and geometry it
  creates, and the game creates many lazily, cached per process. **[V]** (24 draws apart between a fresh and a reused
  process when the zone-1 guardian fell) → UUIDs are drawn from a private stream.
- The frame-rate governor lowers the live-enemy cap below 45 measured fps. **[V]** at 60 Hz: measured 60.00, cap never cut,
  including 9 minutes at 800 live enemies.

## 8. The numbers that decide a run's ranked KOs

Ranked KOs = the run's own KOs + the Overtime bonus when Overtime is cashed: the number the KO leaderboard shows.
(The game's own "score" **[C]** is another, far larger number: for an ordinary run (KOs × 2 +
seconds × 3 + damage dealt / 200 + 1,500 a zone cleared + 800 a guardian + 6,000 for a victory) × (1 + tier / 2). It
is not used here.) With today's player about three quarters of a run's ranked KOs is the
bonus.

### 8.1 Overtime

Constants of the build (**[C]**, the object the game names its Overtime settings in; **[P]** where a probe checked
them: every stored run's bonus is reproduced exactly by the formula).

| | |
|---|---|
| Rounds | 30 s each, 24 at most (then Overtime is cashed by itself) |
| Round multiplier | 1.25, 1.5, 2, 2.5, 3, 4, then +1 a round; +0.1 for every seal kept (12 at most); +0.5 with the offering Pleamar |
| Bonus | sum over rounds of KOs in the round × (multiplier − 1), rounded down |
| A KO counts | 1 + seconds into Overtime / 45, up to 7 (the same weight multiplies what the enemy drops) |
| Spawn rate | 30 + 0.8 a second up to 150 a second, × clamp(difficulty × enemy amount × the tier's amount, 1, 3); at most 350 bodies; what is not spawned because the cap is reached is lost |
| Elites | every 20 s, 6 + 2 a round; each counts 1 |
| The ceiling | every body killed on arrival at ×3 spawns: 5,269, 11,995, 21,747, 34,321, 49,820, 62,971, 72,027, 81,026, 90,084 KOs in rounds 1 to 9 and **94,500 a round from round 10** |
| Enemy HP | ×4 a minute; **from second 480 a further ×12 a minute** (×48 a minute: ×6.9 a round) |
| Enemy damage | ×2 a minute; from second 480 a further ×4 a minute |
| The tide | from second 120, 0.25 % of a reference HP a second, ×2 a minute; **from second 480 ×4 a minute**. The reference HP is 400 + the run clock in seconds when Overtime starts. Overheal and shield absorb it first. The offering Dique cuts it by 30 %, Pleamar raises it by 25 % |
| Healing | fades to half by second 225; the offering Manantial doubles it (at most back to 1) |
| The ring | closes from second 90 to 240, to 40 % of the arena (60 % with Rompeolas) |
| A hit | takes at most 40 % of max HP (25 % from elites and Alphas), then nothing lands for 0.45 s. Evasion is capped at 60 %; armor reduces by armor / (armor + 45) |

Ranked KOs of Overtime alone (its KOs and its bonus) if cashed at the end of a round, at the ceiling (millions):

| Cashed after round | Tide, % of the reference HP a second | 12 seals and Pleamar | no seals |
|---|---|---|---|
| 10 (5 min) | 2 | 3.67 | 2.79 |
| 14 (7 min) | 8 | 8.29 | 6.76 |
| 16 (8 min) | 16 | 11.16 | 9.31 |
| 18 (9 min) | 64 | 14.41 | 12.24 |
| 20 (10 min) | 256 | 18.04 | 15.54 |
| 22 (11 min) | 1,024 | 22.05 | 19.23 |
| 24 (12 min) | 4,096 | 26.43 | 23.29 |

- **Berries are the main heal [C] [P].** Every KO drops a healing berry with chance 0.6 % × the power-up stat × the
  KO's weight. A berry heals 25 % of max HP through the healing stat. A build heals as long as it kills.
- **Training [C] [P].** A level-up with nothing left to offer heals 20 % of max HP and adds to one of seven stats,
  drawn evenly (crit chance drops out once every hit is a mega crit): damage +2 %, max HP +3 %, attack speed
  +1.5 %, area +1.5 %, crit chance +0.5 points, luck +2, armor +1. From the 50th trained level on each step is a
  third of that. The steps of one stat add up into one multiplier: 1,000 trained levels are about max HP ×2.7 and
  damage ×2.1; 5,000 are max HP ×9.3 and damage ×6.6. Level-ups go on in Overtime.
- **A hit [C]** is the move's base damage × the damage stat × the special or physical stat × the type's item bonus
  (1 + 0.4 for each item of the move's type) × effectiveness × the capped item bonuses (Metronome, Coin Case …) ×
  damage to elites (elites, Alphas and bosses only) × 1 + 0.2 for each Binding Band on a stunned, rooted,
  paralysed, frozen or sleeping enemy × the relics' multiplier × the crit. A crit is × crit damage; a mega crit
  (crit chance + mega crit chance above 1) is × crit damage × (1 + 0.5 × (crit damage − 1)). Burn and poison are a
  share of the hit that set them (30 % and 12 % a second, × status damage): nothing deals a share of the enemy's
  HP except the relic Eye of the Abyss (finishes what is under 12 %). One hit is capped at 1e30.
- **What a 20 million run needs (expected from the above, not measured):** the ceiling held through round 21 or 22;
  30 million, the top of the leaderboard, is the ceiling held through round 23 or 24 with four to five million KOs
  made before Overtime (ours: about two).
  The tide at the end of those rounds asks for a max HP of roughly 15,000 to 30,000, and enemy HP there is 16,000
  to 110,000 times what it is at second 480. A leaderboard Mewtwo (29.4 million, 96 minutes) ended at level 6,293
  with max HP 19,650, damage ×152, special ×50.5, 313 items.
- **Where a leaderboard build's lead comes from** (the saved Mewtwo, `test/fixtures/leaderboard/`, against the
  best run of plan-9 on seeds 1–30; the factors are read from the two builds, what each is worth in rounds is
  **expected, not measured**). No single number: factors that multiply one another, each of 1.5 to 4.
  - Damage stat ×3.7 and max HP ×10.9: training (level 6,293 for 2,727) and items the player's item pool leaves
    out (Assault Vest, max HP ×1.12 each, ten held; Oran Berry).
  - Special ×3.1 (Choice Specs, ×1.35 each, five held); the crit ×3.4 (crit damage 15.0 for 8.75, mega crit chance
    0.89 for 0.69); Binding Band ×2 on what Trick Room stuns and Mist freezes; three legendary relics from rifts
    (the player holds none); area ×1.8.
  - Survival: healing ×12.6 (Big Root, Soothe Bell), power-ups ×4.8 (the vitamin Poké Radar: more berries),
    armor ×3.1, lifesteal 0.34 for 0.
  - Experience ×3.5 (43.7 for 12.6) is what makes the levels. A saved Nidoking's moves dealt 1e21 to 3e22 damage
    each over the run; the player's deal 1e15 to 4e15.
  - One round more at the ceiling after second 480 costs damage ×6.9 and the tide ×2 a round (×4 a minute).

### 8.2 A zone's final swarm and collapse

- The final swarm begins at the zone's second 600, whether the guardian has fallen or not **[C] [V\*]**. Spawns ×6;
  the horde's HP ×1.5 and its damage ×1.3 a minute of swarm **[C]**; enemy damage measured to double about every
  45 s **[P]**.
- 480 s after the swarm began (zone second 1080; 1200 in zone 3) the collapse drains a share of a reference HP
  every second, ×2.4 a minute, and healing fades to half over four minutes **[C]**. Leaving through the portal ends
  it. The game keeps a log of the seconds spent in a collapse and the KOs made in it.
- The deep swarm is where the experience is: a zone played to its second 1060 gives a run of about 2,500 levels;
  leaderboard runs (96 minutes for our 60) stay well into the collapse.

### 8.3 Moves: slots, Bill's machine, Hypno, the build plan

- Four move slots. A move goes to level 8; with a TM Case held to level 10, and a fusion to ★6 for ★5 **[C] [P]**.
- **Bill's machine [C] [P]:** one in each of zones 1 to 3, none in the sanctuary; it works once. It takes two moves
  that are both at level 8 or more and either **fuses** them (one new move in one slot) or **links** them (both
  keep firing from one slot, each ×1.15 damage and one bonus; a linked pair gets no more upgrades). Neither a
  fusion nor a pair goes in again. A move that only strengthens the Pokémon or sets the weather (Encore) can be
  neither linked nor fused, except as an ingredient of the species' own fusion.
- So a fusion, two linked pairs and one move that cannot be linked are six moves in four slots, and take all three
  machines of a run.
- **Level-up offers [C] [P]:** a new move is offered only with a free slot. Each move of the species' own four that
  is not held and not banished is offered three times as often as anything else. A level-up with a free slot draws
  a move of the species' own line with chance 35 % and one of another League member with chance 50 %.
- **The account's build plan [C] [P]** ("Plan de build", kept in `localStorage` under
  `pokebonk.buildPlan.<account id>`): up to four favourite moves with the Lab's Affinity at its top level, each
  offered with a chance of 15 % when a line or League draw is made, always shown when drawn, and one in every
  lesson of Hypno; and up to 40 moves of the pool switched off (never one of the species' own four, and 12 moves of
  other League members stay on: the game switches moves back on, in list order, until 12 are).
- **Hypno [C] [P]:** one in each zone. Pays for a forgotten move or vitamin (level × 8 × zone), any number of
  times. One lesson a zone for a free slot: one favourite, one move of the species' kit, then random ones; a lesson
  turned down keeps the same offers; forgetting a move with the lesson ready opens it at once.
- Encore, while active: damage ×1.25, attack speed ×1.2, movement ×1.15 (6 s, cooldown 12.6 s). Perish Song curses
  what it hits: ×1.25 damage taken for 4 s. A frozen enemy (Mist, 35 %) takes ×1.2 **[C]**.

### 8.4 Map points of a zone

One guardian altar, and by the game's own list **[C]**: about 5 Unown altars (fewer on a small map), Gengar's altar,
2 challenge altars, a cursed altar, fossil ruins, Rhydon's totem, a Porygon altar, a dojo, Bill's machine, a nest,
the shop, Ditto, Hypno, 2 Snorlax, 2 Magnemite, slot machines, free and cursed and paid Poké Balls, cages, berries,
rocks. Nothing comes back after use in a standard run (it does in Survival).

- **Unown altars [C]:** stood in until charged, 8 / 14 / 22 / 35 s by tier (common, rare, epic, gold), ×1.25 in
  zone 2 and ×1.5 in zone 3, shorter with a Secret Key; the charge drains when the circle is left for more than
  1.2 s. Epic and gold altars call waves of the horde while they charge; the gold one is sealed until the zone's
  second 90 and gives two blessings of four offers, the others one of three.
- **Blessings [C]:** each is one stat for the rest of the run, scaled by rarity (×1, 1.2, 1.45, 1.75, 2.1; the
  rarity is drawn by luck). At the top rarity: damage ×1.25, special damage ×1.38, attack speed ×1.21, area ×1.25,
  experience ×1.32, crit damage +0.42, +2 projectiles (from epic), max HP +42.
- **Rhydon's totem [C] [P]:** answers three times while the guardian sleeps; each roar gives the guardian +30 % HP
  and +12 % damage and one more Great Ball at its fall.
- **Curses [C]:** the cursed altar ×1.15 enemies and ×1.1 difficulty, a cursed Poké Ball ×1.05, Gengar's altar
  ×1.2; a Gengar at the slot machine ×1.05 twice.
- **Rifts [P]** (opened with Incense): 22 to 85 s with the zone clock stopped; 1 to 3 items, a few levels and a
  relic (one of 47, each a multiplier of 1.05 to 1.5 on one thing).

### 8.5 Tier 2

Enemy amount ×1.6, HP ×1.9, damage ×1.96, speed ×1.16 **[P]**. The tier's `kills` factor in the game's table is read
by no code of the client **[C]**.
