import type { ActionResult } from '../../shared/api.ts';

/** What the last button press did, in the server's words. */
export function Notice({ result, onDismiss }: { result: ActionResult | null; onDismiss: () => void }) {
  return (
    <div aria-live="polite" className="min-h-0">
      {result ? (
        <p className={`flex items-start justify-between gap-3 border-l-2 py-1 pl-3 ${result.ok ? 'border-good text-ink' : 'border-critical text-critical-ink'}`}>
          <span className="max-w-[80ch]">{result.message}</span>
          <button type="button" className="btn-quiet btn shrink-0" onClick={onDismiss}>Dismiss</button>
        </p>
      ) : null}
    </div>
  );
}
