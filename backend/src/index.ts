import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors, { type CorsOptions } from 'cors';
import multer from 'multer';
import { DeviceManager } from './manager/DeviceManager';
import { TemplateManager } from './manager/TemplateManager';
import { LabelManager } from './manager/LabelManager';
import { exportToJSON, exportToCSV, exportToTXT } from './utils/export';
import path from 'path';
import fs from 'fs';
import { DB_ROOT } from './config/paths';
import { ensureDir } from './config/ensureDir';
import { assertDatabaseConfigured } from './db/prisma';
import { requireAuth } from './auth/middleware';
import { audit, requireRoleAtLeast } from './auth/middleware';
import { createSession, findSession, listSessions, revokeAllSessions, revokeAllSessionsExcept, revokeAllSessionsForUser, revokeSession } from './auth/sessionStore';
import { signAuthToken, verifyAuthToken } from './auth/authToken';
import { getOwnerPassword, getOwnerUser, isOwnerUsername, loadOwnerState, setEmergencyLock } from './auth/ownerStore';
import { createUser, deleteUser, findUserById, findUserByLogin, getUserPublic, listUsers, rotateUserTokenVersion, setUserDisabled, setUserPasswordHash, setUserRole } from './auth/userStore';
import { hashPassword, validatePasswordPolicy, verifyPassword } from './auth/passwords';
import { appendAuditEvent, readAuditTail } from './auth/auditLog';
import { buildUserStatsTable, recordOutgoingMessage, recordQuickReplyUse } from './auth/statsStore';

const normalizeOrigin = (origin: string) => origin.trim().replace(/\/+$/, '');

const parseAllowedOrigins = (): string[] | '*' | null => {
    const raw = String(process.env.APP_CORS_ORIGINS || '').trim();
    if (!raw) return null;
    if (raw === '*') return '*';
    const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalizeOrigin);
    return Array.from(new Set(parts));
};

const allowedOrigins = parseAllowedOrigins();
const isOriginAllowed = (origin: string | undefined) => {
    if (allowedOrigins === '*' || !allowedOrigins) return true;
    if (!origin) return true; // same-origin / server-to-server / non-browser
    const o = normalizeOrigin(origin);
    return (allowedOrigins as string[]).includes(o);
};

const corsOptions: CorsOptions = {
    origin: (origin, cb) => {
        if (isOriginAllowed(origin || undefined)) return cb(null, true);
        return cb(new Error('CORS_NOT_ALLOWED'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: (origin, cb) => {
            if (isOriginAllowed(origin || undefined)) return cb(null, true);
            return cb(new Error('CORS_NOT_ALLOWED'), false);
        },
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }
});

const notifyOwner = (event: any) => {
    try {
        io.to('role:OWNER').emit('security:event', event);
    } catch {}
};

const deviceManager = DeviceManager.getInstance();
const templateManager = TemplateManager.getInstance();
const labelManager = LabelManager.getInstance();
deviceManager.setIO(io);

// Configuración de multer para manejo de archivos
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100 MB máximo
});

// Fail-fast: si falta DATABASE_URL en producción, abortar con un error claro.
assertDatabaseConfigured();

app.use(cors(corsOptions));
// Express v5 + path-to-regexp no acepta '*' como ruta
app.options(/.*/, cors(corsOptions));
app.use(express.json());
ensureDir(DB_ROOT);
app.use('/storage', express.static(path.join(DB_ROOT, 'storage')));

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        const login = String(username || '').trim();
        const pass = String(password || '');
        if (!login || !pass) return res.status(400).json({ error: 'Credenciales inválidas' });

        const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() || (req.socket?.remoteAddress ? String(req.socket.remoteAddress) : null);
        const userAgent = String(req.headers['user-agent'] || '').trim() || null;

        if (isOwnerUsername(login)) {
            const ownerPass = getOwnerPassword();
            if (!ownerPass) return res.status(500).json({ error: 'OWNER_PASSWORD no configurada' });
            if (pass !== ownerPass) {
                return res.status(401).json({ error: 'Credenciales inválidas' });
            }
            const owner = getOwnerUser();
            const session = createSession(owner.id, ip, userAgent);
            const token = signAuthToken({ sub: owner.id, r: owner.role, sid: session.id, tv: owner.tokenVersion });
            appendAuditEvent({
                actorUserId: owner.id,
                actorRole: owner.role,
                action: 'login',
                targetUserId: null,
                ip,
                userAgent,
                meta: { role: owner.role }
            });
            return res.json({ token, user: { id: owner.id, username: owner.username, email: owner.email, role: owner.role } });
        }

        const stored = findUserByLogin(login);
        if (!stored) return res.status(401).json({ error: 'Credenciales inválidas' });
        if (stored.disabled) return res.status(403).json({ error: 'Usuario desactivado' });
        const okPass = await verifyPassword(pass, stored.passwordHash);
        if (!okPass) return res.status(401).json({ error: 'Credenciales inválidas' });
        const pub = getUserPublic(stored);

        const session = createSession(pub.id, ip, userAgent);
        const token = signAuthToken({ sub: pub.id, r: pub.role, sid: session.id, tv: pub.tokenVersion });
        appendAuditEvent({
            actorUserId: pub.id,
            actorRole: pub.role,
            action: 'login',
            targetUserId: null,
            ip,
            userAgent,
            meta: { role: pub.role }
        });
        return res.json({ token, user: { id: pub.id, username: pub.username, email: pub.email, role: pub.role } });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Error al iniciar sesión' });
    }
});

