const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const two = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** 12,345 */
export const num = (n: number | null | undefined): string => (n == null || Number.isNaN(n) ? '–' : whole.format(n));
export const num1 = (n: number | null | undefined): string => (n == null || Number.isNaN(n) ? '–' : one.format(n));
export const num2 = (n: number | null | undefined): string => (n == null || Number.isNaN(n) ? '–' : two.format(n));

/** 1,284 · 12.9K · 2.0M: for axes and tight figures. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return whole.format(n);
}

export const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** 12:34 of game time, or 1:02:03. */
export function gameClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** "33 min", "2 h 5 min", "48 s". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '–';
  const s = Math.round(seconds);
  if (s < 90) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

/** "14:02" today, otherwise "24 Nov, 14:02". */
export function when(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso), now = new Date();
  return d.toDateString() === now.toDateString() ? clock.format(d) : `${day.format(d)}, ${clock.format(d)}`;
}

/** "3 min ago", "2 h ago", "just now". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const shortHash = (sha: string | null | undefined): string => (sha ? sha.slice(0, 12) : '–');

/** A "nice" upper bound and step for an axis that starts at zero. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 1 };
  const raw = max / ticks, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

/** Coordinates in SVG need no more than one decimal. */
export const px = (n: number): number => Math.round(n * 10) / 10;

export const REWARD_NAMES: Record<string, string> = {
  ko: 'KOs', overtime: 'Overtime bonus', overtime_void: 'Lost overtime', guardian: 'Guardians beaten', zone: 'Zones entered', legendary: 'Legendary beaten', death: 'Fainting',
  map_use: 'Using the map', shop_sale: 'Selling in the shop', idle: 'Standing still', point_use: 'Map points used', item: 'Items collected', spend: 'Pokédollars spent', earn: 'Pokédollars earned',
};

export const KIND_NAMES: Record<string, string> = {
  levelup: 'Level-up', evolution: 'Evolution', item: 'Item found', itemChoice: 'Item choice', blessing: 'Blessing', seals: 'Guardian seals', sanctuaryPath: 'Sanctuary path',
  leaveSanctuary: 'Leaving the sanctuary', overtimeStart: 'Overtime', overtimeOffer: 'Overtime offering', trade: 'Trade', shop: 'Shop', shopSell: 'Shop, selling', ditto: 'Ditto',
  party: 'Party', shinySwap: 'Shiny swap', relic: 'Relic', dojo: 'Dojo', dojoPrize: 'Dojo prize', slots: 'Slot machine', forget: 'Hypno', lesson: 'Hypno, lesson', fusion: "Bill's machine",
};
