/**
 * How the Rivers layer responds to the pointer when no river is being drawn.
 *
 * - `select`: click a river to select it, or one of its hexes to pick that hex;
 *   drag one of its hexes to move it.
 * - `extend`: click a hex to stretch the selected river's nearer end to it.
 * - `navigability`: drag along rivers to mark them navigable or not.
 *
 * Drawing a new river is not a tool kind: it is the river draft in App, which
 * takes over the pointer while it exists.
 */
export type RiverToolKind = 'select' | 'extend' | 'navigability';

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

/** A message about the last river edit, shown in the river panel next to the controls. */
export interface RiverNotice {
  kind: 'error' | 'info';
  text: string;
}
