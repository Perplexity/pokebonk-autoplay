import { useState } from 'react';
import type { JobInfo } from '../../shared/api.ts';
import { useApi } from '../lib/api.ts';
import { ago, when } from '../lib/format.ts';

const STATE: Record<JobInfo['state'], string> = { running: 'Running', succeeded: 'Finished', failed: 'Failed', stopped: 'Stopped', unknown: 'Ended while the dashboard was closed' };

function JobLog({ job }: { job: JobInfo }) {
  const { data } = useApi<{ text: string }>(`/jobs/${job.id}/log`, job.state === 'running' ? 3_000 : 60_000);
  return (
    <pre className="mt-2 max-h-72 overflow-auto rounded-[3px] border border-rule bg-housing-deep/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap" tabIndex={0} aria-label={`Output of ${job.title}`}>
      {data ? data.text || 'Nothing printed yet.' : 'Reading the log…'}
    </pre>
  );
}

/** What the dashboard has started: each with its state and, on request, the end of its output. */
export function JobList({ jobs }: { jobs: JobInfo[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul>
      {jobs.map((j) => (
        <li key={j.id} className="min-w-0 border-b border-grid py-2 last:border-b-0">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span className="flex max-w-full min-w-0 items-center gap-2">
              <span className={`lamp ${j.state === 'running' ? 'lamp-on' : ''}`} style={j.state === 'failed' ? { background: 'var(--critical)', borderColor: 'var(--critical)' } : undefined} />
              <span className="truncate first-letter:uppercase">{j.title}</span>
            </span>
            <span className="flex items-center gap-3 text-ink-2">
              <span>{STATE[j.state]}{j.state === 'failed' && j.exitCode != null ? ` (exit code ${j.exitCode})` : ''}</span>
              <span title={when(j.startedAt)}>{ago(j.startedAt)}</span>
              <button type="button" className="btn btn-quiet" aria-expanded={open === j.id} onClick={() => setOpen((cur) => (cur === j.id ? null : j.id))}>{open === j.id ? 'Hide output' : 'Show output'}</button>
            </span>
          </div>
          {open === j.id ? <JobLog job={j} /> : null}
        </li>
      ))}
    </ul>
  );
}
