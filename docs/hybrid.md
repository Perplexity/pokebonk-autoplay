# The hybrid: skills and a manager (phase 2)

Mewtwo, forest, tier 2, Ranked, build `mwsewi0r` (0.10.26), account preset `unlocked-v4:balanced`, offline.
Rules start it, the learner can overrule them: the phase 1 heuristic (`heuristic2`, plan-3) gives a default at every
decision, and a learned **manager** decides what is actually done.

```
python -m pokebonk_rl.bc collect|fit   copy the heuristic into a manager        configs/manager.yaml
python -m pokebonk_rl.train            PPO from that copy                       configs/manager.yaml
python -m pokebonk_rl.evaluate         a manager on fixed seeds                 configs/manager-evaluation.yaml
        │  pipes, one per game process (docs/training.md §1), `init` with `manager`
        └── node src/ipc/server.ts
              └── src/hybrid/manager.ts   the manager's environment
                    ├── src/agents/heuristic2   the adviser: its plan, its dialog answers
                    └── src/bot/brain           the skills' "how": movement and fighting, 20 times a game second
```

The low-level path (keys 20 times a second, `configs/training.yaml`, observation layout 2, action layout 2) is
unchanged and still runs. Nothing of it was renumbered or re-hashed.

## 1. A decision

| | One step | Game time |
|---|---|---|
| A dialog is open | an option or an extra action (leave, sell, refresh, banish, …) | none |
| In play | a **skill**: an order to the heuristic's brain, carried out until one of the ends below | about a second |

A skill's slice ends when (`src/hybrid/manager.ts`):

- `slice_seconds` of game time have passed (default 1);
- a dialog opens, or the episode ends;
- the skill can no longer be carried out: its target was used, the zone changed;
- **the heuristic's own proposal changes** (`end_on_proposal_change`): the default plan sees a reason to do something
  else, so the manager is asked again at that moment.

Measured on seed 5, first 300 game seconds: 414 decisions (350 skills, 64 dialog answers) for 6,158 low-level
decisions. 265 slices ended on time, 57 on a dialog, 13 on a changed proposal, 14 because the skill was done.

### Skills (`src/hybrid/actions.ts`, `skills.ts`)

| Skill | The order | Possible when |
|---|---|---|
| `farm` | fight where the brain sees fit (herding, priority targets, experience on the ground, a live guardian or legendary). A cleared zone's portal is not taken, the guardian is not woken | always |
| `near_portal` | the same within the plan's leash of the portal; beyond it, back to the portal through the horde ("fight in the ring") | a portal exists |
| `wake` | to the guardian's altar (the sanctuary: the shrine) through the horde, and wake it | it sleeps |
| `portal` | a cleared zone: leave. Overtime: cash. The sanctuary after the legendary: the way to Overtime | cleared, or Overtime |
| `retreat` | get away and heal: a berry within 30 m, else keep running | always |
| `use:<kind>` × 29 | to the nearest unused map point of that kind through the horde, and use it | one exists and can be paid for |

`use` kinds: freechest, chest, cursedchest, berry, slots, meowth (shop), ditto, cage, snorlax, magnet, rhydon, cursed,
greed, altar, challenge, power, rock, bill, hypno, dojo, fossil, porygon, nest, arch, bonk, fairy, grove, meadow,
shroom. A point that a skill of the manager's own walks to for 40 s without using it is given up for the zone.

Under the manager the brain wakes nothing by itself (`quietTuning`): waking is the skill `wake`.

**Not a skill yet:** opening a rift (Incense), a fused rift, and the Max form. Their ids will be appended. Nothing
plays a dojo trial or a rift on purpose either: `use:dojo` starts a trial and the brain then fights as usual.

### The proposal

Every observation carries the action the heuristic would take here, and it is always allowed.

- In a dialog: the heuristic's answer (`choose2`).
- In play: the skill its order amounts to (`classify`): an errand is `use:<kind of its target>`, the walk to the altar
  is `wake`, the way to the portal is `portal`, the stay by the portal is `near_portal`, everything else `farm`.

**Taking the proposal is the heuristic.** The skill that equals the proposal is carried out by the heuristic's own
tick, its order and its tuning, so a manager that always takes the proposal plays the heuristic's episode to the key
press (tested on a real episode, and through the Python side). Any other skill runs under the order in `skills.ts`.
The heuristic's plan keeps running as an adviser either way; if it is not followed for long, its own errand
time-outs still count.

### Bill's machine and the TM Case

The owner (2026-11-25): "move levels can actually level up to level 10 with a TM Case, and we should realistically
never fuse or join until we have this item, as this maximises our damage even more."

