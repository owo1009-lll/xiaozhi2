import fs from "node:fs";
import path from "node:path";

// Adds a Chinese display layer to a generated truth-signoff page.
//
// The generator itself is one of the frozen P3 sourceBindings, so editing it
// would invalidate the preregistration and switch Stage A recording
// authorisation back off. This therefore post-processes the OUTPUT html only.
//
// Display-only by construction: it rewrites rendered text nodes and option
// labels, never the values the page stores or downloads, so the signed JSON is
// byte-identical to what the untranslated page would produce.
//
//   node scripts/localize-truth-signoff-page.mjs <index.html> [out.html]
const source = path.resolve(process.argv[2] || "");
const target = path.resolve(process.argv[3] || source.replace(/\.html$/, "-zh.html"));
if (!fs.existsSync(source)) throw new Error(`page not found: ${source}`);

const DICTIONARY = {
  merged_substitution: "错音（音高错）",
  missing: "漏音",
  extra: "多拉",
  drag: "拖拍",
  positive: "★ 真错误",
  confusion_negative: "○ 对照（不是错误）",
  "accurate-pitch-control": "对照：音准拉准",
  "ordinary-step-control": "对照：正常级进",
  "wrong-pitch-control": "对照：音高错但有声",
  "neighbor-extension-control": "对照：前音盖住拍点",
  "normal-bow-change": "对照：正常换弓",
  "vibrato-peak": "对照：正常揉弦",
  "natural-rubato": "对照：自然 rubato",
  "normal-long-bow": "对照：正常长弓",
  calibration: "标定组",
  "fresh-blind": "盲测组",
  pending: "待确认",
  "local-private-pending": "本机私有 · 待确认",
};

const LOCALIZER = `
<script>
// Display layer only: the stored values, the localStorage payload and the
// downloaded JSON keep their original identifiers.
(function () {
  const DICT = ${JSON.stringify(DICTIONARY, null, 2)};
  const FIELD_LABELS = {
    asPerformed: "实际拉成什么样",
    completeErrorInventory: "本条录音的错误我已全部标注",
    consent: "知情同意",
    licenseStatus: "授权状态",
    performerId: "演奏者",
    deviceId: "设备",
    roomId: "房间",
    measure: "小节",
    beat: "拍",
    scoreMidi: "谱面音高",
    gate: "错误类型",
    label: "角色",
  };
  const all = { ...DICT, ...FIELD_LABELS };

  function translateTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const pending = [];
    while (walker.nextNode()) pending.push(walker.currentNode);
    for (const node of pending) {
      const raw = node.nodeValue.trim();
      if (all[raw]) node.nodeValue = node.nodeValue.replace(raw, all[raw]);
    }
  }

  function translateOptions(root) {
    for (const option of root.querySelectorAll("option")) {
      const raw = option.textContent.trim();
      // Only the visible label changes; option.value is left untouched.
      if (all[raw]) option.textContent = all[raw];
    }
    for (const input of root.querySelectorAll("input[placeholder]")) {
      const raw = input.getAttribute("placeholder").trim();
      if (all[raw]) input.setAttribute("placeholder", all[raw]);
    }
  }

  function run() {
    translateTextNodes(document.body);
    translateOptions(document);
  }

  // The page re-renders on every edit, so re-apply after DOM mutations.
  const observer = new MutationObserver(() => {
    observer.disconnect();
    run();
    observer.observe(document.body, { childList: true, subtree: true });
  });

  document.addEventListener("DOMContentLoaded", () => {
    run();
    observer.observe(document.body, { childList: true, subtree: true });
  });
  if (document.readyState !== "loading") {
    run();
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
</script>
`;

const html = fs.readFileSync(source, "utf8");
if (!html.includes("</body>")) throw new Error("page has no </body> to append to");
fs.writeFileSync(target, html.replace("</body>", `${LOCALIZER}</body>`), "utf8");

console.log(JSON.stringify({
  ok: true,
  source: path.relative(process.cwd(), source).replace(/\\/g, "/"),
  target: path.relative(process.cwd(), target).replace(/\\/g, "/"),
  terms: Object.keys(DICTIONARY).length,
  generatorUntouched: true,
}, null, 2));
