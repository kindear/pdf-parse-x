import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';
import katex from 'katex';
import sanitizeHtml from 'sanitize-html';
import { headingId, normalizeInline } from './text-utils.js';

const previewCss = readFileSync(
  new URL('../web/preview.css', import.meta.url),
  'utf8'
);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMathBlock(latex) {
  try {
    const tagMatch = latex.match(/\\tag\{([^{}]+)\}\s*$/);
    const tag = tagMatch?.[1] ?? '';
    const formula = tagMatch
      ? latex.replace(/\\tag\{[^{}]+\}\s*$/, '').trim()
      : latex;
    const mathml = katex.renderToString(formula, {
      displayMode: true,
      output: 'mathml',
      throwOnError: false,
      strict: 'ignore',
      trust: false
    });

    if (!tag) {
      return `<div class="math-display">${mathml}</div>`;
    }

    return [
      '<div class="math-row">',
      `  <span class="math-formula">${mathml}</span>`,
      `  <span class="math-number">(${escapeHtml(tag)})</span>`,
      '</div>'
    ].join('\n');
  } catch {
    return `<pre class="math-error">${escapeHtml(latex)}</pre>`;
  }
}

function renderMathInline(latex) {
  try {
    const mathml = katex.renderToString(latex, {
      displayMode: false,
      output: 'mathml',
      throwOnError: false,
      strict: 'ignore',
      trust: false
    });
    return `<span class="math-inline" title="${escapeHtml(latex)}">${mathml}</span>`;
  } catch {
    return `<code class="math-error">${escapeHtml(latex)}</code>`;
  }
}

function stripMarkdownInline(text) {
  return normalizeInline(
    String(text ?? '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/<[^>]+>/g, '')
  );
}

export function extractToc(markdown) {
  const toc = [];
  const used = new Map();
  let inFence = false;

  for (const rawLine of String(markdown ?? '').split(/\r?\n/)) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = rawLine.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;

    const level = match[1].length;
    const text = stripMarkdownInline(match[2]);
    if (!text) continue;

    let id = headingId(text);
    const count = used.get(id) ?? 0;
    used.set(id, count + 1);
    if (count) id = `${id}-${count + 1}`;

    toc.push({ level, text, id });
  }

  return toc;
}

function addHeadingIds(html, toc) {
  let index = 0;
  return html.replace(/<h([1-4])>(.*?)<\/h\1>/gs, (match, level, inner) => {
    const entry = toc[index];
    index += 1;
    const id = entry?.id ?? `section-${index}`;
    return `<h${level} id="${escapeHtml(id)}">${inner}</h${level}>`;
  });
}

