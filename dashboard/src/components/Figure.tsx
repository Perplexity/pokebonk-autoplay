import type { ReactNode } from 'react';

interface Props { label: string; value: ReactNode; detail?: ReactNode }

/** One figure of the ledger line: a label, the number, and what it is measured against. */
export function Figure({ label, value, detail }: Props) {
  return (
    <div className="min-w-0 border-l border-axis pl-3">
      <dt className="type-label">{label}</dt>
      <dd className="type-figure mt-1 truncate">{value}</dd>
      {detail ? <dd className="mt-1 text-xs text-ink-2">{detail}</dd> : null}
    </div>
  );
}
