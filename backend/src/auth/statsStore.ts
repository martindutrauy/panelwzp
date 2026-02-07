import { dbPath } from '../config/paths';
import { atomicWriteJson, safeReadJson } from './storage';
import { loadSessionsFile } from './sessionStore';
import { listUsers } from './userStore';
import { getOwnerUser } from './ownerStore';

type UserStats = {
    v: 1;
    messagesSent: number;
    quickRepliesUsed: number;
    responseSamples: number;
    responseTotalMs: number;
    updatedAt: number;
};

type StatsFile = {
    v: 1;
    users: Record<string, UserStats>;
};

const STATS_FILE = dbPath('security', 'stats.json');

const lastIncomingByChat = new Map<string, number>();

const getKey = (deviceId: string, chatId: string) => `${deviceId}::${chatId}`;

const readStatsFile = (): StatsFile => {
    const parsed = safeReadJson<StatsFile>(STATS_FILE);
    if (!parsed || parsed.v !== 1 || typeof parsed.users !== 'object' || !parsed.users) return { v: 1, users: {} };
    return parsed;
};

const getOrCreateUserStats = (file: StatsFile, userId: string): UserStats => {
    const existing = file.users[userId];
    if (existing?.v === 1) return existing;
    const created: UserStats = { v: 1, messagesSent: 0, quickRepliesUsed: 0, responseSamples: 0, responseTotalMs: 0, updatedAt: Date.now() };
    file.users[userId] = created;
    return created;
};

const writeStatsFile = (file: StatsFile) => {
    atomicWriteJson(STATS_FILE, file);
};

export const markIncomingMessage = (deviceId: string, chatId: string, atMs: number) => {
    if (!deviceId || !chatId) return;
    const at = Number(atMs);
    if (!Number.isFinite(at) || at <= 0) return;
    lastIncomingByChat.set(getKey(deviceId, chatId), at);
};

export const recordOutgoingMessage = (userId: string, deviceId: string, chatId: string, atMs: number) => {
    const uid = String(userId || '').trim();
    if (!uid) return;
    const file = readStatsFile();
    const u = getOrCreateUserStats(file, uid);
    u.messagesSent += 1;

    const at = Number(atMs);
    const key = getKey(deviceId, chatId);
    const lastIncoming = lastIncomingByChat.get(key);
    if (Number.isFinite(at) && Number.isFinite(lastIncoming)) {
        const delta = at - (lastIncoming as number);
        if (delta >= 0 && delta <= 6 * 60 * 60 * 1000) {
            u.responseSamples += 1;
            u.responseTotalMs += delta;
            lastIncomingByChat.delete(key);
        }
    }

    u.updatedAt = Date.now();
    writeStatsFile(file);
};

export const recordQuickReplyUse = (userId: string) => {
    const uid = String(userId || '').trim();
    if (!uid) return;
    const file = readStatsFile();
    const u = getOrCreateUserStats(file, uid);
    u.quickRepliesUsed += 1;
    u.updatedAt = Date.now();
    writeStatsFile(file);
};

export const getUserStatsSnapshot = () => {
    const file = readStatsFile();
    return file.users;
};

export const computeConnectionStats = (nowMs: number = Date.now()) => {
    const sessions = loadSessionsFile().sessions;
    const byUser: Record<string, { activeSessions: number; connectedMsTotal: number; connectedMsCurrent: number; lastSeenAt: number }> = {};
    for (const s of sessions) {
        const uid = String(s.userId || '').trim();
        if (!uid) continue;
        if (!byUser[uid]) byUser[uid] = { activeSessions: 0, connectedMsTotal: 0, connectedMsCurrent: 0, lastSeenAt: 0 };
        const item = byUser[uid]!;
        const start = Number(s.createdAt) || 0;
        const end = s.revokedAt ? Number(s.revokedAt) : nowMs;
        const dur = Math.max(0, end - start);
        item.connectedMsTotal += dur;
        if (!s.revokedAt) {
            item.activeSessions += 1;
            item.connectedMsCurrent += dur;
        }
        item.lastSeenAt = Math.max(item.lastSeenAt, Number(s.lastSeenAt) || 0);
    }
    return byUser;
};

export const buildUserStatsTable = (opts: { includeOwner: boolean }) => {
    const users = opts.includeOwner ? [getOwnerUser(), ...listUsers()] : listUsers();
    const stats = getUserStatsSnapshot();
    const conn = computeConnectionStats();
    const rows = users
        .map((u) => {
            const s = stats[u.id];
            const c = conn[u.id];
            const responseAvgMs = s && s.responseSamples > 0 ? Math.round(s.responseTotalMs / s.responseSamples) : null;
            return {
                id: u.id,
                username: u.username,
                email: u.email,
                role: u.role,
                disabled: u.disabled,
                messagesSent: s?.messagesSent ?? 0,
                quickRepliesUsed: s?.quickRepliesUsed ?? 0,
                responseAvgMs,
                responseSamples: s?.responseSamples ?? 0,
                connectedMsTotal: c?.connectedMsTotal ?? 0,
                connectedMsCurrent: c?.connectedMsCurrent ?? 0,
                activeSessions: c?.activeSessions ?? 0,
                lastSeenAt: c?.lastSeenAt ?? 0
            };
        });
    return rows.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
};
