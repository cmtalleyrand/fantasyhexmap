import type { LetteringId } from './lettering.js';
import type { MapState } from '../../shared/types.js';
import type { Scene, SceneOptions } from './scene.js';
import type { View } from './view.js';
import type { RenderProfile } from './profile.js';

export interface PaintView {
  view: View;
  size: { width: number; height: number };
  dpr: number;
}

export type PaintRequest =
  /** With `allowStandIn`, a build whose exact coast is not yet fitted first returns a stand-in (`standIn` in the reply). */
  | { type: 'build'; version: number; id: number; map: MapState; options: SceneOptions; allowStandIn?: boolean; profile?: boolean }
  | { type: 'scene'; version: number; scene: Scene; lettering: LetteringId; profile?: boolean }
  | ({ type: 'paint'; version: number; id: number; profile?: boolean } & PaintView);

export interface PaintReply {
  version: number;
  id: number;
  bitmap?: ImageBitmap;
  /** Sent separately, after the sharp frame, once the whole map is rasterized. */
  overview?: { bitmap: ImageBitmap; width: number; height: number };
  error?: string;
  metadata?: Omit<Scene, 'prims'>;
  /** The scene built is a stand-in; the exact scene must still be requested. */
  standIn?: boolean;
  timings?: { buildMs?: number; paintMs?: number; overviewMs?: number };
  profile?: RenderProfile;
}
