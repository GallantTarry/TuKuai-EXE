# TuKuai-EXE

面向 **TuKuai Studio** 的纯免费、零存储留存 Windows x64 安装包云端封装工具。

用户在浏览器端拖入**已构建好的应用程序目录**（如 PyInstaller / Nuitka / jpackage 输出目录，含主 `.exe`）与可选 `license.txt`：
1. **本地打包**：浏览器通过本地内置的 `fflate.browser.js`（零海外 CDN 依赖）做选择性轻量归档（已压缩后缀直存 PassThrough，其余 Deflate level 1）；
2. **分片并发上传（国内直连）**：经 Cloudflare Turnstile 与 Worker **4 GB 容量硬熔断保护**校验后，前端通过 Worker 自定义域名按 `8 MiB × 3 并发`（`<= 8 MiB` 单片直传）流式写入 Cloudflare R2；
3. **云端领包与秒删源码**：GitHub Actions（Public 仓库 Windows Server 2022 虚拟机）通过安全密钥 `/claim` 领包并获取成品回传签名链接，下载输入包后**立即通知 Worker 秒删 R2 源码包**；
4. **云端安全编译**：自动识别并转码 `license.txt` 为 UTF-16 LE BOM（防中文乱码）、防 INI 注入校验后生成 `.iss` 脚本，调用 `ISCC.exe` 编译 `x64compatible` 安装包；
5. **成品双通道回传与分片极速下载**：Runner 将 `.exe` 以零重压 Store 模式打成 `.zip` 直接传回 R2 缓存 **1 小时**（Cron 自动清理），同时保留 1 天过期 Actions Artifact 作为冷备；前端按 **`4 MiB × 3 并发 + 自动重试`** 从 Worker 拉取合并保存（超 1 小时自动无缝切回 GitHub Artifact 通道）。

---

## 目录结构

```text
TuKuai-EXE/
├── .github/workflows/build-installer.yml   # GitHub Actions 云端封装、R2 成品回存与冷备流水线
├── scripts/build-installer.ps1             # 安全解压、UTF-16 BOM 转码、.iss 生成与 ISCC 编译脚本
├── worker/                                 # Cloudflare Worker 调度、分片代理、4 GB 熔断与定时清理后端
│   ├── src/
│   │   ├── index.ts
│   │   ├── sigv4.ts                        # 零依赖 WebCrypto R2 SigV4 预签名器
│   │   ├── validation.ts
│   │   └── types.ts
│   ├── test/core.test.mjs
│   ├── wrangler.toml
│   └── package.json
└── web/
    ├── TuKuaiEXE.html                      # 分片并发上传/下载前端（可独立运行或嵌入 TuKuai-Studio）
    ├── fflate.browser.js                   # 本地托管的 fflate@0.8.2 ESM 模块
    └── index.html
```

---

## 部署步骤

### 1. 确保 GitHub 仓库配置完整
1. 在 GitHub 上将 `TuKuai-EXE` 仓库设为 **Public**（享受无限免费 Windows Actions 时长及 Artifact 存储）。
2. 在仓库 `Settings -> Secrets and variables -> Actions` 添加 2 个 Repository Secrets：
   * `RUNNER_AUTH_SECRET`：自己随机生成的长密钥（例如 32 位以上随机字符串），与 Worker 侧一致。
   * `WORKER_BASE_URL`：你部署后的 Cloudflare Worker 域名（建议绑定自定义域名以优化国内直连，例如 `https://exe.example.com`，末尾不要斜杠）。

### 2. 部署 Cloudflare Worker
进入 `worker/` 目录安装依赖并创建 KV Namespace：

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create JOBS_KV
```

把命令输出的 KV `id` 填入 `worker/wrangler.toml` 的 `[[kv_namespaces]]` 中，然后部署（推荐在 Cloudflare Dashboard 的 Worker → `Domains` 绑定自己的自定义域名）：

```bash
npm run deploy
```

接着依次写入 5 个机密变量（在终端按提示粘贴即可，**切勿写入源码**）：

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put GITHUB_PAT
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put RUNNER_AUTH_SECRET
```

### 3. 嵌入到 TuKuai-Studio
1. 将 `web/TuKuaiEXE.html` 与 `web/fflate.browser.js` 一并复制到 `TuKuai-Studio/TuKuaiEXE/`，并把 HTML 顶部 `TUKUAI_EXE_CONFIG.apiBase` 改为你的 Worker 域名。
2. 若绑定了额外访问域名，同步更新 `worker/wrangler.toml` 的 `ALLOWED_ORIGINS`（改完需重新执行 `npm run deploy`）以及 Turnstile 站点 Hostnames 白名单。
3. 在 `TuKuai-Studio/sections.json` 的 `Sys`（`id: "red"`）板块中挂载 `TuKuaiEXE/TuKuaiEXE.html` 即可。

---

## 本地测试

```bash
cd worker
npm run typecheck
npm test
```

本地启动 Worker + 静态前端测试页：

```bash
cd worker
npx wrangler dev
```
