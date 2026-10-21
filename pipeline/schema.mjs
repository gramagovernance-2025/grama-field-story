import { z } from "zod";
import { CATEGORIES } from "./config.mjs";

// Mirrors parse-whatsapp's per-request schema build in sacci-net (category
// names are fixed here rather than loaded from a live table, since this
// project has no database — CATEGORIES in config.mjs is the single source
// of truth both the prompt and this schema read from).
export function buildEntrySchema() {
  const EntrySchema = z.object({
    category: z.enum(CATEGORIES),
    event_date: z.string(),
    date_label: z.string(),
    source_message_indexes: z.array(z.number()),
    title: z.string(),
    findings: z.array(z.string()),
    about: z.string(),
    details: z.string(),
    results: z.string(),
    place: z.string(),
  });
  return z.object({ entries: z.array(EntrySchema) });
}
