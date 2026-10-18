import type { RenderProfile } from './profile.js';
import type { MapState } from '../../shared/types.js';
import type { LetteringId } from './lettering.js';
import type { Scene, SceneOptions } from './scene.js';

/** Build the scene of `map` (see `buildStaticScene`), its lettering loaded first so names measure true. */
export interface BuildRequest {
  id: number;
  map: MapState;
  options: SceneOptions;
  lettering: LetteringId;
  profile?: boolean;
}

export interface BuildReply {
  id: number;
  scene?: Scene;
  profile?: RenderProfile;
  error?: string;
}
