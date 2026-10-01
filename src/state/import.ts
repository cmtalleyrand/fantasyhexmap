import { LAYER_ORDER, type MapState } from '../../shared/types.js';
import { normaliseHexDimensions } from '../../shared/surfaceArea.js';

const RESPONSE_KEYS = new Set<string>(LAYER_ORDER);

export function parseMapImport(text: string): MapState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The file is not one valid JSON document (${detail}). ` +
        'A file may contain only one top-level object, and backslashes may only introduce valid JSON escapes such as \\n, \\t, \\" or \\\\.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('That file does not look like a fantasyhexmap export.');
  }

  const object = parsed as Record<string, unknown>;
  const candidate = (object.map ?? object) as Partial<MapState>;
  if (!candidate.layers || !candidate.cols || !candidate.rows) {
    const keys = Object.keys(object);
    if (keys.length > 0 && keys.every((key) => RESPONSE_KEYS.has(key))) {
      throw new Error(
        'This is a webchat layer response, not a saved-map export. Import it from a layer\'s “by webchat” dialog and select the same layers.',
      );
    }
    throw new Error('That file does not look like a fantasyhexmap export.');
  }

  return { ...candidate, hexDimensions: normaliseHexDimensions(candidate.hexDimensions) } as MapState;
}
