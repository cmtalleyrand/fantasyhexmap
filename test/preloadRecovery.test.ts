import assert from 'node:assert/strict';
import test from 'node:test';
import { installPreloadRecovery } from '../src/preloadRecovery.ts';

test('reloads the page and suppresses the stale chunk error', () => {
  let listener: ((event: Event) => void) | undefined;
  let reloads = 0;
  const target = {
    addEventListener(type: 'vite:preloadError', nextListener: (event: Event) => void) {
      assert.equal(type, 'vite:preloadError');
      listener = nextListener;
    },
    location: {
      reload() {
        reloads += 1;
      },
    },
  };

  installPreloadRecovery(target);
  const event = new Event('vite:preloadError', { cancelable: true });
  assert.ok(listener);
  listener(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(reloads, 1);
});