app.use('/api', (req, res, next) => {
    if (req.path === '/auth/login') return next();
    return requireAuth(req, res, next);
});

app.get('/api/auth/me', (req, res) => {
    const u = (req as any).auth?.user;
    if (!u) return res.status(401).json({ error: 'No autorizado' });
    res.json({ id: u.id, username: u.username, email: u.email, role: u.role });
});

app.post('/api/auth/logout', (req, res) => {
    const auth = (req as any).auth;
    if (!auth?.sessionId) return res.status(401).json({ error: 'No autorizado' });
    revokeSession(auth.sessionId, auth.user?.id || null, 'logout');
    audit(req, 'logout', auth.user?.id || null);
    res.json({ success: true });
});

app.post('/api/auth/change-password', async (req, res) => {
    try {
        const auth = (req as any).auth;
        const u = auth?.user;
        if (!u) return res.status(401).json({ error: 'No autorizado' });
        if (u.role === 'OWNER') {
            return res.status(400).json({ error: 'La contraseña del propietario del sistema no puede modificarse desde la interfaz web.' });
        }
        const { currentPassword, newPassword } = req.body || {};
        const stored = findUserById(u.id);
        if (!stored) return res.status(401).json({ error: 'No autorizado' });
        const ok = await verifyPassword(String(currentPassword || ''), stored.passwordHash);
        if (!ok) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
        const policy = validatePasswordPolicy(String(newPassword || ''));
        if (!policy.ok) return res.status(400).json({ error: policy.error });
        const newHash = await hashPassword(String(newPassword || ''));
        setUserPasswordHash(u.id, newHash);
        revokeAllSessionsForUser(u.id, u.id, 'password_changed');
        audit(req, 'password_changed', u.id);
        notifyOwner({ action: 'password_changed', userId: u.id, by: u.id, at: Date.now() });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Error al cambiar contraseña' });
    }
});

app.get('/api/security/audit', requireRoleAtLeast('ADMIN'), (req, res) => {
    const actor = (req as any).auth?.user as { role?: string } | undefined;
    const limitRaw = Number(req.query?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 200;
    const events = readAuditTail(limit);
    if (actor?.role === 'ADMIN') {
        return res.json(events.filter((e) => e.actorUserId !== 'owner' && e.targetUserId !== 'owner' && e.actorRole !== 'OWNER'));
    }
    res.json(events);
});

app.get('/api/security/audit/query', requireRoleAtLeast('ADMIN'), (req, res) => {
    const actor = (req as any).auth?.user as { role?: string } | undefined;
    const includeOwner = actor?.role === 'OWNER';
    const limitRaw = Number(req.query?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10000, Math.floor(limitRaw))) : 2000;

    const fromRaw = String(req.query?.from ?? '').trim();
    const toRaw = String(req.query?.to ?? '').trim();
    const actorUserId = String(req.query?.actorUserId ?? '').trim() || null;
    const targetUserId = String(req.query?.targetUserId ?? '').trim() || null;
    const actionQ = String(req.query?.action ?? '').trim().toLowerCase() || null;

    const parseTs = (v: string) => {
        if (!v) return null;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : null;
    };
    const from = parseTs(fromRaw);
    const to = parseTs(toRaw);

    const usersIndex = new Map(listUsers().map((u) => [u.id, u] as const));
    const owner = includeOwner ? getOwnerUser() : null;
    const labelOf = (userId: string | null) => {
        if (!userId) return null;
        if (userId === 'owner' && owner) return { id: owner.id, username: owner.username, role: owner.role };
        const u = usersIndex.get(userId);
        if (u) return { id: u.id, username: u.username, role: u.role };
        return { id: userId, username: userId, role: 'USER' };
    };

    let events = readAuditTail(limit);
    if (!includeOwner) {
        events = events.filter((e) => e.actorUserId !== 'owner' && e.targetUserId !== 'owner' && e.actorRole !== 'OWNER');
    }
    if (actorUserId) {
        if (!includeOwner && actorUserId === 'owner') return res.json([]);
        events = events.filter((e) => e.actorUserId === actorUserId);
    }
    if (targetUserId) {
        if (!includeOwner && targetUserId === 'owner') return res.json([]);
        events = events.filter((e) => e.targetUserId === targetUserId);
    }
    if (actionQ) {
        events = events.filter((e) => String(e.action || '').toLowerCase().includes(actionQ));
    }
    if (from) {
        events = events.filter((e) => Number(e.at || 0) >= from);
    }
    if (to) {
        events = events.filter((e) => Number(e.at || 0) <= to);
    }

    const enriched = events.map((e) => ({
        ...e,
        actor: labelOf(e.actorUserId ?? null),
        target: labelOf(e.targetUserId ?? null)
    }));
    res.json(enriched);
});

