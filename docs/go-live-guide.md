# 上线手册:stringinstrumentdiagnosis.icu

前端放 Vercel(你熟),后端(分析器)放这台机器、经 Cloudflare 隧道对外。学生打开域名 → 用 Vercel 上的界面 → 界面把请求发到 `api.` 子域 → 隧道进到这台机器的后端。

**现在上线的形态是「受控试点」**:学生能上传练习录音,由你在本机复核后放行反馈;机器自动判分暂时是关的。2026-07-24 已完成一个当前合同下的离线 review-only 批，证明全谱候选与 M3+ 复核链可以实际运行，但它使用的是已查看录音，不能作为学生自动判分的 fresh 发布证据。P0–P2 零录音审计已经榨完，Round 6 当前只授权先录 6 条反向配平 calibration；只有它训练出的冻结候选先通过既有真实干净域安全闸，才条件追加 6 条 untouched fresh 并执行一次性 `90% precision / 50% recall / 0 strict-FP` 真闸。数值通过后仍须另行取得学生端发布授权；不能再写成“现在一次录满 12 条”或“等 round4 6 条后直接开开关”。

**口径边界:** 本手册的“上线”只指公网提交+教师人工复核站点,不等于签署口径中的 `projectReleaseReady`,也不授权照片谱自动评分。M4a 的 189/189 逐框签署现已完成,M4 必选路径已从项目总闸失败项移除;总闸仍因 ordinary/M3+ 学生自动反馈闸保持关闭。当前三个自动反馈运行时开关继续为 false。

代码这边我已经全部就绪:公网守卫(只放行学生接口,后台/研究/`/data` 一律挡在公网外)、CORS、前端自动指向 `api.` 子域、`vercel.json`、启动脚本、隧道配置模板。下面是**只有你能做的账户步骤**。

---

## 一次性准备:域名托管到 Cloudflare

1. 注册 [Cloudflare](https://dash.cloudflare.com/sign-up)(免费),`Add a site` 填 `stringinstrumentdiagnosis.icu`,选 Free 计划。
2. Cloudflare 会给你两个 nameserver。到你**买域名的网站**(.icu 注册商)后台,把该域名的 nameserver 改成这两个。生效要几分钟到几小时。
3. 生效后 Cloudflare 面板里这个域名状态变成 `Active`。之后主域名和 api 子域的 DNS 都在 Cloudflare 这里配。

---

## A. 后端上线(这台机器)

### A1. 起后端(公网模式)

在项目目录开 PowerShell:

```powershell
npm run go-live:backend
```

这会以公网模式起后端:只监听 127.0.0.1:3000(外部只能经隧道进)、只放行学生接口、CORS 允许你的域名。**窗口保持开着**,关掉 = 后端停。本机你自己复核走 `http://localhost:3000/?mode=strings`(本机访问不受公网限制)。

### A2. 装并接好 Cloudflare 隧道

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login                 # 浏览器里选 stringinstrumentdiagnosis.icu 授权
cloudflared tunnel create string-diag-api
cloudflared tunnel route dns string-diag-api api.stringinstrumentdiagnosis.icu
```

`create` 会打印一个 **Tunnel ID** 和一个凭据 json 路径。把 [config/cloudflared-config.example.yml](../config/cloudflared-config.example.yml) 复制到 `C:\Users\Administrator\.cloudflared\config.yml`,把里面两个 `REPLACE_WITH_TUNNEL_ID` 换成你的 Tunnel ID。然后:

```powershell
cloudflared tunnel run string-diag-api
```

这个窗口也保持开着。验证:浏览器打开 `https://api.stringinstrumentdiagnosis.icu/api/health`,看到 `{"ok":true}` 就通了。

> 想让后端和隧道开机自启、不用一直开着窗口,做完能跑通后告诉我,我给你配成 Windows 服务。

---

## B. 前端上线(Vercel)

1. 登录 [Vercel](https://vercel.com),`Add New → Project`,导入这个仓库(`owo1009-lll/xiaozhi2`)。
2. Framework 会自动识别为 Vite,构建配置用仓库里的 `vercel.json`,不用改。**部署分支**要选包含上线代码的分支(当前是 `feature/model-bakeoff-omr-align`,或先合并到 `main` 再部署——见文末)。
3. `Deploy`。首次部署完会给一个 `xxx.vercel.app` 地址,先用它测界面能不能打开。
4. `Settings → Domains` 添加 `stringinstrumentdiagnosis.icu`。Vercel 会给出要加的 DNS 记录(通常是 apex 的 A 记录或 CNAME)。

---

## C. DNS 收尾(都在 Cloudflare 面板)

在 Cloudflare 的 DNS 页面确认两条:

| 记录 | 名称 | 值 | 代理状态 |
| --- | --- | --- | --- |
| 主域名 → Vercel | `@`(即 apex) | 按 Vercel 给的 A/CNAME 值 | **DNS only(灰云)** |
| api 子域 → 隧道 | `api` | 由 `route dns` 自动创建(隧道 CNAME) | 代理(橙云),不用改 |

主域名那条一定要设成**灰云(DNS only)**,否则会和 Vercel 的证书打架。

---

## D. 验证上线

1. 浏览器打开 `https://stringinstrumentdiagnosis.icu` —— 应看到**学生上传页**(填曲名、传录音)。
2. 传一条测试录音,提示"提交成功,老师复核后反馈"。
3. 在这台机器打开 `http://localhost:3000/?mode=strings` —— 你的**复核台**,能看到刚才那条提交以及机器生成的两层复核辅助：`机器确诊候选` 和 `自查提示`。两层都只供教师判断，不会自动发给学生；确认后仍由你写反馈、点 Release 放行。
4. 回到学生页刷新"我的练习记录",看到放行的反馈。

跑通这一圈,试点就上线了。

---

## 安全与运维要点

- **后台数据不出本机**:学生录音/照片存在这台机器的 `data/private`,Vercel 只放静态界面,不碰数据。公网守卫挡住了 `/data`、复核、研究、教师所有后台接口——外面的人打这些接口只会拿到 403。
- **这台机器要保持开机联网**,它就是后端服务器,关机=学生页能开但传不了(api 子域连不上)。
- **自动判分仍是关的**(试点形态)。当前严格确诊召回仍为 `2/12`；当前只补 Round 6 Stage A 的 6 条 calibration，安全闸通过才补 6 条 fresh。随后还须通过一次性 fresh 真闸、ordinary/M3+ 学生闸并取得显式发布授权，不能用本次 review-only 试点或 Stage A calibration 代签。
- 更新上线内容:前端改动 push 后 Vercel 自动重部署;后端改动在这台机器 `git pull` 后重跑 `npm run go-live:backend`。

## 关于上线分支

上线代码目前在 `feature/model-bakeoff-omr-align` 分支。你可以让 Vercel 直接部署这个分支,或先把它合并到 `main` 再让 Vercel 部署 `main`(更规范)。合并要不要现在做、由你定——说一声我来发 PR。
