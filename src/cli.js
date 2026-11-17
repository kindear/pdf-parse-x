import 'dotenv/config';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { convertPdfToMarkdown } from './lib/pdf-parser.js';
import { getFormulaLlmConfig } from './lib/formula-llm.js';
import { createConsoleProgress, formatDuration } from './lib/progress.js';
import { safeOutputName } from './lib/text-utils.js';

function usage() {
  console.log(`用法:
  npm run convert -- <input.pdf> [output-dir] [--preview]

示例:
  npm run convert -- paper.pdf output/paper
  npm run convert -- "C:\\docs\\paper.pdf"
  npm run convert -- paper.pdf output/paper --preview

说明:
  默认不生成 preview.html，网页预览由 npm start 启动的服务从 main.md 实时渲染。
  --preview（或 PERSIST_PREVIEW=true）会额外写出可双击打开的静态预览文件。

可选环境变量（写在 .env）:
  FORMULA_LLM_BASE_URL / FORMULA_LLM_API_KEY / FORMULA_LLM_MODEL
  未配置时公式回退为 PDF 原图。`);
}

async function main() {
  const args = process.argv.slice(2);
  const keepPreview = args.includes('--preview');
  const [inputArg, outputArg] = args.filter((arg) => arg !== '--preview');

  if (!inputArg || inputArg === '--help' || inputArg === '-h') {
    usage();
    process.exitCode = inputArg ? 0 : 1;
    return;
  }

  const inputPath = path.resolve(inputArg);
  try {
    await access(inputPath, constants.R_OK);
  } catch {
    console.error(`找不到或无法读取 PDF: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  const defaultOutput = path.join(
    process.cwd(),
    'output',
    safeOutputName(path.basename(inputPath, path.extname(inputPath)))
  );
  const outputDir = path.resolve(outputArg ?? defaultOutput);

  console.log(`输入: ${inputPath}`);
  console.log(`输出: ${outputDir}`);

  const llmConfig = getFormulaLlmConfig();
  console.log(
    `公式模型: ${
      llmConfig.enabled
        ? `${llmConfig.model} @ ${llmConfig.baseUrl}`
        : '未启用（公式回退为 PDF 原图）'
    }`
  );
  console.log('');

  const startedAt = performance.now();
  const result = await convertPdfToMarkdown(inputPath, {
    outputDir,
    previewFile: keepPreview,
    onProgress: createConsoleProgress()
  });
  const elapsed = performance.now() - startedAt;

  console.log('');
  console.log(`转换完成（总耗时 ${formatDuration(elapsed)}）`);
  console.log(`  标题: ${result.metadata.title}`);
  console.log(`  页数: ${result.report.pages}`);
  console.log(`  图片: ${result.report.figures}`);
  console.log(`  表格: ${result.report.tables}`);
  console.log(`  公式: ${result.report.equations}`);
  if (result.report.equations) {
    console.log(
      `  LaTeX: ${result.report.latexEquations}/${result.report.equations}（模型重建 ${result.report.llmEquations}）`
    );
  }
  console.log(`  文本覆盖: ${result.report.tokenCoverage}%`);
  console.log('');
  console.log(`  Markdown: ${path.join(outputDir, 'main.md')}`);
  console.log(
    keepPreview
      ? `  预览页:   ${path.join(outputDir, 'preview.html')}`
      : '  预览:     npm start 后访问 /preview/<文档 ID>（按需从 main.md 渲染）'
  );
  console.log(`  图片目录: ${path.join(outputDir, 'figs')}`);
  console.log(`  表格目录: ${path.join(outputDir, 'tables')}`);
  console.log(`  完整性:   ${path.join(outputDir, 'report.json')}`);

  if (result.report.warnings.length) {
    console.log('');
    console.log('警告:');
    for (const warning of result.report.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
