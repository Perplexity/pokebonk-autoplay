import { lazy, Suspense, useState } from 'react';
import type { ComponentType } from 'react';
import type { Overview as OverviewData } from '../shared/api.ts';
import { Loading } from './components/Screen.tsx';
import { useApi } from './lib/api.ts';
import { href, useRoute } from './lib/route.ts';
import Overview from './views/Overview.tsx';

// The overview is the first thing shown and ships with the page; every other view is fetched when it is first opened.
const VIEWS: Record<string, ComponentType<{ arg: string | null; query: URLSearchParams }>> = {
  evaluations: lazy(() => import('./views/Evaluations.tsx')),
  breakdowns: lazy(() => import('./views/Breakdowns.tsx')),
  models: lazy(() => import('./views/Models.tsx')),
  history: lazy(() => import('./views/History.tsx')),
  episode: lazy(() => import('./views/Episode.tsx')),
  watch: lazy(() => import('./views/Watch.tsx')),
};

const NAV = [
  { view: 'overview', label: 'Overview' },
  { view: 'evaluations', label: 'Evaluations' },
  { view: 'breakdowns', label: 'Breakdowns' },
  { view: 'models', label: 'Models' },
  { view: 'history', label: 'History' },
  { view: 'watch', label: 'Watch' },
];

const STATE_WORDS = { training: 'Training', evaluating: 'Evaluating', idle: 'Idle' } as const;

function StatusLamp() {
  const { data, error } = useApi<OverviewData>('/overview', 5_000);
  const state = data?.status.state ?? 'idle';
  return (
    <p className="flex items-center gap-2 whitespace-nowrap text-ink-2" title={data?.status.headline}>
      <span className={`lamp ${state === 'training' ? 'lamp-on' : state === 'evaluating' ? 'lamp-busy' : ''}`} style={error ? { background: 'var(--critical)', borderColor: 'var(--critical)' } : undefined} />
      {error ? 'Server not answering' : data ? STATE_WORDS[state] : 'Connecting'}
    </p>
  );
}

function FooterWithData() {
  const { data } = useApi<OverviewData>('/overview', 5_000);
  return <Footer data={data} />;
}

type Theme = 'light' | 'dark';
const THEME_KEY = 'pokebonk-dashboard-theme';
const systemTheme = (): Theme => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const readTheme = (): Theme | null => { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : null; } catch { return null; } };
// Applied before the first paint, so a chosen theme never flashes the other one.
const chosenAtLoad = readTheme();
if (chosenAtLoad) document.documentElement.dataset.theme = chosenAtLoad;

function Footer({ data }: { data: OverviewData | undefined }) {
  const [theme, setTheme] = useState<Theme>(() => readTheme() ?? systemTheme());
  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* the choice then lasts until the page is closed */ }
    setTheme(next);
  };
  return (
    <footer className="mt-12 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-axis pt-3 text-xs text-ink-2">
      <p className="min-w-0 truncate">{data ? `Reading ${data.database.path}. This page runs on this machine only and contacts nothing else.` : ''}</p>
      <button type="button" className="btn btn-quiet" onClick={flip}>{theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}</button>
    </footer>
  );
}

export default function App() {
  const route = useRoute();
  const View = VIEWS[route.view];
  const current = route.view === 'episode' ? 'history' : VIEWS[route.view] ? route.view : 'overview';
  return (
    <div className="mx-auto min-h-screen max-w-[84rem] px-4 pb-16 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-axis py-3">
        <a href={href('overview')} className="text-base font-bold font-stretch-[112%] no-underline">PokéBonk training</a>
        <nav aria-label="Sections" className="order-3 w-full overflow-x-auto sm:order-none sm:w-auto">
          <ul className="flex gap-1">
            {NAV.map((n) => (
              <li key={n.view}>
                <a href={href(n.view)} aria-current={current === n.view ? 'page' : undefined}
                  className={`block border-b-2 px-2.5 py-1.5 font-semibold whitespace-nowrap ${current === n.view ? 'border-action text-ink' : 'border-transparent text-ink-2 hover:border-axis hover:text-ink'}`}>{n.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <StatusLamp />
      </header>
      <main className="pt-6">
        {View ? <Suspense fallback={<Loading what="this view" />}><View arg={route.arg} query={route.query} /></Suspense> : <Overview />}
      </main>
      <FooterWithData />
    </div>
  );
}
