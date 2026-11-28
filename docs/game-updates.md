# Taking a new version of the game

Everything here runs on one pinned build of the game (`mwsewi0r`, 0.10.26): the local copy in `mirror/`, the data
export in `data/game-knowledge/mwsewi0r/`, the numbers in docs/game.md §8, and every measured result.

**This procedure has not been run yet.** The project has only ever had one build. The steps are what the code needs,
in order; expect the first update to find gaps in them, and write those down here.

## 1. A new local copy (you run this, never Claude)

`npm run mirror` and `node scripts/mirror-sprites.ts` are the only commands in the repository that contact the
public game site. They issue plain GETs for static files: no login, no API call. Nothing else may contact it, and
an assistant working in this repository does not run them.

```sh
cp -R mirror mirror-mwsewi0r         # keep the old build: the copy is one folder, and the new files go into it
npm run mirror -- --deep             # page shell, code, data, sprites, portraits, cries
node scripts/mirror-sprites.ts       # every sprite sheet the game can spawn (an enemy's size comes from its sheet)
```

- `mirror/` is git-ignored and must never be published: it is someone else's game.
- **Not built:** running two builds side by side. The environment loads whatever `mirror/index.html` names. To go
  back to the old build, swap the folders.

## 2. The data export

```sh
node scripts/export-knowledge.ts            # writes data/game-knowledge/<new build>/{species,moves,items}.json
node scripts/export-knowledge.ts --check    # repeats it in memory and compares with the files
```

The export finds the game's tables by their shape (`src/knowledge/registries.ts`). A table that changed shape stops
it with an error that names the table: fix the shape there, never by hand in the output. docs/game-knowledge.md
describes the files.

## 3. The environment

```sh
npm test                                    # the environment's tests name what no longer fits
node scripts/env-determinism.ts             # the same seed gives the same episode
node scripts/fidelity/compare.ts --seed=1 --map=forest --steps=3600 --script=walk   # against a real local Chrome
```

- The environment finds the game's own functions by what their source does, because names are minified and change
  with every build (`src/environment/profile.ts`, `dialogs.ts`, `gamefns.ts`). A function it cannot find is refused
  by name, at reset: nothing is guessed.
- A new dialog, a new map point or a new run state stops an episode with an `UnknownSituationError` that says what
  was met. Each needs a decision kind (`src/environment/dialogs.ts`) and a rule in the player's chooser.
- Tests pin facts of the build (its id, the number of moves and items, a few values). A pinned value that changed is
  a fact to re-read, not a test to loosen.
- docs/fidelity.md lists where the headless environment is known to differ from a browser, and why each is left.

## 4. The numbers

Every **[C]** number in docs/game.md §8 was read in the old build's code. Read each again: the Overtime settings
(one object: search the code for `roundSecs`), the final swarm and collapse (`finalSwarm`, `hordeHp`), Bill's
machine and Hypno, the level-up offer chances, the altar tiers (`charge:8`), the blessing list (`+{n}% daño`).
A number that changed changes what the plan should do.

## 5. The player

1. `src/player/policy.ts` names the build whose data export it reads. Point it at the new one.
2. Check every build in `plan.builds` against the new export: a move that was renamed or removed is an error at
   start-up (`kit.ts`), a move whose numbers changed is not.
3. Play the current plan on the tuning seeds. **Results of two builds are not comparable**: this batch is the new
   baseline, and docs/results.md starts a new table for the build.
4. Then the loop of docs/player.md §6, with the new meta.
