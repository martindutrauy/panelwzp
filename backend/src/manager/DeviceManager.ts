import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    WAProto,
    downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import readline from 'readline';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { Server as SocketServer } from 'socket.io';
import cron from 'node-cron';
import { encryptSensitiveFields, decryptSensitiveFields } from '../utils/crypto';
import { DB_ROOT, dbPath } from '../config/paths';
import { ensureDir } from '../config/ensureDir';

const logger = pino({ level: 'info' });

// Store simple en memoria para chats, mensajes y contactos
interface SimpleStore {
    chats: Map<string, any>;
    messages: Map<string, any[]>;
    contacts: Map<string, string>; // jid -> nombre
    canonicalByKey: Map<string, string>;
    canonicalByName: Map<string, string>;
    aliases: Map<string, string>;
    profilePhotos: Map<string, { url: string; updatedAt: number }>;
}

const stores: Map<string, SimpleStore> = new Map();

function createSimpleStore(): SimpleStore {
    return {
        chats: new Map(),
        messages: new Map(),
        contacts: new Map(),
        canonicalByKey: new Map(),
        canonicalByName: new Map(),
        aliases: new Map(),
        profilePhotos: new Map()
    };
}

function chatKeyOf(chatId: string): string {
    if (!chatId) return chatId;
    if (chatId.endsWith('@g.us')) return chatId;
    const prefix = chatId.split('@')[0] || chatId;
    return prefix.split(':')[0] || prefix;
}

function hasDeviceSuffix(chatId: string): boolean {
    const prefix = chatId.split('@')[0] || chatId;
    return prefix.includes(':');
}

function isLid(chatId: string): boolean {
    return String(chatId || '').endsWith('@lid');
}

