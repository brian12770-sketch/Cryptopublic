import { useEffect, useMemo, useRef, useState } from 'react';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';

export interface Tile {
  key: string;
  label: string;
  /** Value printed under the label, e.g. +2.31% or 3.2×. */
  value: string;
  /** Colour class from lib/scale. */
  cls: string;
  /** Layout weight. Only read when `layoutKey` changes. */
  size: number;
  /** Full description for assistive tech. */
  description: string;
}

interface Props {
  tiles: Tile[];
  /** Changes when tiles should be re-laid out; keeps boxes still between ticks. */
  layoutKey: string;
  activeKey: string | null;
  onHover(key: string | null): void;
  onSelect(key: string): void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Root {
  children: { key: string; size: number }[];
}

export function Treemap({ tiles, layoutKey, activeKey, onHover, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;

  const boxes = useMemo(() => {
    const out = new Map<string, Box>();
    if (size.w < 10 || size.h < 10) return out;
    const data: Root = {
      // Area follows the square root of turnover: proportional area would give
      // BTC and ETH most of the map and leave the other 48 unreadable.
      children: tilesRef.current.map((t) => ({ key: t.key, size: Math.sqrt(Math.max(t.size, 0)) })),
    };
    const root = hierarchy<Root | Root['children'][number]>(data, (d) => ('children' in d ? d.children : undefined))
      .sum((d) => ('size' in d ? d.size : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    treemap<Root | Root['children'][number]>()
      .tile(treemapSquarify.ratio(1.4))
      .size([size.w, size.h])
      .paddingInner(2)
      .round(true)(root);
    for (const leaf of root.leaves()) {
      const d = leaf.data;
      if (!('key' in d)) continue;
      const r = leaf as unknown as { x0: number; y0: number; x1: number; y1: number };
      out.set(d.key, { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, size.w, size.h]);

  return (
    <div className="treemap" ref={ref} onPointerLeave={() => onHover(null)}>
      {tiles.map((t) => {
        const box = boxes.get(t.key);
        if (!box || box.w < 1 || box.h < 1) return null;
        // Size the label to the box; a label that cannot fit is left out rather
        // than clipped. The readout and the table carry every value regardless.
        const font = Math.min(20, box.h / 2.4, (box.w - 6) / (t.label.length * 0.68));
        const showLabel = font >= 9;
        const showValue = showLabel && box.h >= font * 2.5 && t.value.length * font * 0.5 <= box.w - 6;
        return (
          <button
            key={t.key}
            type="button"
            className={`tile c-${t.cls}${activeKey === t.key ? ' is-active' : ''}`}
            style={{ left: box.x, top: box.y, width: box.w, height: box.h, fontSize: font }}
            aria-label={t.description}
            onPointerEnter={(e) => {
              if (e.pointerType === 'mouse') onHover(t.key);
            }}
            onFocus={() => onHover(t.key)}
            onBlur={() => onHover(null)}
            onClick={() => onSelect(t.key)}
          >
            {showLabel && <span className="tile-label">{t.label}</span>}
            {showValue && <span className="tile-value">{t.value}</span>}
          </button>
        );
      })}
    </div>
  );
}
