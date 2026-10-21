#!/usr/bin/env node
// One-off: generates heavily blurred, de-identified background photos for
// the hero band from a few representative field photos already in
// data/media/. Blur is strong enough that no individual is recognisable —
// this is a deliberate design choice (atmosphere, not a documentary photo),
// not a cropped/selective blur.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = new URL("..", import.meta.url).pathname;
const MEDIA_DIR = path.join(ROOT, "data/media");
const OUT_DIR = path.join(ROOT, "site/assets");

const SOURCES = [
  "IMG-20260827-WA0010.jpg",
  "IMG-20260831-WA0005.jpg",
  "IMG-20260903-WA0002.jpg",
  "IMG-20260908-WA0018.jpg",
  "IMG-20260914-WA0013.jpg",
  "IMG-20260914-WA0006.jpg",
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (let i = 0; i < SOURCES.length; i++) {
    const src = path.join(MEDIA_DIR, SOURCES[i]);
    if (!fs.existsSync(src)) {
      console.error(`! missing ${SOURCES[i]}, skipping`);
      continue;
    }
    const dest = path.join(OUT_DIR, `hero-bg-${i + 1}.jpg`);
    await sharp(src)
      .rotate()
      .resize({ width: 500, height: 500, fit: "cover" })
      .blur(28)
      .jpeg({ quality: 60 })
      .toFile(dest);
    console.log(`✓ hero-bg-${i + 1}.jpg ← ${SOURCES[i]}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
