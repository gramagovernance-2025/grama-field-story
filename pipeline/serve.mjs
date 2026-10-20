#!/usr/bin/env node
// Tiny static file server for previewing site/ locally (fetch() for
// story.json needs http://, not file://).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const SITE_DIR = new URL("../site/", import.meta.url).pathname;
const PORT = process.env.PORT || 8787;

const TYPES = { ".html": "text/html", ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".css": "text/css", ".js": "application/javascript" };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const filePath = path.join(SITE_DIR, p);
  if (!filePath.startsWith(SITE_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving site/ at http://localhost:${PORT}`));
