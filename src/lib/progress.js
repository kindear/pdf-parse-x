/**
 * Shared helpers for reporting conversion progress to a terminal or browser.
 *
 * `convertPdfToMarkdown` emits four coarse phases:
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
    Number.isFinite(event.durationMs) ? formatDuration(event.durationMs) : ''
  ]
    .filter(Boolean)
    .join(' · ');
  return `${tag} ${event.label}${suffix ? ` · ${suffix}` : ''}`;
}

/**
 * Terminal renderer that keeps a single line alive: every event rewrites the
 * previous one, so only the latest progress is visible. `finish()` clears that
 * line so the caller can print its own final summary in place.
 */
export function createConsoleProgress({
  write = (chunk) => process.stdout.write(chunk),
  tty = Boolean(process.stdout.isTTY)
} = {}) {
  let active = false;

  const progress = (event) => {
    const tag = `[${event.index}/${event.total}]`;

    if (event.status === 'start') {
      if (!tty) return;
      write(`\r\x1b[2K${tag} ${event.label} … `);
      active = true;
      return;
    }

    if (event.status === 'progress') {
      if (!tty || !event.progress) return;
      write(
        `\r\x1b[2K${tag} ${event.label} … ${event.progress.done}/${event.progress.total}`
      );
      active = true;
      return;
    }

    if (tty) {
      write(`\r\x1b[2K${describeProgress(event)}`);
      active = true;
    } else {
      write(`${describeProgress(event)}\n`);
    }
  };

  progress.finish = () => {
    if (tty && active) write('\r\x1b[2K');
    active = false;
  };

  return progress;
}
