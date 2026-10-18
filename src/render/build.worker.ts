import { beginRenderProfile, endRenderProfile, profileSection, profileTime } from './profile.js';
import type { BuildReply, BuildRequest } from './buildProtocol.js';
import { loadLettering } from './fontFiles.js';
import { buildStaticScene } from './scene.js';
import { stableMap } from './stableMap.js';

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<BuildRequest>) => void;
  postMessage: (reply: BuildReply) => void;
};

const stable = stableMap();

host.onmessage = async ({ data }) => {
  if (data.profile) beginRenderProfile();
  try {
    const fontsDone = profileSection('worker.fonts');
    await loadLettering(data.lettering);
    fontsDone();
    const map = profileTime('worker.stableMap', () => stable(data.map));
    const scene = buildStaticScene(map, data.options);
    const profile = endRenderProfile();
    if (profile) performance.mark('build.reply.start');
    host.postMessage({ id: data.id, scene, ...(profile ? { profile } : {}) });
    if (profile) performance.measure('build.reply', 'build.reply.start');
  } catch (error) {
    endRenderProfile();
    host.postMessage({ id: data.id, error: String(error) });
  }
};
