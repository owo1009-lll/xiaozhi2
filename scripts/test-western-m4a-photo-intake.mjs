import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ingestM4aPhotos } from "./ingest-western-m4a-photo-acceptance.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "western-m4a-intake-"));
try {
  await fs.mkdir(path.join(temporary, "repo", "config"), { recursive: true });
  const source = path.join(temporary, "source");
  await fs.mkdir(source);
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    caseId: `case-${index + 1}`,
    photoPath: `data/private/acceptance/photo-${index + 1}.jpg`,
  }));
  await fs.writeFile(
    path.join(temporary, "repo", "config", "western-m4a-real-photo-acceptance.json"),
    JSON.stringify({ positiveCaptureTasks: tasks }),
  );
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  for (let index = 1; index <= 10; index += 1) {
    await fs.writeFile(path.join(source, `photo-${index}.jpg`), Buffer.concat([jpeg, Buffer.from([index])]));
  }
  const first = await ingestM4aPhotos({ repoRoot: path.join(temporary, "repo"), sourceRoot: source });
  assert.equal(first.ready, true);
  assert.equal(first.rows.filter((row) => row.status === "ingested").length, 10);
  const second = await ingestM4aPhotos({ repoRoot: path.join(temporary, "repo"), sourceRoot: source });
  assert.equal(second.ready, true);
  assert.equal(second.rows.filter((row) => row.status === "already-current").length, 10);
  await fs.writeFile(path.join(source, "photo-1.jpg"), Buffer.concat([jpeg, Buffer.from([99])]));
  const collision = await ingestM4aPhotos({ repoRoot: path.join(temporary, "repo"), sourceRoot: source });
  assert.equal(collision.ready, false);
  assert.equal(collision.rows[0].status, "different-destination-exists");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "exact-ten-file-intake",
    "image-signature-validation",
    "idempotent-reingest",
    "different-existing-photo-fails-without-replace",
  ],
}, null, 2));
