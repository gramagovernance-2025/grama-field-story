#!/usr/bin/env node
// Entry point: `npm run extract -- <path-to-export>`.
// <path-to-export> is whatever WhatsApp gave you — the .zip from "Export
// chat" (with media), a plain .txt, or an already-unzipped folder.
//
// Mirrors sacci-net's WhatsApp Import flow (portal.html waImport +
// supabase/functions/parse-whatsapp), minus the parts that only make sense
// with a live multi-user backend (auth, patient-roster matching, a database
// ledger). What's kept: export parsing, reply-echo stripping, image
// resizing, chunking at ~45 messages/20 images per call, and the Claude
// extraction call itself. Output is never auto-published — it lands in
// data/proposed-entries.json for review before anything becomes part of the
// public story (data/story.json).
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  parseWhatsAppExport,
  loadExportSource,
  hashMessages,
  loadLedger,
  saveLedger,
} from "./parse-export.mjs";
import { resizeImageForVision, isImageFile } from "./images.mjs";
import { buildEntrySchema } from "./schema.mjs";
import { buildSystemPrompt } from "./config.mjs";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const CHUNK_MAX_MESSAGES = 45;
const CHUNK_MIN_BEFORE_DAY_CUT = 20;
const CHUNK_MAX_IMAGES = 20;

function chunkMessages(msgs) {
  const chunks = [];
  let cs = 0;
  while (cs < msgs.length) {
    let ce = Math.min(cs + CHUNK_MAX_MESSAGES, msgs.length);
    if (ce < msgs.length) {
      let de = ce;
      while (de > cs + CHUNK_MIN_BEFORE_DAY_CUT && msgs[de - 1].sent_at.slice(0, 10) === msgs[de].sent_at.slice(0, 10)) {
        de--;
      }
      if (de > cs + CHUNK_MIN_BEFORE_DAY_CUT) ce = de;
    }
    chunks.push({ start: cs, end: ce });
    cs = ce;
  }
  return chunks;
}

async function buildImagePayload(slice, mediaDir) {
  const jobs = [];
  let skipped = 0;
  slice.forEach((m, j) => {
    (m.media || []).forEach((fn) => {
      if (!isImageFile(fn)) return;
      const filePath = path.join(mediaDir, fn);
      if (!fs.existsSync(filePath)) return;
      if (jobs.length >= CHUNK_MAX_IMAGES) {
        skipped++;
        return;
      }
      jobs.push({ message_index: j, filename: fn, filePath });
    });
  });
  const out = [];
  for (const job of jobs) {
    try {
      const enc = await resizeImageForVision(job.filePath);
      out.push({ message_index: job.message_index, filename: job.filename, ...enc });
    } catch (e) {
      console.error(`  ! skipping unreadable image ${job.filename}: ${e.message}`);
    }
  }
  out.skippedCount = skipped;
  return out;
}

function buildContent(slice, images) {
  const content = [{ type: "text", text: "WhatsApp messages:" }];
  slice.forEach((m, i) => {
    const attached = m.media && m.media.length ? ` [attached: ${m.media.join(", ")}]` : "";
    content.push({ type: "text", text: `[${i}] ${m.sent_at} — ${m.sender}: ${m.body}${attached}` });
    images
      .filter((img) => img.message_index === i)
      .forEach((img) => {
        content.push({ type: "text", text: `(image attached to [${i}]: ${img.filename})` });
        content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
      });
  });
  return content;
}

