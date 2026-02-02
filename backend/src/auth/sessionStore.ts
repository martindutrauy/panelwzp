import crypto from 'crypto';
import { dbPath } from '../config/paths';
import { atomicWriteJson, safeReadJson } from './storage';
import type { AppSession, SessionsFile } from './types';

const SESSIONS_FILE = dbPath('security', 'sessions.json');

const sanitize = (s: AppSession): AppSession => ({
    v: 1,
    id: String(s.id || ''),
    userId: String(s.userId || ''),
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
    lastSeenAt: typeof s.lastSeenAt === 'number' ? s.lastSeenAt : Date.now(),
    ip: s.ip ? String(s.ip) : null,
    userAgent: s.userAgent ? String(s.userAgent) : null,
    revokedAt: typeof s.revokedAt === 'number' ? s.revokedAt : null,
    revokedBy: s.revokedBy ? String(s.revokedBy) : null,
    reason: s.reason ? String(s.reason) : null
});

export const loadSessionsFile = (): SessionsFile => {
    const parsed = safeReadJson<SessionsFile>(SESSIONS_FILE);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.sessions)) return { v: 1, sessions: [] };
    const sessions = parsed.sessions.map(sanitize).filter((s) => s.id && s.userId);
    return { v: 1, sessions };
};

export const saveSessionsFile = (file: SessionsFile) => {
    atomicWriteJson(SESSIONS_FILE, file);
};

export const createSession = (userId: string, ip: string | null, userAgent: string | null) => {
    const { sessions } = loadSessionsFile();
    const now = Date.now();
    const s: AppSession = {
        v: 1,
        id: crypto.randomBytes(18).toString('hex'),
        userId: String(userId || ''),
        createdAt: now,
        lastSeenAt: now,
        ip: ip ? String(ip) : null,
        userAgent: userAgent ? String(userAgent) : null,
        revokedAt: null,
        revokedBy: null,
        reason: null
    };
    saveSessionsFile({ v: 1, sessions: [...sessions, s] });
    return s;
};

export const listSessions = (filterUserId?: string | null) => {
    const { sessions } = loadSessionsFile();
    const uid = filterUserId ? String(filterUserId).trim() : '';
    const items = uid ? sessions.filter((s) => s.userId === uid) : sessions;
    return items.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
};

export const findSession = (sessionId: string) => {
    const { sessions } = loadSessionsFile();
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    return sessions.find((s) => s.id === sid) || null;
};

export const touchSession = (sessionId: string, at: number = Date.now()) => {
    const { sessions } = loadSessionsFile();
    const sid = String(sessionId || '').trim();
    const next = sessions.map((s) => (s.id === sid ? { ...s, lastSeenAt: at } : s));
    saveSessionsFile({ v: 1, sessions: next });
};

export const revokeSession = (sessionId: string, actorUserId: string | null, reason: string | null) => {
    const { sessions } = loadSessionsFile();
    const sid = String(sessionId || '').trim();
    const now = Date.now();
    const next = sessions.map((s) => {
        if (s.id !== sid) return s;
        if (s.revokedAt) return s;
        return { ...s, revokedAt: now, revokedBy: actorUserId ? String(actorUserId) : null, reason: reason ? String(reason) : null };
    });
    saveSessionsFile({ v: 1, sessions: next });
    return next.find((s) => s.id === sid) || null;
};

export const revokeAllSessionsForUser = (userId: string, actorUserId: string | null, reason: string | null) => {
    const { sessions } = loadSessionsFile();
    const uid = String(userId || '').trim();
    const now = Date.now();
    const next = sessions.map((s) => {
        if (s.userId !== uid) return s;
        if (s.revokedAt) return s;
        return { ...s, revokedAt: now, revokedBy: actorUserId ? String(actorUserId) : null, reason: reason ? String(reason) : null };
    });
    saveSessionsFile({ v: 1, sessions: next });
};

export const revokeAllSessions = (actorUserId: string | null, reason: string | null) => {
    const { sessions } = loadSessionsFile();
    const now = Date.now();
    const next = sessions.map((s) => (s.revokedAt ? s : { ...s, revokedAt: now, revokedBy: actorUserId ? String(actorUserId) : null, reason: reason ? String(reason) : null }));
    saveSessionsFile({ v: 1, sessions: next });
};

export const revokeAllSessionsExcept = (keepSessionId: string, actorUserId: string | null, reason: string | null) => {
    const { sessions } = loadSessionsFile();
    const keep = String(keepSessionId || '').trim();
    const now = Date.now();
    const next = sessions.map((s) => {
        if (s.revokedAt) return s;
        if (keep && s.id === keep) return s;
        return { ...s, revokedAt: now, revokedBy: actorUserId ? String(actorUserId) : null, reason: reason ? String(reason) : null };
    });
    saveSessionsFile({ v: 1, sessions: next });
};
