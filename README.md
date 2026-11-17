# pdf-parse-x

Node.js PDF → Markdown 转换器。基于 **pdf-parse 2.x + PDF.js + Sharp**，提取正文、章节、内嵌图片和表格，生成：

```text
pdfs/                   # 待转换的 PDF
output/<document>/
├── main.md           # 完整 Markdown 正文（唯一正文产物）
├── metadata.json     # PDF 元数据
├── report.json       # 页数、图表数量、文本覆盖率、警告
├── formulas.json     # 本次解析出的公式 LaTeX（含 sources 来源标记，可直接当作 sidecar 复用）
├── formulas.llm.json # 可选：模型结果缓存（仅启用公式模型时生成）
├── preview.html      # 可选：--preview / PERSIST_PREVIEW=true 时才生成
├── figs/
│   ├── figure-01.png
│   ├── ...
│   ├── equations/    # 未识别为 LaTeX 的公式原图回退
│   └── parts/        # 多图块图（如 2×2 图）的原始分块
└── tables/
    ├── table-01.md   # 表格 Markdown
    ├── table-01.csv  # 表格 CSV
    ├── table-01.json
    ├── table-01.png  # 表格高清截图（核对用）
    └── ...
```

> 默认**不生成 `preview.html`**：网页预览由服务端在请求时从 `main.md` 实时渲染（见下文），
> 输出目录只保留正文和资源，避免同一内容保存两份。需要可双击打开的静态预览时用 `--preview`。

## 快速开始

```bash
npm install

# 可选：配置公式 LaTeX 重建模型（不配置也能正常转换）
copy .env.example .env

# 转换 pdfs/ 目录中的示例 PDF
npm run convert:sample

# 启动 Web 上传 + 实时 Markdown 预览
npm start
```

打开 <http://localhost:3000>，预览地址为 <http://localhost:3000/preview/software-05-00038>。

也可以直接使用 CLI：

```bash
npm run convert -- "pdfs/paper.pdf" "output/paper"
# 需要可双击打开的静态预览时：
npm run convert -- "pdfs/paper.pdf" "output/paper" --preview
```

命令行把整个流程压缩成 4 个阶段，运行时始终只有一行日志在刷新（终端里被原地覆盖，不会刷屏）：

```text
[1/4] 解析 PDF · 36 页 · 2 图 · 12 表 · 17 公式 · 101,306 字符 · 1.4s
```

结束后保留汇总行（含总耗时）与输出位置：

```text
✔ 转换完成 · 36 页 · 2 图 · 12 表 · 17 公式 · 覆盖 94.16% · 总耗时 2m28s
  标题: ...
  Markdown: output/paper/main.md
  预览:   npm start 后访问 /preview/<文档 ID>（按需从 main.md 渲染）
  资源:   output/paper/figs · output/paper/tables
```

> 输出被重定向到文件或管道时（如 `> log.txt`、`| tee`），每个阶段各占一行，便于事后排查。

输出目录可以省略，默认使用 `output/<pdf 文件名>`。`src/cli.js` 与 `src/server.js` 会通过 `dotenv` 自动读取项目根目录的 `.env`。

## 功能

