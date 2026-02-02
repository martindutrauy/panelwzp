export type Role = 'OWNER' | 'ADMIN' | 'USER';

export type AuthUser = {
    id: string;
    username: string;
    email: string | null;
    role: Role;
    disabled: boolean;
    tokenVersion: number;
    twoFactorRequired: boolean;
    twoFactorEnabled: boolean;
};

export type StoredUser = {
    v: 1;
    id: string;
    username: string;
    email: string | null;
    role: Exclude<Role, 'OWNER'>;
    disabled: boolean;
    passwordHash: string;
    tokenVersion: number;
    twoFactorSecretEnc: string | null;
    createdAt: number;
    updatedAt: number;
    passwordUpdatedAt: number;
};

export type StoredUsersFile = {
    v: 1;
    users: StoredUser[];
};

export type OwnerState = {
    v: 1;
    tokenVersion: number;
    twoFactorSecretEnc: string | null;
    twoFactorRequired: boolean;
    emergencyLock: boolean;
    updatedAt: number;
};

export type AppSession = {
    v: 1;
    id: string;
    userId: string;
    createdAt: number;
    lastSeenAt: number;
    ip: string | null;
    userAgent: string | null;
    revokedAt: number | null;
    revokedBy: string | null;
    reason: string | null;
};

export type SessionsFile = {
    v: 1;
    sessions: AppSession[];
};

export type AuditEvent = {
    v: 1;
    at: number;
    actorUserId: string | null;
    actorRole: Role | null;
    action: string;
    targetUserId: string | null;
    ip: string | null;
    userAgent: string | null;
    meta?: Record<string, any>;
};
