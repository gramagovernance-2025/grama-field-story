#!/usr/bin/env node
// Reads data/story.json (the reviewed, curated entries — see README) plus
// their photos in data/media/, and produces the self-contained site/ folder:
// optimized + thumbnailed images in site/images/, and site/data/story.json
// in the shape story page's JS reads. Nothing here calls Claude — this step
// is pure review-to-publish, safe to re-run any time.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA_DIR = path.join(ROOT, "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const SITE_DIR = path.join(ROOT, "site");
const SITE_IMAGES_DIR = path.join(SITE_DIR, "images");
const SITE_DATA_DIR = path.join(SITE_DIR, "data");

const FULL_MAX_DIM = 1800;
const THUMB_MAX_DIM = 700;

function slugify(title) {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function processPhoto(filename, destBase) {
  const src = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(src)) {
    console.error(`  ! photo not found in data/media/: ${filename} — skipping`);
    return null;
  }
  const img = sharp(src).rotate();
  const meta = await img.metadata();
  const ext = ".jpg";
  const fullName = destBase + ext;
  const thumbName = destBase + "-thumb" + ext;
  await sharp(src).rotate().resize({ width: FULL_MAX_DIM, height: FULL_MAX_DIM, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(path.join(SITE_IMAGES_DIR, fullName));
  await sharp(src).rotate().resize({ width: THUMB_MAX_DIM, height: THUMB_MAX_DIM, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(path.join(SITE_IMAGES_DIR, thumbName));
  // Width/height from the original orientation-corrected image — close
  // enough for the <img width/height> layout hint even after the resize.
  let { width, height } = meta;
  if (meta.orientation && meta.orientation >= 5) [width, height] = [height, width];
  if (width > height) {
    if (width > FULL_MAX_DIM) { height = Math.round((height * FULL_MAX_DIM) / width); width = FULL_MAX_DIM; }
  } else if (height > FULL_MAX_DIM) {
    width = Math.round((width * FULL_MAX_DIM) / height); height = FULL_MAX_DIM;
  }
  return { path: fullName, thumb_path: thumbName, width, height };
}

async function main() {
  const storyPath = path.join(DATA_DIR, "story.json");
  if (!fs.existsSync(storyPath)) {
    console.error("data/story.json not found. Review data/proposed-entries.json and save the entries you want");
    console.error("published as data/story.json first — see README.md.");
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(storyPath, "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.entries;
  const settings = Array.isArray(raw) ? {} : raw.settings || {};

  fs.mkdirSync(SITE_IMAGES_DIR, { recursive: true });
  fs.mkdirSync(SITE_DATA_DIR, { recursive: true });

  const usedSlugs = new Set();
  const outEntries = [];
  for (const e of entries) {
    if (e.is_public === false) continue; // not reviewed yet — leave out of the published site
    let slug = e.slug || slugify(e.title);
    let n = 2;
    while (usedSlugs.has(slug)) slug = `${slug}-${n++}`;
    usedSlugs.add(slug);

    const photoFiles = Array.isArray(e.photos) ? e.photos : [];
    const files = [];
    for (let i = 0; i < photoFiles.length; i++) {
      const processed = await processPhoto(photoFiles[i], `${slug}-${i + 1}`);
      if (processed) files.push({ ...processed, caption: (e.captions && e.captions[photoFiles[i]]) || "" });
    }
    const heroIdx = e.hero_photo ? photoFiles.indexOf(e.hero_photo) : 0;
    const hero = files[heroIdx] || files[0] || null;

    outEntries.push({
      slug,
      kind: e.kind || "event",
      category: e.category || "event",
      visit_number: e.visit_number || null,
      district: e.district || "",
      title: e.title || "",
      findings: Array.isArray(e.findings) ? e.findings : [],
      about: e.about || "",
      details: e.details || "",
      results: e.results || "",
      date_label: e.date_label || "",
      event_date: e.event_date || "",
      place: e.place || "",
      clf_count: e.clf_count || 0,
      hero: hero ? hero.path : null,
      hero_thumb: hero ? hero.thumb_path : null,
      files,
    });
    console.log(`✓ ${slug} (${files.length} photo${files.length === 1 ? "" : "s"})`);
  }

  outEntries.sort((a, b) => (a.event_date || "").localeCompare(b.event_date || ""));

  const consolidatedPhotoFiles = Array.isArray(settings.consolidated?.photos) ? settings.consolidated.photos : [];
  const consolidatedFiles = [];
  for (let i = 0; i < consolidatedPhotoFiles.length; i++) {
    const processed = await processPhoto(consolidatedPhotoFiles[i], `consolidated-${i + 1}`);
    if (processed) {
      consolidatedFiles.push({
        ...processed,
        caption: (settings.consolidated.captions && settings.consolidated.captions[consolidatedPhotoFiles[i]]) || "",
      });
    }
  }
  if (settings.consolidated) {
    settings.consolidated.photos = consolidatedFiles;
    delete settings.consolidated.captions;
  }
  if (consolidatedFiles.length) {
    console.log(`✓ consolidated section (${consolidatedFiles.length} photo${consolidatedFiles.length === 1 ? "" : "s"})`);
  }

  const howSteps = Array.isArray(settings.how_it_works?.steps) ? settings.how_it_works.steps : [];
  let howPhotoCount = 0;
  for (let i = 0; i < howSteps.length; i++) {
    const step = howSteps[i];
    if (step.photo) {
      const processed = await processPhoto(step.photo, `how-it-works-${i + 1}`);
      step.photo = processed ? { ...processed, caption: step.photo_caption || "" } : null;
      howPhotoCount += processed ? 1 : 0;
    }
    delete step.photo_caption;
    if (Array.isArray(step.photos)) {
      const processedPhotos = [];
      for (let j = 0; j < step.photos.length; j++) {
        const entry = step.photos[j];
        const processed = await processPhoto(entry.file, `how-it-works-${i + 1}-${j + 1}`);
        if (processed) {
          processedPhotos.push({ ...processed, caption: entry.caption || "" });
          howPhotoCount++;
        }
      }
      step.photos = processedPhotos;
    }
  }
  if (howPhotoCount) {
    console.log(`✓ how-it-works section (${howPhotoCount} photo${howPhotoCount === 1 ? "" : "s"})`);
  }

  const stats = {
    visits: outEntries.filter((e) => e.kind !== "panel").length,
    districts: new Set(outEntries.map((e) => e.district).filter(Boolean)).size,
    clfs: outEntries.reduce((sum, e) => sum + (e.clf_count || 0), 0),
    leaders: settings.total_leaders || null,
  };

  fs.writeFileSync(
    path.join(SITE_DATA_DIR, "story.json"),
    JSON.stringify({ entries: outEntries, settings, stats }, null, 2)
  );
  console.log(`\n${outEntries.length} entr${outEntries.length === 1 ? "y" : "ies"} published to site/data/story.json`);
  if (!outEntries.length) {
    console.log("(Nothing had is_public: true in data/story.json — nothing to show yet.)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
