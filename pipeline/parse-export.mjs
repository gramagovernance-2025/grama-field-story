// Ports sacci-net's client-side WhatsApp export parser (portal.html,
// parseWhatsAppExport + the zip-unpacking in waAcceptFiles) to Node, plus a
// local-file ledger standing in for SACCI's whatsapp_messages database table
// — so re-running extract on a chat export that overlaps an earlier one
// (the whole group history, say, exported again after a new pilot) only
// sends genuinely new messages to Claude.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";

const MEDIA_EXT = /\.(jpe?g|png|webp|gif|pdf|mp4|opus|m4a)$/i;
const INVISIBLE_MARKS = /[‎‏﻿‪-‮]/g;

function p2(n) {
  return (n < 10 ? "0" : "") + n;
}

function normTimestamp(dateStr, timeStr) {
  const dm = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!dm) return null;
  let d = parseInt(dm[1], 10), mo = parseInt(dm[2], 10), y = parseInt(dm[3], 10);
  if (y < 100) y += 2000;
  const tm = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (!tm) return null;
  let hh = parseInt(tm[1], 10);
  const mm = parseInt(tm[2], 10);
  const ap = timeStr.match(/([ap])\.?\s?m\.?/i);
  if (ap) {
    const half = ap[1].toLowerCase();
    if (half === "p" && hh < 12) hh += 12;
    if (half === "a" && hh === 12) hh = 0;
  }
  return `${y}-${p2(mo)}-${p2(d)} ${p2(hh)}:${p2(mm)}`;
}

function headerParse(line) {
  // "[a, b] Sender: text" where a/b are time and date in either order,
  // plus the common Android form "DD/MM/YYYY, HH:MM - Sender: text".
  const m = line.match(/^\[([^\],]+),\s*([^\]]+)\]\s*([^:]{1,60}):\s?([\s\S]*)$/);
  if (m) {
    const a = m[1].trim(), b = m[2].trim();
    const dateStr = a.indexOf("/") >= 0 ? a : b;
    const timeStr = a.indexOf("/") >= 0 ? b : a;
    const ts = normTimestamp(dateStr, timeStr);
    if (ts) return { sent_at: ts, sender: m[3].trim(), body: m[4] };
  }
  const m2 = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}\s?(?:[apAP]\.?\s?[mM]\.?)?)\s*-\s*([^:]{1,60}):\s?([\s\S]*)$/);
  if (m2) {
    const ts2 = normTimestamp(m2[1], m2[2]);
    if (ts2) return { sent_at: ts2, sender: m2[3].trim(), body: m2[4] };
  }
  return null;
}

function headerLike(line) {
  return /^\[[^\]]*\d{1,2}\/\d{1,2}\/\d{2,4}[^\]]*\]/.test(line) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/.test(line);
}

export function parseWhatsAppExport(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(INVISIBLE_MARKS, ""));
  const msgs = [];
  let cur = null;
  lines.forEach((line) => {
    const head = headerParse(line);
    if (head) {
      cur = { sent_at: head.sent_at, sender: head.sender, body: head.body, media: [] };
      msgs.push(cur);
      return;
    }
    if (headerLike(line)) {
      cur = null; // timestamped system line (no sender) — skip
      return;
    }
    if (cur) cur.body += "\n" + line;
  });
  msgs.forEach((m) => {
    m.body = m.body.replace(/([\w\-.]+\.(?:jpe?g|png|webp|gif|pdf|mp4|opus|m4a))\s*\(file attached\)\s*/gi, (_, fn) => {
      m.media.push(fn);
      return "";
    });
    m.body = m.body.replace(/‎/g, "").trim();
  });
  // Strip quoted-reply echoes: a reply often prefixes a copy of the message
  // it quotes — keep only the new text.
  for (let i = 1; i < msgs.length; i++) {
    for (let j = Math.max(0, i - 12); j < i; j++) {
      const prev = msgs[j].body;
      if (prev && prev.length >= 24 && msgs[i].body.length > prev.length && msgs[i].body.indexOf(prev) === 0) {
        msgs[i].body = msgs[i].body.slice(prev.length).replace(/^\s+/, "");
        break;
      }
    }
  }
  return msgs.filter((m) => m.body || m.media.length);
}

export function sha256hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function hashMessages(msgs) {
  msgs.forEach((m) => {
    m.msg_hash = sha256hex(`${m.sender}|${m.sent_at}|${m.body}`);
  });
  return msgs;
}

// Accepts a .zip (WhatsApp "export with media"), a .txt, or a directory
// already containing both. Returns { text, mediaDir }.
export function loadExportSource(inputPath) {
  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(inputPath);
    const txtName = files.find((f) => f.toLowerCase().endsWith(".txt"));
    if (!txtName) throw new Error(`No .txt chat file found in ${inputPath}`);
    return { text: fs.readFileSync(path.join(inputPath, txtName), "utf8"), mediaDir: inputPath };
  }
  const lower = inputPath.toLowerCase();
  if (lower.endsWith(".zip")) {
    const destDir = path.join(path.dirname(inputPath), `.extracted-${path.basename(inputPath, ".zip")}`);
    const zip = new AdmZip(inputPath);
    fs.mkdirSync(destDir, { recursive: true });
    let txtEntry = null;
    zip.getEntries().forEach((entry) => {
      if (entry.isDirectory) return;
      const base = path.basename(entry.entryName);
      const bl = base.toLowerCase();
      if (bl.endsWith(".txt")) {
        if (!txtEntry || entry.header.size > txtEntry.header.size) txtEntry = entry;
      } else if (MEDIA_EXT.test(bl)) {
        fs.writeFileSync(path.join(destDir, base), entry.getData());
      }
    });
    if (!txtEntry) throw new Error(`No .txt chat file found inside ${inputPath}`);
    fs.writeFileSync(path.join(destDir, path.basename(txtEntry.entryName)), txtEntry.getData());
    return { text: txtEntry.getData().toString("utf8"), mediaDir: destDir };
  }
  if (lower.endsWith(".txt")) {
    return { text: fs.readFileSync(inputPath, "utf8"), mediaDir: path.dirname(inputPath) };
  }
  throw new Error(`Don't know how to read ${inputPath} — expected a .zip, .txt, or a directory`);
}

const DEFAULT_LEDGER_PATH = new URL("../data/ledger.json", import.meta.url).pathname;

export function loadLedger(ledgerPath = DEFAULT_LEDGER_PATH) {
  try {
    return new Set(JSON.parse(fs.readFileSync(ledgerPath, "utf8")));
  } catch {
    return new Set();
  }
}

export function saveLedger(hashes, ledgerPath = DEFAULT_LEDGER_PATH) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify([...hashes], null, 2));
}