function wrapTables(html) {
  return html
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

function addImageAttributes(html) {
  return html.replace(/<img\b([^>]*)>/g, (match, attributes) => {
    let output = attributes.replace(/\s*\/\s*$/, '');
    if (!/\bloading=/.test(output)) output += ' loading="lazy"';
    if (!/\bdecoding=/.test(output)) output += ' decoding="async"';
    return `<img${output}>`;
  });
}

export function renderMarkdown(markdown) {
  const mathBlocks = [];
  const inlineMath = [];

  // 1) Display math: `$$...$$` anywhere (single line, multi line, or inline).
  let prepared = String(markdown ?? '').replace(
    /\$\$([\s\S]*?)\$\$/g,
    (_match, latex) => {
      const index = mathBlocks.length;
      mathBlocks.push(latex.trim());
      return `\n\n@@PDF_MATH_BLOCK_${index}@@\n\n`;
    }
  );

  // 2) Inline math: `$...$`, skipping code fences and existing placeholders.
  let inFence = false;
  prepared = prepared
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || /@@PDF_MATH_BLOCK_\d+@@/.test(line)) return line;

      return line.replace(
        /(?<![\\$])\$(?![\s$])([^$\n]{1,300}?)(?<![\s\\])\$(?![\d$])/g,
        (_match, latex) => {
          const index = inlineMath.length;
          inlineMath.push(latex);
          return `@@PDF_MATH_INLINE_${index}@@`;
        }
      );
    })
    .join('\n');

  const markdownWithPlaceholders = prepared;

  const rawHtml = marked.parse(markdownWithPlaceholders, {
    gfm: true,
    breaks: false,
    async: false
  });

  const sanitized = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'figure',
      'figcaption',
      'details',
      'summary',
      'div',
      'span',
      'h1',
      'h2',
      'h3',
      'h4'
    ]),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
      '*': ['id', 'class']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ?? '';
        if (/^https?:\/\//i.test(href)) {
          return {
            tagName,
            attribs: {
              ...attribs,
              target: '_blank',
              rel: 'noopener noreferrer'
            }
          };
        }
        return { tagName, attribs };
      }
    }
  });

  const toc = extractToc(markdown);
  let html = addImageAttributes(wrapTables(addHeadingIds(sanitized, toc)));

  if (mathBlocks.length) {
    html = html
      .replace(/<p>\s*@@PDF_MATH_BLOCK_(\d+)@@\s*<\/p>/g, (_match, index) =>
        renderMathBlock(mathBlocks[Number(index)])
      )
      .replace(/@@PDF_MATH_BLOCK_(\d+)@@/g, (_match, index) =>
        renderMathBlock(mathBlocks[Number(index)])
      );
  }

  if (inlineMath.length) {
    html = html.replace(/@@PDF_MATH_INLINE_(\d+)@@/g, (_match, index) =>
      renderMathInline(inlineMath[Number(index)])
    );
  }

  return { html, toc };
}

function renderToc(toc) {
  const entries = toc.filter((entry) => entry.level >= 2 && entry.level <= 4);
  if (!entries.length) return '<p class="empty-note">文档没有可导航的章节。</p>';

  return entries
    .map(
      (entry) =>
        `<a class="toc-link toc-level-${entry.level}" href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a>`
    )
    .join('');
}

function renderGallery(items, type, resolveUrl = (value) => value) {
  if (!items.length) {
    return `<p class="empty-note">没有检测到${type === 'figure' ? '图片' : '表格'}资源。</p>`;
  }

  return items
    .map((item, index) => {
      const file = item.file ?? item.image;
      if (!file) return '';
      const href = resolveUrl(file);
      const label =
        type === 'figure'
          ? `Figure ${item.number ?? index + 1}`
          : `Table ${item.number ?? index + 1}`;
      const caption = normalizeInline(item.caption).slice(0, 100);
      return `
        <a class="gallery-item" href="${escapeHtml(href)}" data-lightbox="true" data-caption="${escapeHtml(caption)}">
          <span class="gallery-thumb"><img src="${escapeHtml(href)}" alt="${escapeHtml(label)}" loading="lazy"></span>
          <span class="gallery-label">${escapeHtml(label)}</span>
        </a>
      `;
    })
    .join('');
}

function renderStats(report) {
  const stats = [
    { label: '页数', value: report?.pages ?? 0 },
    { label: '图片', value: report?.figures ?? 0 },
    { label: '表格', value: report?.tables ?? 0 },
    { label: '公式', value: report?.equations ?? 0 },
    { label: '文本覆盖', value: `${report?.tokenCoverage ?? 100}%` }
  ];
  return stats
    .map(
      (stat) =>
        `<div class="stat"><strong>${escapeHtml(stat.value)}</strong><span>${escapeHtml(stat.label)}</span></div>`
    )
    .join('');
}

