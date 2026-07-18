import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const config = JSON.parse(await fs.readFile(
  path.join(repoRoot, "config", "western-m4a-real-photo-acceptance.json"),
  "utf8",
));
const registryRoot = path.join(
  repoRoot,
  "data",
  "experiments",
  "western-strings-m4a",
  "supported-editions",
);
const registry = JSON.parse(await fs.readFile(path.join(registryRoot, "registry.json"), "utf8"));
const entries = new Map(registry.entries.map((entry) => [`${entry.pieceId}:${entry.editionId}`, entry]));
const tasks = config.positiveCaptureTasks.map((task) => {
  const entry = entries.get(`${task.pieceId}:${task.editionId}`);
  if (!entry) throw new Error(`missing registered edition for ${task.caseId}`);
  return {
    ...task,
    renderUrl: `../../data/experiments/western-strings-m4a/supported-editions/${entry.renderPath}`,
    outputName: `${task.caseId}.jpg`,
  };
});

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>M4a 真实屏拍验收包</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #111827; color: #f9fafb; }
    header { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 10px 16px; background: rgba(17,24,39,.96); border-bottom: 1px solid #374151; }
    h1 { margin: 0; font-size: 18px; }
    .meta { color: #cbd5e1; font-size: 13px; }
    button { border: 1px solid #64748b; border-radius: 8px; background: #1e293b; color: white; padding: 8px 12px; cursor: pointer; }
    button.active { background: #0f766e; border-color: #2dd4bf; }
    main { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 60px); }
    aside { padding: 12px; border-right: 1px solid #374151; overflow: auto; }
    .task { width: 100%; text-align: left; margin-bottom: 8px; }
    .viewer { display: grid; place-items: center; padding: 12px; overflow: hidden; background: #0b0f16; }
    #score { max-width: 100%; max-height: calc(100vh - 88px); object-fit: contain; box-shadow: 0 0 0 1px #94a3b8; background: white; }
    .instructions { margin-top: 14px; padding: 12px; border-radius: 8px; background: #1f2937; color: #dbeafe; font-size: 13px; line-height: 1.55; }
    code { color: #99f6e4; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid #374151; } #score { max-height: 72vh; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>M4a 真实屏拍验收包 · 10 张</h1>
      <div class="meta" id="meta"></div>
    </div>
    <button id="fullscreen">全屏显示当前谱页</button>
  </header>
  <main>
    <aside>
      <div id="tasks"></div>
      <div class="instructions">
        <strong>拍摄纪律</strong><br>
        1. 用手机相机拍屏幕，不要截屏；完整保留白色谱页四边。<br>
        2. 按任务指定角度做轻度透视，不要故意模糊或裁页。<br>
        3. 每张照片改成页面显示的精确文件名。<br>
        4. 放入 <code>Downloads\\m4a-photo-acceptance</code>，之后运行：<br>
        <code>npm run western:m4a-photo-intake</code>
      </div>
    </aside>
    <section class="viewer" id="viewer"><img id="score" alt="登记谱页"></section>
  </main>
  <script>
    const tasks = ${JSON.stringify(tasks)};
    const list = document.querySelector('#tasks');
    const score = document.querySelector('#score');
    const meta = document.querySelector('#meta');
    let active = 0;
    function show(index) {
      active = index;
      const task = tasks[index];
      score.src = task.renderUrl;
      meta.textContent = \`${'${task.caseId}'} · ${'${task.pieceId}'} · ${'${task.captureVariant}'} · 保存为 ${'${task.outputName}'}\`;
      [...list.children].forEach((button, i) => button.classList.toggle('active', i === index));
    }
    tasks.forEach((task, index) => {
      const button = document.createElement('button');
      button.className = 'task';
      button.textContent = \`${'${index + 1}'}. ${'${task.caseId}'} · ${'${task.captureVariant}'}\`;
      button.addEventListener('click', () => show(index));
      list.appendChild(button);
    });
    document.querySelector('#fullscreen').addEventListener('click', () => document.querySelector('#viewer').requestFullscreen());
    show(0);
  </script>
</body>
</html>
`;

const outputRoot = path.join(repoRoot, "docs", "m4a-real-photo-capture-pack");
await fs.mkdir(outputRoot, { recursive: true });
await fs.writeFile(path.join(outputRoot, "index.html"), html, "utf8");
await fs.writeFile(
  path.join(outputRoot, "capture-tasks.json"),
  `${JSON.stringify({
    contract: "western-m4a-real-photo-capture-pack-v1",
    policy: "config/western-m4a-real-photo-acceptance.json",
    tasks,
  }, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({ ok: true, outputRoot: path.relative(repoRoot, outputRoot).replace(/\\/g, "/"), taskCount: tasks.length }, null, 2));
