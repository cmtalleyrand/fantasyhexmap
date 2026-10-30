import test from 'node:test';
import { editCases } from '../../scripts/render-edit-fixtures.ts';
import { assertRebuildMatchesUncached } from '../helpers/scene.ts';

test('incremental rebuilds equal uncached rebuilds along the whole chain of edits, Fractured coast galleries included', () => {
  for (const c of editCases()) assertRebuildMatchesUncached(c.map, c.options, c.name);
});
