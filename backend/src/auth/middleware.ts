import type { NextFunction, Request, Response } from 'express';
import { verifyAuthToken } from './authToken';
import { appendAuditEvent } from './auditLog';
import { getOwnerTwoFactorSecret, getOwnerUser, loadOwnerState } from './ownerStore';
import { findUserById, getUserPublic, getUserTwoFactorSecret } from './userStore';
import { findSession, revokeSession, touchSession } from './sessionStore';
import { getSessionIdleTtlMs } from './ownerStore';
import type { AuthUser, Role } from './types';

export type AuthedRequest = Request & { auth?: { user: AuthUser; sessionId: string } };

const getIp = (req: Request) => {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
    return xf || (req.socket?.remoteAddress ? String(req.socket.remoteAddress) : null);
};

const getUserAgent = (req: Request) => {
    const ua = String(req.headers['user-agent'] || '').trim();
    return ua || null;
};

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') return next();

    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    const verified = verifyAuthToken(token);
    if (!verified) return res.status(401).json({ error: 'No autorizado' });

    const session = findSession(verified.sid);
    if (!session || session.userId !== verified.sub) return res.status(401).json({ error: 'Sesión inválida' });
    if (session.revokedAt) return res.status(401).json({ error: 'Sesión revocada' });

    const idleTtl = getSessionIdleTtlMs();
    if (idleTtl > 0 && Date.now() - session.lastSeenAt > idleTtl) {
        revokeSession(session.id, null, 'idle_timeout');
        return res.status(401).json({ error: 'Sesión expirada' });
    }

    const ownerState = loadOwnerState();
    if (ownerState.emergencyLock && verified.r !== 'OWNER') {
        return res.status(423).json({ error: 'Sistema bloqueado (Emergency Lock)' });
    }

    let user: AuthUser | null = null;
    if (verified.r === 'OWNER') {
        const o = getOwnerUser();
        if (verified.tv !== o.tokenVersion) return res.status(401).json({ error: 'Sesión inválida' });
        user = o;
    } else {
        const stored = findUserById(verified.sub);
        if (!stored) return res.status(401).json({ error: 'Usuario inválido' });
        const pub = getUserPublic(stored);
        if (pub.role !== verified.r) return res.status(401).json({ error: 'Usuario inválido' });
        if (verified.tv !== pub.tokenVersion) return res.status(401).json({ error: 'Sesión inválida' });
        if (pub.disabled) return res.status(403).json({ error: 'Usuario desactivado' });
        user = pub;
    }

    const needs2fa = user.role === 'OWNER' || user.role === 'ADMIN';
    if (needs2fa) {
        const secret = user.role === 'OWNER' ? getOwnerTwoFactorSecret() : (() => {
            const st = verified.r !== 'OWNER' ? findUserById(verified.sub) : null;
            return st ? getUserTwoFactorSecret(st) : null;
        })();
        const ok = Boolean(secret);
        if (!ok) {
            const allowed = req.path.startsWith('/security/2fa/') || req.path === '/auth/me';
            if (!allowed) return res.status(403).json({ error: 'Se requiere configurar 2FA para continuar', code: '2FA_SETUP_REQUIRED' });
        }
    }

    (req as AuthedRequest).auth = { user, sessionId: verified.sid };
    touchSession(verified.sid, Date.now());
    next();
};

const roleRank = (r: Role) => (r === 'OWNER' ? 3 : r === 'ADMIN' ? 2 : 1);

export const requireRoleAtLeast = (role: Role) => (req: Request, res: Response, next: NextFunction) => {
    const u = (req as AuthedRequest).auth?.user;
    if (!u) return res.status(401).json({ error: 'No autorizado' });
    if (roleRank(u.role) < roleRank(role)) return res.status(403).json({ error: 'Prohibido' });
    next();
};

export const auditFromRequest = (req: Request) => {
    const u = (req as AuthedRequest).auth?.user;
    return {
        actorUserId: u?.id ?? null,
        actorRole: u?.role ?? null,
        ip: getIp(req),
        userAgent: getUserAgent(req)
    };
};

export const audit = (req: Request, action: string, targetUserId: string | null, meta?: Record<string, any>) => {
    const ctx = auditFromRequest(req);
    appendAuditEvent({
        ...ctx,
        action,
        targetUserId,
        meta
    });
};