function parseArgs(argv) {
  const args = { from: null, to: null, _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") args.from = argv[++i];
    else if (argv[i] === "--to") args.to = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args._[0];
  if (!inputPath) {
    console.error("Usage: npm run extract -- <path-to-whatsapp-export> [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
    console.error("  <path-to-whatsapp-export> is the .zip from WhatsApp's Export Chat (with media),");
    console.error("  a plain .txt, or an already-unzipped folder.");
    console.error("  --from/--to restrict extraction to messages sent in that date range (inclusive).");
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in, then:");
    console.error("  export $(cat .env | xargs) && npm run extract -- <path>");
    process.exit(1);
  }

  console.log(`Reading ${inputPath} ...`);
  const { text, mediaDir } = loadExportSource(inputPath);
  let parsed = parseWhatsAppExport(text);
  if (!parsed.length) {
    console.error("No WhatsApp messages recognized. Expected lines like \"[12:48, 09/08/2026] Name: message\".");
    console.error("First 200 chars of the file:\n" + text.slice(0, 200));
    process.exit(1);
  }
  if (args.from || args.to) {
    const before = parsed.length;
    parsed = parsed.filter((m) => {
      const d = m.sent_at.slice(0, 10);
      if (args.from && d < args.from) return false;
      if (args.to && d > args.to) return false;
      return true;
    });
    console.log(`Filtered to ${parsed.length}/${before} messages between ${args.from || "…"} and ${args.to || "…"}.`);
  }
  hashMessages(parsed);

  // Copy every media file the export actually references into a persistent
  // data/media/ folder, so curation (writing data/story.json) can refer to
  // filenames that outlive the export's temp-extracted directory. Images
  // only here — videos/audio/pdfs aren't part of the story page.
  const mediaOutDir = path.join(DATA_DIR, "media");
  fs.mkdirSync(mediaOutDir, { recursive: true });
  let copiedMedia = 0;
  parsed.forEach((m) => {
    (m.media || []).forEach((fn) => {
      if (!isImageFile(fn)) return;
      const src = path.join(mediaDir, fn);
      const dest = path.join(mediaOutDir, fn);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        copiedMedia++;
      }
    });
  });
  if (copiedMedia) console.log(`Copied ${copiedMedia} photo(s) into data/media/`);

  const ledgerPath = path.join(DATA_DIR, "ledger.json");
  const ledger = loadLedger(ledgerPath);
  const fresh = parsed.filter((m) => !ledger.has(m.msg_hash));
  console.log(`${parsed.length} message(s) in the export, ${parsed.length - fresh.length} already processed earlier.`);
  if (!fresh.length) {
    console.log("Nothing new to extract.");
    return;
  }

  const chunks = chunkMessages(fresh);
  const anthropic = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt();
  const entrySchema = buildEntrySchema();

  const allEntries = [];
  let totalSkippedPhotos = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const { start, end } = chunks[ci];
    const slice = fresh.slice(start, end);
    process.stdout.write(`Reading messages ${start}-${end} (part ${ci + 1}/${chunks.length})`);
    const images = await buildImagePayload(slice, mediaDir);
    totalSkippedPhotos += images.skippedCount || 0;
    process.stdout.write(images.length ? ` + ${images.length} photo(s) ...\n` : " ...\n");

    const response = await anthropic.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: "user", content: buildContent(slice, images) }],
      output_config: { effort: "medium", format: zodOutputFormat(entrySchema) },
    });
    const parsedOutput = response.parsed_output;
    if (!parsedOutput) {
      console.error(`  ! could not parse part ${ci + 1} — skipping`);
      continue;
    }
    parsedOutput.entries.forEach((e) => {
      const photos = [];
      e.source_message_indexes.forEach((i) => {
        (slice[i]?.media || []).filter(isImageFile).forEach((fn) => {
          if (!photos.includes(fn)) photos.push(fn);
        });
      });
      allEntries.push({
        ...e,
        source_message_indexes: e.source_message_indexes.map((x) => x + start),
        photos,
        hero_photo: photos[0] || "",
        is_public: false,
      });
    });
  }

  saveLedger(new Set([...ledger, ...fresh.map((m) => m.msg_hash)]), ledgerPath);

  const outPath = path.join(DATA_DIR, "proposed-entries.json");
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : [];
  const combined = [...existing, ...allEntries];
  fs.writeFileSync(outPath, JSON.stringify(combined, null, 2));

  console.log(`\n${allEntries.length} proposed entr${allEntries.length === 1 ? "y" : "ies"} written to data/proposed-entries.json`);
  if (totalSkippedPhotos) {
    console.log(`⚠️  ${totalSkippedPhotos} photo(s) weren't read (per-chunk limit) — re-run extract on the same export to pick them up.`);
  }
  console.log("Review and edit that file, then move the entries you want published into data/story.json (see README).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