app.get('/api/security/users', requireRoleAtLeast('ADMIN'), (req, res) => {
    res.json({ users: listUsers() });
});

app.get('/api/security/stats/users', requireRoleAtLeast('ADMIN'), (req, res) => {
    const actor = (req as any).auth?.user as { role?: string } | undefined;
    const includeOwner = actor?.role === 'OWNER';
    res.json({ users: buildUserStatsTable({ includeOwner }) });
});

app.post('/api/security/users', requireRoleAtLeast('ADMIN'), async (req, res) => {
    try {
        const actor = (req as any).auth?.user;
        const { username, email, role, password } = req.body || {};
        const nextRole = String(role || 'USER').toUpperCase();
        if (nextRole === 'OWNER') return res.status(400).json({ error: 'No se puede crear OWNER' });
        if (actor?.role === 'ADMIN' && nextRole !== 'USER') return res.status(403).json({ error: 'ADMIN solo puede crear usuarios USER' });
        if (nextRole === 'ADMIN' && actor?.role !== 'OWNER') return res.status(403).json({ error: 'Solo OWNER puede crear ADMIN' });
        const policy = validatePasswordPolicy(String(password || ''));
        if (!policy.ok) return res.status(400).json({ error: policy.error });
        const passwordHash = await hashPassword(String(password || ''));
        const created = createUser({ username: String(username || ''), email: email ? String(email) : null, role: nextRole === 'ADMIN' ? 'ADMIN' : 'USER', passwordHash });
        audit(req, 'user_created', created.id, { role: created.role });
        if (created.role === 'ADMIN') notifyOwner({ action: 'admin_created', userId: created.id, by: actor?.id || null, at: Date.now() });
        res.json({ user: getUserPublic(created) });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Error al crear usuario' });
    }
});

app.delete('/api/security/users/:id', requireRoleAtLeast('ADMIN'), (req, res) => {
    try {
        const actor = (req as any).auth?.user;
        const targetId = String(req.params.id || '').trim();
        if (!targetId) return res.status(400).json({ error: 'id requerido' });
        if (targetId === 'owner') return res.status(403).json({ error: 'No permitido' });
        const target = findUserById(targetId);
        if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (actor?.role === 'ADMIN' && target.role !== 'USER') return res.status(403).json({ error: 'No permitido' });
        const deleted = deleteUser(targetId);
        if (!deleted) return res.status(404).json({ error: 'Usuario no encontrado' });
        revokeAllSessionsForUser(targetId, actor?.id || null, 'user_deleted');
        audit(req, 'user_deleted', targetId, { role: deleted.role });
        notifyOwner({ action: 'user_deleted', userId: targetId, by: actor?.id || null, at: Date.now(), role: deleted.role });
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Error al eliminar usuario' });
    }
});

app.post('/api/security/users/:id/close-sessions', requireRoleAtLeast('ADMIN'), (req, res) => {
    const actor = (req as any).auth?.user;
    const targetId = String(req.params.id || '').trim();
    if (!targetId) return res.status(400).json({ error: 'id requerido' });
    if (targetId === 'owner') return res.status(403).json({ error: 'No permitido' });
    const target = findUserById(targetId);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    revokeAllSessionsForUser(targetId, actor?.id || null, 'close_user_sessions');
    rotateUserTokenVersion(targetId);
    audit(req, 'close_user_sessions', targetId);
    notifyOwner({ action: 'close_user_sessions', userId: targetId, by: actor?.id || null, at: Date.now() });
    res.json({ success: true });
});

