import crypto from 'crypto';
import { dbPath } from '../config/paths';
import { decrypt, encrypt } from '../utils/crypto';
import { atomicWriteJson, safeReadJson } from './storage';
import type { AuthUser, OwnerState } from './types';

const OWNER_ID = 'owner';
const OWNER_STATE_FILE = dbPath('security', 'owner.json');

const getOwnerUsername = () => String(process.env.OWNER_USERNAME || process.env.APP_USERNAME || 'owner').trim() || 'owner';
const getOwnerEmail = () => {
    const raw = String(process.env.OWNER_EMAIL || '').trim();
    return raw || null;
};
export const getOwnerPassword = () => String(process.env.OWNER_PASSWORD || process.env.APP_PASSWORD || '').trim();

export const getAuthSecret = () => String(process.env.APP_AUTH_SECRET || 'dev-secret-change-me');

export const getTokenTtlMs = () => {
    const raw = Number(process.env.APP_TOKEN_TTL_MS);
    if (Number.isFinite(raw) && raw > 60_000) return raw;
    return 8 * 60 * 60 * 1000;
};

export const getSessionIdleTtlMs = () => {
    const raw = Number(process.env.APP_SESSION_IDLE_TTL_MS);
    if (Number.isFinite(raw) && raw > 60_000) return raw;
    return 24 * 60 * 60 * 1000;
};

const getOwnerStateDefaults = (): OwnerState => ({
    v: 1,
    tokenVersion: 0,
    twoFactorSecretEnc: null,
    twoFactorRequired: true,
    emergencyLock: false,
    updatedAt: Date.now()
});

export const loadOwnerState = (): OwnerState => {
    const parsed = safeReadJson<OwnerState>(OWNER_STATE_FILE);
    if (!parsed || parsed.v !== 1) return getOwnerStateDefaults();
    return {
        v: 1,
        tokenVersion: Number.isFinite(parsed.tokenVersion) ? Number(parsed.tokenVersion) : 0,
        twoFactorSecretEnc: typeof parsed.twoFactorSecretEnc === 'string' ? parsed.twoFactorSecretEnc : null,
        twoFactorRequired: parsed.twoFactorRequired !== false,
        emergencyLock: Boolean(parsed.emergencyLock),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
    };
};

export const saveOwnerState = (next: OwnerState) => {
    atomicWriteJson(OWNER_STATE_FILE, next);
};

export const getOwnerTwoFactorSecret = () => {
    const envSecret = String(process.env.OWNER_TOTP_SECRET || '').trim();
    if (envSecret) return envSecret;
    const st = loadOwnerState();
    if (!st.twoFactorSecretEnc) return null;
    const value = decrypt(st.twoFactorSecretEnc);
    return String(value || '').trim() || null;
};

export const setOwnerTwoFactorSecret = (secretBase32: string) => {
    const st = loadOwnerState();
    const next: OwnerState = {
        ...st,
        twoFactorSecretEnc: encrypt(String(secretBase32 || '').trim()),
        updatedAt: Date.now()
    };
    saveOwnerState(next);
    return next;
};

export const rotateOwnerTokenVersion = () => {
    const st = loadOwnerState();
    const next: OwnerState = { ...st, tokenVersion: st.tokenVersion + 1, updatedAt: Date.now() };
    saveOwnerState(next);
    return next;
};

export const setEmergencyLock = (enabled: boolean) => {
    const st = loadOwnerState();
    const next: OwnerState = { ...st, emergencyLock: Boolean(enabled), updatedAt: Date.now() };
    saveOwnerState(next);
    return next;
};

export const getOwnerUser = (): AuthUser => {
    const st = loadOwnerState();
    const secretExists = Boolean(getOwnerTwoFactorSecret());
    return {
        id: OWNER_ID,
        username: getOwnerUsername(),
        email: getOwnerEmail(),
        role: 'OWNER',
        disabled: false,
        tokenVersion: st.tokenVersion,
        twoFactorRequired: st.twoFactorRequired !== false,
        twoFactorEnabled: secretExists
    };
};

export const createOwnerSessionId = () => crypto.randomBytes(18).toString('hex');

export const isOwnerUsername = (username: string) => {
    const u = String(username || '').trim();
    if (!u) return false;
    return u === getOwnerUsername();
};
