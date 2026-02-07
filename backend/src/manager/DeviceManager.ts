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
import { markIncomingMessage } from '../auth/statsStore';
import { getPrisma } from '../db/prisma';

// Logger silencioso para Baileys (evita spam de logs de conexión/stream)
// En producción solo mostrar errores, en desarrollo mostrar warnings
const logger = pino({ level: 'error' });

// Store simple en memoria para chats, mensajes y contactos
interface SimpleStore {
    chats: Map<string, any>;
    messages: Map<string, any[]>;
    contacts: Map<string, string>; // jid -> nombre
    canonicalByKey: Map<string, string>;
    aliases: Map<string, string>;
    profilePhotos: Map<string, { url: string; updatedAt: number }>;
    // Mapeo bidireccional LID <-> Phone para consistencia
    lidToPhone: Map<string, string>; // LID -> número @s.whatsapp.net
    phoneToLid: Map<string, string>; // número @s.whatsapp.net -> LID
    // Cache de pushNames para evitar logs duplicados
    lastPushName: Map<string, string>; // jid -> último pushName conocido
}

const stores: Map<string, SimpleStore> = new Map();

function createSimpleStore(): SimpleStore {
    return {
        chats: new Map(),
        messages: new Map(),
        contacts: new Map(),
        canonicalByKey: new Map(),
        aliases: new Map(),
        profilePhotos: new Map(),
        lidToPhone: new Map(),
        phoneToLid: new Map(),
        lastPushName: new Map()
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

// Registrar mapeo LID <-> Phone cuando lo detectamos
function registerLidPhoneMapping(store: SimpleStore, lid: string, phone: string) {
    if (!lid || !phone || !isLid(lid) || isLid(phone)) return;
    const existingPhone = store.lidToPhone.get(lid);
    const existingLid = store.phoneToLid.get(phone);
    if (existingPhone === phone && existingLid === lid) return; // Ya mapeado
    
    store.lidToPhone.set(lid, phone);
    store.phoneToLid.set(phone, lid);
    console.log(`[LID-MAP] Registrado: ${lid} <-> ${phone}`);
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
}

function resolveCanonicalChatId(store: SimpleStore | undefined, chatId: string): string {
    if (!store || !chatId) return chatId;

    // 1. Verificar alias directo
    const direct = store.aliases.get(chatId);
    if (direct) return direct;

    // 2. Grupos siempre son únicos por su ID completo
    if (chatId.endsWith('@g.us')) {
        return chatId;
    }

    // 3. Para LIDs, SOLO usar mapeo explícito (no fusionar arbitrariamente)
    if (isLid(chatId)) {
        const phoneNumber = store.lidToPhone.get(chatId);
        if (!phoneNumber) return chatId;
        if (store.chats.has(chatId) && !store.chats.has(phoneNumber)) {
            mergeChatData(store, chatId, phoneNumber);
        } else {
            store.aliases.set(chatId, phoneNumber);
        }
        return phoneNumber;
    }
    
    // 4. Para números de teléfono normales
    if (chatId.endsWith('@s.whatsapp.net')) {
        const normalized = (() => {
            const key = chatKeyOf(chatId);
            if (!key) return chatId;
            return `${key}@s.whatsapp.net`;
        })();
        if (normalized !== chatId) {
            if (store.chats.has(chatId) && !store.chats.has(normalized)) {
                mergeChatData(store, chatId, normalized);
            } else {
                store.aliases.set(chatId, normalized);
            }
            return normalized;
        }

        const lid = store.phoneToLid.get(chatId);
        if (lid && store.chats.has(lid) && !store.chats.has(chatId)) {
            // El chat existe con LID pero no con número, migrar al número
            mergeChatData(store, lid, chatId);
            return chatId;
        }
        
        return chatId;
    }

    // Otros tipos de ID -> mantener como están
    return chatId;
}

interface Device {
    id: string;
    name: string;
    phoneNumber: string | null;
    status: 'CONNECTED' | 'DISCONNECTED' | 'QR_READY' | 'CONNECTING' | 'PAIRING_CODE_READY' | 'RECONNECTING';
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
    private groupSubjectFetchInFlight: Map<string, Set<string>> = new Map();
    private groupSubjectFetchLastAt: Map<string, Map<string, number>> = new Map();
    private messageRetentionDays = 90;
    private messagesDbRoot = dbPath('messages');
    private messageWriteChains: Map<string, Promise<void>> = new Map();
    private recentPersistedIds: Map<string, { ids: string[]; set: Set<string> }> = new Map();
    private dbAliasBackfillDone: Set<string> = new Set();

    private constructor() {
        ensureDir(DB_ROOT);
        ensureDir(this.storageRoot);
        ensureDir(this.messagesDbRoot);
        this.loadData();
        this.initRetentionJob();
        // NO auto-reconectar en el constructor - hacerlo después de que el servidor esté listo
    }

    // Método público para iniciar auto-reconexión (llamar después de que el servidor esté listo)
    public async startAutoReconnect() {
        // Marcar dispositivos con sesión guardada como "RECONNECTING"
        const devicesToReconnect: string[] = [];
        
        for (const device of this.devices) {
            const authPath = dbPath('auth', device.id);
            const credsPath = path.join(authPath, 'creds.json');
            if (fs.existsSync(credsPath)) {
                devicesToReconnect.push(device.id);
                this.updateDevice(device.id, { status: 'RECONNECTING', qr: null });
                console.log(`[${device.id}] Sesión guardada detectada`);
            }
        }
        
        if (devicesToReconnect.length === 0) {
            console.log('[AutoReconnect] No hay dispositivos con sesión guardada');
            return;
        }
        
        console.log(`[AutoReconnect] ${devicesToReconnect.length} dispositivo(s) para reconectar`);
        
        // Esperar a que el servidor esté completamente listo
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Reconectar uno por uno con delay entre cada uno
        for (const deviceId of devicesToReconnect) {
            console.log(`[${deviceId}] Iniciando auto-reconexión...`);
            try {
                await this.initDevice(deviceId, 'qr').catch(err => {
                    console.log(`[${deviceId}] Error en auto-reconexión: ${err?.message || err}`);
                    this.updateDevice(deviceId, { status: 'DISCONNECTED', qr: null });
                });
            } catch (err: any) {
                console.log(`[${deviceId}] Error iniciando auto-reconexión:`, err?.message || err);
                this.updateDevice(deviceId, { status: 'DISCONNECTED', qr: null });
            }
            
            // Esperar 3 segundos entre reconexiones para no saturar memoria
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        console.log('[AutoReconnect] Proceso completado');
    }

    private async dbUpsertDeviceRecord(device: { id: string; name: string; status?: string; qr?: string | null; phoneNumber?: string | null; number?: string | null }) {
        const prisma = getPrisma();
        if (!prisma) return;
        const id = String(device?.id || '').trim();
        if (!id) return;
        const name = String(device?.name || '').trim() || id;
        const number = (device as any)?.phoneNumber ?? (device as any)?.number ?? null;
        const status = String((device as any)?.status || 'DISCONNECTED');
        const qr = (device as any)?.qr ?? null;
        try {
            await prisma.device.upsert({
                where: { id },
                create: { id, name, number: number ? String(number) : null, status, qr },
                update: { name, number: number ? String(number) : null, status, qr }
            });
        } catch {}
    }

    private normalizeDbWaChatId(raw: string): string {
        const id = String(raw || '').trim();
        if (!id) return id;
        if (id.endsWith('@g.us')) return id;
        if (id.endsWith('@lid')) return id;
        if (id.endsWith('@s.whatsapp.net')) {
            const prefix = id.split('@')[0] || id;
            const base = prefix.split(':')[0] || prefix;
            return `${base}@s.whatsapp.net`;
        }
        return id;
    }

    private async dbResolveChatForWaChatId(prisma: any, deviceId: string, waChatId: string) {
        const id = String(waChatId || '').trim();
        if (!deviceId || !id) return null;
        const direct = await prisma.chat
            .findUnique({
                where: { deviceId_waChatId: { deviceId, waChatId: id } },
                select: { id: true, waChatId: true, name: true, customName: true }
            })
            .catch(() => null);
        if (direct) return direct;
        const alias = await prisma.chatAlias
            .findUnique({
                where: { deviceId_waChatId: { deviceId, waChatId: id } },
                select: { chatId: true }
            })
            .catch(() => null);
        if (!alias?.chatId) return null;
        return prisma.chat
            .findUnique({
                where: { id: String(alias.chatId) },
                select: { id: true, waChatId: true, name: true, customName: true }
            })
            .catch(() => null);
    }

    private async dbEnsureChatAlias(prisma: any, deviceId: string, waChatId: string, chatId: string) {
        const id = String(waChatId || '').trim();
        const c = String(chatId || '').trim();
        if (!deviceId || !id || !c) return;
        await prisma.chatAlias
            .upsert({
                where: { deviceId_waChatId: { deviceId, waChatId: id } },
                create: { deviceId, waChatId: id, chatId: c },
                update: { chatId: c }
            })
            .catch(() => {});
    }

    private async dbBackfillChatAliasesForDevice(deviceId: string) {
        const prisma = getPrisma();
        if (!prisma) return;
        const d = String(deviceId || '').trim();
        if (!d) return;
        if (this.dbAliasBackfillDone.has(d)) return;
        this.dbAliasBackfillDone.add(d);

        const chats: Array<{ id: string; waChatId: string; lastMessageAt: Date | null }> = await prisma.chat
            .findMany({
                where: { deviceId: d },
                select: { id: true, waChatId: true, lastMessageAt: true }
            })
            .catch(() => []);

        const groups = new Map<string, Array<{ id: string; waChatId: string; lastMessageAt: Date | null }>>();
        for (const c of chats) {
            const chatRowId = String(c?.id || '').trim();
            const wa = String(c?.waChatId || '').trim();
            if (!chatRowId || !wa) continue;
            const normalized = this.normalizeDbWaChatId(wa);
            await this.dbEnsureChatAlias(prisma as any, d, wa, chatRowId);
            if (normalized && normalized !== wa) {
                await this.dbEnsureChatAlias(prisma as any, d, normalized, chatRowId);
            }

            if (wa.endsWith('@s.whatsapp.net')) {
                const key = normalized || wa;
                const arr = groups.get(key) || [];
                arr.push({ id: chatRowId, waChatId: wa, lastMessageAt: c.lastMessageAt || null });
                groups.set(key, arr);
            }
        }

        for (const [key, arr] of groups.entries()) {
            if (arr.length <= 1) continue;
            const sorted = arr
                .slice()
                .sort((a, b) => {
                    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
                    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
                    if (tb !== ta) return tb - ta;
                    return String(a.id).localeCompare(String(b.id));
                });
            const winner = sorted[0];
            if (!winner?.id) continue;
            for (let i = 1; i < sorted.length; i++) {
                const loser = sorted[i];
                if (!loser?.id || loser.id === winner.id) continue;
                await prisma.message.updateMany({ where: { chatId: loser.id }, data: { chatId: winner.id } }).catch(() => {});
                await prisma.chatAlias.updateMany({ where: { chatId: loser.id }, data: { chatId: winner.id } }).catch(() => {});
                await prisma.chat.delete({ where: { id: loser.id } }).catch(() => {});
                await this.dbEnsureChatAlias(prisma as any, d, loser.waChatId, winner.id);
            }
            if (key) {
                await this.dbEnsureChatAlias(prisma as any, d, key, winner.id);
            }
        }
    }

    private async dbHydrateExplicitPeerMappingsFromAliases(deviceId: string, store: SimpleStore) {
        const prisma = getPrisma();
        if (!prisma) return;
        const d = String(deviceId || '').trim();
        if (!d) return;

        const rows: Array<{ waChatId: string; chat?: { waChatId: string } | null }> = await prisma.chatAlias
            .findMany({
                where: { deviceId: d },
                select: { waChatId: true, chat: { select: { waChatId: true } } }
            })
            .catch(() => []);

        for (const r of rows) {
            const aliasId = String(r?.waChatId || '').trim();
            const canonical = String(r?.chat?.waChatId || '').trim();
            if (!aliasId || !canonical) continue;

            const aIsLid = aliasId.endsWith('@lid');
            const aIsPhone = aliasId.endsWith('@s.whatsapp.net');
            const cIsLid = canonical.endsWith('@lid');
            const cIsPhone = canonical.endsWith('@s.whatsapp.net');

            let lid: string | null = null;
            let phone: string | null = null;
            if (aIsLid && cIsPhone) {
                lid = aliasId;
                phone = this.normalizeDbWaChatId(canonical);
            } else if (aIsPhone && cIsLid) {
                lid = canonical;
                phone = this.normalizeDbWaChatId(aliasId);
            }

            if (!lid || !phone || !phone.endsWith('@s.whatsapp.net')) continue;

            store.lidToPhone.set(lid, phone);
            store.phoneToLid.set(phone, lid);
            store.aliases.set(lid, phone);
            if (store.chats.has(lid) && !store.chats.has(phone)) {
                mergeChatData(store, lid, phone);
            }
        }
    }

    private async dbUpsertChatAndMessage(args: {
        deviceId: string;
        waChatId: string;
        waChatIdAliases?: string[];
        chatName: string | null;
        isGroup: boolean;
        unreadCount: number;
        lastMessageAtMs: number;
        profilePhotoUrl?: string | null;
        waMessageId?: string | null;
        fromMe: boolean;
        source: string;
        type: string;
        text: string | null;
        mediaPath?: string | null;
        rawJson?: string | null;
    }) {
        const prisma = getPrisma();
        if (!prisma) return;

        const deviceId = String(args.deviceId || '').trim();
        const waChatId = String(args.waChatId || '').trim();
        if (!deviceId || !waChatId) return;

        const localDevice = this.devices.find((d) => d.id === deviceId);
        await this.dbUpsertDeviceRecord({
            id: deviceId,
            name: String(localDevice?.name || deviceId),
            status: String(localDevice?.status || 'DISCONNECTED'),
            qr: localDevice?.qr ?? null,
            phoneNumber: localDevice?.phoneNumber ?? null
        });

        try {
            const canonicalCandidate = this.normalizeDbWaChatId(waChatId);
            const allIds = new Set<string>();
            allIds.add(waChatId);
            if (canonicalCandidate) allIds.add(canonicalCandidate);
            if (Array.isArray(args.waChatIdAliases)) {
                for (const a of args.waChatIdAliases) {
                    const s = String(a || '').trim();
                    if (s) allIds.add(s);
                }
            }

            let resolvedChat: any = null;
            for (const id of allIds) {
                resolvedChat = await this.dbResolveChatForWaChatId(prisma as any, deviceId, id);
                if (resolvedChat) break;
            }

            const existingChat = resolvedChat;
            const newName = args.chatName ? String(args.chatName).trim() : null;
            let nameToUse: string | null = null;

            const isGroup = Boolean(args.isGroup);
            if (isGroup) {
                nameToUse = newName || (existingChat?.name ? String(existingChat.name).trim() : null);
            } else if (existingChat) {
                if (existingChat.customName) {
                    nameToUse = existingChat.name;
                } else if (existingChat.name && existingChat.name.trim()) {
                    const existingLen = existingChat.name.trim().length;
                    const newLen = newName ? newName.length : 0;
                    nameToUse = newLen > existingLen ? newName : existingChat.name;
                } else {
                    nameToUse = newName;
                }
            } else {
                nameToUse = newName;
            }

            let chatId: string = String(existingChat?.id || '').trim();
            if (!chatId) {
                const created = await prisma.chat.create({
                    data: {
                        deviceId,
                        waChatId: canonicalCandidate || waChatId,
                        name: nameToUse,
                        isGroup: Boolean(args.isGroup),
                        unreadCount: Math.max(0, Math.floor(Number(args.unreadCount || 0))),
                        lastMessageAt: new Date(Number(args.lastMessageAtMs || Date.now())),
                        profilePhotoUrl: args.profilePhotoUrl ? String(args.profilePhotoUrl) : null
                    },
                    select: { id: true }
                });
                chatId = String(created?.id || '').trim();
            } else {
                await prisma.chat.update({
                    where: { id: chatId },
                    data: {
                        ...(nameToUse !== existingChat?.name ? { name: nameToUse } : {}),
                        isGroup: Boolean(args.isGroup),
                        unreadCount: Math.max(0, Math.floor(Number(args.unreadCount || 0))),
                        lastMessageAt: new Date(Number(args.lastMessageAtMs || Date.now())),
                        profilePhotoUrl: args.profilePhotoUrl ? String(args.profilePhotoUrl) : undefined
                    },
                    select: { id: true }
                });
            }

            for (const id of allIds) {
                await this.dbEnsureChatAlias(prisma as any, deviceId, id, chatId);
            }

            const waMessageId = args.waMessageId ? String(args.waMessageId) : '';
            if (!waMessageId) return;

            await prisma.message.upsert({
                where: { waMessageId },
                create: {
                    deviceId,
                    chatId,
                    waMessageId,
                    fromMe: Boolean(args.fromMe),
                    source: String(args.source || 'whatsapp'),
                    type: String(args.type || 'text'),
                    text: args.text ? String(args.text) : null,
                    mediaPath: args.mediaPath ? String(args.mediaPath) : null,
                    timestamp: new Date(Number(args.lastMessageAtMs || Date.now())),
                    status: 'sent',
                    rawJson: args.rawJson ? String(args.rawJson) : null
                },
                update: {
                }
            });
        } catch (e: any) {
            const code = String(e?.code || '');
            if (code === 'P2002' || code === 'P2025') return;
        }
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
        // Con MySQL configurado, la fuente de verdad es la DB (no el JSONL local).
        if (getPrisma()) return;
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
        // Con MySQL configurado, evitamos duplicar en disco.
        if (getPrisma()) return;
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

        // Usar canonicalId completo para evitar mezclar fotos entre chats
        // (antes usaba chatKey que podía ser compartido entre LID y número)
        const uniqueKey = canonicalId;

        const inFlight = this.avatarFetchInFlight.get(deviceId) || new Set<string>();
        if (inFlight.has(uniqueKey)) return;

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

        inFlight.add(uniqueKey);
        this.avatarFetchInFlight.set(deviceId, inFlight);
        this.avatarFetchLastAt.set(deviceId, now);

        void (async () => {
            try {
                // Hash del canonicalId completo para nombre de archivo único
                const fileName = `${crypto.createHash('sha1').update(canonicalId).digest('hex')}.jpg`;
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
                    s.delete(uniqueKey);
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

        this.migrateDeviceNamesToSucursal();
    }

    private migrateDeviceNamesToSucursal() {
        const sucursalRegex = /^sucursal\s+(\d+)\s*$/i;
        const used = new Set<number>();
        for (const d of this.devices || []) {
            const m = String((d as any)?.name || '').trim().match(sucursalRegex);
            if (m && m[1]) {
                const n = Number(m[1]);
                if (Number.isFinite(n) && n > 0) used.add(n);
            }
        }

        const nextAvailable = () => {
            let i = 1;
            while (used.has(i)) i++;
            used.add(i);
            return i;
        };

        let changed = false;
        for (const d of this.devices || []) {
            const current = String((d as any)?.name || '').trim();
            const isSucursal = sucursalRegex.test(current);
            const isCloudLike = /^cloud[\s\-_:]?/i.test(current) || current.toLowerCase().includes('cloud-');
            if (isSucursal) continue;
            if (!isCloudLike) continue;
            const n = nextAvailable();
            (d as any).name = `Sucursal ${n}`;
            changed = true;
            void this.dbUpsertDeviceRecord(d as any);
            this.io?.emit('device:update', d);
        }

        if (changed) {
            this.saveDevices();
        }
    }

    private async ensureGroupSubject(deviceId: string, groupId: string, sock: any, store: SimpleStore, lastMessageAtMs: number, force: boolean = false): Promise<string | null> {
        const d = String(deviceId || '').trim();
        const gid = String(groupId || '').trim();
        if (!d || !gid || !gid.endsWith('@g.us')) return null;

        const now = Date.now();
        const deviceMap = this.groupSubjectFetchLastAt.get(d) || new Map<string, number>();
        this.groupSubjectFetchLastAt.set(d, deviceMap);
        const lastAt = Number(deviceMap.get(gid) || 0);
        const cached = String(store.chats.get(gid)?.name || '').trim();
        if (!force && now - lastAt < 5 * 60 * 1000) return cached || null;

        const inFlight = this.groupSubjectFetchInFlight.get(d) || new Set<string>();
        if (inFlight.has(gid)) return cached || null;
        inFlight.add(gid);
        this.groupSubjectFetchInFlight.set(d, inFlight);

        try {
            const metadata = await sock.groupMetadata(gid).catch(() => null);
            const subject = String((metadata as any)?.subject || '').trim();
            if (!subject) return cached || null;

            const existing = store.chats.get(gid) || { id: gid, name: subject, conversationTimestamp: lastMessageAtMs || now, unreadCount: 0 };
            existing.name = subject;
            store.chats.set(gid, existing);
            store.contacts.delete(gid);
            store.lastPushName.delete(gid);

            deviceMap.set(gid, now);

            const prisma = getPrisma();
            if (prisma) {
                void this.dbUpsertChatAndMessage({
                    deviceId: d,
                    waChatId: gid,
                    chatName: subject,
                    isGroup: true,
                    unreadCount: Number(existing?.unreadCount || 0),
                    lastMessageAtMs: Number(existing?.conversationTimestamp || lastMessageAtMs || now),
                    profilePhotoUrl: store.profilePhotos.get(gid)?.url || null,
                    waMessageId: null,
                    fromMe: false,
                    source: 'whatsapp',
                    type: 'text',
                    text: null,
                    mediaPath: null,
                    rawJson: null
                });
            }

            this.io?.emit('chat:name:update', { deviceId: d, chatId: gid, name: subject });
            return subject;
        } finally {
            const set = this.groupSubjectFetchInFlight.get(d);
            if (set) set.delete(gid);
        }
    }

    private async dbBackfillGroupSubjectsForDevice(deviceId: string, sock: any, store: SimpleStore) {
        const prisma = getPrisma();
        if (!prisma) return;
        const d = String(deviceId || '').trim();
        if (!d) return;

        const rows: Array<{ id: string; waChatId: string; name: string | null; lastMessageAt: Date | null; unreadCount: number | null }> = await prisma.chat
            .findMany({
                where: { deviceId: d, isGroup: true },
                select: { id: true, waChatId: true, name: true, lastMessageAt: true, unreadCount: true }
            })
            .catch(() => []);

        for (const r of rows) {
            const gid = String(r?.waChatId || '').trim();
            if (!gid.endsWith('@g.us')) continue;
            const metadata = await sock.groupMetadata(gid).catch(() => null);
            const subject = String((metadata as any)?.subject || '').trim();
            if (!subject) continue;

            const currentDbName = String(r?.name || '').trim();
            if (currentDbName !== subject) {
                await prisma.chat.update({ where: { id: String(r.id) }, data: { name: subject } }).catch(() => {});
            }

            const ts = r?.lastMessageAt ? new Date(r.lastMessageAt).getTime() : Date.now();
            const existing = store.chats.get(gid) || { id: gid, name: subject, conversationTimestamp: ts, unreadCount: Number(r?.unreadCount || 0) };
            existing.name = subject;
            store.chats.set(gid, existing);
            store.contacts.delete(gid);
            store.lastPushName.delete(gid);

            const deviceMap = this.groupSubjectFetchLastAt.get(d) || new Map<string, number>();
            deviceMap.set(gid, Date.now());
            this.groupSubjectFetchLastAt.set(d, deviceMap);
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
        void this.dbUpsertDeviceRecord(newDevice as any);
        return newDevice;
    }

    private updateDevice(id: string, data: Partial<Device>) {
        const index = this.devices.findIndex(d => d.id === id);
        if (index !== -1) {
            this.devices[index] = { ...this.devices[index]!, ...data };
            this.saveDevices();
            this.io?.emit('device:update', this.devices[index]);
            void this.dbUpsertDeviceRecord(this.devices[index] as any);
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

        const sticker = m?.stickerMessage;
        if (sticker) return 'Sticker';

        const normalizePhone = (raw: string) => {
            const s = String(raw || '').trim();
            if (!s) return '';
            const hasPlus = s.startsWith('+');
            const cleaned = s.replace(/^tel:/i, '').trim();
            const digits = cleaned.replace(/[^\d]/g, '');
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
                const isTel = /(^|[.;])TEL($|;)/.test(key) || key.startsWith('TEL');
                if (!isTel) continue;

                const phoneFromValue = normalizePhone(value);
                if (phoneFromValue && !phones.includes(phoneFromValue)) phones.push(phoneFromValue);

                const waidMatch = key.match(/WAID=([0-9]+)/i);
                if (waidMatch?.[1]) {
                    const waidPhone = normalizePhone(`+${waidMatch[1]}`);
                    if (waidPhone && !phones.includes(waidPhone)) phones.push(waidPhone);
                }
            }

            if (phones.length === 0) {
                const waidMatch = v.match(/WAID=([0-9]+)/i);
                if (waidMatch?.[1]) {
                    const waidPhone = normalizePhone(`+${waidMatch[1]}`);
                    if (waidPhone) phones.push(waidPhone);
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
        if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType || '')) return null;

        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: (sock: any) => sock.updateMediaMessage(msg) });
            const chatId_sanitized = msg.key.remoteJid.replace(/[^a-zA-Z0-9]/g, '_');
            const dir = path.join(this.storageRoot, deviceId, chatId_sanitized);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const rawMime = String(msg.message[messageType!].mimetype || (messageType === 'stickerMessage' ? 'image/webp' : ''));
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
                mimeType: cleanMime || msg.message[messageType!].mimetype,
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
            const isGroup = unifiedChatId.endsWith('@g.us');
            if (pushName && !fromMe && unifiedChatId && !isGroup) {
                store.contacts.set(unifiedChatId, pushName);
            }
            const groupSubject = isGroup ? String(store.chats.get(unifiedChatId)?.name || '').trim() : '';
            const contactName = isGroup ? null : (store.contacts.get(unifiedChatId) || store.contacts.get(chatId) || pushName || null);
            const chatName = isGroup
                ? (groupSubject || unifiedChatId.split('@')[0] + ' (Grupo)')
                : (String(contactName || '').trim() || unifiedChatId.split('@')[0]);

            const existingChat = store.chats.get(unifiedChatId) || {
                id: unifiedChatId,
                name: chatName,
                conversationTimestamp: timestamp,
                unreadCount: 0
            };
            if (!isGroup && contactName && existingChat.name !== contactName) {
                existingChat.name = String(contactName);
            }
            if (isGroup && groupSubject && existingChat.name !== groupSubject) {
                existingChat.name = groupSubject;
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

            // Persistencia en MySQL (si está configurado)
            const prisma = getPrisma();
            if (prisma) {
                const profilePhotoUrl = store.profilePhotos.get(unifiedChatId)?.url || null;
                void this.dbUpsertChatAndMessage({
                    deviceId,
                    waChatId: unifiedChatId,
                    waChatIdAliases: unifiedChatId !== chatId ? [chatId] : undefined,
                    chatName: String(existingChat?.name || chatName || '').trim() || null,
                    isGroup: unifiedChatId.endsWith('@g.us'),
                    unreadCount: Number(existingChat?.unreadCount || 0),
                    lastMessageAtMs: timestamp,
                    profilePhotoUrl,
                    waMessageId: msg?.key?.id || null,
                    fromMe,
                    source: 'whatsapp',
                    type: String(Object.keys(msg.message || {})[0] || 'text'),
                    text: text ?? null,
                    mediaPath: null,
                    rawJson: (() => {
                        try {
                            return JSON.stringify({ location: location || null });
                        } catch {
                            return null;
                        }
                    })()
                });
            }
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
        await this.dbBackfillChatAliasesForDevice(deviceId);
        await this.dbHydrateExplicitPeerMappingsFromAliases(deviceId, store);

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
                const s = stores.get(deviceId);
                if (s) void this.dbBackfillGroupSubjectsForDevice(deviceId, sock, s);
            }
        });

        sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
            const store = stores.get(deviceId);
            if (!store) return;
            const prisma = getPrisma();

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
                    const isGroup = id.endsWith('@g.us');
                    const baseName = isGroup ? String(ch?.name || '').trim() : String(ch?.name || store.contacts.get(id) || '').trim();
                    const name = baseName || id.split('@')[0];
                    const canonical = resolveCanonicalChatId(store, id);
                    if (canonical !== id) mergeChatData(store, id, canonical);
                    const existing = store.chats.get(canonical) || { id: canonical, name, conversationTimestamp: ts, unreadCount: 0 };
                    existing.name = existing.name || name;
                    existing.conversationTimestamp = Math.max(Number(existing.conversationTimestamp || 0), ts);
                    const unread = Number(ch?.unreadCount || 0);
                    if (Number.isFinite(unread) && unread > 0) existing.unreadCount = Math.max(Number(existing.unreadCount || 0), unread);
                    store.chats.set(canonical, existing);

                    // Persistir chat en MySQL aunque no haya mensajes nuevos
                    if (prisma) {
                        const profilePhotoUrl = store.profilePhotos.get(canonical)?.url || null;
                        void this.dbUpsertChatAndMessage({
                            deviceId,
                            waChatId: canonical,
                            waChatIdAliases: canonical !== id ? [id] : undefined,
                            chatName: String(existing?.name || name || '').trim() || null,
                            isGroup: canonical.endsWith('@g.us'),
                            unreadCount: Number(existing?.unreadCount || 0),
                            lastMessageAtMs: existing?.conversationTimestamp || ts,
                            profilePhotoUrl,
                            waMessageId: null,
                            fromMe: false,
                            source: 'whatsapp',
                            type: 'text',
                            text: null,
                            mediaPath: null,
                            rawJson: null
                        });
                    }
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

                    if (unifiedChatId !== chatId) {
                        mergeChatData(store, chatId, unifiedChatId);
                    }
                }

                const mediaMetadata = await this.handleMedia(deviceId, msg);

                let text = this.extractDisplayText(msg);
                if (msgType === 'stickerMessage') {
                    text = mediaMetadata ? null : (text || 'Sticker');
                }

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
                if (!fromMe) markIncomingMessage(deviceId, unifiedChatId, timestamp);

                // Obtener pushName (nombre del contacto en WhatsApp)
                const pushName = (msg as any).pushName || null;

                // Guardar en el store simple (store ya fue obtenido arriba)
                if (store) {
                    // Guardar pushName como nombre del contacto si existe
                    
                    // IMPORTANTE: Solo guardar pushName para el ID ORIGINAL del mensaje
                    // No para el unifiedChatId si son diferentes (evita mezclar nombres)
                    const isGroupChat = String(unifiedChatId || '').endsWith('@g.us');
                    const isOriginalGroup = String(originalChatId || '').endsWith('@g.us');

                    if (pushName && !msg.key.fromMe && originalChatId && !isOriginalGroup) {
                        const targetId = originalChatId; // Usar ID original, NO el unificado
                        const existingName = store.contacts.get(targetId);
                        const lastKnown = store.lastPushName.get(targetId);
                        
                        // Solo actualizar si no tenemos nombre o si el pushName cambió para este ID específico
                        if (!existingName || lastKnown !== pushName) {
                            store.contacts.set(targetId, pushName);
                            store.lastPushName.set(targetId, pushName);
                            
                            // Si el unificado es diferente y NO tiene nombre propio, también asignar
                            if (unifiedChatId !== originalChatId && !store.contacts.get(unifiedChatId) && !isGroupChat) {
                                store.contacts.set(unifiedChatId, pushName);
                            }
                            
                            console.log(`[${deviceId}] Contacto: ${targetId} -> ${pushName}`);
                        }
                        
                        // Mapeo bidireccional LID <-> Phone para consistencia futura
                        if (isLid(originalChatId) && !isLid(unifiedChatId)) {
                            registerLidPhoneMapping(store, originalChatId, unifiedChatId);
                        } else if (!isLid(originalChatId) && isLid(unifiedChatId)) {
                            registerLidPhoneMapping(store, unifiedChatId, originalChatId);
                        }
                    }

                    // Obtener nombre del contacto - priorizar el ID específico del chat
                    const groupContaminated = isGroupChat && (store.contacts.has(unifiedChatId) || store.lastPushName.has(unifiedChatId));
                    let groupSubject = isGroupChat && !groupContaminated ? String(store.chats.get(unifiedChatId)?.name || '').trim() : '';
                    const contactName = isGroupChat
                        ? null
                        : (store.contacts.get(unifiedChatId) || store.contacts.get(originalChatId) || pushName || null);

                    // Determinar el nombre del chat
                    let chatName: string;
                    if (isGroupChat) {
                        if (!groupSubject || groupContaminated) {
                            const fetched = await this.ensureGroupSubject(deviceId, unifiedChatId, sock, store, timestamp, true);
                            if (fetched) groupSubject = fetched;
                        }
                        chatName = groupSubject || String(unifiedChatId.split('@')[0] || unifiedChatId) + ' (Grupo)';
                    } else {
                        chatName = String(contactName || '').trim() || String(unifiedChatId.split('@')[0] || unifiedChatId);
                    }

                    // Actualizar/crear chat usando unifiedChatId
                    const existingChat = store.chats.get(unifiedChatId) || {
                        id: unifiedChatId,
                        name: chatName,
                        conversationTimestamp: timestamp,
                        unreadCount: 0
                    };
                    
                    // Actualizar nombre si encontramos uno mejor
                    if (!isGroupChat && contactName && existingChat.name !== contactName) {
                        existingChat.name = String(contactName);
                    }
                    if (isGroupChat && groupSubject && existingChat.name !== groupSubject) {
                        existingChat.name = groupSubject;
                    }
                    
                    existingChat.conversationTimestamp = timestamp;
                    if (!fromMe) existingChat.unreadCount++;
                    store.chats.set(unifiedChatId, existingChat);

                    // Guardar mensaje bajo el unifiedChatId
                    if (!store.messages.has(unifiedChatId)) {
                        store.messages.set(unifiedChatId, []);
                    }
                    
                    // Obtener senderName (pushName del remitente) para mensajes recibidos
                    const senderName = !fromMe ? (pushName || null) : null;
                    
                    const stored = {
                        key: msg.key,
                        message: msg.message,
                        messageTimestamp: msg.messageTimestamp,
                        text,
                        fromMe,
                        timestamp,
                        media: mediaMetadata,
                        location,
                        source,
                        senderName
                    };
                    store.messages.get(unifiedChatId)!.push(stored);
                    this.persistStoredMessage(deviceId, unifiedChatId, stored, existingChat?.name || chatName, contactName || null);

                    // Persistencia profesional en MySQL (si DATABASE_URL está configurado)
                    const profilePhotoUrl = store.profilePhotos.get(unifiedChatId)?.url || null;
                    void this.dbUpsertChatAndMessage({
                        deviceId,
                        waChatId: unifiedChatId,
                        waChatIdAliases: unifiedChatId !== originalChatId ? [originalChatId] : undefined,
                        chatName: String(existingChat?.name || chatName || '').trim() || null,
                        isGroup: unifiedChatId.endsWith('@g.us'),
                        unreadCount: Number(existingChat?.unreadCount || 0),
                        lastMessageAtMs: timestamp,
                        profilePhotoUrl,
                        waMessageId: msg.key.id || null,
                        fromMe,
                        source,
                        type: String(msgType || 'text'),
                        text: text ?? null,
                        mediaPath: mediaMetadata?.url || null,
                        rawJson: (() => {
                            try {
                                return JSON.stringify({ 
                                    media: mediaMetadata || null, 
                                    location: location || null,
                                    senderName: !fromMe ? (pushName || null) : null
                                });
                            } catch {
                                return null;
                            }
                        })()
                    });
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
                        source,
                        senderName: !fromMe ? (pushName || null) : null
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

    public async sendMessage(deviceId: string, chatId: string, text: string, quotedMessageId?: string) {
        const sock = this.sessions.get(deviceId);
        if (!sock) throw new Error('Device not connected');

        const store = stores.get(deviceId);
        const canonicalChatId = resolveCanonicalChatId(store, chatId);
        if (store && canonicalChatId !== chatId && store.chats.has(chatId)) {
            mergeChatData(store, chatId, canonicalChatId);
        }
        const targetJid = canonicalChatId;

        console.log(`[${deviceId}] Enviando mensaje a ${targetJid}: ${text.substring(0, 50)}...`);
        if (quotedMessageId) {
            console.log(`[${deviceId}] Con respuesta a mensaje: ${quotedMessageId}`);
        }

        try {
            this.rememberPanelSend(deviceId, targetJid, { text, timestamp: Date.now() });
            
            // Construir mensaje con posible quote
            const messageContent: any = { text };
            
            // Si hay quotedMessageId, buscar el mensaje original y agregar contextInfo
            if (quotedMessageId) {
                const originalMsg = this.findMessageById(deviceId, canonicalChatId, quotedMessageId);
                console.log(`[${deviceId}] Mensaje original encontrado:`, originalMsg ? 'SÍ' : 'NO');
                
                if (originalMsg && originalMsg.message) {
                    // Determinar el participante correcto
                    const participant = originalMsg.key?.participant || originalMsg.key?.remoteJid || targetJid;
                    
                    messageContent.contextInfo = {
                        quotedMessage: originalMsg.message,
                        stanzaId: quotedMessageId,
                        participant: participant
                    };
                    console.log(`[${deviceId}] contextInfo configurado - stanzaId: ${quotedMessageId}, participant: ${participant}`);
                } else if (originalMsg) {
                    // Si no tiene .message pero existe, intentar construir uno básico
                    console.log(`[${deviceId}] Mensaje encontrado pero sin .message, intentando con texto`);
                    if (originalMsg.text) {
                        messageContent.contextInfo = {
                            quotedMessage: { conversation: originalMsg.text },
                            stanzaId: quotedMessageId,
                            participant: originalMsg.key?.participant || originalMsg.key?.remoteJid || targetJid
                        };
                    }
                } else {
                    console.log(`[${deviceId}] No se encontró el mensaje original ${quotedMessageId} - enviando sin quote`);
                }
            }
            
            const result = await sock.sendMessage(targetJid, messageContent);
            const msgId = result?.key?.id as string | undefined;
            if (msgId) this.rememberPanelSend(deviceId, targetJid, { id: msgId, text, timestamp: Date.now() });
            console.log(`[${deviceId}] Mensaje enviado, result:`, result?.key);
            return result;
        } catch (error: any) {
            console.error(`[${deviceId}] Error enviando mensaje:`, error);
            throw error;
        }
    }
    
    // Buscar mensaje por ID en el store (memoria)
    private findMessageById(deviceId: string, chatId: string, messageId: string): any | null {
        const store = stores.get(deviceId);
        if (!store) {
            console.log(`[${deviceId}] findMessageById: store no encontrado`);
            return null;
        }
        
        // Buscar en el chatId dado
        let messages = store.messages.get(chatId) || [];
        console.log(`[${deviceId}] findMessageById: buscando ${messageId} en ${chatId} (${messages.length} mensajes)`);
        
        for (const msg of messages) {
            const id = msg.key?.id || msg.id;
            if (id === messageId) {
                console.log(`[${deviceId}] findMessageById: encontrado en ${chatId}`);
                return msg;
            }
        }
        
        // Si no se encontró, buscar en todos los chats (por si hay alias)
        for (const [cid, msgs] of store.messages.entries()) {
            if (cid === chatId) continue; // Ya lo buscamos
            for (const msg of msgs) {
                const id = msg.key?.id || msg.id;
                if (id === messageId) {
                    console.log(`[${deviceId}] findMessageById: encontrado en chat alternativo ${cid}`);
                    return msg;
                }
            }
        }
        
        console.log(`[${deviceId}] findMessageById: mensaje ${messageId} NO encontrado`);
        return null;
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

        // Usar canonicalId completo para evitar mezclar fotos
        const fileName = `${crypto.createHash('sha1').update(canonicalId).digest('hex')}.jpg`;
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
            const prisma = getPrisma();
            if (prisma) {
                // Obtener chats con su último mensaje
                let rows: any[] = [];
                try {
                    rows = await prisma.chat.findMany({
                        where: { deviceId },
                        orderBy: { lastMessageAt: 'desc' },
                        include: {
                            messages: {
                                orderBy: { timestamp: 'desc' },
                                take: 1,
                                select: {
                                    text: true,
                                    fromMe: true,
                                    type: true,
                                    mediaPath: true,
                                    rawJson: true
                                }
                            }
                        }
                    });
                } catch (dbError: any) {
                    console.error(`[${deviceId}] Error al obtener chats de DB:`, dbError.message);
                    // Si falla la DB, continuar con el store en memoria
                    rows = [];
                }
                
                if (rows.length > 0) {
                    // Función para extraer clave única de un chatId
                    const getChatKey = (id: string): string => {
                        if (!id) return '';
                        if (id.includes('@g.us')) return `g:${id}`;
                        if (String(id).endsWith('@lid')) return `lid:${id}`;
                        if (String(id).endsWith('@s.whatsapp.net')) {
                            const prefix = id.split('@')[0] || id;
                            const base = prefix.split(':')[0] || prefix;
                            return `p:${base}`;
                        }
                        return `o:${id}`;
                    };
                    
                    // Mapear los datos de Prisma
                    const mappedChats = rows.map((c: any) => {
                        const lastMsg = c.messages?.[0];
                        let lastMessageText: string | null = null;
                        let lastMessageType: string = 'text';
                        let lastMessageFromMe: boolean = false;
                        let lastMessageMedia: { mimeType?: string; duration?: number } | null = null;

                        if (lastMsg) {
                            lastMessageText = lastMsg.text;
                            lastMessageType = lastMsg.type || 'text';
                            lastMessageFromMe = Boolean(lastMsg.fromMe);
                            
                            // Extraer duración del audio si existe
                            if (lastMsg.rawJson) {
                                try {
                                    const raw = JSON.parse(lastMsg.rawJson);
                                    if (raw?.media?.mimeType) {
                                        lastMessageMedia = { mimeType: raw.media.mimeType };
                                        // Intentar extraer duración del audio
                                        if (raw.media.duration) {
                                            lastMessageMedia.duration = raw.media.duration;
                                        }
                                    }
                                } catch {}
                            }
                            
                            // Inferir tipo de media del path si no hay rawJson
                            if (!lastMessageMedia && lastMsg.mediaPath) {
                                const ext = String(lastMsg.mediaPath).split('.').pop()?.toLowerCase();
                                if (['ogg', 'mp3', 'wav', 'webm', 'm4a', 'opus'].includes(ext || '')) {
                                    lastMessageMedia = { mimeType: 'audio/' + ext };
                                } else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '')) {
                                    lastMessageMedia = { mimeType: 'image/' + ext };
                                } else if (['mp4', 'mov', 'avi', 'mkv'].includes(ext || '')) {
                                    lastMessageMedia = { mimeType: 'video/' + ext };
                                }
                            }
                        }

                        const customName = (c as any).customName || null;
                        const isGroup = Boolean(c.isGroup);
                        const displayName = isGroup
                            ? (String(c.name || '').trim() || c.waChatId.split('@')[0] + ' (Grupo)')
                            : (customName ? String(customName).trim() : (String(c.name || '').trim() || c.waChatId.split('@')[0]));
                        
                        const lastMessageTime = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : Date.now();
                        
                        return {
                            id: c.waChatId,
                            name: displayName,
                            originalName: c.name || null,
                            customName: customName,
                            lastMessageTime,
                            unreadCount: Number(c.unreadCount || 0),
                            isGroup: Boolean(c.isGroup),
                            profilePhotoUrl: c.profilePhotoUrl || null,
                            lastMessage: lastMessageText,
                            lastMessageType,
                            lastMessageFromMe,
                            lastMessageMedia
                        };
                    });
                    
                    // ========== LOGGING DETALLADO PARA DIAGNÓSTICO ==========
                    console.log(`[${deviceId}] === ANÁLISIS DE CHATS ===`);
                    for (const chat of mappedChats) {
                        const key = getChatKey(chat.id);
                        console.log(`[${deviceId}]   ID: ${chat.id} | Key: ${key} | Name: "${chat.name}"`);
                    }
                    
                    // ========== PASO 1: DEDUPLICACIÓN POR ID ==========
                    // La DB puede tener múltiples registros del mismo contacto
                    // (ej: 123456@s.whatsapp.net y 123456:0@lid)
                    const seenKeys = new Map<string, typeof mappedChats[0]>();
                    
                    for (const chat of mappedChats) {
                        const key = getChatKey(chat.id);
                        const existing = seenKeys.get(key);
                        
                        if (existing) {
                            console.log(`[${deviceId}] Duplicado por ID detectado: ${chat.id} vs ${existing.id}`);
                            
                            // Preservar el customName si alguno lo tiene
                            const mergedCustomName = existing.customName || chat.customName || null;
                            
                            // Elegir el registro más reciente como base
                            let winner = chat.lastMessageTime > existing.lastMessageTime ? chat : existing;
                            let loser = chat.lastMessageTime > existing.lastMessageTime ? existing : chat;
                            
                            // Si el loser tiene mejor nombre y el winner no, combinar
                            const winnerHasRealName = winner.name && !/^\d+$/.test(winner.name);
                            const loserHasRealName = loser.name && !/^\d+$/.test(loser.name);
                            
                            if (loserHasRealName && !winnerHasRealName) {
                                winner = { ...winner, name: loser.name, originalName: loser.originalName };
                            }
                            
                            // SIEMPRE preservar el customName
                            if (mergedCustomName) {
                                winner = { ...winner, customName: mergedCustomName, name: mergedCustomName };
                            }
                            
                            seenKeys.set(key, winner);
                        } else {
                            seenKeys.set(key, chat);
                        }
                    }
                    
                    const deduplicatedById = Array.from(seenKeys.values());
                    console.log(`[${deviceId}] Paso 1 - Por ID: ${mappedChats.length} -> ${deduplicatedById.length}`);
                    
                    // ========== PASO 2: DEDUPLICACIÓN POR CUSTOMNAME ==========
                    // Si el usuario renombró dos chats con el MISMO nombre personalizado,
                    // son el mismo contacto (pueden tener IDs completamente diferentes)
                    const seenCustomNames = new Map<string, typeof mappedChats[0]>();
                    const finalChats: typeof mappedChats = [];
                    
                    for (const chat of deduplicatedById) {
                        // Solo deduplicar si tiene customName (nombre personalizado por el usuario)
                        if (chat.customName) {
                            const normalizedCustomName = chat.customName.toLowerCase().trim();
                            const existing = seenCustomNames.get(normalizedCustomName);
                            
                            if (existing) {
                                console.log(`[${deviceId}] Duplicado por customName detectado: "${chat.customName}" (${chat.id}) vs (${existing.id})`);
                                // Mantener el más reciente
                                if (chat.lastMessageTime > existing.lastMessageTime) {
                                    seenCustomNames.set(normalizedCustomName, chat);
                                }
                            } else {
                                seenCustomNames.set(normalizedCustomName, chat);
                            }
                        } else {
                            // Sin customName, agregar directamente
                            finalChats.push(chat);
                        }
                    }
                    
                    // Combinar: chats sin customName + chats con customName deduplicados
                    const deduplicatedFromDB = [...finalChats, ...Array.from(seenCustomNames.values())]
                        .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
                    
                    console.log(`[${deviceId}] Paso 2 - Por customName: ${deduplicatedById.length} -> ${deduplicatedFromDB.length}`);
                    return deduplicatedFromDB;
                }
            }

            // Obtener store del dispositivo (fallback si no hay DB o está vacía)
            const store = stores.get(deviceId);
            if (!store) {
                console.log(`[${deviceId}] Store no encontrado, devolviendo lista vacía`);
                return [];
            }

            const groupIds = Array.from(store.chats.keys()).filter((id) => String(id || '').endsWith('@g.us'));
            for (const gid of groupIds) {
                const ts = Number(store.chats.get(gid)?.conversationTimestamp || Date.now());
                await this.ensureGroupSubject(deviceId, gid, sock, store, ts, true);
            }

            // Obtener todos los chats almacenados
            const chats = Array.from(store.chats.values());
            console.log(`[${deviceId}] Chats encontrados en store: ${chats.length}`);

            // IMPORTANTE: NO fusionar chats agresivamente - cada chat mantiene su identidad
            const result = chats.map(chat => {
                const chatId = String(chat?.id || '');
                if (!chatId) return null;
                
                const ts = Number(chat?.conversationTimestamp || 0);
                const unread = Number(chat?.unreadCount || 0);
                
                // Obtener nombre SOLO del contacto específico de este chat
                // NO buscar en otros IDs para evitar mezcla de nombres
                const chatName = String(chat?.name || '').trim();
                const isGroup = chatId.endsWith('@g.us');
                const contactName = isGroup ? null : store.contacts.get(chatId);
                
                // Prioridad: contactName del ID específico > nombre del chat > ID limpio
                const displayName = isGroup
                    ? (chatName || String(chatId.split('@')[0] || chatId) + ' (Grupo)')
                    : (String(contactName || '').trim() || chatName || String(chatId.split('@')[0] || chatId));
                const lastMessageTime = ts || Date.now();
                const profilePhotoUrl = store.profilePhotos.get(chatId)?.url || null;
                
                // Obtener último mensaje del store
                const chatMessages = store.messages.get(chatId) || [];
                const lastMsg = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;
                
                let lastMessage: string | null = null;
                let lastMessageType: string = 'text';
                let lastMessageFromMe: boolean = false;
                let lastMessageMedia: { mimeType?: string; duration?: number } | null = null;
                
                if (lastMsg) {
                    lastMessage = lastMsg.text || null;
                    lastMessageFromMe = Boolean(lastMsg.fromMe);
                    
                    if (lastMsg.media) {
                        lastMessageType = lastMsg.media.mimeType?.split('/')[0] || 'file';
                        lastMessageMedia = { 
                            mimeType: lastMsg.media.mimeType,
                            duration: lastMsg.media.duration
                        };
                    }
                }
                
                return {
                    id: chatId,
                    name: displayName,
                    lastMessageTime,
                    unreadCount: unread || 0,
                    isGroup: chatId.endsWith('@g.us'),
                    profilePhotoUrl,
                    lastMessage,
                    lastMessageType,
                    lastMessageFromMe,
                    lastMessageMedia
                };
            }).filter((c): c is NonNullable<typeof c> => c !== null); // Eliminar nulls con type guard

            // DEDUPLICACIÓN: eliminar chats duplicados basándose en el número de teléfono
            // Mantener el más reciente de cada número
            const getChatKey = (id: string): string => {
                if (!id) return '';
                if (id.includes('@g.us')) return `g:${id}`;
                if (String(id).endsWith('@lid')) return `lid:${id}`;
                if (String(id).endsWith('@s.whatsapp.net')) {
                    const prefix = id.split('@')[0] || id;
                    const base = prefix.split(':')[0] || prefix;
                    return `p:${base}`;
                }
                return `o:${id}`;
            };
            
            const seenKeys = new Map<string, typeof result[0]>();
            for (const chat of result) {
                const key = getChatKey(chat.id);
                const existing = seenKeys.get(key);
                
                // Si ya existe uno, mantener el más reciente con el mejor nombre
                if (existing) {
                    const existingHasRealName = existing.name && !/^\d+$/.test(existing.name);
                    const chatHasRealName = chat.name && !/^\d+$/.test(chat.name);
                    
                    if (chat.lastMessageTime > existing.lastMessageTime) {
                        // El nuevo es más reciente
                        if (existingHasRealName && !chatHasRealName) {
                            // Pero el existente tiene mejor nombre, combinar
                            seenKeys.set(key, { ...chat, name: existing.name });
                        } else {
                            seenKeys.set(key, chat);
                        }
                    } else if (chatHasRealName && !existingHasRealName) {
                        // El existente es más reciente pero el nuevo tiene mejor nombre
                        seenKeys.set(key, { ...existing, name: chat.name });
                    }
                    // Si no cambiamos nada, existing se mantiene
                } else {
                    seenKeys.set(key, chat);
                }
            }
            
            const deduplicated = Array.from(seenKeys.values());
            const sorted = deduplicated.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
            for (const chat of sorted.slice(0, 15)) {
                if (chat.isGroup) continue;
                if (chat.profilePhotoUrl) continue;
                this.scheduleProfilePhotoFetch(deviceId, chat.id);
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
                const prisma = getPrisma();
                if (prisma) {
                    void (async () => {
                        const row = await this.dbResolveChatForWaChatId(prisma as any, deviceId, canonicalId);
                        if (!row?.id) return;
                        await prisma.chat.update({ where: { id: String(row.id) }, data: { unreadCount: 0 } }).catch(() => {});
                    })();
                }
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
        const prisma = getPrisma();

        try {
            // 1. Eliminar de WhatsApp (limpiar historial)
            // clear: solo limpia mensajes
            // delete: elimina el chat de la lista
            await sock.chatModify({ delete: true, lastMessages: [] }, canonicalId);

            // 1.5 Eliminar en MySQL (si aplica)
            if (prisma) {
                const row = await this.dbResolveChatForWaChatId(prisma as any, deviceId, canonicalId);
                if (row?.id) {
                    await prisma.chat.delete({ where: { id: String(row.id) } }).catch(() => {});
                }
            }

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
            if (prisma) {
                const row = await this.dbResolveChatForWaChatId(prisma as any, deviceId, canonicalId);
                if (row?.id) {
                    await prisma.chat.delete({ where: { id: String(row.id) } }).catch(() => {});
                }
            }
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
            const prisma = getPrisma();
            if (prisma) {
                const storeForCanonical = stores.get(deviceId);
                const canonicalId = storeForCanonical ? resolveCanonicalChatId(storeForCanonical, chatId) : chatId;
                const chatRow = (await this.dbResolveChatForWaChatId(prisma as any, deviceId, canonicalId)) ||
                    (canonicalId !== chatId ? await this.dbResolveChatForWaChatId(prisma as any, deviceId, chatId) : null);
                if (!chatRow?.id) return [];

                const take = Math.max(1, Math.min(500, Math.floor(Number(limit || 50))));
                const msgs = await prisma.message.findMany({
                    where: { deviceId, chatId: String(chatRow.id) },
                    orderBy: { timestamp: 'desc' },
                    take
                });

                return msgs
                    .slice()
                    .reverse()
                    .map((m: any) => {
                        let parsed: any = null;
                        try {
                            parsed = m.rawJson ? JSON.parse(m.rawJson) : null;
                        } catch {
                            parsed = null;
                        }
                        const media = parsed?.media || null;
                        const location = parsed?.location || null;
                        const senderName = parsed?.senderName || null;
                        return {
                            id: m.waMessageId,
                            text: m.text ?? null,
                            fromMe: Boolean(m.fromMe),
                            timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
                            source: (m.source as any) || (m.fromMe ? 'phone' : 'contact'),
                            media,
                            location,
                            senderName
                        };
                    });
            }

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
                    text: (() => {
                        const computed = this.extractDisplayText(msg);
                        const hasContact = Boolean(msg?.message?.contactMessage || msg?.message?.contactsArrayMessage);
                        const hasSticker = Boolean(msg?.message?.stickerMessage);
                        if (hasContact || hasSticker) return computed || msg.text || (location ? null : (msg.media ? null : '[Media]'));
                        return msg.text || computed || (location ? null : (msg.media ? null : '[Media]'));
                    })(),
                    fromMe: msg.fromMe ?? msg.key?.fromMe,
                    timestamp: msg.timestamp || (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()),
                    source: msg.source || ((msg.fromMe ?? msg.key?.fromMe) ? 'phone' : 'contact'),
                    media: msg.media || null,
                    location,
                    senderName: msg.senderName || null
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

    // ========== RENOMBRAR CONTACTOS ==========
    
    public async renameChat(deviceId: string, chatId: string, customName: string | null) {
        const store = stores.get(deviceId);
        const canonicalChatId = resolveCanonicalChatId(store, chatId);
        const stableKeyOf = (id: string) => {
            const s = String(id || '').trim();
            if (!s) return '';
            if (s.endsWith('@g.us')) return `g:${s}`;
            if (s.endsWith('@lid')) return `lid:${s}`;
            if (s.endsWith('@s.whatsapp.net')) return `p:${chatKeyOf(s)}`;
            return `o:${s}`;
        };
        
        // Intentar actualizar en la base de datos si está disponible
        const prisma = getPrisma();
        if (prisma) {
            try {
                const resolved = await this.dbResolveChatForWaChatId(prisma as any, deviceId, canonicalChatId);
                const canonicalDbId = String(resolved?.waChatId || canonicalChatId);
                const chatKey = stableKeyOf(canonicalDbId);

                // Buscar TODOS los chats del dispositivo
                const allChats = await prisma.chat.findMany({
                    where: { deviceId },
                    select: { id: true, waChatId: true, customName: true, lastMessageAt: true },
                    orderBy: { lastMessageAt: 'desc' }
                });
                
                // 1. Encontrar registros con el mismo número base
                const relatedByKey = allChats.filter((c) => stableKeyOf(c.waChatId) === chatKey);
                
                // 2. Si estamos poniendo un customName, buscar otros chats que YA tienen ese customName
                //    (para fusionarlos - eliminar los duplicados)
                const normalizedNewName = customName ? customName.toLowerCase().trim() : null;
                const duplicatesByName = normalizedNewName 
                    ? allChats.filter(c => 
                        c.customName && 
                        c.customName.toLowerCase().trim() === normalizedNewName &&
                        stableKeyOf(c.waChatId) !== chatKey
                    )
                    : [];
                
                console.log(`[${deviceId}] Rename: key="${chatKey}", relacionados=${relatedByKey.length}, duplicados por nombre=${duplicatesByName.length}`);
                
                // 3. Actualizar todos los registros relacionados por key
                if (relatedByKey.length > 0) {
                    await prisma.chat.updateMany({
                        where: { 
                            deviceId,
                            waChatId: { in: relatedByKey.map(c => c.waChatId) }
                        },
                        data: {
                            customName: customName ? customName.trim() : null
                        }
                    });
                }
                
                // 4. Eliminar duplicados por nombre (mantener solo el más reciente, que es el que estamos renombrando)
                if (duplicatesByName.length > 0) {
                    console.log(`[${deviceId}] Eliminando ${duplicatesByName.length} chats duplicados con nombre "${customName}"`);
                    for (const dup of duplicatesByName) {
                        try {
                            // Primero eliminar mensajes
                            await prisma.message.deleteMany({ where: { chatId: dup.id } });
                            // Luego eliminar el chat
                            await prisma.chat.delete({ where: { id: dup.id } });
                            console.log(`[${deviceId}] Eliminado duplicado: ${dup.waChatId}`);
                        } catch (err) {
                            console.warn(`[${deviceId}] Error eliminando duplicado ${dup.waChatId}:`, err);
                        }
                    }
                }
            } catch (dbError: any) {
                console.warn(`[${deviceId}] No se pudo guardar customName en DB:`, dbError.message);
                // Fallback: intentar actualizar solo el canonicalChatId
                try {
                    const resolved = await this.dbResolveChatForWaChatId(prisma as any, deviceId, canonicalChatId);
                    if (resolved?.id) {
                        await prisma.chat.update({
                            where: { id: String(resolved.id) },
                            data: { customName: customName ? customName.trim() : null }
                        });
                    }
                } catch {}
            }
        }
        
        // SIEMPRE actualizar en el store de memoria
        if (store) {
            // Guardar el nombre personalizado en el store de contactos
            if (customName) {
                store.contacts.set(canonicalChatId, customName.trim());
            }
        }
        
        console.log(`[${deviceId}] Chat ${canonicalChatId} renombrado a: ${customName || '(sin nombre personalizado)'}`);
        
        return { 
            chatId: canonicalChatId, 
            customName: customName ? customName.trim() : null 
        };
    }

    // ========== BÚSQUEDA DE MENSAJES ==========

    public async searchMessages(deviceId: string, query: string, options?: {
        chatId?: string;
        limit?: number;
        fromMe?: boolean;
    }) {
        const prisma = getPrisma();
        if (prisma) {
            const q = String(query || '').trim();
            if (!q) return [];

            const take = Math.max(1, Math.min(200, Math.floor(Number(options?.limit || 50))));
            const fromMeFilter = typeof options?.fromMe === 'boolean' ? options.fromMe : undefined;

            const storeForCanonical = stores.get(deviceId);
            const canonicalChatId = options?.chatId
                ? (storeForCanonical ? resolveCanonicalChatId(storeForCanonical, options.chatId) : options.chatId)
                : null;
            const chatRow = canonicalChatId
                ? ((await this.dbResolveChatForWaChatId(prisma as any, deviceId, canonicalChatId)) ||
                    (options?.chatId && options.chatId !== canonicalChatId ? await this.dbResolveChatForWaChatId(prisma as any, deviceId, options.chatId) : null))
                : null;

            const msgs = await prisma.message.findMany({
                where: {
                    deviceId,
                    ...(chatRow?.id ? { chatId: String(chatRow.id) } : {}),
                    ...(fromMeFilter === undefined ? {} : { fromMe: fromMeFilter }),
                    text: { contains: q }
                },
                orderBy: { timestamp: 'desc' },
                take,
                include: { chat: { select: { waChatId: true, name: true } } }
            });

            return msgs.map((m: any) => {
                const waChatId = m.chat?.waChatId || (chatRow?.waChatId ?? '');
                const chatName = String(m.chat?.name || chatRow?.name || '').trim() || waChatId.split('@')[0];
                const text = String(m.text || '');
                return {
                    id: m.waMessageId,
                    chatId: waChatId,
                    chatName,
                    text,
                    fromMe: Boolean(m.fromMe),
                    timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
                    matchHighlight: this.highlightMatch(text, q)
                };
            });
        }

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

    // Reset completo del cache de un dispositivo (mantiene sesión de WhatsApp)
    public async resetDeviceCache(deviceId: string): Promise<{ success: boolean; message: string }> {
        try {
            console.log(`[${deviceId}] Iniciando reset de cache...`);

            // 1. Limpiar store en memoria
            const store = stores.get(deviceId);
            if (store) {
                store.chats.clear();
                store.messages.clear();
                store.contacts.clear();
                store.aliases.clear();
                store.canonicalByKey.clear();
                store.profilePhotos.clear();
                store.lidToPhone.clear();
                store.phoneToLid.clear();
                store.lastPushName.clear();
                console.log(`[${deviceId}] Store en memoria limpiado`);
            }

            // 2. Limpiar datos en base de datos (si está configurada)
            const prisma = getPrisma();
            if (prisma) {
                // Eliminar mensajes del dispositivo
                await prisma.message.deleteMany({ where: { deviceId } });
                // Eliminar chats del dispositivo
                await prisma.chat.deleteMany({ where: { deviceId } });
                console.log(`[${deviceId}] Datos de DB limpiados`);
            }

            // 3. Limpiar archivos de disco (mensajes persistidos)
            const msgsDir = dbPath('messages');
            const deviceMsgsFile = path.join(msgsDir, `${deviceId}.ndjson`);
            if (fs.existsSync(deviceMsgsFile)) {
                fs.unlinkSync(deviceMsgsFile);
                console.log(`[${deviceId}] Archivo de mensajes eliminado`);
            }

            // 4. Limpiar avatares del dispositivo
            const avatarsDir = dbPath('storage', 'avatars');
            if (fs.existsSync(avatarsDir)) {
                // Solo limpiar si la carpeta existe
                console.log(`[${deviceId}] Carpeta de avatares disponible para limpieza`);
            }

            // 5. Emitir evento de actualización
            this.io?.emit('device:cache:reset', { deviceId });

            console.log(`[${deviceId}] Reset de cache completado`);
            return { success: true, message: 'Cache reseteado correctamente. Los chats se recargarán con los datos correctos.' };
        } catch (error: any) {
            console.error(`[${deviceId}] Error en reset de cache:`, error);
            return { success: false, message: error.message || 'Error al resetear cache' };
        }
    }
}