Read in the game's code: a TM Case (rarity 4, one held at most) raises a move's cap from 8 to 10 and a fusion's from
★5 to ★6; Bill's machine takes any two moves at level 8, with or without it; a fusion inherits the upgrades of both
parents. Measured: 9 of the 50 held-out runs of plan-3 held a TM Case at the end; the valuation rates it 55, among
the ten most valuable items, and no archive takes it out.

- **A rule of the manager, not a preference** (`fuse_needs: tm-case`): at Bill's machine every fusion and every link
  is masked while no TM Case is held. Leaving is always possible. One configuration key turns it off.
- **The heuristic's default** (plan key `fuseNeeds`, chooser `fusionPick`): with the item held, fuse the first pair
  whose moves are both at level 10; never link. This default is in **plan-4**, a candidate that is not measured and
  not the default plan. plan-3 never walks to the machine.

## 2. The action table (`manager-action-layout.json`, version 1)

One discrete action, 226 ids:

| Ids | |
|---|---|
| 0–143 | option 0–143 of the open dialog |
| 144–151 | refresh, skip, take, sell, decline, leave, confirm, reroll |
| 152–167 | banish option 0–7, banish-kit option 0–7 |
| 168–191 | spare: never allowed, kept for extra actions of a later patch |
| 192–196 | farm, near_portal, wake, portal, retreat |
| 197–225 | `use:<kind>`, in the order above |

144 option slots because Ditto lists every distinct item held: the plan-3 runs on the held-out seeds end with 45 to
78 distinct items (17 of 50 with more than 64), Ditto dialogs of up to 74 options are stored, and the low-level
encoding stops an episode with an error at the first dialog of more than 64.

**Append-only.** An id never changes its meaning. A new skill or map point kind goes at the end of its list, a new
extra action into the spare ids. A longer table needs a model of that size; a model trained on the shorter one
keeps playing with the ids it knows.

## 3. The observation (`manager-observation-layout.json`, version 1)

15,474 floats and 739 integers, bounded as in docs/observation.md.

- **Kept from the low-level encoding**, with 144 option rows: `global`, `stats`, `density`, `xp`, `moves`,
  `vitamins`, `items`, `relics`, `choice`, `options`; ids `ids`, `move_slots`, `option_entity`.
- **Left out**: single enemies, shots, hazards, pickups, terrain, the 16 nearest map points. A manager does not
  steer by them; the brain does.
- **Added:**

| Segment | Shape | Content |
|---|---|---|
| `mgr` | 1 × 49 | figures at Overtime sizes (KOs and Overtime bonus to 100 million, level to 20,000, max HP to a million; the low-level scales are flat from 100,000 KOs and level 150); survival: tide and collapse as a share of max HP, the tide's reference HP, **overheal held, how full the lifesteal budget is**, the game's own spawn multiplier and the plan's estimate, the horde's hit as a share of max HP, lowest HP of 20 s, HP lost in 4 s, revives; the plan's clocks (wake due, seconds to the swarm and the collapse); Rhydon's roars; the altar and the portal; the build's caps (TM Case, Max Ether, moves at the cap) |
| `proposal` | 1 × 226 | the heuristic's action, one-hot |
| `prev_play` | 1 × 34 | the manager's previous skill |
| `kinds` | 1 × 174 | per `use` kind: possible now, unused points, the nearest (distance, direction), its price |
| `option_fx` | 144 × 18 | per dialog option, **what it does in numbers**: the heuristic's score, junk or not, the item's or vitamin's worth to the build and its risk part, up to three stat changes (log of the multiplier, the addition), type-bonus share, a multiplier written in the text, a move's damage, cooldown, class and type share |
| `option_fx_stats` | 144 × 3 | the stats those changes are of |

Healing, lifesteal, regeneration, the overheal and shield maxima are in `stats`, as before.

### Ids that survive a patch (`src/hybrid/ids.ts`, `data/encoding/manager-ids.json`)

The vocabulary of a build numbers its keys in sorted order: one new item renumbers every item after it and widens
every vector with an entry per item. The registry is one file for all builds:

- a key keeps the index it was first given, new keys are appended;
- every table has a **capacity** above its content (a quarter more, at least 8), and the capacity sizes the
  observation: 184 item entries for 142 items, 56 stats for 39, 1,808 entity ids for 1,441.

The layout has two hashes. `hash` covers everything, names included. `compat` covers what a network depends on:
segments, shapes, scales, capacities, the action table's size. A model stores `compat`, its action names and the
registry it was trained with, and is refused only when `compat` differs, an id it knows means another key, or the
action table is not the one it knows (`ManagerLayouts.accepts`, tested). A table that outgrows its capacity is
refused at export: that needs a new observation version.

