// 取り込んだ顔をブラウザ内に保存する。画像は Blob のまま IndexedDB に置く。
// 端末の中だけに保存され、どこにも送信されない。

const DB = 'find-type';
const STORE = 'faces';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  }));
}

export const putFaces = (faces) => tx('readwrite', (s) => { for (const f of faces) s.put(f); });
export const allFaces = () => tx('readonly', (s) => s.getAll());
export const deleteFace = (id) => tx('readwrite', (s) => s.delete(id));
export const clearFaces = () => tx('readwrite', (s) => s.clear());

/** 保存されている顔を、アプリが使う形（画像URL付き）に変換する */
export async function loadStoredPool() {
  let rows = [];
  try { rows = await allFaces(); } catch { return []; }
  return rows.map((f) => ({
    id: f.id,
    src: URL.createObjectURL(f.blob),
    gender: f.gender,
    genderProbability: f.genderProbability,
    age: f.age,
    raw: f.raw,
    stored: true,
  }));
}
