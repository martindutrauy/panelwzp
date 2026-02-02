import crypto from 'crypto';
import { getAuthSecret, getTokenTtlMs } from './ownerStore';
import type { Role } from './types';

type AuthTokenPayload = {
    sub: string;
    r: Role;
    sid: string;
    tv: number;
    exp: number;
    iat: number;
};

const b64urlEncode = (input: Buffer | string) => {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    return buf
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
};

const b64urlDecode = (input: string) => {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + pad, 'base64');
};

export const signAuthToken = (payload: { sub: string; r: Role; sid: string; tv: number }, ttlMs: number = getTokenTtlMs()) => {
    const header = { alg: 'HS256', typ: 'APP' };
    const now = Date.now();
    const body: AuthTokenPayload = { sub: payload.sub, r: payload.r, sid: payload.sid, tv: payload.tv, iat: now, exp: now + ttlMs };
    const headerPart = b64urlEncode(JSON.stringify(header));
    const payloadPart = b64urlEncode(JSON.stringify(body));
    const data = `${headerPart}.${payloadPart}`;
    const sig = crypto.createHmac('sha256', getAuthSecret()).update(data).digest();
    const sigPart = b64urlEncode(sig);
    return `${data}.${sigPart}`;
};

export const verifyAuthToken = (token: string): { sub: string; r: Role; sid: string; tv: number } | null => {
    try {
        if (typeof token !== 'string' || !token) return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const headerPart = parts[0]!;
        const payloadPart = parts[1]!;
        const sigPart = parts[2]!;
        const data = `${headerPart}.${payloadPart}`;
        const expectedSig = crypto.createHmac('sha256', getAuthSecret()).update(data).digest();
        const actualSig = b64urlDecode(sigPart);
        if (actualSig.length !== expectedSig.length) return null;
        if (!crypto.timingSafeEqual(actualSig, expectedSig)) return null;
        const payloadRaw = b64urlDecode(payloadPart).toString('utf8');
        const payload = JSON.parse(payloadRaw) as AuthTokenPayload;
        if (!payload?.sub || typeof payload.sub !== 'string') return null;
        if (!payload?.sid || typeof payload.sid !== 'string') return null;
        if (payload?.r !== 'OWNER' && payload?.r !== 'ADMIN' && payload?.r !== 'USER') return null;
        if (!Number.isFinite(payload?.tv)) return null;
        if (!Number.isFinite(payload?.exp) || !Number.isFinite(payload?.iat)) return null;
        if (Date.now() > payload.exp) return null;
        return { sub: payload.sub, r: payload.r, sid: payload.sid, tv: payload.tv };
    } catch {
        return null;
    }
};

