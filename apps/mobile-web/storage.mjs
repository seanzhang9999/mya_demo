const db = await new Promise((resolve, reject) => {
  const q = indexedDB.open("mya-demo-v1", 1);
  q.onupgradeneeded = () => q.result.createObjectStore("store");
  q.onsuccess = () => resolve(q.result);
  q.onerror = () => reject(q.error);
});
export const get = (k) =>
  new Promise((resolve, reject) => {
    const q = db.transaction("store").objectStore("store").get(k);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
export const set = (k, v) =>
  new Promise((resolve, reject) => {
    const t = db.transaction("store", "readwrite");
    t.objectStore("store").put(v, k);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
export async function loadState() {
  const box = await get("encrypted-state");
  if (!box) return {};
  const key = await get("storage-key");
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: box.iv },
        key,
        box.bytes,
      ),
    ),
  );
}
export async function saveState(state) {
  let key = await get("storage-key");
  if (!key) {
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await set("storage-key", key);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(state)),
  );
  await set("encrypted-state", { iv, bytes });
}
