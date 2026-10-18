import { buildExportScene } from './exportScene.js';
import type { PngExportRequest, PngExportReply } from './exportPng.js';
import { loadLettering } from './fontFiles.js';
import { renderPng } from './png.js';
import { CLASSIC_STYLE } from './styles.js';

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<PngExportRequest>) => void;
  postMessage: (reply: PngExportReply) => void;
};

host.onmessage = async ({ data }) => {
  try {
    await loadLettering((data.opts.style ?? CLASSIC_STYLE).knobs.lettering);
    const scene = buildExportScene(data.map, data.visible, data.opts);
    const blob = await renderPng(scene, data.opts.scale ?? 2);
    host.postMessage({ blob });
  } catch (error) {
    host.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
