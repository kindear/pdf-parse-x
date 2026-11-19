// 解析记录缓存在浏览器 IndexedDB：首页先渲染本地记录，再用服务端列表覆盖；
// 服务暂时不可用时仍能回看最近一次成功同步的结果。
const DB_NAME = 'pdf-parse-x';
const DB_VERSION = 1;
const STORE = 'records';

const RECORD_FIELDS = [
  'id',
  'title',
  'sourceFile',
  'pages',
  'figures',
  'tables',
  'equations',
  'coverage',
  'hasChinese',
  'generatedAt',
  'previewUrl',
  'chinesePreviewUrl',
  'markdownUrl',
  'chineseMarkdownUrl',
  'apiUrl'
];

let databasePromise = null;

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'id' });
      }
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => resolve(null));
    request.addEventListener('blocked', () => resolve(null));
  });

  return databasePromise;
}

function runTransaction(mode, run) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve) => {
        if (!database) {
          resolve(false);
          return;
        }

        let transaction;
        try {
          transaction = database.transaction(STORE, mode);
          run(transaction.objectStore(STORE));
        } catch {
          resolve(false);
          return;
        }

        transaction.addEventListener('complete', () => resolve(true));
        transaction.addEventListener('error', () => resolve(false));
        transaction.addEventListener('abort', () => resolve(false));
      })
  );
}

/** Keep only the fields the document card needs, so records stay small. */
export function toRecord(document) {
  if (!document?.id) return null;
  const record = { cachedAt: new Date().toISOString() };
  for (const field of RECORD_FIELDS) {
    record[field] = document[field] ?? null;
  }
  return record;
}

export async function readRecords() {
  const database = await openDatabase();
  if (!database) return [];

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).getAll();
      request.addEventListener('success', () => {
        const records = Array.isArray(request.result) ? request.result : [];
        records.sort((a, b) =>
          String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? ''))
        );
        resolve(records);
      });
      request.addEventListener('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

/** Server list is the source of truth: replace the whole cache in one transaction. */
export async function replaceRecords(documents) {
  const records = (documents ?? []).map(toRecord).filter(Boolean);
  await runTransaction('readwrite', (store) => {
    store.clear();
    for (const record of records) store.put(record);
  });
}

export async function upsertRecord(document) {
  const record = toRecord(document);
  if (!record) return;
  await runTransaction('readwrite', (store) => store.put(record));
}

export async function deleteRecord(id) {
  if (!id) return;
  await runTransaction('readwrite', (store) => store.delete(id));
}
