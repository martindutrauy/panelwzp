import bcrypt from 'bcryptjs';

export const hashPassword = async (password: string) => {
    const value = String(password || '').trim();
    if (!value) throw new Error('password requerido');
    const roundsRaw = Number(process.env.APP_BCRYPT_ROUNDS);
    const rounds = Number.isFinite(roundsRaw) ? Math.max(10, Math.min(14, Math.floor(roundsRaw))) : 12;
    return bcrypt.hash(value, rounds);
};

export const verifyPassword = async (password: string, passwordHash: string) => {
    try {
        const value = String(password || '');
        const hash = String(passwordHash || '');
        if (!value || !hash) return false;
        return await bcrypt.compare(value, hash);
    } catch {
        return false;
    }
};

export const validatePasswordPolicy = (password: string) => {
    const value = String(password || '');
    const minLenRaw = Number(process.env.APP_PASSWORD_MIN_LEN);
    const minLen = Number.isFinite(minLenRaw) ? Math.max(8, Math.min(128, Math.floor(minLenRaw))) : 10;
    if (value.trim().length < minLen) return { ok: false as const, error: `La contraseña debe tener al menos ${minLen} caracteres` };
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return { ok: false as const, error: 'La contraseña debe contener letras y números' };
    return { ok: true as const };
};