- **正文完整提取**：按 PDF 文本坐标重建段落，处理首行缩进、跨页段落、断词连字符，并自动清理期刊页眉、页码和 DOI 页脚。
- **双栏排版**：自动检测页面装订线，先读完左栏再读右栏，跨栏标题、图注和表格按视觉位置插入，避免左右栏文字交错。
- **首页结构识别**：区分期刊页眉、`RESEARCH` 标签、标题、作者、收稿/出版信息、摘要、关键词和正文起始位置；支持 `Abstract—`、`Index Terms—` 这类行内标签。
- **章节结构**：识别 `1 Introduction`、`2.1 ...`、`References`，以及 IEEE 模板的 `II. OVERVIEW OF RAG` 罗马数字章节和 `A. Retrieval Source` 字母子章节，生成 Markdown 标题层级。
- **图片提取**：支持 `Figure 1.` 与 `Fig. 1` 图注，读取 PDF 内嵌位图并按图注写入 `figs/figure-XX.png`。
- **表格提取**：利用 PDF 矢量横线定位表格边界，结合表头分隔线、列中心聚类和行标签重建表格；同时支持 Springer 等期刊的侧边表格标题、无框线表格和跨页旋转表格。
- **参考文献**：识别 `1. Author...`（MDPI 等）、`[1] Author...`（IEEE/ACM）和作者-年份三种格式，每条文献独立成段/独立列表项，跨页续行自动并回同一条目，跨页时编号不重排；期刊页眉页脚（刊名 + 页码、作者名 + 页码）按“多页重复文本”识别并从正文剔除。
- **表格资源双保险**：每张表同时输出 Markdown、CSV、JSON 和表格区域高清截图，避免复杂合并单元格造成的信息损失。
- **公式 LaTeX 输出**：代码不内置任何论文特定的公式规则。LaTeX 可来自通用 sidecar JSON、调用方传入的映射，或可选的 OpenAI 兼容视觉模型；通过校验后以标准 `$$ ... $$` 写入 Markdown，并用 `\tag{N}` 生成右对齐编号。无法可靠重建的公式回退到 `figs/equations/` 原图。
- **行内公式**：PDF 文本层里小于正文号的数学片段（如 `p` + 下标 `ij`）会按字号与基线偏移重建为行内 `$p_{ij}$`；纯脚注数字不会被误判。
- **全文预览**：`/preview/<id>` 在请求时把 `main.md` 渲染成 HTML（目录、图片/表格画廊、图片灯箱、打印/PDF 按钮），改完 md 刷新即生效，不再落盘重复的 HTML 文件。
- **完整性报告**：`report.json` 记录文本 token 覆盖率、公式/表格数量和重建置信度。
- **进度日志**：整个流程只分 4 个阶段（解析 PDF → 提取资源 → 公式 LaTeX → 生成 Markdown），命令行与网页都只显示最新的一条日志，字段为 `[阶段/总数] 名称 · 结果摘要 · 耗时`；公式模型阶段会显示“已处理/总数”。结束后保留最后一行与汇总（含总耗时）。

## 示例结果

- `software-05-00038.pdf` 已生成示例输出：

- 22 页
- 6 张图片
- 8 张表格
- 9 个独立公式（通过 `software-05-00038.formulas.json` sidecar 提供 `$$ ... $$` LaTeX，编号右对齐）
- 文本覆盖率 **99.89%**
- 表格重建置信度全部为 **1.0**

查看：

```text
output/software-05-00038/main.md
```

启动 `npm start` 后访问 <http://localhost:3000/preview/software-05-00038>。

另一个期刊示例 `s10844-026-01076-1.pdf` 的转换结果：

- 36 页
- 2 张图片（`Fig. 1` / `Fig. 2`）
- Table 1–11（Table 5 为跨页旋转表格，保存为两个部分）
- 17 个独立编号公式（由 Mimo 视觉模型重建为 `$$ ... $$` LaTeX）
- 作者-年份参考文献按独立条目输出

```text
output/s10844-026-01076-1/main.md
```

启动 `npm start` 后访问 <http://localhost:3000/preview/s10844-026-01076-1>。

四份 PDF 的实测对比：

| PDF | 页数 | 图片 | 表格 | 公式 (LaTeX/总数) | 文本覆盖 |
| --- | --- | --- | --- | --- | --- |
| `software-05-00038.pdf` | 22 | 6 | 8 | 9/9（sidecar） | 99.89% |
| `s10844-026-01076-1.pdf` | 36 | 2 | 12 | 17/17（模型） | 94.89% |
| `2102.08942v1.pdf` | 23 | 0 | 0 | 0/0 | 100% |
| `2312.10997v5.pdf` | 21 | 6 | 4 | 0/0 | 99.79% |

- `2102.08942v1.pdf` 是单栏纯文字综述，图表与编号公式均为 0，字符按页统计也确认没有整页图形区域。
- `2312.10997v5.pdf` 是 IEEE 双栏模板：`II. OVERVIEW OF RAG` 这类罗马数字章节、`A. Retrieval Source` 这类字母子章节、`TABLE III` 表格标题和 `Fig. 1.` 图注都会被识别；6 张图按图注裁切，4 张表以截图 + 标题保留。
- 覆盖率缺口主要来自图注排版差异（例如 `Fig. 1.` 在 Markdown 中规范为 `Figure 1.`）以及插图内部的文字（图形内的模型名称无法作为正文提取）。

## Web API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/documents` | 已转换文档列表 |
| `POST` | `/api/convert` | `multipart/form-data`，字段名 `pdf` |
| `POST` | `/api/convert-sample` | 转换工作区示例 PDF |
| `GET` | `/api/documents/:id` | 元数据与完整性报告 |
| `DELETE` | `/api/documents/:id` | 删除文档及其图表资源 |
| `GET` | `/preview/:id` | 从 `main.md` 实时渲染预览页（`Cache-Control: no-store`） |
| `GET` | `/api/progress/:id` | SSE 转换进度流（事件 `progress` / `done`），前端用 `progressId` 订阅 |

