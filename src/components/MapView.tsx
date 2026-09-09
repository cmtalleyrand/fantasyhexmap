import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hexIndex, pixelToOffset, gridPixelSize, inBounds } from '../../shared/hex.js';
import type { LayerId, MapState } from '../../shared/types.js';
import { drawScene } from '../render/canvas.js';
import { buildScene, type VisibleLayers } from '../render/scene.js';
import { MAP_COLOURS } from '../render/palette.js';

const HEX_SIZE = 26;

export interface MapViewProps {
  map: MapState;
  visible: VisibleLayers;
  labels: boolean;
  selection: Set<number>;
  onSelectionChange: (next: Set<number>) => void;
  /**
   * Called when a select-drag finishes. In brush mode the caller applies the
   * current value to these hexes as ONE undo entry, rather than one per hex.
   */
  onStrokeEnd: ((indices: number[]) => void) | null;
  activeLayer: LayerId;
  riverDraft: number[] | null;
  onRiverDraftClick: ((index: number) => void) | null;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

export default function MapView(props: MapViewProps) {
  const { map, visible, labels, selection, onSelectionChange, onStrokeEnd } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const drag = useRef<
    | { mode: 'pan'; startX: number; startY: number; originX: number; originY: number }
    | { mode: 'select'; additive: boolean; touched: Set<number> }
    | null
  >(null);

  const scene = useMemo(() => {
    const riverDraftSelection = props.riverDraft ? new Set(props.riverDraft) : null;
    return buildScene(map, {
      size: HEX_SIZE,
      visible,
      labels,
      selection: riverDraftSelection ?? selection,
      hover,
    });
  }, [map, visible, labels, selection, hover, props.riverDraft]);

  // Fit the map into the viewport the first time it is laid out.
  const fitted = useRef(false);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    const grid = gridPixelSize(map.cols, map.rows, HEX_SIZE);
    const scale = Math.min(
      (size.width - 40) / grid.width,
      (size.height - 40) / grid.height,
    );
    const clamped = Math.max(0.15, Math.min(4, scale));
    setView({
      scale: clamped,
      x: (size.width - grid.width * clamped) / 2,
      y: (size.height - grid.height * clamped) / 2,
    });
  }, [map.cols, map.rows, size.width, size.height]);

  useEffect(() => {
    if (!fitted.current && size.width > 10) {
      fitted.current = true;
      fit();
    }
  }, [fit, size.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(size.width * dpr));
    canvas.height = Math.max(1, Math.floor(size.height * dpr));
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = MAP_COLOURS.background;
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
    drawScene(ctx, scene);
    ctx.restore();
  }, [scene, view, size]);

  const hexAt = useCallback(
    (clientX: number, clientY: number): number | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const worldX = (clientX - rect.left - view.x) / view.scale;
      const worldY = (clientY - rect.top - view.y) / view.scale;
      const { col, row } = pixelToOffset(worldX, worldY, HEX_SIZE);
      if (!inBounds(map.cols, map.rows, col, row)) return null;
      return hexIndex(map.cols, col, row);
    },
    [map.cols, map.rows, view],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const panning = e.button === 1 || e.button === 2 || e.altKey;
    if (panning) {
      drag.current = {
        mode: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        originX: view.x,
        originY: view.y,
      };
      return;
    }
    const index = hexAt(e.clientX, e.clientY);
    if (index === null) return;

    if (props.onRiverDraftClick) {
      props.onRiverDraftClick(index);
      return;
    }

    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const touched = new Set<number>([index]);
    drag.current = { mode: 'select', additive, touched };
    const next = additive ? new Set(selection) : new Set<number>();
    if (additive && selection.has(index)) next.delete(index);
    else next.add(index);
    onSelectionChange(next);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const index = hexAt(e.clientX, e.clientY);
    setHover(index);
    const state = drag.current;
    if (!state) return;
    if (state.mode === 'pan') {
      setView((v) => ({
        ...v,
        x: state.originX + (e.clientX - state.startX),
        y: state.originY + (e.clientY - state.startY),
      }));
      return;
    }
    if (index === null || state.touched.has(index)) return;
    state.touched.add(index);
    const next = state.additive ? new Set(selection) : new Set(state.touched);
    if (state.additive) for (const i of state.touched) next.add(i);
    onSelectionChange(next);
  };

  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (state?.mode === 'select' && onStrokeEnd) onStrokeEnd([...state.touched]);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((v) => {
      const factor = Math.exp(-e.deltaY * 0.0015);
      const scale = Math.max(0.12, Math.min(6, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };

  const hoverText = () => {
    if (hover === null) return 'Drag to select · Alt-drag or right-drag to pan · Wheel to zoom';
    const col = hover % map.cols;
    const row = Math.floor(hover / map.cols);
    const bits: string[] = [`hex ${col},${row}`];
    const base = map.layers.base.data?.[hover];
    if (base) bits.push(base);
    const elevation = map.layers.elevation.data?.[hover];
    if (elevation) bits.push(elevation);
    const climate = map.layers.climate.data?.[hover];
    if (climate) bits.push(climate);
    const vegetation = map.layers.vegetation.data?.[hover];
    if (vegetation) bits.push(vegetation);
    const population = map.layers.population.data?.[hover];
    if (population !== null && population !== undefined) bits.push(`pop ${population.toLocaleString()}`);
    const owner = map.layers.polities.data?.owner[hover];
    if (owner) {
      const polity = map.layers.polities.data?.polities.find((p) => p.id === owner);
      if (polity) bits.push(polity.name);
    }
    const cities = map.layers.cities.data?.cities.filter((c) => hexIndex(map.cols, c.col, c.row) === hover) ?? [];
    for (const city of cities) bits.push(`${city.name} (${city.population.toLocaleString()})`);
    return bits.join(' · ');
  };

  return (
    <div className="mapwrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHover(null);
          onPointerUp();
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="maphud">{hoverText()}</div>
      <div className="mapzoom">
        <button className="tiny" onClick={() => setView((v) => ({ ...v, scale: Math.min(6, v.scale * 1.2) }))}>+</button>
        <button className="tiny" onClick={() => setView((v) => ({ ...v, scale: Math.max(0.12, v.scale / 1.2) }))}>−</button>
        <button className="tiny" onClick={fit}>fit</button>
      </div>
    </div>
  );
}