app.patch('/api/security/users/:id', requireRoleAtLeast('ADMIN'), (req, res) => {
    try {
        const actor = (req as any).auth?.user;
        const targetId = String(req.params.id || '').trim();
        if (!targetId) return res.status(400).json({ error: 'id requerido' });
        const target = findUserById(targetId);
        if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

        const { disabled, role } = req.body || {};
        if (typeof disabled === 'boolean') {
            if (actor?.role === 'ADMIN' && target.role !== 'USER') return res.status(403).json({ error: 'No permitido' });
            const updated = setUserDisabled(targetId, Boolean(disabled));
            if (!updated) return res.status(404).json({ error: 'Usuario no encontrado' });
            audit(req, 'user_disabled_changed', targetId, { disabled: Boolean(disabled) });
            return res.json({ user: getUserPublic(updated) });
        }
        if (typeof role === 'string') {
            const nextRole = String(role || '').toUpperCase();
            if (nextRole === 'OWNER') return res.status(400).json({ error: 'No se puede asignar OWNER' });
            if (actor?.role !== 'OWNER') return res.status(403).json({ error: 'Solo OWNER puede cambiar roles' });
            const updated = setUserRole(targetId, nextRole === 'ADMIN' ? 'ADMIN' : 'USER');
            if (!updated) return res.status(404).json({ error: 'Usuario no encontrado' });
            audit(req, 'user_role_changed', targetId, { role: updated.role });
            notifyOwner({ action: 'role_changed', userId: targetId, by: actor?.id || null, at: Date.now(), role: updated.role });
            return res.json({ user: getUserPublic(updated) });
        }
        return res.status(400).json({ error: 'Nada para actualizar' });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Error al actualizar usuario' });
    }
});

app.post('/api/security/users/:id/reset-password', requireRoleAtLeast('ADMIN'), async (req, res) => {
    try {
        const actor = (req as any).auth?.user;
        const targetId = String(req.params.id || '').trim();
        const target = findUserById(targetId);
        if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (actor?.role === 'ADMIN' && target.role !== 'USER') return res.status(403).json({ error: 'No permitido' });
        const { newPassword } = req.body || {};
        const policy = validatePasswordPolicy(String(newPassword || ''));
        if (!policy.ok) return res.status(400).json({ error: policy.error });
        const passwordHash = await hashPassword(String(newPassword || ''));
        setUserPasswordHash(targetId, passwordHash);
        revokeAllSessionsForUser(targetId, actor?.id || null, 'password_reset');
        audit(req, 'password_reset', targetId);
        notifyOwner({ action: 'password_reset', userId: targetId, by: actor?.id || null, at: Date.now() });
        res.json({ success: true });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Error al resetear contraseña' });
    }
});

app.get('/api/security/sessions', requireRoleAtLeast('USER'), (req, res) => {
    const actor = (req as any).auth?.user;
    const targetUserId = String(req.query?.userId || '').trim();
    const filterUserId = targetUserId || null;
    if (actor?.role === 'USER') {
        const sessions = listSessions(actor.id);
        return res.json({ sessions: sessions.map((s) => ({ ...s, user: { id: actor.id, username: actor.username, role: actor.role } })) });
    }
    if (actor?.role === 'ADMIN' && !filterUserId) {
        const sessions = listSessions().filter((s) => s.userId !== 'owner');
        const usersIndex = new Map(listUsers().map((u) => [u.id, u] as const));
        return res.json({
            sessions: sessions.map((s) => {
                const u = usersIndex.get(s.userId);
                return { ...s, user: u ? { id: u.id, username: u.username, role: u.role } : { id: s.userId, username: s.userId, role: 'USER' } };
            })
        });
    }
    const sessions = listSessions(filterUserId || undefined).filter((s) => (actor?.role === 'OWNER' ? true : s.userId !== 'owner'));
    const usersIndex = new Map(listUsers().map((u) => [u.id, u] as const));
    const owner = actor?.role === 'OWNER' ? getOwnerUser() : null;
    return res.json({
        sessions: sessions.map((s) => {
            if (s.userId === 'owner' && owner) return { ...s, user: { id: owner.id, username: owner.username, role: owner.role } };
            const u = usersIndex.get(s.userId);
            return { ...s, user: u ? { id: u.id, username: u.username, role: u.role } : { id: s.userId, username: s.userId, role: 'USER' } };
        })
    });
});