`data/` is not in git, the registry with it. Every model's `state.json` carries the registry it was trained with.

## 4. The network (`python/pokebonk_rl/manager.py`, `manager_net.py`, architecture `manager-v1`)

- Ids go through embedding tables; move slots and dialog options are encoded row by row (an option's row is its
  low-level features, its `option_fx` and its ids together) and kept in order; everything is mixed into 512 features.
- **The proposal is appended to those 512 unchanged, and the policy head is one linear layer.** So there is a direct
  weight from "the heuristic proposes X" to the logit of X. It starts at `proposal_logit` = 8: an untrained manager's
  most probable action is always the proposal, and a sampled action is the proposal with probability about 0.99.
  It is a weight like any other: training can lower it where leaving the proposal pays.
- The value network has one hidden layer of 256.

## 5. Warm start (`python/pokebonk_rl/bc.py`)

```sh
python -m pokebonk_rl.bc collect --config configs/manager.yaml --seeds 1000000-1000019 --out data/bc/plan3
python -m pokebonk_rl.bc fit     --config configs/manager.yaml --data data/bc/plan3 --name manager-copy-01
python -m pokebonk_rl.evaluate   --config configs/manager-evaluation.yaml --model manager-copy-01 --seeds 1-30 --reference tier2-mewtwo-h2p3-balanced-fresh
```

- `collect` plays whole episodes with every decision the proposal and stores each decision: observation, mask,
  proposal, game seconds, and the run's KOs and Overtime bonus, so any reward version can be computed from the
  files later. Held-out seeds are refused. An episode takes about 1.2 MB (measured: 24 MB for 20).
- `fit` trains the policy to give the stored proposal (cross-entropy on the masked distribution) and writes a run
  with one checkpoint at 0 timesteps.
- **What this copy is.** Because of the direct path the copy is exact before any training: `fit` reports agreement
  1.0 before its first step. The check that the copy plays like the heuristic is therefore a check of the whole chain
  (network, masks, pipes, manager environment, skills), not of how well something was learned. The value network is
  not trained here: it needs the reward, which phase 3 defines.

## 6. PPO (`python/pokebonk_rl/train.py`)

`manager.enabled` in the configuration makes a run a manager run for good.

- **Start**: `manager.init_from` = the copy.
- **Penalty for straying**: `stray_penalty` of reward is taken away for every decision that is not the proposal,
  fading linearly to zero over `stray_fade_timesteps`. It is kept apart from the stored reward components
  (`manager/strayed_share` and `manager/stray_penalty` in TensorBoard, `manager` in each episode's record).
- **Discount by game time**: a step lasts between no time and a second or more, so the discount of a step is
  `γ ** dt` with `γ = exp(−1 / horizon_seconds)` for one game second (`TimeDiscountBuffer`, tested against the
  formula by hand and against ordinary GAE when every step lasts a second). Horizon: 1000 s.
- **Preset**: a checkpoint records its account preset and item archive; a resume or an evaluation on another one is
  refused.
- **One episode per game process** (`workers.recycle_after: 1`): an episode in a reused process is not the episode
  its seed names (docs/environment.md §3, cause 5). Found in this phase.
- **The standing-still and no-KO rules** (`env.max_idle_game_time`, `env.max_ko_gap_game_time`) are on, as for every
  model. The heuristic's opening walk to the free chests breaks the no-KO rule in about one run in 25 on tier 2, so
  a manager that takes every proposal loses those episodes at their start (docs/phase-2-report.md §6). Open.

Reward, budget, the promotion metric and the comparison of sqrt against log are phase 3.

## 7. Tests

- `test/hybrid/hybrid.test.ts` (no game): the action table pinned id by id, masks, orders, the proposal's skill,
  Bill's machine and the TM Case, the id registry, the layout and its two hashes.
- `test/hybrid/manager.test.ts` (boots the game twice): the manager that takes every proposal against the heuristic
  in a second process, same seed: same low-level steps, same end, every counter equal; every observation bounded,
  with the proposal one-hot and allowed; a second episode played against the proposal with every allowed skill in
  turn; forbidden actions refused.
- `python/tests/test_units.py`: layouts accepted and refused, configuration, the discount, the untrained manager
  takes the proposal and obeys the mask, stored decisions come back as they were.
- `python/tests/test_game.py`: collect → fit → evaluate → train → resume through the command lines; the copy's
  episodes equal the heuristic's; the copy is refused on another item archive.
