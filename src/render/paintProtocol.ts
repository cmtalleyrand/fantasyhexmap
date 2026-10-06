import type { LetteringId } from './lettering.js';
import type { Scene } from './scene.js';
import type { View } from './view.js';

export interface PaintView {
  view: View;
  size: { width: number; height: number };
  dpr: number;
}

export type PaintRequest =
  | { type: 'scene'; version: number; scene: Scene; lettering: LetteringId }
  | ({ type: 'paint'; version: number; id: number } & PaintView);

export interface PaintReply {
  version: number;
  id: number;
  bitmap?: ImageBitmap;
  overview?: { bitmap: ImageBitmap; width: number; height: number };
  error?: string;
}
