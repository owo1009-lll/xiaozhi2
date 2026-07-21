import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  manifestTemplateCsv,
  truthTemplate,
} from "../docs/round5-targeted-diagnosis-capture-pack/capture-plan.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repo, "docs", "round5-targeted-diagnosis-capture-pack");
await fs.writeFile(path.join(output, "manifest.template.csv"), manifestTemplateCsv(), "utf8");
await fs.writeFile(
  path.join(output, "truth.template.json"),
  `${JSON.stringify(truthTemplate(), null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({
  ok: true,
  manifest: "docs/round5-targeted-diagnosis-capture-pack/manifest.template.csv",
  truth: "docs/round5-targeted-diagnosis-capture-pack/truth.template.json",
}));
