import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props { title: string; open: boolean; onClose: () => void; children: ReactNode }

/** A dialog on the browser's own <dialog>: focus is kept inside it and Escape closes it. */
export function Modal({ title, open, onClose, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-[3px] border border-ink bg-housing p-0 backdrop:backdrop-blur-[1px]">
      {open ? (
        <div className="p-5">
          <h2 className="type-title mb-4">{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
