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