function renderMetaRows(metadata) {
  const date = String(metadata?.creationDate ?? '');
  const pdfDate = date.match(/^D:(\d{4})(\d{2})(\d{2})/);
  const rows = [
    ['作者', metadata?.author],
    ['来源', metadata?.sourceFile],
    ['页数', metadata?.pages],
    ['创建日期', pdfDate ? `${pdfDate[1]}-${pdfDate[2]}-${pdfDate[3]}` : metadata?.creationDate]
  ].filter(([, value]) => value);

  if (!rows.length) return '';
  return rows
    .map(
      ([label, value]) =>
        `<div class="meta-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
    )
    .join('');
}

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\?)/i;

// 预览页挂在 /preview/<id> 下，正文里的相对路径要换成 /output/<id>/… ；
// 这里不能靠 <base> 实现，否则 #章节锚点 会被解析成 /output/<id>/#节 而跳转失败。
function resolveAssetUrl(value, base) {
  const url = String(value ?? '').trim();
  if (!url || !base || ABSOLUTE_URL.test(url)) return value;
  return `${base}${url}`;
}

function absolutizeAssetUrls(html, base) {
  if (!base) return html;
  return html.replace(
    /(\ssrc="|\shref="|\sposter=")([^"]*)(")/g,
    (match, prefix, value, suffix) =>
      `${prefix}${resolveAssetUrl(value, base)}${suffix}`
  );
}

export function buildPreviewHtml({
  title,
  markdown,
  metadata = {},
  report = {},
  figures = [],
  tables = [],
  baseHref = '',
  backUrl = ''
}) {
  const rendered = renderMarkdown(markdown);
  const resolveUrl = (value) => resolveAssetUrl(value, baseHref);
  const bodyHtml = absolutizeAssetUrls(rendered.html, baseHref);
  const pageTitle = normalizeInline(title || metadata.title) || 'PDF 转 Markdown';
  const backLink = backUrl
    ? `<a class="topbar-link" href="${escapeHtml(backUrl)}">← 文档列表</a>`
    : '<span class="topbar-brand">pdf-parse-x</span>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)} · Markdown 预览</title>
  <style>${previewCss}</style>
</head>
<body>
  <div class="preview-shell">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-brand">
        <span class="brand-mark">P</span>
        <div>
          <strong>pdf-parse-x</strong>
          <small>PDF → Markdown</small>
        </div>
      </div>

      <div class="sidebar-document">
        <p class="eyebrow">当前文档</p>
        <h1>${escapeHtml(pageTitle)}</h1>
        ${renderMetaRows({ ...metadata, pages: report?.pages })}
      </div>

      <div class="stats-grid">${renderStats(report)}</div>

      <nav class="sidebar-section" aria-label="目录">
        <div class="section-title">目录</div>
        <div class="toc">${renderToc(rendered.toc)}</div>
      </nav>

      <section class="sidebar-section">
        <div class="section-title">图片资源 <span>${figures.length}</span></div>
        <div class="gallery">${renderGallery(figures, 'figure', resolveUrl)}</div>
      </section>

      <section class="sidebar-section">
        <div class="section-title">表格资源 <span>${tables.length}</span></div>
        <div class="gallery">${renderGallery(tables, 'table', resolveUrl)}</div>
      </section>

      <section class="sidebar-section sidebar-downloads">
        <div class="section-title">下载</div>
        <a href="${escapeHtml(resolveUrl('main.md'))}" download>Markdown 文件</a>
        <a href="${escapeHtml(resolveUrl('report.json'))}" download>完整性报告</a>
        <a href="${escapeHtml(resolveUrl('metadata.json'))}" download>元数据</a>
      </section>
    </aside>

    <main class="main-panel">
      <header class="topbar">
        ${backLink}
        <div class="topbar-actions">
          <button class="topbar-button" type="button" id="toggleSidebar" aria-label="切换侧边栏">目录</button>
          <a class="topbar-button primary" href="${escapeHtml(resolveUrl('main.md'))}" download>下载 Markdown</a>
          <button class="topbar-button" type="button" id="printButton">打印 / PDF</button>
        </div>
      </header>

      <article class="markdown-body" id="markdownBody">
        ${bodyHtml}
      </article>

      <footer class="preview-footer">
        <span>由 pdf-parse-x 自动生成</span>
        <span>${report?.pages ?? 0} 页 · ${figures.length} 张图 · ${tables.length} 张表</span>
      </footer>
    </main>
  </div>

  <div class="lightbox" id="lightbox" aria-hidden="true">
    <button type="button" class="lightbox-close" aria-label="关闭预览">×</button>
    <figure>
      <img id="lightboxImage" alt="">
      <figcaption id="lightboxCaption"></figcaption>
    </figure>
  </div>

  <script>
    (() => {
      const sidebar = document.getElementById('sidebar');
      const toggle = document.getElementById('toggleSidebar');
      const printButton = document.getElementById('printButton');
      const lightbox = document.getElementById('lightbox');
      const lightboxImage = document.getElementById('lightboxImage');
      const lightboxCaption = document.getElementById('lightboxCaption');

      toggle?.addEventListener('click', () => {
        sidebar?.classList.toggle('is-open');
      });

      printButton?.addEventListener('click', () => window.print());

      document.querySelectorAll('a.toc-link').forEach((link) => {
        link.addEventListener('click', (event) => {
          const id = decodeURIComponent((link.getAttribute('href') || '').replace(/^#/, ''));
          const target = id ? document.getElementById(id) : null;
          if (!target) return;
          event.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
          sidebar?.classList.remove('is-open');
        });
      });

      const openLightbox = (src, alt, caption) => {
        lightboxImage.src = src;
        lightboxImage.alt = alt || '';
        lightboxCaption.textContent = caption || '';
        lightbox.classList.add('is-open');
        lightbox.setAttribute('aria-hidden', 'false');
      };

      const closeLightbox = () => {
        lightbox.classList.remove('is-open');
        lightbox.setAttribute('aria-hidden', 'true');
        lightboxImage.removeAttribute('src');
      };

      document.addEventListener('click', (event) => {
        const link = event.target.closest('[data-lightbox="true"]');
        if (!link) return;
        event.preventDefault();
        openLightbox(
          link.getAttribute('href'),
          link.querySelector('img')?.alt,
          link.getAttribute('data-caption')
        );
      });

      document.querySelectorAll('.markdown-body img').forEach((image) => {
        image.addEventListener('click', () => {
          openLightbox(image.getAttribute('src'), image.getAttribute('alt'), image.getAttribute('alt'));
        });
      });

      lightbox?.addEventListener('click', (event) => {
        if (event.target === lightbox || event.target.closest('.lightbox-close')) {
          closeLightbox();
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && lightbox.classList.contains('is-open')) {
          closeLightbox();
        }
      });

      const tocLinks = [...document.querySelectorAll('a.toc-link')];
      const headings = tocLinks
        .map((link) => document.getElementById(link.getAttribute('href').slice(1)))
        .filter(Boolean);

      if ('IntersectionObserver' in window && headings.length) {
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const id = entry.target.id;
            tocLinks.forEach((link) => {
              link.classList.toggle('active', link.getAttribute('href') === '#' + id);
            });
          }
        }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
        headings.forEach((heading) => observer.observe(heading));
      }
    })();
  </script>
</body>
</html>`;
}

export async function writePreviewFile({
  outputDir,
  markdown,
  metadata,
  report,
  figures,
  tables,
  title
}) {
  const html = buildPreviewHtml({
    title: title || metadata?.title,
    markdown,
    metadata,
    report,
    figures,
    tables
  });
  await writeFile(path.join(outputDir, 'preview.html'), html, 'utf8');
}

/**
 * Rebuild the sidebar galleries from the Markdown itself. Live previews only
 * have `main.md` on disk, so the resource list is derived instead of stored.
 */
export function collectResources(markdown) {
  const figures = [];
  const tables = [];

  for (const match of String(markdown ?? '').matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const alt = match[1];
    const file = match[2];
    if (!/^(figs|tables)\//.test(file)) continue;

    const label = alt.match(/\b(Figure|Fig\.?|Table)\s*(\d+)?/i);
    const number = label?.[2] ? Number(label[2]) : null;
    const target = file.startsWith('tables/') ? tables : figures;
    target.push({
      number,
      caption: alt,
      file
    });
  }

  return { figures, tables };
}
