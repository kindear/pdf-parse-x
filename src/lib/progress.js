/**
 * Shared helpers for reporting conversion progress to a terminal or browser.
 *
 * `convertPdfToMarkdown` emits events shaped like:
 *   { total, index, label, status: 'start' | 'progress' | 'done' | 'error',
 *     durationMs, detail, progress: { done, total } }
 */

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function describeProgress(event) {
  const tag = `[${event.index}/${event.total}]`;
  if (event.status === 'start') return `${tag} ${event.label}`;
  const suffix = [
    event.status === 'error' ? '失败' : '',
    event.detail ?? '',
    formatDuration(event.durationMs)
  ]
    .filter(Boolean)
    .join('  ');
  return `${tag} ${event.label} … ${suffix}`;
}

/**
 * Terminal renderer: keeps the running step on one line and rewrites it with
 * per-item progress when the stream is a TTY.
 */
export function createConsoleProgress({
  write = (chunk) => process.stdout.write(chunk),
  tty = Boolean(process.stdout.isTTY)
} = {}) {
  let activeLine = false;
  let activeHead = '';

  return (event) => {
    if (event.status === 'start') {
      activeHead = `[${event.index}/${event.total}] ${event.label}`;
      if (tty) {
        write(`${activeHead} … `);
        activeLine = true;
      }
      return;
    }

    if (event.status === 'progress') {
      if (!tty || !event.progress) return;
      write(`\r${activeHead} … ${event.progress.done}/${event.progress.total}`);
      activeLine = true;
      return;
    }

    if (tty && activeLine) {
      write(`\r${describeProgress(event)}\n`);
    } else {
      write(`${describeProgress(event)}\n`);
    }
    activeLine = false;
    activeHead = '';
  };
}
