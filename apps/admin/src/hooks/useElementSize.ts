import { useLayoutEffect, useRef, useState } from 'react';

export type ElementSize = { width: number; height: number };

/**
 * Observe an element's size using ResizeObserver.
 * Returns a tuple: [ref, { width, height }]
 */
export default function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Initialize with current size
    const rect = el.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setSize({ width: cr.width, height: cr.height });
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size] as const;
}