import useSWR, { mutate } from 'swr';
import type { SWRResponse } from 'swr';
import type { ActionResult } from '../../shared/api.ts';

export class ApiError extends Error {}

export async function fetcher<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(body?.message ?? `The dashboard server answered ${res.status}.`);
  }
  return (await res.json()) as T;
}

/**
 * One resource of the dashboard server. Components asking for the same path share one request and one copy of the
 * data; it is asked for again every `refreshMs` while the page is visible.
 */
export function useApi<T>(path: string | null, refreshMs = 15_000): SWRResponse<T, ApiError> {
  return useSWR<T, ApiError>(path, fetcher, { refreshInterval: refreshMs, keepPreviousData: true, revalidateOnFocus: true, dedupingInterval: 2_000, errorRetryInterval: 5_000 });
}

/** Press a button of the dashboard: the answer says in words what happened. Everything shown is then asked for again. */
export async function act(path: string, body: Record<string, unknown>): Promise<ActionResult> {
  let result: ActionResult;
  try {
    const res = await fetch(`/api/actions/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pokebonk-Dashboard': '1' }, body: JSON.stringify(body) });
    result = (await res.json()) as ActionResult;
  } catch {
    result = { ok: false, message: 'The dashboard server did not answer. Is it still running?' };
  }
  void mutate(() => true);
  return result;
}
