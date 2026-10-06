/** A map image independent of the viewport: navigation copies pixels instead of replaying paths. */
import { drawScene } from './canvas.js';
import type { Scene } from './scene.js';
import type { View } from './view.js';

export class SceneRaster {
  readonly canvas: HTMLCanvasElement;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly phaseX: number;
  readonly phaseY: number;

  constructor(readonly scene: Scene, view: View, viewport: { width: number; height: number }, readonly dpr: number) {
    this.scale = view.scale;
    const pixels = dpr * view.scale;
    this.phaseX = view.x * dpr - Math.floor(view.x * dpr);
    this.phaseY = view.y * dpr - Math.floor(view.y * dpr);
    // Cache the whole map when it fits. At large zooms retain an overscanned
    // window, so a 100×100 map cannot allocate a map-sized canvas at 4× DPR.
    const full = scene.width * scene.height * pixels * pixels <= 8_000_000;
    const margin = 160;
    const left = full ? 0 : Math.max(0, (-view.x - margin) / view.scale);
    const top = full ? 0 : Math.max(0, (-view.y - margin) / view.scale);
    const right = full ? scene.width : Math.min(scene.width, (viewport.width - view.x + margin) / view.scale);
    const bottom = full ? scene.height : Math.min(scene.height, (viewport.height - view.y + margin) / view.scale);
    this.x = (Math.floor(left * pixels) - this.phaseX) / pixels;
    this.y = (Math.floor(top * pixels) - this.phaseY) / pixels;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, Math.ceil((right - this.x) * pixels) + 1);
    this.canvas.height = Math.max(1, Math.ceil((bottom - this.y) * pixels) + 1);
    this.width = this.canvas.width / pixels;
    this.height = this.canvas.height / pixels;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(pixels, 0, 0, pixels, -this.x * pixels, -this.y * pixels);
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
    drawScene(ctx, scene);
  }

  covers(view: View, viewport: { width: number; height: number }): boolean {
    const left = Math.max(0, -view.x / view.scale), top = Math.max(0, -view.y / view.scale);
    const right = Math.min(this.scene.width, (viewport.width - view.x) / view.scale);
    const bottom = Math.min(this.scene.height, (viewport.height - view.y) / view.scale);
    if (right <= left || bottom <= top) return true;
    return left >= this.x && top >= this.y && right <= this.x + this.width && bottom <= this.y + this.height;
  }

  sharpAt(view: View): boolean {
    return this.scale === view.scale
      && Math.abs(this.phaseX - (view.x * this.dpr - Math.floor(view.x * this.dpr))) < 1e-8
      && Math.abs(this.phaseY - (view.y * this.dpr - Math.floor(view.y * this.dpr))) < 1e-8;
  }

  draw(ctx: CanvasRenderingContext2D, view: View): void {
    ctx.drawImage(this.canvas, view.x + this.x * view.scale, view.y + this.y * view.scale,
      this.width * view.scale, this.height * view.scale);
  }
}
