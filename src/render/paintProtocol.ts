import type { LetteringId } from './lettering.js';
import type { MapState } from '../../shared/types.js';
import type { Scene, SceneOptions } from './scene.js';
import type { View } from './view.js';

export interface PaintView {
  view: View;
  size: { width: number; height: number };
  dpr: number;
}

export type PaintRequest =
  | { type: 'build'; version: number; id: number; map: MapState; options: SceneOptions }
  | { type: 'scene'; version: number; scene: Scene; lettering: LetteringId }
  | ({ type: 'paint'; version: number; id: number } & PaintView);

export interface PaintReply {
  version: number;
  id: number;
  bitmap?: ImageBitmap;
  overview?: { bitmap: ImageBitmap; width: number; height: number };
  error?: string;
  metadata?: Omit<Scene, 'prims'>;
  /** A sharp first frame can arrive before its whole-map overview. */
  complete?: boolean;
  timings?: { buildMs?: number; paintMs?: number; overviewMs?: number };
}
