import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const assetsDir = fileURLToPath(new URL('../assets/', import.meta.url));
const outputPath = fileURLToPath(new URL('../assets/banner-storytelling.png', import.meta.url));
const provenancePath = fileURLToPath(new URL('../assets/banner-storytelling.png.json', import.meta.url));
const WIDTH = 1600;
const HEIGHT = 294;
const SCALE = 2;

function imageDataUri(bytes, mimeType) {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function makeBannerHtml(artData, signatureData) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${WIDTH}, initial-scale=1">
  <title>Vítor Cepeda Lopes | Creative work. Systems. Open source.</title>
  <style>
    html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    body { position: relative; background: #E6342E; color: #0b0b0b; }
    .top-band { position: absolute; inset: 0 0 auto; height: 99px; background: #050505; }
    .red-field { position: absolute; inset: 99px 0 0; background: #E6342E; }
    .signature { position: absolute; z-index: 2; top: 17px; left: 52px; height: 67px; width: auto; }
    .tagline { position: absolute; z-index: 2; top: 41px; right: 386px; color: #fff; font: 500 16px/1.2 'Avenir Next', sans-serif; letter-spacing: 2px; white-space: nowrap; }
    .architecture { position: absolute; z-index: 1; inset: 0; clip-path: polygon(82% 0, 100% 0, 100% 100%, 61% 100%); }
    .architecture img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 100% 56%; }
    .headline { position: absolute; z-index: 2; top: 112px; left: 48px; display: flex; flex-direction: column; color: #090909; font-family: 'Avenir Next Condensed', 'Avenir Next'; font-size: 79px; font-weight: 700; line-height: .88; letter-spacing: -1.8px; white-space: nowrap; }
    .headline span { display: block; }
    .stairs-copy { position: absolute; z-index: 3; top: 153px; right: 37px; width: 118px; color: #fff; font: 500 12px/1.55 'Avenir Next', sans-serif; letter-spacing: 3px; }
    .stairs-copy span { display: block; }
    .stairs-copy::after { content: ''; display: block; width: 28px; height: 2px; margin-top: 9px; background: #E6342E; }
  </style>
</head>
<body>
  <div class="top-band"></div>
  <div class="red-field"></div>
  <div class="architecture" aria-hidden="true"><img src="${artData}" alt=""></div>
  <img class="signature" src="${signatureData}" alt="">
  <div class="tagline">Storytelling · Creativity · Agentic systems</div>
  <div class="headline"><span>Creative work.</span><span>Systems. Open source.</span></div>
  <div class="stairs-copy" aria-label="Better stories. Brighter systems."><span>BETTER</span><span>STORIES</span><span>BRIGHTER</span><span>SYSTEMS</span></div>
</body>
</html>`;
}

async function main() {
  const art = await readFile(`${assetsDir}/banner-art.png`);
  const signature = await readFile(`${assetsDir}/signature.svg`, 'utf8');
  const html = makeBannerHtml(imageDataUri(art, 'image/png'), imageDataUri(Buffer.from(signature), 'image/svg+xml'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: SCALE,
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => Promise.all(Array.from(document.images, (image) => image.decode())));
    const textFits = await page.evaluate(() => {
      const headline = document.querySelector('.headline');
      const bounds = headline.getBoundingClientRect();
      const secondLine = headline.lastElementChild.getBoundingClientRect();
      const tagline = document.querySelector('.tagline').getBoundingClientRect();
      const signature = document.querySelector('.signature').getBoundingClientRect();
      return bounds.bottom <= window.innerHeight && secondLine.right < window.innerWidth * 0.62 && tagline.left > signature.right && tagline.bottom < 99;
    });
    if (!textFits) throw new Error('banner text does not fit the approved composition');
    await page.screenshot({ path: outputPath, type: 'png', animations: 'disabled' });
  } finally {
    await browser.close();
  }

  const provenance = {
    generatedBy: 'scripts/render-banner.mjs',
    output: 'assets/banner-storytelling.png',
    outputCssSize: { width: WIDTH, height: HEIGHT },
    outputPixelSize: { width: WIDTH * SCALE, height: HEIGHT * SCALE },
    inputs: [
      { path: 'assets/banner-art.png', provenance: 'Root-supplied generated architectural artwork; see assets/banner-art.png.json.' },
      { path: 'assets/signature.svg', provenance: 'Unchanged copy of output/cv-assets/personal-brand/vitor-signature-negative.svg.' },
    ],
    typography: { family: 'Avenir Next Condensed', source: 'Installed macOS system font; no font file is distributed.' },
    artworkRole: 'Decorative architectural composition, not a portfolio-work image.',
    tagline: 'Storytelling · Creativity · Agentic systems',
  };
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  console.log(`Rendered ${provenance.output} at ${provenance.outputPixelSize.width}x${provenance.outputPixelSize.height}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Banner rendering failed: ${error.message}`);
    process.exitCode = 1;
  });
}