## 实现要点

### 1. 文本与版式

- `pdf-parse` 负责元数据、完整文本、内嵌图片和页面截图。
- `pdfjs-dist` 负责逐项文本坐标、字号、字体和矢量线条。
- 文本项按基线聚合成视觉行，再依据首行缩进、行距、标题正则重建段落。
- 双栏页面先用“窄文本项的 x 区间”寻找装订线：整页通栏行（标题、摘要、跨栏图）会跨过中线，因此不参与判定；同一基线上出现跨装订线的明显空白时，该行被拆成左右两段。分栏结果会传给 Markdown 构建阶段，标题、图注和表格按左栏 → 右栏的阅读顺序插入。
- 单栏页面要求“跨栏窄项比例”足够低才会启用分栏，避免把居中的短行误判成两栏。

### 2. 表格

表格识别不是只依赖 `pdf-parse.getTable()`（对带框线的学术 PDF 常常返回空表），而是使用：

1. 从 PDF 绘图操作中提取横向/纵向线条；
2. 找到表格上方最近的 `Table N.` 图注；
3. 用表格顶线、表头分隔线和底线确定区域；
4. 合并表头碎片（例如 `T` + `p` + `(s)` → `Tp (s)`）；
5. 以表头列中心为锚点分配数据单元格；
6. 用第一列行标签的纵坐标把多行单元格归入正确行；
7. 同时生成 Markdown、CSV、JSON 和截图。

没有框线的表格会使用文本布局回退，并在 `report.json` 中标记 `fallback: true`。

### 3. 图片

- 单张内嵌图直接转 PNG。
- 同一图注下的多个图块按尺寸自动纵向/横向拼接；无法判断时按 2 列网格拼接。
- 没有检测到内嵌位图时（例如矢量绘制的插图），按图注与上下正文的空白间隔估算图片区域并裁剪，不写入整页截图。
- 实在无法定位时会跳过该图并在 `report.json` 中说明，而不是把整页图片塞进 Markdown。
- 表格同样不会回退到整页截图：无框线/旋转表格会按标题位置与内容边界裁剪（旋转表还会自动旋转并裁掉白边）。
- 所有图片与表格块都插入到对应正文位置：双栏页面按左栏→右栏的行序插入，单栏页面按纵坐标插入，不会堆到页面开头或文末。

### 4. 通用公式 LaTeX 与可选大模型

代码中没有“某篇论文第 N 个公式对应某段 LaTeX”的硬编码。可选机制：

1. **Sidecar JSON**（推荐，离线、可复现）：

   ```text
   paper.formulas.json
   paper.pdf.formulas.json
   formulas/paper.json
   ```

   ```json
   {
     "1": "E = mc^2",
     "3": "\\sum_{i=1}^{n} x_i"
   }
   ```

   也可以调用 API 时传入 `options.formulaLatex`。

   **输出目录也会带一份 sidecar**：每次转换结束会把最终 LaTeX 写入
   `output/<文档>/formulas.json`，除公式映射外还记录 `sources`（`sidecar` / `llm` / `llm-cache`）
   与生成时间，因此单个输出目录即可自包含、可离线复现：

   ```json
   {
     "version": 1,
     "source": "paper.pdf",
     "generatedAt": "2026-11-17T...",
     "sources": { "1": "llm" },
     "formulas": { "1": "E = mc^2 \\tag{1}" }
   }
   ```

   读取优先级：调用方 `options.formulaLatex` → PDF 同目录的 sidecar → `formulas/<stem>.json`
   → **输出目录里的 `formulas.json`**。传 `refresh: true` 时会忽略输出目录的副本，强制重新求解。

