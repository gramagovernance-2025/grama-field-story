# grama-field-story

Turns a WhatsApp chat export from GRAMA's field coordination group into a
dynamic "Field Visits" story page for gramagovernance.com — in the editorial
style of [Redrawing the Map](https://gramagovernance.com/Redrawing-the-Map/).
Entries are grouped by district, each with a Top Findings summary up front
and About/What Happened/Results sections, and never name individual people —
results and outputs only.

Static site, no backend. Field visits are infrequent, so the flow is: export
the chat after a visit wraps up, run the pipeline, review what it found, publish.

## How it works

```
data/raw/<export>  →  extract.mjs  →  data/proposed-entries.json  (unreviewed)
                                            │
                                      (you review & edit)
                                            ▼
                                     data/story.json  (curated, is_public: true)
                                            │
                                      build-site.mjs
                                            ▼
                                 site/  (ready to deploy as-is)
```

1. **Export the chat.** In WhatsApp: open the group → ⋮ → More → Export chat
   → choose "Include media". Put the resulting `.zip` in `data/raw/`.

2. **Extract.** Parses the export, resizes any photos, and sends new
   messages (chunked, ~45 messages / 20 images per call) to Claude, which
   groups them into candidate story entries — same approach as SACCI's
   WhatsApp Import, minus the parts that only make sense with a live
   multi-user backend.

   ```
   cp .env.example .env   # fill in ANTHROPIC_API_KEY
   npm run extract -- data/raw/your-export.zip
   ```

   Output: `data/proposed-entries.json`, and every photo referenced in the
   export copied into `data/media/`. Nothing is published yet.

3. **Review.** Open `data/proposed-entries.json`. For each entry you want to
   publish, check/edit `title`, `findings`, `about`, `details`, `results`,
   `event_date`, `date_label`, `category`, `place` — rewrite anything that
   still reads like a narrative rather than results-first, and double check
   no individual is named. Add `district` (used to group the page's
   sections) and `visit_number` (this entry's position within the published
   set). Trim `photos` down to the ones worth showing and caption them. Copy
   the entries you're keeping into `data/story.json` (an array, or
   `{entries: [...], settings: {...}}` — see below), and set
   `is_public: true` on each. Run extract again any time — new entries
   append to `proposed-entries.json` without touching ones already reviewed
   into `story.json`.

   `data/story.json` entry shape:
   ```json
   {
     "is_public": true,
     "slug": "optional-custom-slug",
     "category": "field-visit",
     "district": "Muzaffarpur",
     "visit_number": 1,
     "event_date": "2026-03-12",
     "date_label": "12 March 2026",
     "title": "...",
     "findings": ["A specific, concrete result.", "Another one."],
     "about": "Why this visit happened / what was being tested.",
     "details": "What actually happened, told plainly.",
     "results": "What this visit produced or changed.",
     "place": "Village, Block",
     "photos": ["IMG-20260312-WA0007.jpg"],
     "hero_photo": "IMG-20260312-WA0007.jpg",
     "captions": { "IMG-20260312-WA0007.jpg": "..." }
   }
   ```
   Optional top-level `settings`: `{"title": "...", "intro": "..."}` for the
   page's hero heading and dek.

4. **Build.** Resizes photos (full + thumbnail), writes
   `site/data/story.json` in the shape the page reads.

   ```
   npm run build
   ```

5. **Preview.**

   ```
   npm run serve
   ```
   then open http://localhost:8787.

6. **Publish.** `site/` is self-contained (HTML + `data/story.json` +
   `images/`) — push it to its own repo and GitHub Pages (same pattern as
   `Redrawing-the-Map` and `gramagovernance-2025.github.io`), or copy it into
   an existing repo as a subdirectory. Nothing to configure, no database.

## Customizing for the actual chat

Edit `pipeline/config.mjs` before your first `extract` run:
- `CATEGORIES` — the tags an entry can be filed under (defaults: field-visit,
  finding, partnership, milestone, event).
- `buildSystemPrompt()` — the extraction instructions themselves, if the
  defaults need tuning once you see what real output looks like. Written to
  never name individuals and to produce results-first `findings`/`about`/
  `details`/`results` fields rather than a narrative.

## Project layout

- `pipeline/` — the Node scripts (`extract.mjs`, `build-site.mjs`,
  `serve.mjs`) and their shared modules (`parse-export.mjs` — WhatsApp export
  parsing, `images.mjs` — photo resizing, `schema.mjs` — the structured
  output schema Claude fills in, `config.mjs` — domain knowledge/prompt).
- `data/` — `raw/` (your exports, gitignored), `media/` (extracted photos,
  gitignored), `proposed-entries.json` (AI output, gitignored — regenerate
  any time), `story.json` (curated, **committed** — this is the reviewed,
  approved content), `ledger.json` (dedup record, gitignored).
- `site/` — the published page. `index.html` + `data/story.json` +
  `images/` is the entire deployable artifact.
