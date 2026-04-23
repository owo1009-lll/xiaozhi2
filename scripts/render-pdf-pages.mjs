import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas } from "@napi-rs/canvas";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readArg(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index < process.argv.length - 1) {
    return process.argv[index + 1];
  }
  return fallback;
}

function parsePages(rawPages, maxPages) {
  if (!rawPages) {
    return [1];
  }

  const result = new Set();
  for (const part of String(rawPages).split(",")) {
    const token = part.trim();
    if (!token) continue;
    if (token.includes("-")) {
      const [startToken, endToken] = token.split("-", 2);
      const start = Math.max(1, Number(startToken));
      const end = Math.min(maxPages, Number(endToken));
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const lower = Math.min(start, end);
        const upper = Math.max(start, end);
        for (let page = lower; page <= upper; page += 1) {
          result.add(page);
        }
      }
      continue;
    }

    const page = Number(token);
    if (Number.isFinite(page) && page >= 1 && page <= maxPages) {
      result.add(page);
    }
  }

  return Array.from(result).sort((left, right) => left - right);
}

async function renderPage(page, scale, outputPath) {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;
  await fs.writeFile(outputPath, canvas.toBuffer("image/png"));
}

async function main() {
  const pdfPath = path.resolve(repoRoot, readArg("--pdf", "data/test_score.pdf"));
  const outputDir = path.resolve(repoRoot, readArg("--output-dir", "data/pdf_preview"));
  const scale = Number(readArg("--scale", "1.6")) || 1.6;

  const loadingTask = pdfjsLib.getDocument(pdfPath);
  const pdfDocument = await loadingTask.promise;
  const pages = parsePages(readArg("--pages", ""), pdfDocument.numPages);

  await fs.mkdir(outputDir, { recursive: true });

  const outputs = [];
  for (const pageNumber of pages) {
    const page = await pdfDocument.getPage(pageNumber);
    const outputPath = path.join(outputDir, `page-${pageNumber}.png`);
    await renderPage(page, scale, outputPath);
    outputs.push(path.relative(repoRoot, outputPath));
  }

  console.log(JSON.stringify({
    ok: true,
    pdfPath,
    pageCount: pdfDocument.numPages,
    renderedPages: pages,
    outputDir,
    outputs,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
