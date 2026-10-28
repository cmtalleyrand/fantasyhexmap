import test from 'node:test';
import { editCases } from '../../scripts/render-edit-fixtures.ts';
import { assertCachedBuildsMatch } from '../helpers/scene.ts';

test('incremental rebuilds equal uncached rebuilds along the whole chain of edits, Fractured coast galleries included', () => {
  assertCachedBuildsMatch(editCases());
});
