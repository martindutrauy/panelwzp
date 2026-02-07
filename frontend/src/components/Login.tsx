import React, { useState } from 'react';
import { Button, Card, Input, Typography, message } from 'antd';
import { apiFetch } from '../lib/runtime';
import { setAuthToken, setAuthUser } from '../lib/auth';

export const Login = ({ onLoggedIn }: { onLoggedIn: () => void }) => {
    const [username, setUsername] = useState('admin');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [messageApi, contextHolder] = message.useMessage();

    const submit = async () => {
        setLoading(true);
        try {
            const res = await apiFetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al iniciar sesión'));
            const token = String(data?.token || '');
            if (!token) throw new Error('Token inválido');
            setAuthToken(token);
            if (data?.user?.id && data?.user?.username && data?.user?.role) {
                setAuthUser({
                    id: String(data.user.id),
                    username: String(data.user.username),
                    email: data.user.email ? String(data.user.email) : null,
                    role: String(data.user.role).toUpperCase() as any
                });
            }
            onLoggedIn();
        } catch (error: any) {
            messageApi.error(String(error?.message || 'Error al iniciar sesión'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b141a' }}>
            {contextHolder}
            <Card style={{ width: 360, background: '#111b21', border: '1px solid #222e35' }}>
                <Typography.Title level={3} style={{ marginTop: 0, color: '#e9edef' }}>
                    Ingresar
                </Typography.Title>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Input
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Usuario"
                        autoComplete="username"
                    />
                    <Input.Password
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Contraseña"
                        autoComplete="current-password"
                        onPressEnter={submit}
                    />
                    <Button type="primary" loading={loading} onClick={submit}>
                        Entrar
                    </Button>
                </div>
            </Card>
        </div>
    );
};
