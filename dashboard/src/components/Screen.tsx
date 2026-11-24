import type { ReactNode } from 'react';

interface Props { title: string; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }

/** A screen set into the housing: a titled window that holds data. */
export function Screen({ title, note, actions, children, className = '' }: Props) {
  return (
    <section className={`screen p-4 sm:p-5 ${className}`}>
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="type-title">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {note ? <p className="mb-3 max-w-[70ch] text-ink-2">{note}</p> : null}
      {children}
    </section>
  );
}

/** What a screen says when it has nothing to show: what is missing and what to do about it. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 border-l-2 border-axis py-1 pl-3 text-ink-2">
      <p className="max-w-[60ch]">{children}</p>
      {action ?? null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="text-ink-3" role="status">Reading {what}…</p>;
}

export function Failure({ error }: { error: Error }) {
  return <p className="border-l-2 border-critical pl-3 text-critical-ink" role="alert">{error.message}</p>;
}