2. **OpenAI 兼容公式模型**（例如 Mimo Flash）：

   ```bash
   LLM_BASE_URL=https://api.xiaomimimo.com/v1
   LLM_API_KEY=sk-...
   LLM_MODEL=mimo-v2.6-flash
   LLM_VISION=true
   LLM_TIMEOUT_MS=120000
   LLM_CONCURRENCY=3
   LLM_MAX_IMAGES=0
   ```

   服务需兼容 `POST /chat/completions`（Mimo 官方接口为 `https://api.xiaomimimo.com/v1`）。模型会收到公式区域截图（可选）和 PDF 文本层上下文，返回 LaTeX；结果必须通过 KaTeX 校验，失败则自动回退到原图。多行公式会被自动包裹为 `gathered` 环境，模型直接返回 `aligned` 时保持原样。

   - `LLM_VISION=false` 时只发送文本层内容，适用于纯文本模型。
   - `LLM_CONCURRENCY` 控制并发请求数；`LLM_MAX_IMAGES` 限制单次转换最多调用多少个公式（`0` 表示不限）。
   - 本地无鉴权服务可设置 `LLM_ALLOW_NO_KEY=true`。
   - 该能力默认关闭，不会自动上传 PDF 内容。
   - 可选设置 `FIGURE_LLM_ENABLED=true`，在坐标规则无法关联图片时，将图注所在页面截图发送给同一视觉模型定位并裁剪。结果会在报告中提示人工核对；模型返回的矩形未通过范围/置信度/面积校验时不会采用，改由图注附近空白间隔估算区域。此设置需要配置上面的模型地址、密钥和视觉模式。
   - 视觉模式需要公式截图；截图不可用时直接保留原图，不会悄悄改用可能不完整的文本层。请求失败、超时、服务状态码及 LaTeX 校验失败会在报告中分别提示。调用上限之外的公式也会单独提示。
   - `formulas.llm.json` 缓存与 PDF 内容、模型、服务地址和视觉模式绑定；旧版无身份信息的缓存不会自动复用。KaTeX 校验只检查语法，不能保证模型转写与原文一致。

### 5. 预览

预览页不落盘，由服务端在请求时生成：

- **直接渲染 `main.md`**：`marked` 解析 Markdown，`sanitize-html` 清洗，公式交由 KaTeX 转成 MathML（无需外部字体或 CDN）；
- 块级 `$$ ... $$`渲染为居中公式 + 右对齐编号，行内 `$ ... $` 渲染为行内 MathML，`$` 不会出现在页面上；
- 响应头 `Cache-Control: no-store`，修改 `main.md` 后刷新即可看到最新内容；
- 通过 `<base href="/output/<id>/">` 复用 `figs/...`、`tables/...` 相对路径，图片与表格链接无需重写；
- 侧边栏的目录、图片画廊和表格画廊都从 Markdown 现场提取（`collectResources`），不依赖额外索引文件；
- 需要分享单个 HTML 时，用 `--preview`（或 `PERSIST_PREVIEW=true`）额外生成自包含的 `preview.html`。

## 项目结构

```text
src/
├── cli.js                  # 命令行入口
├── server.js               # Express 上传/预览服务
├── lib/
│   ├── pdf-parser.js       # 转换流水线：图片、表格、Markdown、报告
│   ├── pdf-layout.js       # PDF.js 文本坐标、矢量线条、表格/图注检测
│   ├── markdown-builder.js # 段落/标题/图表块 → Markdown
│   ├── formula-latex.js    # 通用 sidecar/映射加载与 KaTeX 校验
│   ├── formula-llm.js      # 可选 OpenAI 兼容公式模型（含 Mimo Flash）
│   ├── figure-llm.js       # 可选：图片定位（FIGURE_LLM_ENABLED）
│   ├── preview.js          # Markdown → HTML 渲染（服务端按需调用）
│   ├── progress.js         # 单行进度日志格式化（CLI 原地刷新，SSE 共用）
│   ├── report.js           # 文本覆盖率与完整性报告
│   └── text-utils.js       # 文本拼接、断词、行内公式、表格工具
└── web/
    ├── index.html          # 上传界面
    ├── app.js
    ├── styles.css
    └── preview.css         # 预览页样式
```

> 样例 PDF 放在 `pdfs/`；测试会在 `pdfs/` 与项目根目录两处查找样例（见 `test/fixtures.js`）。

## 限制

- 当前版本针对**带文本层的 PDF**。扫描件需要先做 OCR（例如 Tesseract）再转换。
- 旋转页面、跨页表格、复杂合并单元格、公式排版可能需要人工核对；表格原图会一并保留。
- 公式 LaTeX 需要通过 sidecar、调用方映射或可选视觉模型提供；未配置时默认使用 PDF 原版裁剪图片，避免乱码。行内公式由字号/基线几何重建为 `$...$`，不依赖模型。
- 大模型输出存在幻觉风险，因此只接受通过 KaTeX 校验的结果；仍建议人工抽查关键公式。
- 单文件上传上限 100 MB。

## 技术栈

- Node.js 20+
- `pdf-parse` 2.x
- `pdfjs-dist`
- `sharp`
- `express` + `multer`
- `marked` + `sanitize-html`
- `katex`（服务端渲染为 MathML，无需外部字体）
