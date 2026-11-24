/**
 * The little game knowledge the heuristic baseline's chooser needs, hand-copied from the registries of game build
 * `mwsewi0r` (0.10.26): what each vitamin raises, and a coarse worth for the items that matter most to a build that
 * mainly has to stay alive. A decision only carries keys (`vprotein`, `leftovers`), not texts.
 *
 * This is deliberately small and not tuned. A key that is not listed gets a neutral score; nothing here is needed for
 * correctness. The full, generated knowledge base belongs to src/knowledge/.
 */

/** Vitamin key → the stat line the game shows for it (its registry `desc`, lower case). */
export const VITAMIN_EFFECT: Record<string, string> = {
  protein: 'physical damage', calcium: 'special damage', iron: 'armor', zinc: 'regenerating shield', carbos: 'move speed',
  'hp-up': 'max hp', 'pp-up': 'projectile', ether: 'attack speed', 'dire-hit': 'crit chance', 'x-speed': 'projectile speed',
  'x-defense': 'evasion', 'x-attack': 'status chance', stardust: 'area', elixir: 'duration', 'super-potion': 'regeneration',
  nugget: 'pokédollars', 'exp-candy': 'experience', 'star-piece-v': 'luck', 'max-potion': 'lifesteal', 'escape-rope': 'pickup',
  cursed: 'more and stronger enemies', 'sticky-barb': 'thorns', 'enigma-berry': 'overheal', 'super-lure': 'elite spawns',
  'poke-radar': 'power-ups', 'loaded-dice': 'a random stat',
};

/** Offer texts every build of the baseline stays away from: they make the horde bigger or stronger. */
export const ALWAYS_AVOID = ['more and stronger enemies', 'elite spawns'];

/** Items that raise one move type: worth a lot when the kit has a move of that type, little otherwise. */
export const TYPE_ITEMS: Record<string, string> = {
  charcoal: 'fire', 'mystic-water': 'water', 'miracle-seed': 'grass', magnet: 'electric', 'never-melt-ice': 'ice', 'black-belt': 'fighting',
  'poison-barb': 'poison', 'soft-sand': 'ground', 'sharp-beak': 'flying', 'twisted-spoon': 'psychic', 'silver-powder': 'bug', 'hard-stone': 'rock',
  'spell-tag': 'ghost', 'dragon-fang': 'dragon', 'black-glasses': 'dark', 'metal-coat': 'steel', 'silk-scarf': 'normal', 'fairy-feather': 'fairy',
};

/** Items that raise one damage class: worth a lot when the kit has a move of that class. */
export const CLASS_ITEMS: Record<string, 'physical' | 'special'> = {
  'muscle-band': 'physical', 'choice-band': 'physical', 'thick-club': 'physical', 'wise-glasses': 'special', 'choice-specs': 'special',
};

const tier = (score: number, keys: string): Record<string, number> => Object.fromEntries(keys.split(' ').map((k) => [k, score]));

/** Item key → worth (0–100). Not listed: `ITEM_DEFAULT`. */
export const ITEM_SCORE: Record<string, number> = {
  // A second life.
  ...tier(95, 'max-revive revive focus-sash rainbow-wing'),
  // Large flat multipliers.
  ...tier(85, 'dawn-stone master-ball shiny-stone moon-stone lustrous-orb adamant-orb sun-stone soul-dew clear-bell pp-max max-elixir rare-candy tm-case poke-flute silph-scope'),
  // Staying alive.
  ...tier(78, 'leftovers shell-bell big-root sitrus-berry lum-berry assault-vest protector guard-spec max-repel eviolite focus-band black-sludge'),
  ...tier(68, 'potion soothe-bell berry-juice oran-berry lax-incense bright-powder smoke-ball heavy-ball shed-shell'),
  // Experience: levels are damage.
  ...tier(72, 'lucky-egg exp-share'),
  // Plain damage.
  ...tier(66, 'quick-claw razor-claw scope-lens wide-lens cleanse-tag metronome expert-belt stick razor-fang level-ball up-grade dusk-stone thunder-stone electirizer reaper-cloth choice-scarf'),
  // More or harder enemies, or more damage taken.
  ...tier(15, 'white-flute lure-ball rage-candy-bar fast-ball life-orb macho-brace'),
};
export const ITEM_DEFAULT = 50;

/** Worth of one more of `key` for a kit with these move types and damage classes. */
export function itemScore(key: string, moves: { type: string; cls: string }[]): number {
  const type = TYPE_ITEMS[key];
  if (type) return moves.some((m) => m.type === type) ? 80 : 25;
  const cls = CLASS_ITEMS[key];
  if (cls) return moves.some((m) => m.cls === cls) ? 80 : 25;
  return ITEM_SCORE[key] ?? ITEM_DEFAULT;
}

/** Overtime "tide offerings" that make holding out easier (the others raise the stakes). In order of preference. */
export const OVERTIME_HOLD = ['manantial', 'dique', 'rompeolas'];
