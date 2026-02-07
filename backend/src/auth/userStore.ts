import crypto from 'crypto';
import { dbPath } from '../config/paths';
import { atomicWriteJson, safeReadJson } from './storage';
import type { AuthUser, Role, StoredUser, StoredUsersFile } from './types';

const USERS_FILE = dbPath('security', 'users.json');

const normalizeUsername = (value: string) => String(value || '').trim().toLowerCase();
const normalizeEmail = (value: string) => String(value || '').trim().toLowerCase();

const sanitizeUser = (u: StoredUser): StoredUser => ({
    v: 1,
    id: String(u.id || ''),
    username: String(u.username || '').trim(),
    email: u.email ? String(u.email).trim() : null,
    role: u.role === 'ADMIN' ? 'ADMIN' : 'USER',
    disabled: Boolean(u.disabled),
    passwordHash: String(u.passwordHash || ''),
    tokenVersion: Number.isFinite(u.tokenVersion) ? Number(u.tokenVersion) : 0,
    createdAt: typeof u.createdAt === 'number' ? u.createdAt : Date.now(),
    updatedAt: typeof u.updatedAt === 'number' ? u.updatedAt : Date.now(),
    passwordUpdatedAt: typeof u.passwordUpdatedAt === 'number' ? u.passwordUpdatedAt : Date.now()
});

export const loadUsersFile = (): StoredUsersFile => {
    const parsed = safeReadJson<StoredUsersFile>(USERS_FILE);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.users)) return { v: 1, users: [] };
    const users = parsed.users.map(sanitizeUser).filter((u) => u.id && u.username && u.passwordHash);
    return { v: 1, users };
};

export const saveUsersFile = (file: StoredUsersFile) => {
    atomicWriteJson(USERS_FILE, file);
};

export const listUsers = (): AuthUser[] => {
    const { users } = loadUsersFile();
    return users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        disabled: u.disabled,
        tokenVersion: u.tokenVersion
    }));
};

export const findUserById = (id: string): StoredUser | null => {
    const { users } = loadUsersFile();
    const uid = String(id || '').trim();
    if (!uid) return null;
    return users.find((u) => u.id === uid) || null;
};

export const findUserByLogin = (login: string): StoredUser | null => {
    const value = String(login || '').trim();
    if (!value) return null;
    const needleUser = normalizeUsername(value);
    const needleEmail = normalizeEmail(value);
    const { users } = loadUsersFile();
    return users.find((u) => normalizeUsername(u.username) === needleUser || (u.email && normalizeEmail(u.email) === needleEmail)) || null;
};

export const getUserPublic = (u: StoredUser): AuthUser => ({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    disabled: u.disabled,
    tokenVersion: u.tokenVersion
});

export const createUser = (input: { username: string; email?: string | null; role: Role; passwordHash: string }) => {
    if (input.role === 'OWNER') throw new Error('No se puede crear OWNER');
    const username = String(input.username || '').trim();
    if (!username) throw new Error('username requerido');
    const email = input.email ? String(input.email).trim() : null;
    const { users } = loadUsersFile();
    const nu = normalizeUsername(username);
    if (users.some((u) => normalizeUsername(u.username) === nu)) throw new Error('username ya existe');
    if (email) {
        const ne = normalizeEmail(email);
        if (users.some((u) => u.email && normalizeEmail(u.email) === ne)) throw new Error('email ya existe');
    }
    const now = Date.now();
    const u: StoredUser = {
        v: 1,
        id: crypto.randomUUID(),
        username,
        email,
        role: input.role === 'ADMIN' ? 'ADMIN' : 'USER',
        disabled: false,
        passwordHash: String(input.passwordHash || ''),
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
        passwordUpdatedAt: now
    };
    saveUsersFile({ v: 1, users: [...users, u] });
    return u;
};

export const setUserDisabled = (userId: string, disabled: boolean) => {
    const { users } = loadUsersFile();
    const id = String(userId || '').trim();
    const nextUsers = users.map((u) => (u.id === id ? { ...u, disabled: Boolean(disabled), updatedAt: Date.now() } : u));
    saveUsersFile({ v: 1, users: nextUsers });
    return nextUsers.find((u) => u.id === id) || null;
};

export const setUserRole = (userId: string, role: 'ADMIN' | 'USER') => {
    const { users } = loadUsersFile();
    const id = String(userId || '').trim();
    const nextUsers = users.map((u) => (u.id === id ? { ...u, role: role, updatedAt: Date.now() } : u));
    saveUsersFile({ v: 1, users: nextUsers });
    return nextUsers.find((u) => u.id === id) || null;
};

export const rotateUserTokenVersion = (userId: string) => {
    const { users } = loadUsersFile();
    const id = String(userId || '').trim();
    const nextUsers = users.map((u) => (u.id === id ? { ...u, tokenVersion: u.tokenVersion + 1, updatedAt: Date.now() } : u));
    saveUsersFile({ v: 1, users: nextUsers });
    return nextUsers.find((u) => u.id === id) || null;
};

export const setUserPasswordHash = (userId: string, passwordHash: string) => {
    const { users } = loadUsersFile();
    const id = String(userId || '').trim();
    const now = Date.now();
    const nextUsers = users.map((u) => (u.id === id ? { ...u, passwordHash: String(passwordHash || ''), passwordUpdatedAt: now, updatedAt: now, tokenVersion: u.tokenVersion + 1 } : u));
    saveUsersFile({ v: 1, users: nextUsers });
    return nextUsers.find((u) => u.id === id) || null;
};

export const deleteUser = (userId: string) => {
    const { users } = loadUsersFile();
    const id = String(userId || '').trim();
    const existing = users.find((u) => u.id === id) || null;
    if (!existing) return null;
    const nextUsers = users.filter((u) => u.id !== id);
    saveUsersFile({ v: 1, users: nextUsers });
    return existing;
};
