import type { DrawingCompromise } from './scene.js';

/** Group equal notices without discarding any locations; losses precede adaptations. */
export function groupCompromises(notes: DrawingCompromise[]): DrawingCompromise[] {
  const groups = new Map<string, DrawingCompromise>();
  for (const note of notes) {
    const key = JSON.stringify([note.severity ?? 'loss', note.what, note.why]);
    const known = groups.get(key);
    if (known) known.hexes = [...new Set([...known.hexes, ...note.hexes])];
    else groups.set(key, { ...note, hexes: [...note.hexes] });
  }
  return [...groups.values()].sort((a, b) => Number(a.severity === 'adaptation') - Number(b.severity === 'adaptation'));
}
