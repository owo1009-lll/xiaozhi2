#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";

async function renderMask(svgPath, width, height, outputPath) {
  const image = await loadImage(svgPath);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, canvas.toBuffer("image/png"));
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error("manifest-path-required");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  for (const row of manifest.rows) {
    for (const name of Object.keys(row.outputs)) {
      await renderMask(row.maskSvgs[name], row.width, row.height, row.outputs[name]);
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, pageCount: manifest.rows.length })}\n`);
}

await main();
