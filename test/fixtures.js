import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Sample PDFs live in `pdfs/`, but older checkouts keep them next to
 * package.json. Tests skip themselves when the fixture is missing.
 */
export function resolveFixture(name) {
  const candidates = [
    path.resolve('pdfs', name),
    path.resolve(name)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
