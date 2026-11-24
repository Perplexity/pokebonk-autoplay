import { useCallback, useRef, useState } from 'react';

/** The width of an element, kept current: charts are drawn in real pixels so that their text is never stretched. */
export function useWidth<T extends HTMLElement>(initial = 640): [(node: T | null) => void, number] {
  const [width, setWidth] = useState(initial);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) return;
    const now = Math.round(node.getBoundingClientRect().width);
    if (now > 0) setWidth(now);
    observer.current = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setWidth((prev) => (prev === w || w === 0 ? prev : w));
    });
    observer.current.observe(node);
  }, []);
  return [ref, width];
}
