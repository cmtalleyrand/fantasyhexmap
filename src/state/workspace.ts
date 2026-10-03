export type MapNavigationTool = 'select' | 'pan';

export interface PanelVisibility {
  layers: boolean;
  inspector: boolean;
}

export function startsPan(
  tool: MapNavigationTool,
  input: { button: number; altKey: boolean; spaceHeld: boolean },
): boolean {
  return tool === 'pan' || input.spaceHeld || input.altKey || input.button === 1 || input.button === 2;
}

export function toggleMapFocus(
  panels: PanelVisibility,
  previous: PanelVisibility,
): { panels: PanelVisibility; previous: PanelVisibility } {
  if (panels.layers || panels.inspector) {
    return { panels: { layers: false, inspector: false }, previous: panels };
  }
  return {
    panels: previous.layers || previous.inspector ? previous : { layers: true, inspector: true },
    previous,
  };
}

/**
 * The app works in one of two modes. AI mode is for describing and generating
 * the map; manual mode is for editing it by hand. Each shows only its own tools.
 */
export type EditorMode = 'ai' | 'manual';

const MODE_KEY = 'fhm.mode';

export function loadMode(fallback: EditorMode): EditorMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return stored === 'ai' || stored === 'manual' ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function saveMode(mode: EditorMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private windows and blocked storage just forget the choice.
  }
}

/** Which groups of controls a mode shows. Everything not listed here is shared. */
export function modeFeatures(mode: EditorMode) {
  const ai = mode === 'ai';
  return {
    /** Generation, the instruction box, batch ticks, the plan, the description, the decision log. */
    ai,
    /** Brush, city drag, river tools, hand editors, resize. */
    manual: !ai,
  };
}
