const title = document.getElementById('translateTitle');
const subtitle = document.getElementById('translateSubtitle');
const progressLabel = document.getElementById('progressLabel');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const statusBox = document.getElementById('statusBox');
const previewLink = document.getElementById('previewLink');
const retryButton = document.getElementById('retryButton');

const documentId = decodeURIComponent(
  window.location.pathname.split('/').filter(Boolean).pop() ?? ''
);

let progressStream = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function setProgress(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.style.width = `${value}%`;
  progressPercent.textContent = `${value}%`;
}

function showStatus(type, message) {
  statusBox.hidden = false;
  statusBox.className = `status-box ${type}`;
  statusBox.innerHTML = message;
}

function progressLine(event) {
  const tag = `[${event.index}/${event.total}]`;
  if (event.status === 'start') return `${tag} ${event.label}…`;
  if (event.status === 'progress') {
    return `${tag} ${event.label} ${event.progress?.done ?? 0}/${event.progress?.total ?? 0}`;
  }
  const detail = [
    event.status === 'error' ? '失败' : '',
    event.detail,
    Number.isFinite(event.durationMs) ? formatDuration(event.durationMs) : ''
  ]
    .filter(Boolean)
    .join(' · ');
  return `${tag} ${event.label}${detail ? ` · ${detail}` : ''}`;
}

function endProgressStream() {
  progressStream?.close();
  progressStream = null;
}

function beginProgressStream() {
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (typeof EventSource !== 'function') return id;

  const stream = new EventSource(`/api/progress/${id}`);
  stream.addEventListener('progress', (event) => {
    try {
      const payload = JSON.parse(event.data);
      progressLabel.textContent = progressLine(payload);
      const stepTotal = payload.total || 1;
      if (payload.status === 'progress' && Number(payload.progress?.total) > 0) {
        const stepDone = Math.min(
          1,
          Number(payload.progress.done) / Number(payload.progress.total)
        );
        setProgress(((payload.index - 1 + stepDone) / stepTotal) * 100);
      } else if (payload.status === 'start') {
        setProgress(((payload.index - 1) / stepTotal) * 100);
      } else if (payload.status === 'done' || payload.status === 'error') {
        setProgress((payload.index / stepTotal) * 100);
      }
    } catch {
      // Malformed frame: keep the previous label.
    }
  });
  stream.addEventListener('done', () => {
    stream.close();
    if (progressStream === stream) progressStream = null;
  });
  progressStream = stream;
  return id;
}

function notifyList(id) {
  try {
    const channel = new BroadcastChannel('pdf-parse-x');
    channel.postMessage({ type: 'pdf-parse-x:translated', id });
    channel.close();
  } catch {
    // BroadcastChannel is optional; the list also refreshes when it regains focus.
  }
}

function fail(message) {
  title.textContent = '翻译失败';
  subtitle.textContent = '可以重试，或返回文档列表稍后再试。';
  showStatus('error', escapeHtml(message));
  retryButton.hidden = false;
}

async function run() {
  if (!documentId) {
    fail('缺少文档 ID。');
    return;
  }

  const startedAt = performance.now();
  const progressId = beginProgressStream();

  try {
    const response = await fetch(
      `/api/documents/${encodeURIComponent(documentId)}/translation`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ progressId })
      }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '翻译失败。');

    setProgress(100);
    const translated = Number(payload.translated ?? 0);
    const total = Number(payload.total ?? 0);
    const elapsed = formatDuration(performance.now() - startedAt);
    progressLabel.textContent = `[1/1] 生成中文版 · ${translated}/${total} 段 · ${elapsed}`;
    title.textContent = '中文版已生成';
    subtitle.textContent = '正在打开中文预览…';
    const failed = Number(payload.failed ?? 0);
    showStatus(
      'success',
      `${escapeHtml(translated)}/${escapeHtml(total)} 段已翻译 · ${escapeHtml(elapsed)}${
        failed > 0 ? ` · ${escapeHtml(failed)} 段保留英文` : ''
      }<br>即将自动跳转，也可以点击下方按钮。`
    );

    const previewUrl = payload.chinesePreviewUrl || `/preview/${encodeURIComponent(documentId)}?lang=zh`;
    previewLink.href = previewUrl;
    previewLink.hidden = false;
    notifyList(documentId);
    window.setTimeout(() => window.location.replace(previewUrl), 900);
  } catch (error) {
    fail(error.message);
  } finally {
    endProgressStream();
  }
}

retryButton.addEventListener('click', () => window.location.reload());

run();
