'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const { chromium } = require(modulePath);
  const root = path.resolve(__dirname, '..');
  const html = path.join(root, 'assets', 'social-card.html');
  const output = path.join(root, 'assets', 'social-card.png');
  const launch = { headless: true, args: ['--no-sandbox'] };
  if (process.env.CHROME_EXECUTABLE) launch.executablePath = process.env.CHROME_EXECUTABLE;
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    if (dimensions.width !== 1200 || dimensions.height !== 675) throw new Error('Social card layout must be 1200 by 675 pixels.');
    await page.screenshot({ path: output, animations: 'disabled' });
    const image = await fs.readFile(output);
    const width = image.readUInt32BE(16);
    const height = image.readUInt32BE(20);
    if (width !== 1200 || height !== 675) throw new Error('Social card image must be 1200 by 675 pixels.');
    process.stdout.write(`${output} ${width}x${height}\n`);
  } finally {
    await browser.close();
  }
}

main().catch(() => {
  process.stderr.write('Could not render the social card. Set PLAYWRIGHT_MODULE and CHROME_EXECUTABLE.\n');
  process.exitCode = 1;
});
