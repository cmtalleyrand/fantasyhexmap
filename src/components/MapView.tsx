import type { PolityNameMin } from '../render/labels.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hexIndex, pixelToOffset, gridPixelSize, inBounds } from '../../shared/hex.js';
import type { LayerId, MapState } from '../../shared/types.js';
import { drawPrims, drawScene } from '../render/canvas.js';
import { buildStaticScene, decorationPrims, type VisibleLayers } from '../render/scene.js';
import type { MapStyle } from '../render/styles.js';
import { MAP_COLOURS } from '../render/palette.js';
import { riversThroughHex } from '../../shared/derive.js';
import { formatLength, riverLength } from '../../shared/riverLength.js';
import { riverLabel } from '../../shared/riverEdit.js';
import { normaliseHexDimensions } from '../../shared/surfaceArea.js';
import type { RiverTool } from '../state/riverTools.js';
import { pinchView, zoomAt, type ScreenPoint, type View } from '../render/view.js';
import { startsPan, type MapNavigationTool } from '../state/workspace.js';
import { loadLettering } from '../render/fontFiles.js';

const HEX_SIZE = 26;

export interface MapViewProps {
  map: MapState;
  visible: VisibleLayers;
  labels: boolean;
  riverNames: boolean;
  rangeNames: boolean;
  seaNames: boolean;
  landNames: boolean;
  polityNames: PolityNameMin;
  polityOpacity: number;
  mapStyle: MapStyle;
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
  onCityMove: ((cityId: string, targetIndex: number) => void) | null;
  /** Non-null while the Rivers layer is being edited on the map (and no river is being drawn). */
  riverTool: RiverTool | null;
  /** A river hex was clicked or grabbed; the caller decides which river that selects. */
  onRiverSelect: (index: number) => void;
  onRiverMove: (fromIndex: number, toIndex: number) => void;
  /** The extend tool clicked this hex while a river was selected. */
  onRiverExtend: (index: number) => void;
  /** A navigability stroke finished over these hexes. */
  onRiverPaint: (indices: number[]) => void;
  /**
   * The hexes of the place name being painted into, or null when none is armed. They stay outlined
   * under the pointer, and strokes add to the selection rather than replacing it.
   */
  paintHexes?: number[] | null;
  /** Shown over the middle of the map, such as the first step on an empty map. */
  overlay?: React.ReactNode;
  /** Messages pinned to the top of the map: errors and the outcome of the last action. */
  banner?: React.ReactNode;
}

