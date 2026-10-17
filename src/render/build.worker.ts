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
  try {
    await loadLettering(data.lettering);
    const scene = buildStaticScene(stable(data.map), data.options);
    host.postMessage({ id: data.id, scene });
  } catch (error) {
    host.postMessage({ id: data.id, error: String(error) });
  }
};
