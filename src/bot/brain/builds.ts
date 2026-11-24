/**
 * Curated builds. A build is a short plan for the level-up picks of one starter line: which moves are its core (take
 * and upgrade these first), which stats it scales with, and what it never wants. Names are matched against the text
 * of the offer cards, case-insensitive; a build that names nothing still works through the stat weights.
 *
 * Add your own in config.json under bot.builds (same shape), keyed by Pokédex id of the unevolved starter.
 */
export interface Build {
  name: string;
  /** Move names, most wanted first. Taking and levelling these comes before everything else. */
  core: string[];
  /** Offer text patterns this build scales with, strongest first. */
  scale: string[];
  /** Offer text patterns to avoid. */
  avoid: string[];
}

const DAMAGE = ['damage', 'area', 'attack speed', 'cooldown', 'crit', 'projectile', 'duration'];

export const BUILDS: Record<number, Build[]> = {
  // Bulbasaur line: heals off Grass hits, so it wants many small hits and area.
  1: [
    { name: 'bloom', core: ['Vine Whip', 'Razor Leaf', 'Leech Seed', 'Petal Dance', 'Solar Beam'], scale: ['area', 'attack speed', 'damage', 'healing', 'status'], avoid: ['thorns'] },
    { name: 'toxic garden', core: ['Vine Whip', 'Sludge Bomb', 'Poison Powder', 'Venoshock'], scale: ['status', 'duration', 'area', 'damage'], avoid: [] },
  ],
  // Charmander line: glass cannon, stronger below 40% HP.
  4: [
    { name: 'inferno', core: ['Ember', 'Flamethrower', 'Fire Spin', 'Fire Blast', 'Flame Burst'], scale: ['damage', 'special', 'area', 'crit', 'attack speed'], avoid: ['thorns'] },
    { name: 'dragon claws', core: ['Ember', 'Dragon Claw', 'Slash', 'Dragon Rage', 'Wing Attack'], scale: ['damage', 'physical', 'attack speed', 'crit'], avoid: [] },
  ],
  // Squirtle line: armour and shields, fights inside the pack.
  7: [
    { name: 'tidal wall', core: ['Water Gun', 'Bubble', 'Surf', 'Hydro Pump', 'Water Pulse'], scale: ['area', 'damage', 'special', 'shield', 'armor'], avoid: [] },
    { name: 'shell spin', core: ['Water Gun', 'Rapid Spin', 'Aqua Tail', 'Skull Bash'], scale: ['physical', 'damage', 'armor', 'attack speed'], avoid: [] },
  ],
  // Chikorita line.
  152: [{ name: 'aroma guard', core: ['Trailblaze', 'Razor Leaf', 'Magical Leaf', 'Giga Drain'], scale: ['area', 'healing', 'max hp', 'damage'], avoid: [] }],
  // Cyndaquil line: fire around it, burns stack its passive.
  155: [
    { name: 'eruption', core: ['Burning Jealousy', 'Temper Flare', 'Fire Pledge', 'Blast Burn', 'Flame Wheel', 'Eruption'], scale: ['area', 'status', 'damage', 'special', 'attack speed'], avoid: [] },
    { name: 'wildfire', core: ['Burning Jealousy', 'Flamethrower', 'Lava Plume', 'Inferno'], scale: ['status', 'duration', 'area', 'damage'], avoid: [] },
  ],
  // Totodile line.
  158: [{ name: 'jaws', core: ['Bite', 'Crunch', 'Aqua Tail', 'Waterfall', 'Ice Fang'], scale: ['physical', 'damage', 'attack speed', 'lifesteal'], avoid: [] }],
};

export const GENERIC: Build = { name: 'generic', core: [], scale: DAMAGE, avoid: [] };

/** The build for a species: its own line's first build, else the generic damage build. `variant` picks an alternative. */
export function buildFor(starter: number, variant = 0, extra: Record<string, Build[]> = {}): Build {
  const list = extra[String(starter)] ?? BUILDS[starter];
  return list?.length ? list[Math.min(variant, list.length - 1)] : GENERIC;
}
