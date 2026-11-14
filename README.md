# TuKuai-EXE

面向 **TuKuai Studio** 的纯免费、零存储留存 Windows x64 安装包云端封装工具。

用户在浏览器端拖入**已构建好的应用程序目录**（如 PyInstaller / Nuitka / jpackage 输出目录，含主 `.exe`）与 `license.txt`：
1. 浏览器内通过 `fflate` 零压缩（STORE）快速归档；
2. 经 Cloudflare Turnstile 与 Worker **4 GB 容量硬熔断保护**校验后直传 Cloudflare R2；
3. GitHub Actions（Public 仓库 Windows Server 2022 虚拟机）通过安全密钥领包后**立即通知 Worker 删除 R2 临时文件**；
4. 自动清洗并转码 `license.txt`（UTF-16 LE BOM 防中文乱码）、生成防注入 `.iss` 脚本，调用 `ISCC.exe` 编译 `x64compatible` 安装包；
5. 编译成品上传为 1 天过期 Actions Artifact，前端通过 Worker `302` 跳转到微软 Azure 官方临时直链高速下载。

---

## 目录结构

```text
TuKuai-EXE/
├── .github/workflows/build-installer.yml   # GitHub Actions 云端封装流水线
├── scripts/build-installer.ps1             # 安全解压、转码、.iss 生成与 ISCC 编译脚本
├── worker/                                 # Cloudflare Worker 调度与 4 GB 熔断保护后端
│   ├── src/
│   │   ├── index.ts
│   │   ├── sigv4.ts                        # 零依赖 WebCrypto R2 SigV4 预签名器
│   │   ├── validation.ts
│   │   └── types.ts
│   ├── test/core.test.mjs
│   ├── wrangler.toml
│   └── package.json
└── web/
    ├── TuKuaiEXE.html                      # 可独立运行也可直接嵌入 TuKuai-Studio 的前端页
    └── index.html
```

---

## 部署步骤

### 1. 确保 GitHub 仓库配置完整
1. 在 GitHub 上将 `TuKuai-EXE` 仓库设为 **Public**（享受无限免费 Windows Actions 时长及 Artifact 存储）。
2. 在仓库 `Settings -> Secrets and variables -> Actions` 添加 2 个 Repository Secrets：
   * `RUNNER_AUTH_SECRET`：自己随机生成的长密钥（例如 32 位以上随机字符串），与 Worker 侧一致。
   * `WORKER_BASE_URL`：你部署后的 Cloudflare Worker 域名，例如 `https://tukuai-exe-worker.xxx.workers.dev`（末尾不要斜杠）。

### 2. 部署 Cloudflare Worker
进入 `worker/` 目录安装依赖并创建 KV Namespace：

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create JOBS_KV
```

把命令输出的 KV `id` 填入 `worker/wrangler.toml` 的 `[[kv_namespaces]]` 中，然后部署：

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
1. 将 `web/TuKuaiEXE.html` 复制到 `TuKuai-Studio/TuKuaiEXE/TuKuaiEXE.html`，并把顶部 `TUKUAI_EXE_CONFIG.apiBase` 改为你部署成功的 Worker URL。
2. 如果你的站点绑定了除 `https://xn--2esp7m.xn--udsye.art` 以外的域名，同步更新 `worker/wrangler.toml` 的 `ALLOWED_ORIGINS`（重新 `npm run deploy`）以及 R2 Bucket CORS 与 Turnstile 白名单。
3. 在 `TuKuai-Studio/sections.json` 的 `Sys`（`id: "red"`）板块中挂载 `TuKuaiEXE/TuKuaiEXE.html` 即可。

---

## 本地测试

```bash
cd worker
npm test
```

本地启动 Worker + 静态前端测试页：

```bash
cd worker
npx wrangler dev
```
