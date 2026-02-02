import crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buf: Buffer) => {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const b of buf) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            output += ALPHABET[(value >>> (bits - 5)) & 31]!;
            bits -= 5;
        }
    }
    if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31]!;
    return output;
};

const base32Decode = (input: string) => {
    const s = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of s) {
        const idx = ALPHABET.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
};

const hotp = (secret: Buffer, counter: number) => {
    const buf = Buffer.alloc(8);
    let tmp = counter;
    for (let i = 7; i >= 0; i--) {
        buf[i] = tmp & 0xff;
        tmp = Math.floor(tmp / 256);
    }
    const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
    const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
    const b0 = hmac[offset] ?? 0;
    const b1 = hmac[offset + 1] ?? 0;
    const b2 = hmac[offset + 2] ?? 0;
    const b3 = hmac[offset + 3] ?? 0;
    const code = ((b0 & 0x7f) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff);
    return code % 1_000_000;
};

export const generateTotpSecret = (bytes: number = 20) => {
    const b = crypto.randomBytes(Math.max(10, Math.min(64, bytes)));
    return base32Encode(b);
};

export const buildOtpauthUrl = (opts: { issuer: string; account: string; secretBase32: string }) => {
    const issuer = encodeURIComponent(String(opts.issuer || '').trim() || 'Panel');
    const account = encodeURIComponent(String(opts.account || '').trim() || 'user');
    const secret = encodeURIComponent(String(opts.secretBase32 || '').trim().replace(/\s+/g, ''));
    return `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
};

export const verifyTotpCode = (secretBase32: string, code: string, window: number = 1, nowMs: number = Date.now()) => {
    const secret = base32Decode(String(secretBase32 || '').trim());
    if (!secret.length) return false;
    const value = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(value)) return false;
    const target = Number(value);
    const step = 30_000;
    const counter = Math.floor(nowMs / step);
    const w = Math.max(0, Math.min(5, Math.floor(window)));
    for (let i = -w; i <= w; i++) {
        if (hotp(secret, counter + i) === target) return true;
    }
    return false;
};
