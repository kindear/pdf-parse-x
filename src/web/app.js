const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('pdfInput');
const sampleButton = document.getElementById('sampleButton');
const refreshButton = document.getElementById('refreshButton');
const documentGrid = document.getElementById('documentGrid');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressLabel = document.getElementById('progressLabel');
const progressSteps = document.getElementById('progressSteps');
const statusBox = document.getElementById('statusBox');

let busy = false;
let progressStream = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function showStatus(type, message) {
  statusBox.hidden = false;
  statusBox.className = `status-box ${type}`;
  statusBox.innerHTML = message;
}

function clearStatus() {
  statusBox.hidden = true;
  statusBox.className = 'status-box';
  statusBox.innerHTML = '';
}

function setBusy(value, label = '正在处理…') {
  busy = value;
  fileInput.disabled = value;
  sampleButton.disabled = value;
  refreshButton.disabled = value;
  if (value) {
    progressWrap.hidden = false;
    progressLabel.textContent = label;
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
  } else {
    setTimeout(() => {
      progressWrap.hidden = true;
    }, 500);
  }
}

function setProgress(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.style.width = `${value}%`;
  progressPercent.textContent = `${value}%`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function resetProgressSteps() {
  progressSteps.innerHTML = '';
  progressSteps.hidden = true;
}

function renderProgressStep(event) {
  progressSteps.hidden = false;
  let item = progressSteps.querySelector(`li[data-step="${event.index}"]`);
  if (!item) {
    item = document.createElement('li');
    item.dataset.step = String(event.index);
    item.innerHTML =
      '<span class="progress-step-label"></span><span class="progress-step-meta"></span>';
    progressSteps.appendChild(item);
  }

  item.querySelector('.progress-step-label').textContent =
    `${event.index}/${event.total} ${event.label}`;
  const meta = item.querySelector('.progress-step-meta');

  if (event.status === 'start') {
    item.className = 'is-running';
    meta.textContent = '进行中…';
  } else if (event.status === 'progress') {
    item.className = 'is-running';
    meta.textContent = `${event.progress?.done ?? 0}/${event.progress?.total ?? 0}`;
  } else {
    item.className = event.status === 'error' ? 'is-error' : 'is-done';
    meta.textContent = [event.detail, formatDuration(event.durationMs)]
      .filter(Boolean)
      .join(' · ');
    setProgress((event.index / (event.total || 1)) * 100);
  }

  progressSteps.scrollTop = progressSteps.scrollHeight;
}

function beginProgressStream(label) {
  resetProgressSteps();
  progressLabel.textContent = label;
  endProgressStream();

  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (typeof EventSource !== 'function') return id;

  const stream = new EventSource(`/api/progress/${id}`);
  stream.addEventListener('progress', (event) => {
    try {
      renderProgressStep(JSON.parse(event.data));
    } catch {
      // Malformed frame: ignore and keep the previous state.
    }
  });
  stream.addEventListener('done', () => {
    stream.close();
    if (progressStream === stream) progressStream = null;
  });
  progressStream = stream;
  return id;
}

function endProgressStream() {
  if (!progressStream) return;
  progressStream.close();
  progressStream = null;
}

function documentCard(document) {
  const coverage = document.coverage == null ? '--' : `${document.coverage}%`;
  return `
    <article class="document-card" data-id="${escapeHtml(document.id)}">
      <div class="card-top">
        <span class="file-chip" title="${escapeHtml(document.sourceFile)}">${escapeHtml(document.sourceFile)}</span>
        <span class="coverage-chip">覆盖 ${escapeHtml(coverage)}</span>
      </div>
      <h3>${escapeHtml(document.title || document.id)}</h3>
      <p>${escapeHtml(formatDate(document.generatedAt))} · ${escapeHtml(document.pages)} 页</p>
      <div class="card-stats">
        <div class="card-stat"><strong>${escapeHtml(document.figures)}</strong><span>图片</span></div>
        <div class="card-stat"><strong>${escapeHtml(document.tables)}</strong><span>表格</span></div>
        <div class="card-stat"><strong>${escapeHtml(document.equations)}</strong><span>公式</span></div>
        <div class="card-stat"><strong>${escapeHtml(document.pages)}</strong><span>页数</span></div>
      </div>
      <div class="card-actions">
        <a class="button primary" href="${escapeHtml(document.previewUrl)}">打开预览</a>
        <a class="button" href="${escapeHtml(document.markdownUrl)}" download>下载 MD</a>
        <button class="button danger" type="button" data-delete="${escapeHtml(document.id)}">删除</button>
      </div>
    </article>
  `;
}

function renderEmpty() {
  documentGrid.innerHTML = `
    <div class="empty-state">
      <div class="empty-orbit"></div>
      <h3>还没有转换记录</h3>
      <p>上传一个 PDF，生成第一份带图表资源的 Markdown 文档。</p>
    </div>
  `;
}

async function loadDocuments() {
  try {
    const response = await fetch('/api/documents');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '读取文档列表失败。');
    const documents = payload.documents ?? [];
    if (!documents.length) {
      renderEmpty();
      return;
    }
    documentGrid.innerHTML = documents.map(documentCard).join('');
  } catch (error) {
    documentGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-orbit"></div>
        <h3>无法读取文档列表</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
  }
}

