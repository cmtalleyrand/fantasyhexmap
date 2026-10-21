import assert from 'node:assert/strict';

/** Scene SVGs reuse clip/pattern IDs. Each image must own a separate SVG document. */
export function sceneImage(svg, alt = '') {
  return `<img alt="${alt.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
}

/** Every contact-sheet panel must render exactly as it does in isolation. */
export async function verifySceneImages(page) {
  const reference = await page.context().newPage();
  let checked = 0;
  try {
    for (const image of await page.locator('.card img').all()) {
      const info = await image.evaluate(i => ({ src: i.src, width: i.getBoundingClientRect().width, height: i.getBoundingClientRect().height, x: i.getBoundingClientRect().x, y: i.getBoundingClientRect().y }));
      // Keep the absolute pixel position too: SVG rasterization can round
      // fractional transforms differently at a different page origin.
      await reference.setContent(`<style>body{margin:0;background:#f5f3ed}img{position:absolute;left:${info.x}px;top:${info.y}px;display:block;width:${info.width}px;height:${info.height}px}</style><img src="${info.src}">`);
      await reference.locator('img').evaluate(i => i.decode());
      const actual = await image.screenshot(), expected = await reference.locator('img').screenshot();
      assert.ok(actual.equals(expected), `Comparison panel ${checked + 1} differs from its standalone render`);
      checked++;
    }
  } finally { await reference.close(); }
  assert.ok(checked > 0, 'No isolated comparison images were verified');
  return checked;
}
