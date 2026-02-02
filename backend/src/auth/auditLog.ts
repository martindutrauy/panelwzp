import fs from 'fs';
import path from 'path';
import { dbPath } from '../config/paths';
import type { AuditEvent, Role } from './types';

const AUDIT_FILE = dbPath('security', 'audit.log');

export const appendAuditEvent = (evt: Omit<AuditEvent, 'v' | 'at'> & { at?: number }) => {
    const record: AuditEvent = {
        v: 1,
        at: typeof evt.at === 'number' ? evt.at : Date.now(),
        actorUserId: evt.actorUserId ?? null,
        actorRole: (evt.actorRole as Role | null) ?? null,
        action: String(evt.action || ''),
        targetUserId: evt.targetUserId ?? null,
        ip: evt.ip ?? null,
        userAgent: evt.userAgent ?? null,
        meta: evt.meta
    };
    const dir = path.dirname(AUDIT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
        fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {}
};

export const readAuditTail = (limit: number = 200) => {
    try {
        if (!fs.existsSync(AUDIT_FILE)) return [];
        const raw = fs.readFileSync(AUDIT_FILE, 'utf8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const tail = lines.slice(Math.max(0, lines.length - Math.max(1, limit)));
        const parsed: AuditEvent[] = [];
        for (const line of tail) {
            try {
                const obj = JSON.parse(line) as AuditEvent;
                if (obj?.v === 1 && typeof obj.at === 'number' && typeof obj.action === 'string') parsed.push(obj);
            } catch {}
        }
        return parsed;
    } catch {
        return [];
    }
};
