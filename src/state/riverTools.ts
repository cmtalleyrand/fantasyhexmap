/** How the Rivers layer responds to the pointer when no river is being drawn. */
export type RiverToolKind = 'select' | 'move' | 'navigability';

export interface RiverTool {
  kind: RiverToolKind;
  /** The river being edited; highlighted on the map. */
  selectedId: string | null;
  /** What the navigability brush paints. */
  paintNavigable: boolean;
  /** Paint from the touched hex all the way to the river's mouth. */
  downstream: boolean;
}

export const DEFAULT_RIVER_TOOL: RiverTool = {
  kind: 'select',
  selectedId: null,
  paintNavigable: true,
  downstream: false,
};