function uploadFile(file) {
  if (busy) return;
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) {
    showStatus('error', '请选择 PDF 文件。');
    return;
  }

  clearStatus();
  setBusy(true, '正在解析 PDF…');
  const progressId = beginProgressStream('正在上传…');

  const formData = new FormData();
  formData.append('pdf', file);
  formData.append('progressId', progressId);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/convert');

  xhr.upload.addEventListener('progress', (event) => {
    if (event.lengthComputable) {
      setProgress((event.loaded / event.total) * 100);
      if (event.loaded >= event.total) {
        progressLabel.textContent = '正在解析 PDF…';
        setProgress(0);
      }
    }
  });

  xhr.addEventListener('load', async () => {
    let payload = {};
    try {
      payload = JSON.parse(xhr.responseText || '{}');
    } catch {
      payload = {};
    }

    if (xhr.status >= 200 && xhr.status < 300) {
      setProgress(100);
      showStatus(
        'success',
        `转换完成：<strong>${escapeHtml(payload.title || file.name)}</strong>。
         <a href="${escapeHtml(payload.previewUrl)}">打开 Markdown 预览 →</a>`
      );
      await loadDocuments();
    } else {
      showStatus('error', escapeHtml(payload.error || '转换失败，请检查 PDF 是否有效。'));
    }
    endProgressStream();
    setBusy(false);
  });

  xhr.addEventListener('error', () => {
    showStatus('error', '网络请求失败，请确认本地服务仍在运行。');
    endProgressStream();
    setBusy(false);
  });

  xhr.send(formData);
}

fileInput.addEventListener('change', () => {
  uploadFile(fileInput.files?.[0]);
  fileInput.value = '';
});

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
  });
}

dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  uploadFile(file);
});

sampleButton.addEventListener('click', async () => {
  if (busy) return;
  clearStatus();
  setBusy(true, '正在解析示例 PDF…');
  progressWrap.hidden = false;
  const progressId = beginProgressStream('正在解析示例 PDF…');

  try {
    const response = await fetch('/api/convert-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ progressId })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '示例解析失败。');
    setProgress(100);
    showStatus(
      'success',
      `示例转换完成：<strong>${escapeHtml(payload.title || '示例文档')}</strong>。
       <a href="${escapeHtml(payload.previewUrl)}">打开 Markdown 预览 →</a>`
    );
    await loadDocuments();
  } catch (error) {
    showStatus('error', escapeHtml(error.message));
  } finally {
    endProgressStream();
    setBusy(false);
  }
});

refreshButton.addEventListener('click', () => {
  loadDocuments();
});

documentGrid.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete]');
  if (!button) return;
  const id = button.getAttribute('data-delete');
  if (!id || busy) return;
  if (!window.confirm('删除这份转换结果及其图片/表格资源？')) return;

  button.disabled = true;
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '删除失败。');
    await loadDocuments();
    showStatus('success', '文档已删除。');
  } catch (error) {
    showStatus('error', escapeHtml(error.message));
    button.disabled = false;
  }
});

loadDocuments();