function normalizeName(name: string): string {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function preferredChatId(a: string, b: string): string {
    if (!a) return b;
    if (!b) return a;
    if (a.endsWith('@g.us') || b.endsWith('@g.us')) return a.endsWith('@g.us') ? a : b;
    const aLid = isLid(a);
    const bLid = isLid(b);
    if (aLid !== bLid) return aLid ? b : a;
    const aHas = hasDeviceSuffix(a);
    const bHas = hasDeviceSuffix(b);
    if (aHas !== bHas) return aHas ? b : a;
    return a.length <= b.length ? a : b;
}

function mergeChatData(store: SimpleStore, fromId: string, toId: string) {
    if (!fromId || !toId || fromId === toId) return;

    store.aliases.set(fromId, toId);

    const fromChat = store.chats.get(fromId);
    const toChat = store.chats.get(toId);
    if (fromChat) {
        if (!toChat) {
            store.chats.set(toId, { ...fromChat, id: toId });
        } else {
            const merged = { ...toChat };
            const fromTs = Number(fromChat?.conversationTimestamp || 0);
            const toTs = Number(toChat?.conversationTimestamp || 0);
            merged.conversationTimestamp = Math.max(fromTs, toTs);
            const fromUnread = Number(fromChat?.unreadCount || 0);
            const toUnread = Number(toChat?.unreadCount || 0);
            merged.unreadCount = (Number.isFinite(fromUnread) ? fromUnread : 0) + (Number.isFinite(toUnread) ? toUnread : 0);
            if (fromChat?.name && !toChat?.name) merged.name = fromChat.name;
            store.chats.set(toId, merged);
        }
        store.chats.delete(fromId);
    }

    const fromMsgs = store.messages.get(fromId);
    if (fromMsgs && fromMsgs.length) {
        const toMsgs = store.messages.get(toId) || [];
        const mergedMsgs = toMsgs.concat(fromMsgs);
        mergedMsgs.sort((x: any, y: any) => Number(x?.timestamp || 0) - Number(y?.timestamp || 0));
        store.messages.set(toId, mergedMsgs);
        store.messages.delete(fromId);
    }

    const fromContact = store.contacts.get(fromId);
    const toContact = store.contacts.get(toId);
    if (fromContact && !toContact) store.contacts.set(toId, fromContact);
    if (fromContact) store.contacts.delete(fromId);

    const fromPhoto = store.profilePhotos.get(fromId);
    const toPhoto = store.profilePhotos.get(toId);
    if (fromPhoto && !toPhoto) store.profilePhotos.set(toId, fromPhoto);
    if (fromPhoto) store.profilePhotos.delete(fromId);

    for (const [k, v] of store.aliases.entries()) {
        if (k === fromId) store.aliases.set(k, toId);
        else if (v === fromId) store.aliases.set(k, toId);
    }

    for (const [k, v] of store.canonicalByKey.entries()) {
        if (v === fromId) store.canonicalByKey.set(k, toId);
    }

    for (const [k, v] of store.canonicalByName.entries()) {
        if (v === fromId) store.canonicalByName.set(k, toId);
    }
}

function findRecentChatByName(store: SimpleStore, name: string, timestamp: number): string | null {
    const normalized = String(name || '').trim();
    if (!normalized) return null;

    const maxAgeMs = 30 * 60 * 1000;
    const candidates: Array<{ id: string; ts: number }> = [];

    for (const chat of store.chats.values()) {
        const id = String(chat?.id || '');
        if (!id) continue;
        if (id.endsWith('@g.us')) continue;
        const chatName = String(store.contacts.get(id) || chat?.name || '').trim();
        if (!chatName) continue;
        if (chatName !== normalized) continue;

        const ts = Number(chat?.conversationTimestamp || 0);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        if (Math.abs(timestamp - ts) > maxAgeMs) continue;
        candidates.push({ id, ts });
    }

    candidates.sort((a, b) => b.ts - a.ts);
    if (candidates.length !== 1) return null;
    return candidates[0]!.id;
}

function resolveCanonicalChatIdByName(store: SimpleStore, chatId: string, contactName: string): string {
    const normalized = normalizeName(contactName);
    if (!normalized) return chatId;

    const existing = store.canonicalByName.get(normalized);
    if (existing) {
        store.aliases.set(chatId, existing);
        return existing;
    }

    const matches: string[] = [];
    for (const chat of store.chats.values()) {
        const id = String(chat?.id || '');
        if (!id) continue;
        if (id.endsWith('@g.us')) continue;
        const chatName = normalizeName(store.contacts.get(id) || chat?.name || '');
        if (chatName === normalized) matches.push(id);
    }

    if (!matches.length) {
        store.canonicalByName.set(normalized, chatId);
        return chatId;
    }

    let canonical = preferredChatId(chatId, matches[0]!);
    for (const id of matches.slice(1)) canonical = preferredChatId(canonical, id);
    store.canonicalByName.set(normalized, canonical);
    store.aliases.set(chatId, canonical);
    return canonical;
}

function resolveCanonicalChatId(store: SimpleStore | undefined, chatId: string): string {
    if (!store || !chatId) return chatId;

    const direct = store.aliases.get(chatId);
    if (direct) return direct;

    const key = chatKeyOf(chatId);
    if (!key) return chatId;

    const mapped = store.canonicalByKey.get(key);
    if (mapped) return mapped;

    let best = chatId;
    for (const existingId of store.chats.keys()) {
        if (chatKeyOf(existingId) !== key) continue;
        best = preferredChatId(best, existingId);
    }
    store.canonicalByKey.set(key, best);
    store.aliases.set(chatId, best);
    return best;
}

interface Device {
    id: string;
    name: string;
    phoneNumber: string | null;
    status: 'CONNECTED' | 'DISCONNECTED' | 'QR_READY' | 'CONNECTING' | 'PAIRING_CODE_READY';
    qr: string | null;
}

interface FileMetadata {
    id: string;
    deviceId: string;
    chatId: string;
    fileName: string;
    path: string;
    mimeType: string;
    size: number;
    timestamp: number;
}

export class DeviceManager {
    private static instance: DeviceManager;
    private sessions: Map<string, any> = new Map();
    private devices: Device[] = [];
    private io: SocketServer | null = null;
    private pendingPanelSends: Map<string, Array<{ id?: string; chatId: string; text?: string | null; timestamp: number }>> = new Map();
    private storageRoot = dbPath('storage');
    private devicesPath = dbPath('devices.json');
    private filesPath = dbPath('files.json');
    private pairingMode: Map<string, 'qr' | 'code'> = new Map();
    private reconnectAttempts: Map<string, number> = new Map();
    private connectWatchdogs: Map<string, NodeJS.Timeout> = new Map();
    private pairingCodeLastAt: Map<string, number> = new Map();
    private avatarFetchInFlight: Map<string, Set<string>> = new Map();
    private avatarFetchLastAt: Map<string, number> = new Map();
    private messageRetentionDays = 90;
    private messagesDbRoot = dbPath('messages');
    private messageWriteChains: Map<string, Promise<void>> = new Map();
    private recentPersistedIds: Map<string, { ids: string[]; set: Set<string> }> = new Map();

    private constructor() {
        ensureDir(DB_ROOT);
        ensureDir(this.storageRoot);
        ensureDir(this.messagesDbRoot);
        this.loadData();
        this.initRetentionJob();
    }

    private getDeviceMessagesDbPath(deviceId: string) {
        return path.join(this.messagesDbRoot, `${deviceId}.jsonl`);
    }

    private rememberPersistedId(deviceId: string, msgId: string) {
        if (!msgId) return;
        const existing = this.recentPersistedIds.get(deviceId) || { ids: [], set: new Set<string>() };
        if (existing.set.has(msgId)) return;
        existing.ids.push(msgId);
        existing.set.add(msgId);
        const max = 5000;
        while (existing.ids.length > max) {
            const old = existing.ids.shift();
            if (old) existing.set.delete(old);
        }
        this.recentPersistedIds.set(deviceId, existing);
    }

    private shouldSkipPersist(deviceId: string, msgId: string) {
        if (!msgId) return false;
        const existing = this.recentPersistedIds.get(deviceId);
        return existing ? existing.set.has(msgId) : false;
    }

    private enqueueAppendLine(deviceId: string, line: string) {
        const filePath = this.getDeviceMessagesDbPath(deviceId);
        const prev = this.messageWriteChains.get(deviceId) || Promise.resolve();
        const next = prev
            .then(async () => {
                await fs.promises.appendFile(filePath, line, { encoding: 'utf8' });
            })
            .catch(() => {});
        this.messageWriteChains.set(deviceId, next);
        return next;
    }

    private async restoreMessagesFromDisk(deviceId: string, store: SimpleStore) {
        if (store.messages.size > 0) return;
        const filePath = this.getDeviceMessagesDbPath(deviceId);
        if (!fs.existsSync(filePath)) return;

        const cutoff = this.getMessageRetentionCutoffMs(Date.now());
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
            const trimmed = String(line || '').trim();
            if (!trimmed) continue;
            let rec: any = null;
            try {
                rec = JSON.parse(trimmed);
            } catch {
                continue;
            }
            const chatId = String(rec?.chatId || '');
            if (!chatId) continue;
            const msg = rec?.msg;
            if (!msg) continue;

            const ts = this.getStoredMessageTimestampMs(msg);
            if (!ts || ts < cutoff) continue;

            const msgId = String(msg?.key?.id || msg?.id || '');
            if (msgId) this.rememberPersistedId(deviceId, msgId);

            if (!store.messages.has(chatId)) store.messages.set(chatId, []);
            const arr = store.messages.get(chatId)!;
            if (msgId) {
                const exists = arr.slice(-200).some((m: any) => String(m?.key?.id || m?.id || '') === msgId);
                if (exists) continue;
            }
            arr.push(msg);

            const name = String(rec?.chatName || rec?.contactName || '').trim() || chatId.split('@')[0];
            const existingChat = store.chats.get(chatId) || { id: chatId, name, conversationTimestamp: ts, unreadCount: 0 };
            if (name && existingChat.name !== name) existingChat.name = name;
            existingChat.conversationTimestamp = Math.max(Number(existingChat.conversationTimestamp || 0), ts);
            store.chats.set(chatId, existingChat);

            const contactName = String(rec?.contactName || '').trim();
            if (contactName && !chatId.endsWith('@g.us')) {
                store.contacts.set(chatId, contactName);
            }
        }

        for (const [chatId, msgs] of store.messages.entries()) {
            if (!Array.isArray(msgs) || msgs.length === 0) {
                store.messages.delete(chatId);
                continue;
            }
            msgs.sort((a: any, b: any) => Number(this.getStoredMessageTimestampMs(a)) - Number(this.getStoredMessageTimestampMs(b)));
            store.messages.set(chatId, msgs);
        }
        this.pruneOldMessages(deviceId);
    }

    private persistStoredMessage(deviceId: string, chatId: string, msg: any, chatName?: string | null, contactName?: string | null) {
        const id = String(msg?.key?.id || msg?.id || '');
        if (id && this.shouldSkipPersist(deviceId, id)) return;

        const ts = this.getStoredMessageTimestampMs(msg);
        if (!ts) return;
        if (ts < this.getMessageRetentionCutoffMs(Date.now())) return;

        const payload = {
            chatId,
            chatName: chatName ?? null,
            contactName: contactName ?? null,
            msg
        };
        const line = `${JSON.stringify(payload)}\n`;
        void this.enqueueAppendLine(deviceId, line);
        if (id) this.rememberPersistedId(deviceId, id);
    }

    private clearConnectWatchdog(deviceId: string) {
        const t = this.connectWatchdogs.get(deviceId);
        if (t) {
            clearTimeout(t);
            this.connectWatchdogs.delete(deviceId);
        }
    }

    private scheduleProfilePhotoFetch(deviceId: string, chatId: string) {
        const sock = this.sessions.get(deviceId);
        const store = stores.get(deviceId);
        if (!sock || !store) return;
        if (!chatId || chatId.endsWith('@g.us')) return;

        const canonicalId = resolveCanonicalChatId(store, chatId);
        if (!canonicalId || canonicalId.endsWith('@g.us')) return;

        const key = chatKeyOf(canonicalId);
        if (!key) return;

        const inFlight = this.avatarFetchInFlight.get(deviceId) || new Set<string>();
        if (inFlight.has(key)) return;

        const ttlMs = 7 * 24 * 60 * 60 * 1000;
        const cached = store.profilePhotos.get(canonicalId);
        if (cached && Date.now() - cached.updatedAt < ttlMs) return;

        const lastAt = this.avatarFetchLastAt.get(deviceId) || 0;
        const now = Date.now();
        const minGapMs = 800;
        if (now - lastAt < minGapMs) {
            setTimeout(() => this.scheduleProfilePhotoFetch(deviceId, canonicalId), minGapMs);
            return;
        }

        inFlight.add(key);
        this.avatarFetchInFlight.set(deviceId, inFlight);
        this.avatarFetchLastAt.set(deviceId, now);

        void (async () => {
            try {
                const fileName = `${crypto.createHash('sha1').update(key).digest('hex')}.jpg`;
                const dir = path.join(DB_ROOT, 'storage', 'avatars', deviceId);
                ensureDir(dir);
                const filePath = path.join(dir, fileName);
                const urlPath = `/storage/avatars/${encodeURIComponent(deviceId)}/${fileName}`;

                const existing = store.profilePhotos.get(canonicalId);
                if (existing && fs.existsSync(filePath)) {
                    store.profilePhotos.set(canonicalId, { url: existing.url, updatedAt: Date.now() });
                    return;
                }

                const profileUrl = typeof (sock as any).profilePictureUrl === 'function'
                    ? await (sock as any).profilePictureUrl(canonicalId, 'image').catch(() => null)
                    : null;

                if (!profileUrl) return;

                const resp = await fetch(profileUrl);
                if (!resp.ok) return;
                const arr = await resp.arrayBuffer();
                const buf = Buffer.from(arr);
                fs.writeFileSync(filePath, buf);

                store.profilePhotos.set(canonicalId, { url: urlPath, updatedAt: Date.now() });
            } catch {} finally {
                const s = this.avatarFetchInFlight.get(deviceId);
                if (s) {
                    s.delete(key);
                    if (s.size === 0) this.avatarFetchInFlight.delete(deviceId);
                }
            }
        })();
    }

    private startConnectWatchdog(deviceId: string, sock: any) {
        this.clearConnectWatchdog(deviceId);

        if ((this.pairingMode.get(deviceId) || 'qr') !== 'qr') return;

        const timeoutMs = 25000;
        const timer = setTimeout(() => {
            const current = this.devices.find(d => d.id === deviceId);
            if (!current) return;
            if (current.status !== 'CONNECTING') return;
            if (current.qr) return;

            const attempt = (this.reconnectAttempts.get(deviceId) || 0) + 1;
            this.reconnectAttempts.set(deviceId, attempt);

            try {
                if (typeof sock?.end === 'function') sock.end(new Error('CONNECT_TIMEOUT'));
                else if (sock?.ws?.close) sock.ws.close();
            } catch {}

            this.sessions.delete(deviceId);
            stores.delete(deviceId);
            this.updateDevice(deviceId, { status: 'DISCONNECTED', qr: null, phoneNumber: null });

            if (attempt <= 2) {
                setTimeout(() => {
                    this.initDevice(deviceId, 'qr');
                }, 800);
            }
        }, timeoutMs);

        this.connectWatchdogs.set(deviceId, timer);
    }

    private loadData() {
        if (!fs.existsSync(this.storageRoot)) fs.mkdirSync(this.storageRoot, { recursive: true });

        if (fs.existsSync(this.devicesPath)) {
            const rawData = JSON.parse(fs.readFileSync(this.devicesPath, 'utf-8'));
            // Desencriptar campos sensibles al cargar
            this.devices = rawData.map((device: Device) =>
                decryptSensitiveFields(device, ['phoneNumber', 'qr'])
            );
        }
    }

    private saveDevices() {
        // Encriptar campos sensibles antes de guardar
        const encryptedDevices = this.devices.map(device =>
            encryptSensitiveFields(device, ['phoneNumber', 'qr'])
        );
        fs.writeFileSync(this.devicesPath, JSON.stringify(encryptedDevices, null, 2));
    }

    public static getInstance(): DeviceManager {
        if (!DeviceManager.instance) {
            DeviceManager.instance = new DeviceManager();
        }
        return DeviceManager.instance;
    }

    private rememberPanelSend(deviceId: string, chatId: string, entry: { id?: string; text?: string | null; timestamp: number }) {
        const list = this.pendingPanelSends.get(deviceId) || [];
        list.push({ chatId, ...entry });
        if (list.length > 200) list.splice(0, list.length - 200);
        this.pendingPanelSends.set(deviceId, list);
    }

    private computeTotalUnread(deviceId: string): number {
        const store = stores.get(deviceId);
        if (!store) return 0;
        let total = 0;
        for (const chat of store.chats.values()) {
            const n = Number(chat?.unreadCount || 0);
            if (Number.isFinite(n) && n > 0) total += n;
        }
        return total;
    }

    private resolveSource(deviceId: string, chatId: string, msgId: string | undefined, text: string | null, timestamp: number, fromMe: boolean): 'panel' | 'phone' | 'contact' {
        if (!fromMe) return 'contact';

        const list = this.pendingPanelSends.get(deviceId);
        if (!list || list.length === 0) return 'phone';

        const byIdIndex = msgId ? list.findIndex(e => e.id === msgId) : -1;
        if (byIdIndex >= 0) {
            list.splice(byIdIndex, 1);
            this.pendingPanelSends.set(deviceId, list);
            return 'panel';
        }

        if (text) {
            const maxAgeMs = 15000;
            const idx = list.findIndex(e =>
                e.chatId === chatId &&
                e.text === text &&
                Math.abs(timestamp - e.timestamp) <= maxAgeMs
            );
            if (idx >= 0) {
                list.splice(idx, 1);
                this.pendingPanelSends.set(deviceId, list);
                return 'panel';
            }
        }

        return 'phone';
    }

    private async transcodeToOggOpus(inputBuffer: Buffer): Promise<Buffer> {
        if (!ffmpegPath) throw new Error('ffmpeg no disponible');
        const ffmpeg = ffmpegPath as string;

        const base = crypto.randomUUID();
        const inPath = path.join(os.tmpdir(), `${base}.webm`);
        const outPath = path.join(os.tmpdir(), `${base}.ogg`);

        await fs.promises.writeFile(inPath, inputBuffer);

        try {
            await new Promise<void>((resolve, reject) => {
                const args = [
                    '-y',
                    '-i', inPath,
                    '-c:a', 'libopus',
                    '-b:a', '24k',
                    '-vbr', 'on',
                    '-compression_level', '10',
                    '-application', 'voip',
                    '-f', 'ogg',
                    outPath
                ];

                const proc = spawn(ffmpeg, args, { windowsHide: true }) as import('child_process').ChildProcessWithoutNullStreams;
                let stderr = '';

                proc.stderr.on('data', (chunk: Buffer) => {
                    stderr += chunk?.toString?.() ?? '';
                });

                proc.on('error', reject);
                proc.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(stderr || `ffmpeg exit code ${code}`));
                });
            });

            return await fs.promises.readFile(outPath);
        } finally {
            await fs.promises.rm(inPath, { force: true }).catch(() => {});
            await fs.promises.rm(outPath, { force: true }).catch(() => {});
        }
    }

    public setIO(io: SocketServer) {
        this.io = io;
        // Auto-reconectar dispositivos que tienen credenciales guardadas
        this.autoReconnectDevices();
    }

    private async autoReconnectDevices() {
        const authDir = dbPath('auth');

        for (const device of this.devices) {
            const deviceAuthPath = path.join(authDir, device.id);
            const credsPath = path.join(deviceAuthPath, 'creds.json');

            // Solo auto-reconectar si tiene credenciales COMPLETAS (creds.json existe y tiene contenido)
            // Esto evita generar QRs automáticamente para dispositivos no vinculados
            if (fs.existsSync(credsPath)) {
                try {
                    const credsContent = fs.readFileSync(credsPath, 'utf-8');
                    const creds = JSON.parse(credsContent);
                    
                    // Verificar que tenga credenciales de registro (significa que ya estuvo conectado)
                    if (creds.registered) {
                        console.log(`[${device.id}] Auto-reconectando dispositivo ${device.name}...`);
                        device.status = 'DISCONNECTED';
                        try {
                            await this.initDevice(device.id, 'qr');
                        } catch (error) {
                            console.error(`[${device.id}] Error al auto-reconectar:`, error);
                        }
                    } else {
                        // Tiene creds pero no está registrado, marcar como desconectado
                        console.log(`[${device.id}] Dispositivo no registrado, requiere escaneo QR`);
                        device.status = 'DISCONNECTED';
                    }
                } catch (error) {
                    // Error al leer creds, marcar como desconectado
                    device.status = 'DISCONNECTED';
                }
            } else {
                // No tiene credenciales, marcar como desconectado
                device.status = 'DISCONNECTED';
            }
        }

        this.saveDevices();
    }

    public getDevices() {
        return (this.devices || [])
            .filter(Boolean)
            .map((device: any) => {
                const id = String(device?.id ?? '');
                const base = {
                    id,
                    name: String(device?.name ?? ''),
                    phoneNumber: device?.phoneNumber ?? null,
                    status: device?.status ?? 'DISCONNECTED',
                    qr: device?.qr ?? null
                };
                let unreadCount = 0;
                try {
                    if (id) unreadCount = this.computeTotalUnread(id);
                } catch {
                    unreadCount = 0;
                }
                return { ...base, ...device, id, unreadCount };
            });
    }

    public createDevice(name: string) {
        const id = Math.random().toString(36).substr(2, 9);
        const newDevice: Device = { id, name, phoneNumber: null, status: 'DISCONNECTED', qr: null };
        this.devices.push(newDevice);
        this.saveDevices();
        return newDevice;
    }

    private updateDevice(id: string, data: Partial<Device>) {
        const index = this.devices.findIndex(d => d.id === id);
        if (index !== -1) {
            this.devices[index] = { ...this.devices[index]!, ...data };
            this.saveDevices();
            this.io?.emit('device:update', this.devices[index]);
        }
    }

    public renameDevice(id: string, name: string) {
        if (typeof name !== 'string') throw new Error('Nombre inválido');
        const trimmedName = name.trim();
        if (!trimmedName) throw new Error('El nombre no puede estar vacío');
        if (trimmedName.length > 60) throw new Error('El nombre es demasiado largo');

        const exists = this.devices.some(d => d.id === id);
        if (!exists) return null;

        this.updateDevice(id, { name: trimmedName });
        return this.devices.find(d => d.id === id) || null;
    }

    private initRetentionJob() {
        cron.schedule('0 0 * * *', () => {
            logger.info('Running retention policy job...');
            this.cleanupOldFiles(30); // 30 days retention
        });

        cron.schedule('0 * * * *', () => {
            try {
                this.pruneOldMessagesForAllDevices();
                this.compactAllDeviceMessagesDb();
            } catch {}
        });
    }

    private cleanupOldFiles(days: number) {
        const threshold = Date.now() - (days * 24 * 60 * 60 * 1000);
        // Logic to delete files from storageRoot based on file system stats
        // This is a simplified version
    }

    private getMessageRetentionCutoffMs(nowMs: number) {
        return nowMs - this.messageRetentionDays * 24 * 60 * 60 * 1000;
    }

    private getStoredMessageTimestampMs(msg: any) {
        const direct = Number(msg?.timestamp);
        if (Number.isFinite(direct) && direct > 0) return direct;
        const tsSec = msg?.messageTimestamp != null ? Number(msg.messageTimestamp) : Number(msg?.key?.messageTimestamp);
        if (Number.isFinite(tsSec) && tsSec > 0) return tsSec * 1000;
        const msgTsSec = msg?.key?.id && msg?.messageTimestamp != null ? Number(msg.messageTimestamp) : NaN;
        if (Number.isFinite(msgTsSec) && msgTsSec > 0) return msgTsSec * 1000;
        return 0;
    }

    private extractDisplayText(msg: any) {
        const m = msg?.message ? msg.message : msg;
        const text =
            m?.conversation ||
            m?.extendedTextMessage?.text ||
            m?.imageMessage?.caption ||
            m?.videoMessage?.caption ||
            m?.documentMessage?.caption ||
            null;
        if (text) return text;

        const normalizePhone = (raw: string) => {
            const s = String(raw || '').trim();
            if (!s) return '';
            const hasPlus = s.startsWith('+');
            const digits = s.replace(/[^\d]/g, '');
            if (!digits) return '';
            return hasPlus ? `+${digits}` : digits;
        };

        const parseVcard = (raw: string) => {
            const v = String(raw || '').trim();
            if (!v) return { name: '', phones: [] as string[] };
            const lines = v.split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean);
            let name = '';
            const phones: string[] = [];
            for (const line of lines) {
                const idx = line.indexOf(':');
                if (idx <= 0) continue;
                const key = line.slice(0, idx).toUpperCase();
                const value = line.slice(idx + 1).trim();
                if (!value) continue;
                if (key === 'FN') {
                    if (!name) name = value;
                    continue;
                }
                if (key === 'N') {
                    if (!name) {
                        const parts = value.split(';').map((p) => p.trim()).filter(Boolean);
                        const composed = [parts[1], parts[0]].filter(Boolean).join(' ').trim();
                        if (composed) name = composed;
                    }
                    continue;
                }
                if (key.startsWith('TEL')) {
                    const phone = normalizePhone(value);
                    if (!phone) continue;
                    if (!phones.includes(phone)) phones.push(phone);
                }
            }
            return { name: String(name || '').trim(), phones };
        };

        const contact = m?.contactMessage;
        if (contact) {
            const displayName = String(contact?.displayName || '').trim();
            const { name: vName, phones } = parseVcard(String(contact?.vcard || ''));
            const name = displayName || vName;
            const phone = phones[0] || '';
            if (name && phone) return `Contacto: ${name} (${phone})`;
            if (name) return `Contacto: ${name}`;
            if (phone) return `Contacto: ${phone}`;
            return 'Contacto compartido';
        }

        const contactsArray = m?.contactsArrayMessage;
        if (contactsArray) {
            const contacts = Array.isArray(contactsArray?.contacts) ? contactsArray.contacts : [];
            if (contacts.length === 1) {
                const c = contacts[0] || {};
                const displayName = String(c?.displayName || '').trim();
                const { name: vName, phones } = parseVcard(String(c?.vcard || ''));
                const name = displayName || vName;
                const phone = phones[0] || '';
                if (name && phone) return `Contacto: ${name} (${phone})`;
                if (name) return `Contacto: ${name}`;
                if (phone) return `Contacto: ${phone}`;
                return 'Contacto compartido';
            }
            if (contacts.length > 1) {
                const labels = contacts
                    .slice(0, 2)
                    .map((c: any) => {
                        const displayName = String(c?.displayName || '').trim();
                        const { name: vName, phones } = parseVcard(String(c?.vcard || ''));
                        const name = displayName || vName;
                        const phone = phones[0] || '';
                        if (name && phone) return `${name} (${phone})`;
                        if (name) return name;
                        if (phone) return phone;
                        return 'Contacto';
                    })
                    .filter(Boolean);
                const extra = contacts.length - labels.length;
                const base = labels.join(', ');
                return extra > 0 ? `Contactos: ${base} (+${extra} más)` : `Contactos: ${base}`;
            }
            return 'Contactos compartidos';
        }

        return null;
    }

    private pruneOldMessages(deviceId: string, nowMs: number = Date.now()) {
        const store = stores.get(deviceId);
        if (!store) return { removed: 0, remaining: 0 };
        const cutoff = this.getMessageRetentionCutoffMs(nowMs);
        let removed = 0;
        let remaining = 0;

        for (const [chatId, msgs] of store.messages.entries()) {
            if (!Array.isArray(msgs) || msgs.length === 0) {
                store.messages.delete(chatId);
                continue;
            }
            const filtered = msgs.filter((m: any) => {
                const ts = this.getStoredMessageTimestampMs(m);
                if (!ts) return false;
                return ts >= cutoff;
            });
            removed += msgs.length - filtered.length;
            if (filtered.length) {
                store.messages.set(chatId, filtered);
                remaining += filtered.length;
            } else {
                store.messages.delete(chatId);
            }
        }

        return { removed, remaining };
    }

    private pruneOldMessagesForAllDevices() {
        const now = Date.now();
        for (const deviceId of stores.keys()) {
            this.pruneOldMessages(deviceId, now);
        }
    }

    private async compactDeviceMessagesDbInternal(deviceId: string, nowMs: number) {
        const filePath = this.getDeviceMessagesDbPath(deviceId);
        if (!fs.existsSync(filePath)) return;

        const cutoff = this.getMessageRetentionCutoffMs(nowMs);
        const tmpPath = `${filePath}.tmp`;

        const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: readStream, crlfDelay: Infinity });
        const writeStream = fs.createWriteStream(tmpPath, { encoding: 'utf8' });

        try {
            for await (const line of rl) {
                const trimmed = String(line || '').trim();
                if (!trimmed) continue;
                let rec: any = null;
                try {
                    rec = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                const msg = rec?.msg;
                if (!msg) continue;
                const ts = this.getStoredMessageTimestampMs(msg);
                if (!ts || ts < cutoff) continue;
                writeStream.write(`${JSON.stringify(rec)}\n`);
            }
        } finally {
            try {
                rl.close();
            } catch {}
            try {
                readStream.close();
            } catch {}
            await new Promise<void>((resolve) => writeStream.end(() => resolve()));
        }

        await fs.promises.rename(tmpPath, filePath).catch(async () => {
            try {
                await fs.promises.unlink(tmpPath);
            } catch {}
        });
    }

    private compactDeviceMessagesDb(deviceId: string) {
        const now = Date.now();
        const prev = this.messageWriteChains.get(deviceId) || Promise.resolve();
        const next = prev
            .then(() => this.compactDeviceMessagesDbInternal(deviceId, now))
            .catch(() => {});
        this.messageWriteChains.set(deviceId, next);
    }

    private compactAllDeviceMessagesDb() {
        for (const d of this.devices) {
            if (!d?.id) continue;
            this.compactDeviceMessagesDb(d.id);
        }
    }

    private async handleMedia(deviceId: string, msg: any) {
        const messageType = Object.keys(msg.message || {})[0];
        if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType || '')) return null;

        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: (sock: any) => sock.updateMediaMessage(msg) });
            const chatId_sanitized = msg.key.remoteJid.replace(/[^a-zA-Z0-9]/g, '_');
            const dir = path.join(this.storageRoot, deviceId, chatId_sanitized);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const rawMime = String(msg.message[messageType!].mimetype || '');
            const cleanMime = (rawMime.split(';')[0] ?? '').trim();
            const rawExt = cleanMime.split('/')[1] || 'bin';
            const ext = rawExt.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 16) || 'bin';
            const fileName = `${msg.key.id}.${ext}`;
            const filePath = path.join(dir, fileName);

            fs.writeFileSync(filePath, buffer);

            const relativePath = `${deviceId}/${chatId_sanitized}/${fileName}`;
            const url = `/storage/${relativePath}`;

            return {
                id: msg.key.id!,
                deviceId,
                chatId: msg.key.remoteJid,
                fileName,
                path: filePath,
                url,
                mimeType: msg.message[messageType!].mimetype,
                size: buffer.length,
                timestamp: Date.now()
            };
        } catch (err) {
            logger.error(`Failed to download media: ${err}`);
            return null;
        }
    }

    private upsertHistoryMessage(deviceId: string, store: SimpleStore, msg: any) {
        const originalChatId = msg?.key?.remoteJid;
        if (!originalChatId) return;
        if (originalChatId === 'status@broadcast') return;

        const chatId = String(originalChatId);
        const chatKey = chatKeyOf(chatId);
        let unifiedChatId = resolveCanonicalChatId(store, chatId);

        if (unifiedChatId !== chatId) {
            mergeChatData(store, chatId, unifiedChatId);
        }

        const text = this.extractDisplayText(msg);

        const locationMessage = (msg.message as any)?.locationMessage || (msg.message as any)?.liveLocationMessage || null;
        const location = locationMessage
            ? {
                latitude: Number(locationMessage.degreesLatitude ?? locationMessage.latitude),
                longitude: Number(locationMessage.degreesLongitude ?? locationMessage.longitude),
                name: locationMessage.name ?? null,
                address: locationMessage.address ?? null
            }
            : null;

        const tsSec = msg.messageTimestamp ? Number(msg.messageTimestamp) : 0;
        const timestamp = tsSec ? tsSec * 1000 : Date.now();
        if (timestamp < this.getMessageRetentionCutoffMs(Date.now())) return;
        const fromMe = Boolean(msg?.key?.fromMe);

        if (store) {
            const pushName = msg?.pushName;
            if (pushName && !fromMe && unifiedChatId) {
                store.contacts.set(unifiedChatId, pushName);
            }

            const contactName = store.contacts.get(unifiedChatId) || store.contacts.get(chatId) || pushName;
            if (contactName && !unifiedChatId.endsWith('@g.us')) {
                const byName = resolveCanonicalChatIdByName(store, unifiedChatId, contactName);
                if (byName !== unifiedChatId) {
                    store.canonicalByKey.set(chatKey, byName);
                    store.aliases.set(unifiedChatId, byName);
                    mergeChatData(store, unifiedChatId, byName);
                    unifiedChatId = byName;
                }
                if (pushName && !fromMe && unifiedChatId) {
                    store.contacts.set(unifiedChatId, pushName);
                }
            }

            let chatName: string;
            if (unifiedChatId.endsWith('@g.us')) {
                chatName = contactName || unifiedChatId.split('@')[0] + ' (Grupo)';
            } else {
                chatName = contactName || unifiedChatId.split('@')[0];
            }

            const existingChat = store.chats.get(unifiedChatId) || {
                id: unifiedChatId,
                name: chatName,
                conversationTimestamp: timestamp,
                unreadCount: 0
            };
            if (contactName && existingChat.name !== contactName) {
                existingChat.name = contactName;
            }
            existingChat.conversationTimestamp = Math.max(Number(existingChat.conversationTimestamp || 0), timestamp);
            store.chats.set(unifiedChatId, existingChat);

            if (!store.messages.has(unifiedChatId)) {
                store.messages.set(unifiedChatId, []);
            }
            const arr = store.messages.get(unifiedChatId)!;
            const id = msg?.key?.id;
            if (id) {
                const exists = arr.slice(-200).some((m: any) => (m?.key?.id || m?.id) === id);
                if (exists) return;
            }
            const stored = {
                key: msg.key,
                message: msg.message,
                messageTimestamp: msg.messageTimestamp,
                text,
                fromMe,
                timestamp,
                media: null,
                location,
                source: 'phone'
            };
            arr.push(stored);
            this.persistStoredMessage(deviceId, unifiedChatId, stored, existingChat?.name || chatName, contactName || null);
        }
    }

    public async initDevice(deviceId: string, mode?: 'qr' | 'code') {
        const existingDevice = this.devices.find(d => d.id === deviceId);
        if (!existingDevice) throw new Error('Dispositivo no encontrado');

        if (this.sessions.has(deviceId)) {
            this.updateDevice(deviceId, { status: 'CONNECTING' });
            return;
        }
        if (mode) this.pairingMode.set(deviceId, mode);

        this.updateDevice(deviceId, { status: 'CONNECTING', qr: null });

        const authPath = dbPath('auth', deviceId);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        // Crear store simple en memoria para este dispositivo (o reutilizar el existente)
        const store = stores.get(deviceId) || createSimpleStore();
        stores.set(deviceId, store);
        await this.restoreMessagesFromDisk(deviceId, store);

        const currentMode = this.pairingMode.get(deviceId) || mode || 'qr';
        
        const browser = currentMode === 'code'
            ? ["Chrome (Windows)", "Chrome", "131.0.0.0"]
            : ["Panel Multi-Dispositivo", "Chrome", "1.0.0"];

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            printQRInTerminal: false,
            // Forzar escritorio
            mobile: false,
            // Configuración de red más tolerante
            retryRequestDelayMs: 5000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            // Evitar marcas de online prematuras
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: true,
            browser: browser as any
        });

        this.sessions.set(deviceId, sock);
        this.startConnectWatchdog(deviceId, sock);
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            const currentMode = this.pairingMode.get(deviceId) || 'qr';
            if (qr && currentMode !== 'code') {
                this.clearConnectWatchdog(deviceId);
                this.updateDevice(deviceId, { qr, status: 'QR_READY' });
            }

            if (connection === 'close') {
                this.clearConnectWatchdog(deviceId);
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

                if (statusCode === DisconnectReason.loggedOut) {
                    this.sessions.delete(deviceId);
                    stores.delete(deviceId);

                    if (currentMode === 'qr') {
                        const attempt = (this.reconnectAttempts.get(deviceId) || 0) + 1;
                        this.reconnectAttempts.set(deviceId, attempt);

                        this.updateDevice(deviceId, { status: 'CONNECTING', qr: null, phoneNumber: null });
                        try {
                            fs.rmSync(authPath, { recursive: true, force: true });
                        } catch {}

                        if (attempt <= 2) {
                            setTimeout(() => {
                                this.initDevice(deviceId, 'qr');
                            }, 600);
                        } else {
                            this.updateDevice(deviceId, { status: 'DISCONNECTED', qr: null, phoneNumber: null });
                        }
                    } else {
                        this.updateDevice(deviceId, { status: 'DISCONNECTED', qr: null });
                    }
                    return;
                }

                if (statusCode === DisconnectReason.restartRequired) {
                    this.sessions.delete(deviceId);
                    this.updateDevice(deviceId, { status: 'CONNECTING', qr: null });
                    setTimeout(() => this.initDevice(deviceId), 600);
                    return;
                }

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    this.sessions.delete(deviceId);
                    const attempt = (this.reconnectAttempts.get(deviceId) || 0) + 1;
                    this.reconnectAttempts.set(deviceId, attempt);
                    const delayMs = Math.min(15000, 750 * Math.pow(2, Math.max(0, attempt - 1)));
                    this.updateDevice(deviceId, { status: 'CONNECTING', qr: null });
                    setTimeout(() => {
                        this.initDevice(deviceId);
                    }, delayMs);
                } else {
                    this.updateDevice(deviceId, { status: 'DISCONNECTED', qr: null });
                    this.sessions.delete(deviceId);
                }
            } else if (connection === 'open') {
                this.clearConnectWatchdog(deviceId);
                this.reconnectAttempts.set(deviceId, 0);
                const phoneNumber = sock.user?.id.split(':')[0] || null;
                this.updateDevice(deviceId, { status: 'CONNECTED', phoneNumber, qr: null });
            }
        });

        sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
            const store = stores.get(deviceId);
            if (!store) return;

            if (Array.isArray(contacts)) {
                for (const c of contacts as any[]) {
                    const id = String(c?.id || '');
                    const name = String(c?.name || c?.notify || '').trim();
                    if (id && name) store.contacts.set(id, name);
                }
            }

            if (Array.isArray(chats)) {
                for (const ch of chats as any[]) {
                    const id = String(ch?.id || '');
                    if (!id) continue;
                    const tsSec = Number(ch?.conversationTimestamp || ch?.lastMessageRecvTimestamp || 0);
                    const ts = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : Date.now();
                    const name = String(ch?.name || store.contacts.get(id) || '').trim() || id.split('@')[0];
                    const canonical = resolveCanonicalChatId(store, id);
                    if (canonical !== id) mergeChatData(store, id, canonical);
                    const existing = store.chats.get(canonical) || { id: canonical, name, conversationTimestamp: ts, unreadCount: 0 };
                    existing.name = existing.name || name;
                    existing.conversationTimestamp = Math.max(Number(existing.conversationTimestamp || 0), ts);
                    const unread = Number(ch?.unreadCount || 0);
                    if (Number.isFinite(unread) && unread > 0) existing.unreadCount = Math.max(Number(existing.unreadCount || 0), unread);
                    store.chats.set(canonical, existing);
                }
            }

            if (Array.isArray(messages)) {
                for (const m of messages as any[]) {
                    this.upsertHistoryMessage(deviceId, store, m);
                }
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            for (const msg of m.messages) {
                const originalChatId = msg.key.remoteJid;
                if (!originalChatId) continue;

                // Ignorar mensajes de status/broadcast
                if (originalChatId === 'status@broadcast') continue;

                // Ignorar mensajes de protocolo (confirmaciones, recibos de lectura, etc.)
                const msgType = Object.keys(msg.message || {})[0];
                if (msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage') {
                    console.log(`[${deviceId}] Ignorando mensaje de protocolo: ${msgType}`);
                    continue;
                }

                // Ignorar mensajes sin contenido útil (reacciones, etc.)
                if (msgType === 'reactionMessage' || msgType === 'pollUpdateMessage') {
                    continue;
                }

                // Usar el chatId original sin modificar - NO convertir @lid a @s.whatsapp.net
                // porque los LIDs son identificadores de privacidad que NO corresponden a números de teléfono
                const chatId = originalChatId;

                const chatKey = chatKeyOf(originalChatId);

                // Buscar si ya existe un chat con el mismo número (pero posiblemente diferente sufijo)
                const store = stores.get(deviceId);
                let unifiedChatId = chatId;
                if (store) {
                    const existingCanonical = store.canonicalByKey.get(chatKey);
                    if (existingCanonical) {
                        unifiedChatId = existingCanonical;
                        store.aliases.set(chatId, unifiedChatId);
                    } else {
                        const byKey = resolveCanonicalChatId(store, chatId);
                        unifiedChatId = byKey;
                    }

                    if (unifiedChatId === chatId && chatId.includes('@lid')) {
                        const pushName = (msg as any).pushName;
                        const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
                        const byName = findRecentChatByName(store, pushName, ts);
                        if (byName) {
                            unifiedChatId = byName;
                            store.aliases.set(chatId, unifiedChatId);
                            store.canonicalByKey.set(chatKey, unifiedChatId);
                        }
                    }

                    if (unifiedChatId !== chatId) {
                        mergeChatData(store, chatId, unifiedChatId);
                    }
                }

                const mediaMetadata = await this.handleMedia(deviceId, msg);

                const text = this.extractDisplayText(msg);

                const locationMessage = (msg.message as any)?.locationMessage || (msg.message as any)?.liveLocationMessage || null;
                const location = locationMessage
                    ? {
                        latitude: Number(locationMessage.degreesLatitude),
                        longitude: Number(locationMessage.degreesLongitude),
                        name: locationMessage.name ?? null,
                        address: locationMessage.address ?? null
                    }
                    : null;

                const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
                const fromMe = !!msg.key.fromMe;
                const source = this.resolveSource(deviceId, unifiedChatId, msg.key.id ?? undefined, text, timestamp, fromMe);

                console.log(`[${deviceId}] Mensaje ${fromMe ? 'enviado' : 'recibido'}: ${text?.substring(0, 50) || '[media]'}`);

                // Guardar en el store simple (store ya fue obtenido arriba)
                if (store) {
                    // Guardar pushName como nombre del contacto si existe
                    const pushName = (msg as any).pushName;
                    if (pushName && !msg.key.fromMe && unifiedChatId) {
                        store.contacts.set(unifiedChatId, pushName);
                        console.log(`[${deviceId}] pushName guardado: ${unifiedChatId} -> ${pushName}`);
                    }

                    // Obtener nombre del contacto si existe
                    const contactName = store.contacts.get(unifiedChatId) || 
                                       store.contacts.get(originalChatId) ||
                                       pushName;

                    if (contactName && !unifiedChatId.endsWith('@g.us')) {
                        const byName = resolveCanonicalChatIdByName(store, unifiedChatId, contactName);
                        if (byName !== unifiedChatId) {
                            store.canonicalByKey.set(chatKey, byName);
                            store.aliases.set(unifiedChatId, byName);
                            mergeChatData(store, unifiedChatId, byName);
                            unifiedChatId = byName;
                        }
                        if (pushName && !msg.key.fromMe && unifiedChatId) {
                            store.contacts.set(unifiedChatId, pushName);
                        }
                    }

                    // Determinar el nombre del chat
                    let chatName: string;
                    if (unifiedChatId.endsWith('@g.us')) {
                        chatName = contactName || unifiedChatId.split('@')[0] + ' (Grupo)';
                    } else {
                        chatName = contactName || unifiedChatId.split('@')[0];
                    }

                    // Actualizar/crear chat usando unifiedChatId
                    const existingChat = store.chats.get(unifiedChatId) || {
                        id: unifiedChatId,
                        name: chatName,
                        conversationTimestamp: timestamp,
                        unreadCount: 0
                    };
                    
                    // Actualizar nombre si encontramos uno mejor
                    if (contactName && existingChat.name !== contactName) {
                        existingChat.name = contactName;
                    }
                    
                    existingChat.conversationTimestamp = timestamp;
                    if (!fromMe) existingChat.unreadCount++;
                    store.chats.set(unifiedChatId, existingChat);

                    // Guardar mensaje bajo el unifiedChatId
                    if (!store.messages.has(unifiedChatId)) {
                        store.messages.set(unifiedChatId, []);
                    }
                    const stored = {
                        key: msg.key,
                        message: msg.message,
                        messageTimestamp: msg.messageTimestamp,
                        text,
                        fromMe,
                        timestamp,
                        media: mediaMetadata,
                        location,
                        source
                    };
                    store.messages.get(unifiedChatId)!.push(stored);
                    this.persistStoredMessage(deviceId, unifiedChatId, stored, existingChat?.name || chatName, contactName || null);
                }

                this.scheduleProfilePhotoFetch(deviceId, unifiedChatId);

                // Emitir con unifiedChatId para que el frontend use el mismo ID
                this.io?.emit('message:new', {
                    deviceId,
                    chatId: unifiedChatId,
                    msg: {
                        id: msg.key.id,
                        text,
                        fromMe,
                        timestamp,
                        media: mediaMetadata,
                        location,
                        source
                    }
                });
            }
        });

        sock.ev.on('presence.update', (p) => {
            this.io?.emit('presence:update', { deviceId, ...p });
        });

        // Detectar llamadas entrantes
        sock.ev.on('call', (calls: any[]) => {
            for (const call of calls) {
                // Solo nos interesan las llamadas entrantes (offer)
                if (call.status === 'offer') {
                    console.log(`[${deviceId}] Llamada entrante de ${call.from}`);
                    this.io?.emit('call:incoming', {
                        deviceId,
                        callId: call.id,
                        from: call.from,
                        timestamp: call.date || Date.now(),
                        isVideo: call.isVideo
                    });
                }
            }
        });

        sock.ev.on('chats.update', (updates: any[]) => {
            const store = stores.get(deviceId);
            if (!store) return;

            let changed = false;
            for (const upd of updates) {
                const id = String(upd?.id || '');
                if (!id) continue;

                const incomingUnread = upd?.unreadCount;
                if (incomingUnread !== 0) continue;

                const incomingKey = chatKeyOf(id);
                const existingId = Array.from(store.chats.keys()).find((cid) => chatKeyOf(cid) === incomingKey) || id;

                const chat = store.chats.get(existingId);
                if (!chat) continue;

                if (Number(chat.unreadCount || 0) > 0) {
                    chat.unreadCount = 0;
                    store.chats.set(existingId, chat);
                    changed = true;
                }
            }

            if (changed) {
                this.io?.emit('device:unread:update', {
                    deviceId,
                    totalUnread: this.computeTotalUnread(deviceId)
                });
            }
        });

        // Escuchar sincronización de contactos del dispositivo
        sock.ev.on('contacts.upsert', (contacts) => {
            const store = stores.get(deviceId);
            if (store) {
                for (const contact of contacts) {
                    if (contact.id && (contact.name || contact.notify)) {
                        const contactName = contact.name || contact.notify || '';
                        if (contactName) {
                            store.contacts.set(contact.id, contactName);
                            console.log(`[${deviceId}] Contacto guardado: ${contact.id} -> ${contactName}`);
                        }
                    }
                }
            }
        });

        sock.ev.on('contacts.update', (updates) => {
            const store = stores.get(deviceId);
            if (store) {
                for (const update of updates) {
                    if (update.id && (update.name || update.notify)) {
                        const contactName = update.name || update.notify || '';
                        if (contactName) {
                            store.contacts.set(update.id, contactName);
                        }
                    }
                }
            }
        });

        return sock;
    }

    public async requestPairingCode(deviceId: string, phoneNumber: string) {
        const httpError = (status: number, message: string) =>
            Object.assign(new Error(message), { status });

        if (typeof phoneNumber !== 'string') throw httpError(400, 'Número inválido');
        // Eliminar caracteres no numéricos
        let cleaned = phoneNumber.replace(/[^\d]/g, '');
        if (cleaned.length < 8) throw httpError(400, 'Número inválido');

        // Para Uruguay (598) y otros países, WhatsApp suele requerir el formato internacional estándar.
        // Ejemplo Uruguay: 598 99 123 456 -> 59899123456
        // Se envía el número limpio tal cual lo ingresa el usuario (sin hacks automáticos de país).
        if (cleaned.startsWith('5980') && cleaned.length === 12) {
            cleaned = `598${cleaned.slice(4)}`;
        }

        const device = this.devices.find(d => d.id === deviceId);
        if (!device) throw httpError(404, 'Dispositivo no encontrado');
        if (device.status === 'CONNECTED') throw httpError(409, 'El dispositivo ya está conectado');

        const now = Date.now();
        const cooldownMs = 20000;
        const lastAt = this.pairingCodeLastAt.get(deviceId) || 0;
        if (now - lastAt < cooldownMs) {
            const waitSec = Math.ceil((cooldownMs - (now - lastAt)) / 1000);
            throw httpError(429, `Esperá ${waitSec}s para generar otro código`);
        }
        this.pairingCodeLastAt.set(deviceId, now);

        // Limpiar sesión previa para evitar conflictos
        await this.disconnectAndClean(deviceId);
        // Forzar borrado físico de carpeta auth por seguridad
        const authPath = dbPath('auth', deviceId);
        if (fs.existsSync(authPath)) {
            try { fs.rmSync(authPath, { recursive: true, force: true }); } catch {}
        }

        this.pairingMode.set(deviceId, 'code');
        this.updateDevice(deviceId, { status: 'CONNECTING', qr: null });

        const masked = cleaned.length <= 4 ? '****' : `${'*'.repeat(Math.max(0, cleaned.length - 4))}${cleaned.slice(-4)}`;

        let lastError: any = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`[${deviceId}] Pairing por código: intento ${attempt}...`);
                await this.initDevice(deviceId, 'code');
                const sock = this.sessions.get(deviceId);
                if (!sock) throw new Error('Device not connected');
                if (typeof sock.requestPairingCode !== 'function') throw new Error('Pairing por código no soportado');

                const code = await new Promise<string>((resolve, reject) => {
                    // Aumentar timeout a 60s para dar tiempo al usuario
                    const timeoutMs = 60000;
                    const timer = setTimeout(() => {
                        cleanup();
                        reject(new Error('Timeout esperando conexión para generar código'));
                    }, timeoutMs);

                    const handler = async (update: any) => {
                        // Esperar a 'qr' es lo más seguro para saber que está listo para pairing
                        if (update?.qr) {
                            try {
                                // Delay mayor para asegurar estabilidad del socket
                                console.log(`[${deviceId}] Socket listo, esperando 4s antes de pedir código...`);
                                await new Promise(r => setTimeout(r, 4000));
                                console.log(`[${deviceId}] Solicitando código para ${masked}...`);
                                const pairingCode = await sock.requestPairingCode(cleaned);
                                resolve(pairingCode);
                                cleanup();
                            } catch (err) {
                                console.error(`[${deviceId}] Error pidiendo código:`, err);
                                reject(err);
                                cleanup();
                            }
                        }
                    };

                    const cleanup = () => {
                        clearTimeout(timer);
                        sock.ev.off('connection.update', handler);
                    };

                    sock.ev.on('connection.update', handler);
                });
                this.updateDevice(deviceId, { status: 'PAIRING_CODE_READY', qr: null });
                return { code };
            } catch (error: any) {
                lastError = error;
                const msg = String(error?.message || error || '');
                const retryable = msg.includes('Connection Closed') || msg.includes('Connection Failure') || msg.includes('connection errored');
                if (!retryable || attempt === 3) break;
                
                await this.disconnectAndClean(deviceId);
                await new Promise<void>(r => setTimeout(r, 1500 * attempt));
            }
        }

        throw lastError || new Error('Error al generar código');
    }

    public async sendMessage(deviceId: string, chatId: string, text: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        const store = stores.get(deviceId);
        const canonicalChatId = resolveCanonicalChatId(store, chatId);
        if (store && canonicalChatId !== chatId && store.chats.has(chatId)) {
            mergeChatData(store, chatId, canonicalChatId);
        }
        const targetJid = canonicalChatId;

        console.log(`[${deviceId}] Enviando mensaje a ${targetJid}: ${text.substring(0, 50)}...`);

        try {
            this.rememberPanelSend(deviceId, targetJid, { text, timestamp: Date.now() });
            const result = await sock.sendMessage(targetJid, { text });
            const msgId = result?.key?.id as string | undefined;
            if (msgId) this.rememberPanelSend(deviceId, targetJid, { id: msgId, text, timestamp: Date.now() });
            console.log(`[${deviceId}] Mensaje enviado, result:`, result?.key);
            return result;
        } catch (error: any) {
            console.error(`[${deviceId}] Error enviando mensaje:`, error);
            throw error;
        }
    }

    public async sendMedia(deviceId: string, chatId: string, fileBuffer: Buffer, mimeType: string, caption?: string, isVoiceNote: boolean = false) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        const store = stores.get(deviceId);
        const canonicalChatId = resolveCanonicalChatId(store, chatId);
        if (store && canonicalChatId !== chatId && store.chats.has(chatId)) {
            mergeChatData(store, chatId, canonicalChatId);
        }

        let messageContent: any;

        if (mimeType.startsWith('image/')) {
            messageContent = {
                image: fileBuffer,
                caption: caption || '',
                contextInfo: {
                    externalAdReply: {
                        title: 'Panel WhatsApp',
                        body: 'Imagen desde Administración',
                        mediaType: 1
                    }
                }
            };
        } else if (mimeType === 'application/pdf' || mimeType.startsWith('application/')) {
            messageContent = {
                document: fileBuffer,
                mimetype: mimeType,
                fileName: caption || 'documento.pdf',
                contextInfo: {
                    externalAdReply: {
                        title: 'Panel WhatsApp',
                        body: 'Documento desde Administración',
                        mediaType: 1
                    }
                }
            };
        } else if (mimeType.startsWith('video/')) {
            messageContent = {
                video: fileBuffer,
                caption: caption || '',
                mimetype: mimeType
            };
        } else if (mimeType.startsWith('audio/')) {
            const cleanMime = (mimeType.split(';')[0] ?? '').trim();
            let audioBuffer = fileBuffer;
            let audioMime = mimeType;

            if (isVoiceNote && cleanMime !== 'audio/ogg') {
                try {
                    audioBuffer = await this.transcodeToOggOpus(fileBuffer);
                    audioMime = 'audio/ogg; codecs=opus';
                } catch (error: any) {
                    console.error(`[${deviceId}] Error convirtiendo nota de voz a OGG/Opus:`, error?.message || error);
                    audioBuffer = fileBuffer;
                    audioMime = mimeType;
                }
            }

            messageContent = {
                audio: audioBuffer,
                mimetype: audioMime,
                ptt: isVoiceNote // true = nota de voz, false = audio normal
            };
        } else {
            throw new Error(`Tipo de archivo no soportado: ${mimeType}`);
        }

        this.rememberPanelSend(deviceId, canonicalChatId, { timestamp: Date.now() });
        const result = await sock.sendMessage(canonicalChatId, messageContent);
        const msgId = result?.key?.id as string | undefined;
        if (msgId) this.rememberPanelSend(deviceId, canonicalChatId, { id: msgId, timestamp: Date.now() });
        return result;
    }

    // ========== GROUP MANAGEMENT ==========

    public async getGroups(deviceId: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            const groups = await sock.groupFetchAllParticipating();
            return Object.values(groups).map((group: any) => ({
                id: group.id,
                name: group.subject,
                participants: group.participants.length,
                owner: group.owner,
                creation: group.creation,
                desc: group.desc,
                announce: group.announce
            }));
        } catch (error) {
            console.error('Error al obtener grupos:', error);
            return [];
        }
    }

    public async createGroup(deviceId: string, name: string, participants: string[]) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            const group = await sock.groupCreate(name, participants);
            return group;
        } catch (error: any) {
            throw new Error(`Error al crear grupo: ${error.message}`);
        }
    }

    public async getGroupMetadata(deviceId: string, groupId: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            const metadata = await sock.groupMetadata(groupId);
            return metadata;
        } catch (error: any) {
            throw new Error(`Error al obtener metadata del grupo: ${error.message}`);
        }
    }

    public async addParticipantsToGroup(deviceId: string, groupId: string, participants: string[]) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            const result = await sock.groupParticipantsUpdate(groupId, participants, 'add');
            return result;
        } catch (error: any) {
            throw new Error(`Error al agregar participantes: ${error.message}`);
        }
    }

    public async removeParticipantsFromGroup(deviceId: string, groupId: string, participants: string[]) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            const result = await sock.groupParticipantsUpdate(groupId, participants, 'remove');
            return result;
        } catch (error: any) {
            throw new Error(`Error al eliminar participantes: ${error.message}`);
        }
    }

    public async promoteParticipants(deviceId: string, groupId: string, participants: string[]) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            const result = await sock.groupParticipantsUpdate(groupId, participants, 'promote');
            return result;
        } catch (error: any) {
            throw new Error(`Error al promover participantes: ${error.message}`);
        }
    }

    public async demoteParticipants(deviceId: string, groupId: string, participants: string[]) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            const result = await sock.groupParticipantsUpdate(groupId, participants, 'demote');
            return result;
        } catch (error: any) {
            throw new Error(`Error al degradar participantes: ${error.message}`);
        }
    }

    public async updateGroupSubject(deviceId: string, groupId: string, subject: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            await sock.groupUpdateSubject(groupId, subject);
            return { success: true };
        } catch (error: any) {
            throw new Error(`Error al actualizar nombre del grupo: ${error.message}`);
        }
    }

    public async updateGroupDescription(deviceId: string, groupId: string, description: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            await sock.groupUpdateDescription(groupId, description);
            return { success: true };
        } catch (error: any) {
            throw new Error(`Error al actualizar descripción del grupo: ${error.message}`);
        }
    }

    public async leaveGroup(deviceId: string, groupId: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            await sock.groupLeave(groupId);
            return { success: true };
        } catch (error: any) {
            throw new Error(`Error al salir del grupo: ${error.message}`);
        }
    }

    // ========== CHAT MANAGEMENT ==========

    public async importChatProfilePhoto(deviceId: string, chatId: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        const store = stores.get(deviceId);
        if (!store) throw new Error('Store no encontrado');

        const canonicalId = resolveCanonicalChatId(store, chatId);
        if (!canonicalId) throw new Error('Chat inválido');

        const key = chatKeyOf(canonicalId);
        const fileName = `${crypto.createHash('sha1').update(key).digest('hex')}.jpg`;
        const dir = path.join(DB_ROOT, 'storage', 'avatars', deviceId);
        ensureDir(dir);
        const filePath = path.join(dir, fileName);
        const urlPath = `/storage/avatars/${encodeURIComponent(deviceId)}/${fileName}`;

        const existing = store.profilePhotos.get(canonicalId);
        if (existing && fs.existsSync(filePath)) {
            return { success: true, chatId: canonicalId, url: existing.url };
        }

        const profileUrl = typeof (sock as any).profilePictureUrl === 'function'
            ? await (sock as any).profilePictureUrl(canonicalId, 'image').catch(() => null)
            : null;

        if (!profileUrl) {
            store.profilePhotos.delete(canonicalId);
            return { success: false, chatId: canonicalId, error: 'Sin foto de perfil' };
        }

        const resp = await fetch(profileUrl);
        if (!resp.ok) throw new Error(`Error descargando foto: HTTP ${resp.status}`);
        const arr = await resp.arrayBuffer();
        const buf = Buffer.from(arr);
        fs.writeFileSync(filePath, buf);

        store.profilePhotos.set(canonicalId, { url: urlPath, updatedAt: Date.now() });
        return { success: true, chatId: canonicalId, url: urlPath };
    }

    public async getChats(deviceId: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        try {
            // Obtener store del dispositivo
            const store = stores.get(deviceId);
            if (!store) {
                console.log(`[${deviceId}] Store no encontrado, devolviendo lista vacía`);
                return [];
            }

            // Obtener todos los chats almacenados
            const chats = Array.from(store.chats.values());
            console.log(`[${deviceId}] Chats encontrados en store: ${chats.length}`);

            const merged = new Map<string, { ids: string[]; lastMessageTime: number; unreadCount: number; names: string[] }>();
            for (const chat of chats) {
                const id = String(chat?.id || '');
                if (!id) continue;
                let canonical = resolveCanonicalChatId(store, id);
                if (canonical !== id) mergeChatData(store, id, canonical);

                const nameCandidate = store.contacts.get(canonical) || store.contacts.get(id) || String(chat?.name || '');
                if (!canonical.endsWith('@g.us') && nameCandidate) {
                    const byName = resolveCanonicalChatIdByName(store, canonical, nameCandidate);
                    if (byName !== canonical) {
                        mergeChatData(store, canonical, byName);
                        canonical = byName;
                    }
                }

                const entry = merged.get(canonical) || { ids: [], lastMessageTime: 0, unreadCount: 0, names: [] };
                if (!entry.ids.includes(id)) entry.ids.push(id);

                const ts = Number(chat?.conversationTimestamp || 0);
                if (Number.isFinite(ts) && ts > entry.lastMessageTime) entry.lastMessageTime = ts;

                const unread = Number(chat?.unreadCount || 0);
                if (Number.isFinite(unread) && unread > 0) entry.unreadCount += unread;

                const n = String(chat?.name || '').trim();
                if (n) entry.names.push(n);

                merged.set(canonical, entry);
            }

            const result = Array.from(merged.entries()).map(([canonicalId, entry]) => {
                const contactName =
                    store.contacts.get(canonicalId) ||
                    entry.ids.map((id) => store.contacts.get(id)).find(Boolean) ||
                    entry.names.find(Boolean) ||
                    '';

                const displayName = String(contactName || '').trim() || canonicalId.split('@')[0];
                const lastMessageTime = entry.lastMessageTime || Date.now();
                const profilePhotoUrl = store.profilePhotos.get(canonicalId)?.url || null;
                return {
                    id: canonicalId,
                    name: displayName,
                    lastMessageTime,
                    unreadCount: entry.unreadCount || 0,
                    isGroup: canonicalId.endsWith('@g.us'),
                    profilePhotoUrl
                };
            });

            const sorted = result.sort((a: any, b: any) => b.lastMessageTime - a.lastMessageTime);
            for (const chat of sorted.slice(0, 15)) {
                if (chat?.isGroup) continue;
                if (chat?.profilePhotoUrl) continue;
                this.scheduleProfilePhotoFetch(deviceId, String(chat.id));
            }
            return sorted;
        } catch (error) {
            console.error('Error al obtener chats:', error);
            return [];
        }
    }

    // Marcar chat como leído
    public markChatAsRead(deviceId: string, chatId: string) {
        const store = stores.get(deviceId);
        if (store) {
            const canonicalId = resolveCanonicalChatId(store, chatId);
            const chat = store.chats.get(canonicalId);
            if (chat) {
                const hadUnread = Number(chat.unreadCount || 0) > 0;
                chat.unreadCount = 0;
                store.chats.set(canonicalId, chat);
                console.log(`[${deviceId}] Chat marcado como leído: ${canonicalId}`);
                if (hadUnread) {
                    this.io?.emit('device:unread:update', {
                        deviceId,
                        chatId: canonicalId,
                        totalUnread: this.computeTotalUnread(deviceId)
                    });
                }
                return true;
            }
        }
        return false;
    }

    // Eliminar chat (local y remoto)
    public async deleteChat(deviceId: string, chatId: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        const store = stores.get(deviceId);
        const canonicalId = store ? resolveCanonicalChatId(store, chatId) : chatId;

        try {
            // 1. Eliminar de WhatsApp (limpiar historial)
            // clear: solo limpia mensajes
            // delete: elimina el chat de la lista
            await sock.chatModify({ delete: true, lastMessages: [] }, canonicalId);

            // 2. Eliminar del store local
            if (store) {
                store.chats.delete(canonicalId);
                store.messages.delete(canonicalId);
                store.contacts.delete(canonicalId);

                for (const [k, v] of store.aliases.entries()) {
                    if (k === canonicalId || v === canonicalId) store.aliases.delete(k);
                }
                for (const [k, v] of store.canonicalByKey.entries()) {
                    if (v === canonicalId) store.canonicalByKey.delete(k);
                }
            }
            
            console.log(`[${deviceId}] Chat eliminado: ${canonicalId}`);
            return true;
        } catch (error) {
            console.error(`[${deviceId}] Error eliminando chat:`, error);
            // Intentar eliminar localmente aunque falle remoto
            if (store) {
                store.chats.delete(canonicalId);
                store.messages.delete(canonicalId);
                store.contacts.delete(canonicalId);

                for (const [k, v] of store.aliases.entries()) {
                    if (k === canonicalId || v === canonicalId) store.aliases.delete(k);
                }
                for (const [k, v] of store.canonicalByKey.entries()) {
                    if (v === canonicalId) store.canonicalByKey.delete(k);
                }
            }
            return true;
        }
    }

    public async getChatMessages(deviceId: string, chatId: string, limit: number = 50) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        // Marcar como leído automáticamente al obtener mensajes
        this.markChatAsRead(deviceId, chatId);

        try {
            // Obtener store del dispositivo
            const store = stores.get(deviceId);
            if (!store) {
                console.log(`[${deviceId}] Store no encontrado para mensajes`);
                return [];
            }

            this.pruneOldMessages(deviceId);

            const canonicalId = resolveCanonicalChatId(store, chatId);

            // Cargar mensajes del chat
            const messages = store.messages.get(canonicalId) || [];
            console.log(`[${deviceId}] Mensajes encontrados para ${canonicalId}: ${messages.length}`);

            // Tomar los últimos 'limit' mensajes
            const recentMessages = messages.slice(-limit);

            return recentMessages.map((msg: any) => {
                const locationMessage = msg.location
                    ? msg.location
                    : (msg.message as any)?.locationMessage || (msg.message as any)?.liveLocationMessage || null;

                const location = locationMessage
                    ? {
                        latitude: Number(locationMessage.degreesLatitude ?? locationMessage.latitude),
                        longitude: Number(locationMessage.degreesLongitude ?? locationMessage.longitude),
                        name: locationMessage.name ?? null,
                        address: locationMessage.address ?? null
                    }
                    : null;

                return {
                    id: msg.key?.id || msg.id,
                    text: msg.text || this.extractDisplayText(msg) || (location ? null : (msg.media ? null : '[Media]')),
                    fromMe: msg.fromMe ?? msg.key?.fromMe,
                    timestamp: msg.timestamp || (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()),
                    source: msg.source || ((msg.fromMe ?? msg.key?.fromMe) ? 'phone' : 'contact'),
                    media: msg.media || null,
                    location
                };
            });
        } catch (error) {
            console.error('Error al obtener mensajes:', error);
            return [];
        }
    }

    public async stopDevice(deviceId: string) {
        const sock = this.sessions.get(deviceId);
        if (sock) {
            this.clearConnectWatchdog(deviceId);
            try {
                await sock.logout();
            } catch {}
            this.sessions.delete(deviceId);
            stores.delete(deviceId);
            this.updateDevice(deviceId, { status: 'DISCONNECTED', qr: null });
        }
    }

    // ========== DISCONNECT AND CLEAN ==========

    public async disconnectAndClean(deviceId: string) {
        console.log(`[${deviceId}] Desconectando y limpiando datos...`);

        await this.stopDevice(deviceId);

        const authRoot = dbPath('auth');
        const authPath = dbPath('auth', deviceId);
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log(`[${deviceId}] Carpeta de auth eliminada:`, authPath);
            } catch (error) {
                console.error(`[${deviceId}] Error al eliminar carpeta auth:`, error);
            }
        }
        try {
            fs.mkdirSync(authRoot, { recursive: true });
            fs.mkdirSync(authPath, { recursive: true });
        } catch (error) {
            console.error(`[${deviceId}] Error al recrear carpeta auth:`, error);
        }

        // 3. Eliminar carpeta de storage/archivos
        const storagePath = path.join(this.storageRoot, deviceId);
        if (fs.existsSync(storagePath)) {
            try {
                fs.rmSync(storagePath, { recursive: true, force: true });
                console.log(`[${deviceId}] Carpeta de storage eliminada:`, storagePath);
            } catch (error) {
                console.error(`[${deviceId}] Error al eliminar carpeta storage:`, error);
            }
        }

        const messagesDbPath = this.getDeviceMessagesDbPath(deviceId);
        if (fs.existsSync(messagesDbPath)) {
            try {
                fs.rmSync(messagesDbPath, { force: true });
            } catch {}
        }

        // 4. Actualizar estado del dispositivo
        this.updateDevice(deviceId, {
            status: 'DISCONNECTED',
            qr: null,
            phoneNumber: null
        });

        console.log(`[${deviceId}] Dispositivo desconectado y limpiado completamente`);

        return { success: true, message: 'Dispositivo desconectado y datos eliminados' };
    }

    public async deleteDevice(deviceId: string) {
        // Primero desconectar y limpiar
        await this.disconnectAndClean(deviceId);

        // Eliminar de la lista de dispositivos
        this.devices = this.devices.filter(d => d.id !== deviceId);
        this.saveDevices();

        console.log(`[${deviceId}] Dispositivo eliminado completamente`);

        return { success: true, message: 'Dispositivo eliminado' };
    }

    // ========== BÚSQUEDA DE MENSAJES ==========

    public async searchMessages(deviceId: string, query: string, options?: {
        chatId?: string;
        limit?: number;
        fromMe?: boolean;
    }) {
        const store = stores.get(deviceId);
        if (!store) {
            throw new Error('Dispositivo no tiene mensajes en memoria');
        }

        this.pruneOldMessages(deviceId);

        const results: any[] = [];
        const searchQuery = query.toLowerCase().trim();
        const limit = options?.limit || 50;

        // Determinar en qué chats buscar
        let chatIds: string[] = [];
        if (options?.chatId) {
            chatIds = [options.chatId];
        } else {
            // Buscar en todos los chats
            chatIds = Array.from(store.messages.keys());
        }

        for (const chatId of chatIds) {
            const messages = store.messages.get(chatId) || [];

            for (const msg of messages) {
                // Filtrar por fromMe si se especifica
                const msgFromMe = msg.fromMe ?? msg.key?.fromMe;
                if (options?.fromMe !== undefined && msgFromMe !== options.fromMe) {
                    continue;
                }

                // Obtener texto del mensaje
                const text = msg.text ||
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.videoMessage?.caption ||
                    msg.message?.documentMessage?.caption ||
                    '';

                // Buscar en el texto
                if (text && text.toLowerCase().includes(searchQuery)) {
                    results.push({
                        id: msg.key?.id || msg.id,
                        chatId,
                        chatName: chatId.split('@')[0],
                        text,
                        fromMe: msgFromMe,
                        timestamp: msg.timestamp || (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()),
                        matchHighlight: this.highlightMatch(text, searchQuery)
                    });

                    // Limitar resultados
                    if (results.length >= limit) {
                        break;
                    }
                }
            }

            if (results.length >= limit) {
                break;
            }
        }

        // Ordenar por timestamp descendente (más recientes primero)
        results.sort((a, b) => b.timestamp - a.timestamp);

        console.log(`[${deviceId}] Búsqueda "${query}": ${results.length} resultados encontrados`);
        return results;
    }

    private highlightMatch(text: string, query: string): string {
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return text.replace(regex, '**$1**');
    }
}
