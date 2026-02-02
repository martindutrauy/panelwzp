const TOKEN_KEY = 'app_auth_token';
const USER_KEY = 'app_auth_user';

export const getAuthToken = () => {
    try {
        return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
        return '';
    }
};

export const setAuthToken = (token: string) => {
    try {
        localStorage.setItem(TOKEN_KEY, token);
    } catch {}
};

export const clearAuthToken = () => {
    try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
    } catch {}
};

export type AuthUser = { id: string; username: string; email: string | null; role: 'OWNER' | 'ADMIN' | 'USER' };

export const getAuthUser = (): AuthUser | null => {
    try {
        const raw = localStorage.getItem(USER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<AuthUser>;
        const id = String(parsed?.id || '').trim();
        const username = String(parsed?.username || '').trim();
        const role = String(parsed?.role || '').toUpperCase();
        if (!id || !username) return null;
        if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'USER') return null;
        const email = parsed?.email ? String(parsed.email).trim() : null;
        return { id, username, email, role: role as any };
    } catch {
        return null;
    }
};

export const setAuthUser = (user: AuthUser) => {
    try {
        localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch {}
};