export default function MapView(props: MapViewProps) {
  const { map, visible, labels, riverNames, rangeNames, seaNames, landNames, polityNames, polityOpacity, mapStyle, selection, onSelectionChange, onStrokeEnd } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const drag = useRef<
    | { mode: 'pan'; startX: number; startY: number; originX: number; originY: number }
    | { mode: 'select'; additive: boolean; touched: Set<number> }
    | { mode: 'city'; cityId: string; target: number }
    | { mode: 'riverMove'; from: number; target: number }
    | { mode: 'riverPaint'; touched: Set<number> }
    | { mode: 'pinch'; start: View; a0: ScreenPoint; b0: ScreenPoint; ids: [number, number] }
    | null
  >(null);
  /** Every pointer currently down, by id, for two-finger pan and zoom on touch screens. */
  const pointers = useRef(new Map<number, ScreenPoint>());
  /** Held Space turns a drag into a pan, as in most drawing tools. */
  const spaceHeld = useRef(false);
  const [panReady, setPanReady] = useState(false);
  const [navigationTool, setNavigationTool] = useState<MapNavigationTool>('select');
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e)) return;
      e.preventDefault();
      spaceHeld.current = true;
      setPanReady(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceHeld.current = false;
      setPanReady(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Names are measured in the style's lettering, so once its bundled fonts
  // have loaded the map is laid out again with the real widths.
  const [fontsVersion, setFontsVersion] = useState(0);
  const lettering = mapStyle.knobs.lettering;
  useEffect(() => {
    let live = true;
    void loadLettering(lettering).then(() => {
      if (live) setFontsVersion((v) => v + 1);
    });
    return () => {
      live = false;
    };
  }, [lettering]);

  // The map itself is rebuilt only when the data or a display option changes;
  // the pointer moving only rebuilds the hover and selection outlines.
  const scene = useMemo(
    () =>
      buildStaticScene(map, {
        size: HEX_SIZE,
        visible,
        labels,
        riverNames,
        rangeNames,
        seaNames,
        landNames,
        polityNames,
        polityOpacity,
        style: mapStyle,
        highlightRiver: props.riverTool?.selectedId ?? null,
      }),
    [map, visible, labels, riverNames, rangeNames, seaNames, landNames, polityNames, polityOpacity, mapStyle, props.riverTool?.selectedId, fontsVersion],
  );
  const decoration = useMemo(() => {
    const riverDraftSelection = props.riverDraft ? new Set(props.riverDraft) : null;
    return decorationPrims(map, {
      size: HEX_SIZE,
      visible,
      labels,
      selection: riverDraftSelection ?? (props.paintHexes ? new Set([...props.paintHexes, ...selection]) : selection),
      hover,
    });
  }, [map, visible, labels, selection, hover, props.riverDraft, props.paintHexes]);

  // Fit the map into the viewport the first time it is laid out, and again
  // whenever a different map (a load, an import, a new map) takes its place.
  const fitted = useRef(false);
  useEffect(() => {
    fitted.current = false;
  }, [map.id, map.cols, map.rows]);
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
  }, [fit, size.width, map.id]);

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
    drawPrims(ctx, decoration);
    ctx.restore();
  }, [scene, decoration, view, size]);

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

  const localPoint = (e: { clientX: number; clientY: number }): ScreenPoint => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, localPoint(e));
    if (pointers.current.size === 2) {
      // A second finger turns whatever the first one started into a pan and zoom.
      // The first touch has already selected its hex; the pinch just leaves that be.
      const [[idA, a0], [idB, b0]] = [...pointers.current.entries()] as [[number, ScreenPoint], [number, ScreenPoint]];
      drag.current = { mode: 'pinch', start: view, a0, b0, ids: [idA, idB] };
      return;
    }
    if (pointers.current.size > 2) return;
    const panning = startsPan(navigationTool, {
      button: e.button,
      altKey: e.altKey,
      spaceHeld: spaceHeld.current,
    });
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

    const tool = props.riverTool;
    if (tool) {
      if (tool.kind === 'select') {
        // A river hex is picked, and dragging it moves it; anywhere else just picks the hex.
        const rivers = map.layers.rivers.data?.rivers ?? [];
        if (riversThroughHex(rivers, index % map.cols, Math.floor(index / map.cols)).length > 0) {
          props.onRiverSelect(index);
          drag.current = { mode: 'riverMove', from: index, target: index };
        }
        onSelectionChange(new Set([index]));
      } else if (tool.kind === 'extend') {
        const rivers = map.layers.rivers.data?.rivers ?? [];
        const here = riversThroughHex(rivers, index % map.cols, Math.floor(index / map.cols));
        // With a river selected, clicking another river runs the selected one
        // into it as a tributary; with none, it picks the river clicked.
        if (here.some((r) => r.id === tool.selectedId)) {
          // Already part of the selected river: nothing to extend.
        } else if (tool.selectedId) props.onRiverExtend(index);
        else if (here.length > 0) props.onRiverSelect(index);
        onSelectionChange(new Set([index]));
      } else {
        drag.current = { mode: 'riverPaint', touched: new Set([index]) };
        onSelectionChange(new Set([index]));
      }
      return;
    }

    if (props.onCityMove) {
      const city = map.layers.cities.data?.cities.find(
        (candidate) => hexIndex(map.cols, candidate.col, candidate.row) === index,
      );
      if (city) {
        drag.current = { mode: 'city', cityId: city.id, target: index };
        onSelectionChange(new Set([index]));
        return;
      }
    }

    // Painting a name only ever adds: the name's own hexes stay shown and a stroke never un-selects.
    const painting = !!props.paintHexes && !!onStrokeEnd;
    const additive = painting || e.shiftKey || e.ctrlKey || e.metaKey;
    const touched = new Set<number>([index]);
    drag.current = { mode: 'select', additive, touched };
    const next = additive ? new Set(selection) : new Set<number>();
    if (additive && !painting && selection.has(index)) next.delete(index);
    else next.add(index);
    onSelectionChange(next);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, localPoint(e));
    const state = drag.current;
    if (state?.mode === 'pinch') {
      const a = pointers.current.get(state.ids[0]);
      const b = pointers.current.get(state.ids[1]);
      if (a && b) setView(pinchView(state.start, state.a0, state.b0, a, b));
      return;
    }
    const index = hexAt(e.clientX, e.clientY);
    setHover(index);
    if (!state) return;
    if (state.mode === 'pan') {
      setView((v) => ({
        ...v,
        x: state.originX + (e.clientX - state.startX),
        y: state.originY + (e.clientY - state.startY),
      }));
      return;
    }
    if (state.mode === 'city') {
      if (index !== null && index !== state.target) {
        state.target = index;
        onSelectionChange(new Set([index]));
      }
      return;
    }
    if (state.mode === 'riverMove') {
      if (index !== null && index !== state.target) {
        state.target = index;
        onSelectionChange(new Set([state.from, index]));
      }
      return;
    }
    if (state.mode === 'riverPaint') {
      if (index !== null && !state.touched.has(index)) {
        state.touched.add(index);
        onSelectionChange(new Set(state.touched));
      }
      return;
    }
    if (index === null || state.touched.has(index)) return;
    state.touched.add(index);
    const next = state.additive ? new Set(selection) : new Set(state.touched);
    if (state.additive) for (const i of state.touched) next.add(i);
    onSelectionChange(next);
  };

  const onPointerUp = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (e) pointers.current.delete(e.pointerId);
    else pointers.current.clear();
    const state = drag.current;
    if (state?.mode === 'pinch') {
      // The gesture ends when either finger lifts; the other does nothing until it lifts too.
      if (pointers.current.size < 2) drag.current = null;
      return;
    }
    drag.current = null;
    if (state?.mode === 'select' && onStrokeEnd) onStrokeEnd([...state.touched]);
    if (state?.mode === 'city') props.onCityMove?.(state.cityId, state.target);
    if (state?.mode === 'riverMove' && state.target !== state.from) {
      // A drag moved the hex; a plain click leaves it picked.
      onSelectionChange(new Set());
      props.onRiverMove(state.from, state.target);
    }
    if (state?.mode === 'riverPaint') {
      onSelectionChange(new Set());
      props.onRiverPaint([...state.touched]);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0015), px, py));
  };

  const hoverText = () => {
    if (hover === null) {
      const nav = navigationTool === 'pan'
        ? 'Drag to pan · wheel or pinch to zoom'
        : 'Drag to select · Space-drag, right-drag or two fingers to pan';
      if (props.onRiverDraftClick) return `Click hexes from source to mouth · Enter finishes, Esc cancels · ${nav}`;
      if (props.riverTool?.kind === 'extend') return `Click a hex to extend the selected river to it (a lake upstream to rise in it, another river to flow into it) · ${nav}`;
      if (props.riverTool?.kind === 'navigability') return `Drag along a river to set navigability · ${nav}`;
      if (props.riverTool) return `Click a river to select it, drag one of its hexes to move it · ${nav}`;
      return props.onCityMove
        ? `Drag a city to move it · ${nav}`
        : nav;
    }
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
    for (const river of riversThroughHex(map.layers.rivers.data?.rivers ?? [], col, row)) {
      const seg = river.segments.find((x) => x.col === col && x.row === row);
      const dims = normaliseHexDimensions(map.hexDimensions);
      bits.push(
        `${riverLabel(river, map.layers.rivers.data?.rivers ?? [])} (${seg?.navigable ? 'navigable' : 'not navigable'}, ${formatLength(riverLength(river, dims), dims.unit, dims.lengthRounding)})`,
      );
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
        onPointerCancel={onPointerUp}
        className={navigationTool === 'pan' ? 'pan-tool' : undefined}
        style={panReady ? { cursor: 'grab' } : undefined}
        onPointerLeave={() => {
          setHover(null);
          if (pointers.current.size <= 1) onPointerUp();
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      {props.overlay && <div className="map-overlay">{props.overlay}</div>}
      {props.banner}
      <div className="maphud">{hoverText()}</div>
      <div className="mapzoom" role="toolbar" aria-label="Map navigation">
        <div className="map-tool-toggle" aria-label="Pointer tool">
          <button
            className="tiny"
            aria-pressed={navigationTool === 'select'}
            onClick={() => setNavigationTool('select')}
            title="Drag across hexes to select them"
          >
            select
          </button>
          <button
            className="tiny"
            aria-pressed={navigationTool === 'pan'}
            onClick={() => setNavigationTool('pan')}
            title="Drag the map to move around it"
          >
            pan
          </button>
        </div>
        <button
          className="tiny"
          aria-label="Zoom in"
          onClick={() => setView((v) => zoomAt(v, 1.2, size.width / 2, size.height / 2))}
        >
          +
        </button>
        <button
          className="tiny"
          aria-label="Zoom out"
          onClick={() => setView((v) => zoomAt(v, 1 / 1.2, size.width / 2, size.height / 2))}
        >
          −
        </button>
        <button className="tiny" onClick={fit}>fit</button>
      </div>
    </div>
  );
}