app.post('/api/security/sessions/:id/revoke', requireRoleAtLeast('USER'), (req, res) => {
    const actor = (req as any).auth?.user;
    const sid = String(req.params.id || '').trim();
    const s = findSession(sid);
    if (!s) return res.status(404).json({ error: 'Sesión no encontrada' });
    if (actor?.role === 'USER' && s.userId !== actor.id) return res.status(403).json({ error: 'No permitido' });
    if (actor?.role === 'ADMIN' && s.userId === 'owner') return res.status(403).json({ error: 'No permitido' });
    revokeSession(sid, actor?.id || null, 'revoked');
    audit(req, 'session_revoked', s.userId, { sessionId: sid });
    res.json({ success: true });
});

app.post('/api/security/sessions/revoke-all', requireRoleAtLeast('OWNER'), (req, res) => {
    const actor = (req as any).auth?.user;
    const keep = String((req as any).auth?.sessionId || '').trim();
    revokeAllSessionsExcept(keep, actor?.id || null, 'close_all_sessions');
    audit(req, 'close_all_sessions', null);
    res.json({ success: true });
});

app.post('/api/security/emergency-lock', requireRoleAtLeast('OWNER'), (req, res) => {
    const actor = (req as any).auth?.user;
    setEmergencyLock(true);
    const keep = String((req as any).auth?.sessionId || '').trim();
    revokeAllSessionsExcept(keep, actor?.id || null, 'emergency_lock');
    for (const u of listUsers()) {
        setUserDisabled(u.id, true);
    }
    audit(req, 'emergency_lock', null);
    notifyOwner({ action: 'emergency_lock', by: actor?.id || null, at: Date.now() });
    res.json({ success: true });
});

app.post('/api/security/emergency-unlock', requireRoleAtLeast('OWNER'), (req, res) => {
    setEmergencyLock(false);
    audit(req, 'emergency_unlock', null);
    notifyOwner({ action: 'emergency_unlock', by: (req as any).auth?.user?.id || null, at: Date.now() });
    res.json({ success: true });
});

// REST Routes
app.get('/api/devices', (req, res) => {
    try {
        res.json(deviceManager.getDevices());
    } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Error al obtener dispositivos' });
    }
});

app.post('/api/devices', (req, res) => {
    try {
        const { name } = req.body;
        const device = deviceManager.createDevice(name);
        audit(req, 'device_created', null, { deviceId: device?.id || null, name: String(name || '') });
        res.json(device);
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Error al crear dispositivo' });
    }
});

app.patch('/api/devices/:id', (req, res) => {
    try {
        const { name } = req.body;
        const updated = deviceManager.renameDevice(req.params.id, name);
        if (!updated) return res.status(404).json({ error: 'Dispositivo no encontrado' });
        audit(req, 'device_renamed', null, { deviceId: req.params.id, name: String(name || '') });
        res.json(updated);
    } catch (error: any) {
        res.status(400).json({ error: error.message || 'Error al actualizar dispositivo' });
    }
});

app.post('/api/devices/:id/start', async (req, res) => {
    try {
        await deviceManager.initDevice(req.params.id, 'qr');
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/pairing-code', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        const result = await deviceManager.requestPairingCode(req.params.id, phoneNumber);
        res.json(result);
    } catch (error: any) {
        const status = typeof error?.status === 'number'
            ? error.status
            : (String(error?.message || '').includes('no encontrado') ? 404 : 400);
        res.status(status).json({ error: error?.message || 'Error al generar código' });
    }
});

app.post('/api/devices/:id/stop', async (req, res) => {
    await deviceManager.stopDevice(req.params.id);
    res.json({ success: true });
});

