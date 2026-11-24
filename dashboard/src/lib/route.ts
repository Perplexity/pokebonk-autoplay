import { useSyncExternalStore } from 'react';

/** The page is addressed by the hash: `#/evaluations/3`. No router library is needed for six views. */
const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener('hashchange', notify, { passive: true });
  return () => window.removeEventListener('hashchange', notify);
};
const read = (): string => window.location.hash.replace(/^#\/?/, '') || 'overview';

export interface Route { view: string; arg: string | null; query: URLSearchParams }

export function useRoute(): Route {
  const raw = useSyncExternalStore(subscribe, read);
  const [path, search = ''] = raw.split('?');
  const [view, arg = null] = path.split('/');
  return { view, arg: arg ? decodeURIComponent(arg) : null, query: new URLSearchParams(search) };
}

export const href = (view: string, arg?: string | number | null, query?: Record<string, string | number>): string => {
  const q = query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : '';
  return `#/${view}${arg != null ? `/${encodeURIComponent(String(arg))}` : ''}${q}`;
};

export const go = (view: string, arg?: string | number | null, query?: Record<string, string | number>): void => { window.location.hash = href(view, arg, query).slice(1); };
