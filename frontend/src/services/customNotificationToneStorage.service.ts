const DB_NAME = 'wzp.notification_audio.v1';
const DB_VERSION = 1;
const STORE = 'branch_tone';

const openDb = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

export const saveCustomNotificationTone = async (branchId: string, blob: Blob) => {
    const id = String(branchId || '').trim();
    if (!id) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.put(blob, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
};

export const loadCustomNotificationTone = async (branchId: string) => {
    const id = String(branchId || '').trim();
    if (!id) return null;
    const db = await openDb();
    return await new Promise<Blob | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req = store.get(id);
        req.onsuccess = () => resolve((req.result as Blob) || null);
        req.onerror = () => reject(req.error);
    });
};

export const deleteCustomNotificationTone = async (branchId: string) => {
    const id = String(branchId || '').trim();
    if (!id) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
};