// Desconectar y limpiar datos de conexión
app.post('/api/devices/:id/disconnect-clean', async (req, res) => {
    try {
        const result = await deviceManager.disconnectAndClean(req.params.id);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Reset completo del cache de chats/contactos (mantiene sesión de WhatsApp)
app.post('/api/devices/:id/reset-cache', async (req, res) => {
    try {
        const result = await deviceManager.resetDeviceCache(req.params.id);
        audit(req, 'device_cache_reset', null, { deviceId: req.params.id });
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Eliminar dispositivo completamente
app.delete('/api/devices/:id', async (req, res) => {
    try {
        const result = await deviceManager.deleteDevice(req.params.id);
        audit(req, 'device_deleted', null, { deviceId: req.params.id });
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Obtener lista de chats
app.get('/api/devices/:id/chats', async (req, res) => {
    try {
        const chats = await deviceManager.getChats(req.params.id);
        res.json(chats);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Obtener mensajes de un chat
app.get('/api/devices/:id/chats/:chatId/messages', async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
        const messages = await deviceManager.getChatMessages(req.params.id, req.params.chatId, limit);
        res.json(messages);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/chats/:chatId/import-profile-photo', async (req, res) => {
    try {
        const result = await deviceManager.importChatProfilePhoto(req.params.id, req.params.chatId);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Buscar mensajes
app.get('/api/devices/:id/messages/search', async (req, res) => {
    try {
        const { q, chatId, limit, fromMe } = req.query;
        
        if (!q || typeof q !== 'string') {
            return res.status(400).json({ error: 'Se requiere el parámetro de búsqueda "q"' });
        }

        const results = await deviceManager.searchMessages(req.params.id, q, {
            chatId: chatId as string | undefined,
            limit: limit ? parseInt(limit as string) : 50,
            fromMe: fromMe === 'true' ? true : fromMe === 'false' ? false : undefined
        });

        res.json(results);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Renombrar contacto (nombre personalizado como si fuera la agenda)
app.put('/api/devices/:id/chats/:chatId/rename', async (req, res) => {
    try {
        const { customName } = req.body;
        const deviceId = req.params.id;
        const chatId = decodeURIComponent(req.params.chatId);
        
        const result = await deviceManager.renameChat(deviceId, chatId, customName || null);
        audit(req, 'chat_rename', null, { deviceId, chatId, customName });
        res.json({ success: true, ...result });
    } catch (error: any) {
        console.error(`[rename] Error:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/chats/:chatId/send-text', async (req, res) => {
    try {
        const { text, quotedMessageId } = req.body;
        const actor = (req as any).auth?.user;
        
        console.log(`[send-text] deviceId=${req.params.id}, chatId=${req.params.chatId}, quotedMessageId=${quotedMessageId || 'none'}`);
        
        const result = await deviceManager.sendMessage(req.params.id, req.params.chatId, text, quotedMessageId);
        recordOutgoingMessage(actor?.id || '', req.params.id, req.params.chatId, Date.now());
        audit(req, 'message_send_text', null, { 
            deviceId: req.params.id, 
            chatId: req.params.chatId, 
            length: String(text || '').length,
            isReply: Boolean(quotedMessageId)
        });
        res.json({ success: true, result });
    } catch (error: any) {
        console.error(`[send-text] Error:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/chats/:chatId/send-media', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se proporcionó ningún archivo' });
        }

        const deviceId = req.params.id as string;
        const chatId = req.params.chatId as string;
        const { caption, isVoiceNote: isVoiceNoteRaw } = req.body;
        const isVoiceNote = isVoiceNoteRaw === 'true' || req.file.originalname?.includes('audio-nota-voz') || false;
        const actor = (req as any).auth?.user;
        
        const result = await deviceManager.sendMedia(
            deviceId,
            chatId,
            req.file.buffer,
            req.file.mimetype || 'application/octet-stream',
            caption || req.file.originalname || 'archivo',
            isVoiceNote
        );
        recordOutgoingMessage(actor?.id || '', deviceId, chatId, Date.now());
        audit(req, 'message_send_media', null, { deviceId, chatId, size: req.file.size, mime: req.file.mimetype || null, isVoiceNote });
        res.json({ success: true, result });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/storage/files', (req, res) => {
    const { deviceId } = req.query;
    const storageRoot = path.join(DB_ROOT, 'storage');
    const files: any[] = [];

    const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                walk(fullPath);
            } else {
                const relativePath = path.relative(storageRoot, fullPath);
                // Filter by deviceId if provided
                if (deviceId && !relativePath.startsWith(deviceId as string)) return;

                files.push({
                    id: file,
                    fileName: file,
                    size: stat.size,
                    timestamp: stat.mtimeMs,
                    chatId: path.basename(path.dirname(fullPath)),
                    url: `/storage/${relativePath.replace(/\\/g, '/')}`
                });
            }
        });
    };

    walk(storageRoot);
    res.json(files.sort((a, b) => b.timestamp - a.timestamp));
});

// ========== TEMPLATES API ==========

app.get('/api/templates', (req, res) => {
    try {
        const templates = templateManager.getAllTemplates();
        res.json(templates);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/templates/categories', (req, res) => {
    try {
        const categories = templateManager.getCategories();
        res.json(categories);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/templates/search', (req, res) => {
    try {
        const { q } = req.query;
        const templates = q ? templateManager.searchTemplates(q as string) : templateManager.getAllTemplates();
        res.json(templates);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/templates/category/:category', (req, res) => {
    try {
        const templates = templateManager.getTemplatesByCategory(req.params.category);
        res.json(templates);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/templates', (req, res) => {
    try {
        const template = templateManager.createTemplate(req.body);
        audit(req, 'template_created', null, { templateId: template?.id || null });
        res.json(template);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/templates/:id', (req, res) => {
    try {
        const template = templateManager.updateTemplate(req.params.id, req.body);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
        audit(req, 'template_updated', null, { templateId: req.params.id });
        res.json(template);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/templates/:id', (req, res) => {
    try {
        const success = templateManager.deleteTemplate(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'Template not found' });
        }
        audit(req, 'template_deleted', null, { templateId: req.params.id });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/templates/:id/use', (req, res) => {
    try {
        templateManager.incrementUsage(req.params.id);
        const actor = (req as any).auth?.user;
        recordQuickReplyUse(actor?.id || '');
        audit(req, 'template_used', null, { templateId: req.params.id });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ========== LABELS API ==========

app.get('/api/labels', (req, res) => {
    try {
        const labels = labelManager.getAllLabels();
        res.json(labels);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/labels', (req, res) => {
    try {
        const label = labelManager.createLabel(req.body);
        audit(req, 'label_created', null, { labelId: label?.id || null });
        res.json(label);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/labels/:id', (req, res) => {
    try {
        const label = labelManager.updateLabel(req.params.id, req.body);
        if (!label) {
            return res.status(404).json({ error: 'Label not found' });
        }
        audit(req, 'label_updated', null, { labelId: req.params.id });
        res.json(label);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/labels/:id', (req, res) => {
    try {
        const success = labelManager.deleteLabel(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'Label not found' });
        }
        audit(req, 'label_deleted', null, { labelId: req.params.id });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Chat label assignments

app.get('/api/devices/:deviceId/chats/:chatId/labels', (req, res) => {
    try {
        const labels = labelManager.getChatLabels(req.params.deviceId, req.params.chatId);
        res.json(labels);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/devices/:deviceId/chats/:chatId', async (req, res) => {
    try {
        const { deviceId, chatId } = req.params;
        const success = await deviceManager.deleteChat(deviceId, chatId);
        if (!success) return res.status(404).json({ error: 'Chat not found' });
        audit(req, 'chat_deleted', null, { deviceId, chatId });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:deviceId/chats/:chatId/labels', (req, res) => {
    try {
        const { labelIds } = req.body;
        labelManager.assignLabels(req.params.deviceId, req.params.chatId, labelIds);
        audit(req, 'chat_labels_assigned', null, { deviceId: req.params.deviceId, chatId: req.params.chatId, labelIds });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:deviceId/chats/:chatId/labels/:labelId', (req, res) => {
    try {
        labelManager.addLabelToChat(req.params.deviceId, req.params.chatId, req.params.labelId);
        audit(req, 'chat_label_added', null, { deviceId: req.params.deviceId, chatId: req.params.chatId, labelId: req.params.labelId });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/devices/:deviceId/chats/:chatId/labels/:labelId', (req, res) => {
    try {
        labelManager.removeLabelFromChat(req.params.deviceId, req.params.chatId, req.params.labelId);
        audit(req, 'chat_label_removed', null, { deviceId: req.params.deviceId, chatId: req.params.chatId, labelId: req.params.labelId });
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:deviceId/labels/:labelId/chats', (req, res) => {
    try {
        const chatIds = labelManager.getChatsByLabel(req.params.deviceId, req.params.labelId);
        res.json(chatIds);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ========== EXPORT API ==========

app.post('/api/export/chat', (req, res) => {
    try {
        const { messages, chatId, deviceId, format } = req.body;
        
        let filepath: string;
        
        switch (format) {
            case 'json':
                filepath = exportToJSON(messages, chatId, deviceId);
                break;
            case 'csv':
                filepath = exportToCSV(messages, chatId, deviceId);
                break;
            case 'txt':
                filepath = exportToTXT(messages, chatId, deviceId);
                break;
            default:
                return res.status(400).json({ error: 'Invalid format. Use json, csv, or txt' });
        }

        // Enviar el archivo
        res.download(filepath, path.basename(filepath), (err) => {
            if (err) {
                console.error('Error al enviar archivo:', err);
            }
            // Opcional: eliminar el archivo después de enviarlo
            // fs.unlinkSync(filepath);
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.use('/exports', express.static(path.join(DB_ROOT, 'exports')));

// ========== GROUPS API ==========

app.get('/api/devices/:id/groups', async (req, res) => {
    try {
        const groups = await deviceManager.getGroups(req.params.id);
        res.json(groups);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/groups', async (req, res) => {
    try {
        const { name, participants } = req.body;
        const result = await deviceManager.createGroup(req.params.id, name, participants);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/devices/:id/groups/:groupId', async (req, res) => {
    try {
        const metadata = await deviceManager.getGroupMetadata(req.params.id, req.params.groupId);
        res.json(metadata);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/groups/:groupId/participants', async (req, res) => {
    try {
        const { participants, action } = req.body;
        let result;
        
        switch (action) {
            case 'add':
                result = await deviceManager.addParticipantsToGroup(req.params.id, req.params.groupId, participants);
                break;
            case 'remove':
                result = await deviceManager.removeParticipantsFromGroup(req.params.id, req.params.groupId, participants);
                break;
            case 'promote':
                result = await deviceManager.promoteParticipants(req.params.id, req.params.groupId, participants);
                break;
            case 'demote':
                result = await deviceManager.demoteParticipants(req.params.id, req.params.groupId, participants);
                break;
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
        
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/devices/:id/groups/:groupId/subject', async (req, res) => {
    try {
        const { subject } = req.body;
        const result = await deviceManager.updateGroupSubject(req.params.id, req.params.groupId, subject);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/devices/:id/groups/:groupId/description', async (req, res) => {
    try {
        const { description } = req.body;
        const result = await deviceManager.updateGroupDescription(req.params.id, req.params.groupId, description);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/devices/:id/groups/:groupId/leave', async (req, res) => {
    try {
        const result = await deviceManager.leaveGroup(req.params.id, req.params.groupId);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io
io.use((socket, next) => {
    const token = String((socket.handshake as any)?.auth?.token || '');
    const verified = verifyAuthToken(token);
    if (!verified) return next(new Error('UNAUTHORIZED'));
    const session = findSession(verified.sid);
    if (!session || session.userId !== verified.sub || session.revokedAt) return next(new Error('UNAUTHORIZED'));
    const st = loadOwnerState();
    if (st.emergencyLock && verified.r !== 'OWNER') return next(new Error('LOCKED'));
    if (verified.r === 'OWNER') {
        const owner = getOwnerUser();
        if (owner.tokenVersion !== verified.tv) return next(new Error('UNAUTHORIZED'));
        (socket as any).auth = { userId: owner.id, role: owner.role, sessionId: session.id };
        socket.join(`role:${owner.role}`);
        socket.join(`user:${owner.id}`);
        return next();
    }
    const u = findUserById(verified.sub);
    if (!u || u.disabled) return next(new Error('UNAUTHORIZED'));
    if (u.role !== verified.r) return next(new Error('UNAUTHORIZED'));
    if (u.tokenVersion !== verified.tv) return next(new Error('UNAUTHORIZED'));
    (socket as any).auth = { userId: u.id, role: u.role, sessionId: session.id };
    socket.join(`role:${u.role}`);
    socket.join(`user:${u.id}`);
    next();
});

// Contador de conexiones activas (evita spam de logs)
let activeConnections = 0;
let lastConnectionLog = 0;

io.on('connection', (socket) => {
    activeConnections++;
    const now = Date.now();
    // Solo loguear cada 30 segundos como máximo
    if (now - lastConnectionLog > 30000) {
        console.log(`[WS] Conexiones activas: ${activeConnections}`);
        lastConnectionLog = now;
    }
    
    socket.on('disconnect', () => {
        activeConnections--;
    });
});

export const startBackend = (port: number = 5000) => {
    return new Promise<void>((resolve, reject) => {
        const onError = (err: any) => {
            server.off('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            server.off('error', onError);
            console.log(`Backend running on port ${port}`);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
    });
};

export const stopBackend = () => {
    return new Promise<void>((resolve, reject) => {
        server.close((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

// Manejo de shutdown graceful para SIGTERM (Railway, Docker, etc)
let isShuttingDown = false;
const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log(`\n[${signal}] Iniciando shutdown graceful...`);
    
    try {
        // Cerrar servidor HTTP
        await stopBackend();
        console.log('[Shutdown] Servidor HTTP cerrado');
        
        // Dar tiempo para que las conexiones se cierren
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('[Shutdown] Completado');
        process.exit(0);
    } catch (err) {
        console.error('[Shutdown] Error:', err);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
    const port = process.env.PORT ? Number(process.env.PORT) : 5000;
    startBackend(Number.isFinite(port) ? port : 5000)
        .then(() => {
            console.log('[Server] Listo, iniciando auto-reconexión de dispositivos...');
            // Iniciar auto-reconexión después de que el servidor esté listo
            deviceManager.startAutoReconnect().catch(err => {
                console.error('[AutoReconnect] Error:', err);
            });
        })
        .catch(err => {
            console.error('[Server] Error al iniciar:', err);
            process.exit(1);
        });
}
