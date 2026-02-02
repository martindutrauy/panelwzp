import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const safeReadJson = <T>(filePath: string): T | null => {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as T;
        return parsed;
    } catch {
        return null;
    }
};

export const atomicWriteJson = (filePath: string, value: any) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
};
