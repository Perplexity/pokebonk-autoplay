# The player

A rule-based player for whole runs: `src/player`. It is deterministic, sees only what the environment's observation
holds (plus a read-only route planner and the game's exported data tables), and every number it plays by is in one
object, the plan. This page says how it works and how to change it.

## 1. A run under the plan

| Where | What the player does |
|---|---|
| A zone, guardian asleep | Errands: the nearest map point whose condition holds (free and paid Poké Balls, cages, the shop, slot machines, Ditto, Snorlax, Magnemite, curses while the horde can grow, Hypno, Bill's machine). When the wake is due, Rhydon's three roars first, then the guardian with the plan's seals. |
| A zone, guardian fallen | The portal stays closed. Errands go on until the final swarm (zone second 600); the swarm is fought within a few metres of the portal. The run leaves at zone second 1060, or earlier in the swarm when HP is low, a Max Revive is spent, or one hit of the horde would take a whole HP bar. |
| The sanctuary | The classic path, the legendary, a short rest, Overtime. |
| Overtime | Fought by the portal with the plan's offerings. Cashed when HP is low, when the tide takes a whole HP bar a second, when a Max Revive is spent, or after the last round. |

With today's builds the level that wakes a guardian early is passed in zone 1, so from zone 2 on the guardian is
woken on arrival and a zone is ten minutes of errands and eight of final swarm.

## 2. The files

| File | What is in it |
|---|---|
| `plan.ts` | The plan: every threshold and list, in sections (a zone, Overtime, dialogs, the build). One current version. |
| `kit.ts` | A Pokémon's build as rules over the moves held: what a free slot takes, what Bill's machine fuses or links, what Hypno forgets. And the account's build plan (favourites, moves switched off) generated from it. |
| `chooser.ts` | The answer to every dialog. |
| `policy.ts` | The lifecycle above, the errands, and what the player remembers between dialogs. |
| `values.ts` | What an item or a vitamin is worth to a build, computed from the game's own effect data and a set of weights per stat (the direction); the item archive generated from it. |
| `brain/` | Movement and fighting: sixteen headings scored at every decision (dodging, terrain, goals), the ultimate, jumps and dashes. The lifecycle gives it orders (`goto`, a leash, keep the portal closed). |
| `adapter.ts` | The brain's heading and buttons as an action of the environment. |

## 3. The build

- **Per Pokémon** (`plan.builds`, by Pokédex number): the two moves to fuse, the other moves in order of preference,
  and up to four favourites. Mewtwo's is the leaderboard build: the fusion of Psystrike and Psycho Boost; Future
  Sight, Perish Song, Trick Room and Mist linked two by two; Encore. Nothing in `kit.ts` names a move, a slot or a
  zone: the same rules build whatever a plan lists. A Pokémon without an entry plays its own four moves.
- **The account** the runs are played on is part of the build: the item archive `stack-2` (what is taken out of the
  item pool, generated for the Pokémon's kit) and the build plan `kit-1` (the favourites, and the rest of the move
  pool switched off as far as the game allows). Both are options of the environment (`--archive`, `--build-plan`)
  and are checked against what the game itself reports at every reset.
- **Vitamins by phase:** experience, the two that make the horde bigger, Pokédollars and luck while the run farms;
  from zone 3's second 720 damage and max HP, with the others forgotten at Hypno.
- **Items** are taken, bought and copied by worth (`values.ts`): damage is the yardstick; luck, experience and
  Pokédollars stand at what they were measured to be worth against it; taking hits stands at a fraction.

## 4. Dialogs

| Dialog | Answer |
|---|---|
| Level-up | With a build: only its moves, the fusion's two first; the Pokémon's other own moves are banished. Vitamins by phase. A weak offer is refreshed, a worthless one skipped. |
| Hypno | Forgets a move the build has no place for, takes the zone's lesson for a move of the build, forgets the farm vitamins in the final phase. |
| Bill's machine | The build's fusion, else a link of two of its moves, else nothing. |
| Found item, item choice, shop, Ditto | By worth; a new shop stock while it is cheap. |
| Slot machine | Spun while a spin costs at most a tenth of the Pokédollars held. |
| Seals | As many of the plan's list as are offered. |
| Overtime offering | The plan's list in order, else none. |
| Blessing | The one whose text scores best for the build (an older text scorer, `brain/choices.ts`). |
| Evolution, sanctuary path, Overtime start | Evolve; the classic path; start. |
| Relic | The first one, while a slot is free. |
| Party | The weakest ally makes room for a stronger newcomer. |
| Trade, shiny swap, dojo | Declined. No rule uses them yet. |

## 5. What it does not do yet

- **Altars.** Unown altars are stood in only when the movement code passes near one; challenge altars, the dojo,
  fossil ruins, the Porygon altar and Power Altars are never used. Two traced runs took 7 and 8 blessings and left
  altars unused in every zone.
- **Blessings and relics are not valued.** A blessing is picked by an old text scorer and a relic is the first
  offered.
- **Rifts** are never opened.
- **The collapse.** A zone is left at its second 1060, before the collapse; leaderboard runs stay far longer.
- **Max HP.** Runs enter Overtime with 1,500 to 2,200 max HP; what ends them there is the tide at a whole bar a
  second, at about Overtime's second 535.
- **One Pokémon has a build.** The rules are general; only Mewtwo's data is written and measured.
- **The wake by level** (999) is an accident of older, weaker builds that today's builds trip in zone 1. It is kept
  because every measurement includes it; it should become a choice.

## 6. Changing it

The loop, whoever states the change (a new strategy seen on the leaderboard, a game update, an idea):

1. **State it** as what a good player does and why. A saved leaderboard build (`test/fixtures/leaderboard/`) says
   what a build ends with; it does not say how it was reached.
2. **Read the game** for the rule behind it (docs/game.md says how facts are marked). Most gains so far were facts:
   a machine works once a zone; a linked pair is two moves in one slot; favourites change what is offered.
3. **Write it as a rule and data**: a new key or list of the plan, a branch in `chooser.ts` or `policy.ts` that reads
   it, and a test. Nothing about one Pokémon, map or tier goes into a rule: that is data of the plan.
4. **Trace one seed** and read it: `node scripts/trace.ts --seed=1` prints the zone's state, every intent and every
   answer. Does it do what was meant?
5. **Measure on the tuning seeds** (1–30) against the current plan, same code for both:
   ```sh
   node scripts/run-episodes.ts --policy=player --policy-options='{"plan":{"leaveHp":0.5}}' --episodes=30 --seed=1 \
     --workers=10 --species=150 --map=forest --tier=2 --max-time=7200 --archive=stack-2 --build-plan=kit-1 --label=my-change
   node scripts/baseline-report.ts --label=my-change
   ```
   Report median, mean, p90 and best, and look at what the runs did (time in each zone, the build at the end, the
   rounds of Overtime), not only at the score.
6. **Check once** on seeds nothing was chosen on (docs/results.md names the current set), then a pull request.

Rules of the loop:

- **A new version, not an edit.** A change that is kept becomes a new plan version (`plan-10`, …) with the old one
  replaced in `plan.ts` and its figures kept in docs/results.md. A change to code that must not alter play (a
  refactor) is shown by a replay: the same seeds give the same episodes, decision for decision
  (`scripts/compare-batches.ts`).
- **One run says nothing.** A score's standard deviation is about three quarters of its mean, and two runs of the
  same seed stop being comparable once play differs anywhere.
- **Do not edit `src/` while a batch runs** from the same checkout: every episode starts a fresh process that loads
  the source as it is then. A second working copy (`git worktree`) is how to keep working.
