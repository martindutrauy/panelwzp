import React, { useEffect, useMemo, useState } from 'react';
import { Button, Divider, Input, Modal, Select, Space, Switch, Table, Tabs, Typography, message, Upload } from 'antd';
import { apiFetch } from '../lib/runtime';
import { getAuthUser } from '../lib/auth';

const { Text } = Typography;

export const GlobalSecurityModal = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    const [messageApi, contextHolder] = message.useMessage();
    const [me, setMe] = useState<{ id: string; username: string; email: string | null; role: 'OWNER' | 'ADMIN' | 'USER' } | null>(() => getAuthUser());
    const [loadingMe, setLoadingMe] = useState(false);

    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmNewPassword, setConfirmNewPassword] = useState('');
    const [changingPassword, setChangingPassword] = useState(false);

    const [users, setUsers] = useState<any[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(false);
    const [createUsername, setCreateUsername] = useState('');
    const [createEmail, setCreateEmail] = useState('');
    const [createRole, setCreateRole] = useState<'USER' | 'ADMIN'>('USER');
    const [createPassword, setCreatePassword] = useState('');
    const [creatingUser, setCreatingUser] = useState(false);

    const [sessions, setSessions] = useState<any[]>([]);
    const [loadingSessions, setLoadingSessions] = useState(false);
    const [revokingAll, setRevokingAll] = useState(false);

    const [userStats, setUserStats] = useState<any[]>([]);
    const [loadingUserStats, setLoadingUserStats] = useState(false);
    const [statsRole, setStatsRole] = useState<'ALL' | 'OWNER' | 'ADMIN' | 'USER'>('ALL');
    const [statsQ, setStatsQ] = useState('');

    const [audit, setAudit] = useState<any[]>([]);
    const [loadingAudit, setLoadingAudit] = useState(false);
    const [auditLimit, setAuditLimit] = useState(2000);
    const [auditFrom, setAuditFrom] = useState('');
    const [auditTo, setAuditTo] = useState('');
    const [auditActor, setAuditActor] = useState<string>('ALL');
    const [auditTarget, setAuditTarget] = useState<string>('ALL');
    const [auditAction, setAuditAction] = useState('');

    // Logo del panel
    const [panelLogo, setPanelLogo] = useState<string | null>(() => localStorage.getItem('panelLogo') || null);

    const formatTime = (ms: number) => {
        try {
            return new Date(ms).toLocaleString('es');
        } catch {
            return String(ms);
        }
    };

    const formatDuration = (ms: number) => {
        const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    };

    const downloadExcel = (fileName: string, rows: Record<string, any>[]) => {
        const escapeHtml = (v: any) => {
            const s = v === null || v === undefined ? '' : String(v);
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        };
        const headerSet = new Set<string>();
        const headers: string[] = [];
        for (const r of rows || []) {
            for (const k of Object.keys(r || {})) {
                if (headerSet.has(k)) continue;
                headerSet.add(k);
                headers.push(k);
            }
        }
        const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
        const body = (rows || [])
            .map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml((r as any)?.[h])}</td>`).join('')}</tr>`)
            .join('');
        const html = `\ufeff<html><head><meta charset="utf-8"></head><body><table>${head}${body}</table></body></html>`;
        const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    const loadMe = async () => {
        if (loadingMe) return;
        setLoadingMe(true);
        try {
            const res = await apiFetch('/api/auth/me');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al cargar usuario'));
            setMe({ id: String(data.id), username: String(data.username), email: data.email ? String(data.email) : null, role: String(data.role).toUpperCase() as any });
        } catch {
        } finally {
            setLoadingMe(false);
        }
    };

    const loadUsers = async () => {
        if (loadingUsers) return;
        setLoadingUsers(true);
        try {
            const res = await apiFetch('/api/security/users');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al cargar usuarios'));
            setUsers(Array.isArray(data?.users) ? data.users : []);
        } catch (e: any) {
            messageApi.error(String(e?.message || 'Error al cargar usuarios'));
        } finally {
            setLoadingUsers(false);
        }
    };

    const loadSessions = async () => {
        if (loadingSessions) return;
        setLoadingSessions(true);
        try {
            const res = await apiFetch('/api/security/sessions');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al cargar sesiones'));
            setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
        } catch (e: any) {
            messageApi.error(String(e?.message || 'Error al cargar sesiones'));
        } finally {
            setLoadingSessions(false);
        }
    };

    const loadUserStats = async () => {
        if (loadingUserStats) return;
        setLoadingUserStats(true);
        try {
            const res = await apiFetch('/api/security/stats/users');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al cargar estadísticas'));
            setUserStats(Array.isArray(data?.users) ? data.users : []);
        } catch (e: any) {
            messageApi.error(String(e?.message || 'Error al cargar estadísticas'));
        } finally {
            setLoadingUserStats(false);
        }
    };

    const loadAudit = async () => {
        if (loadingAudit) return;
        setLoadingAudit(true);
        try {
            const p = new URLSearchParams();
            p.set('limit', String(auditLimit));
            if (auditFrom.trim()) p.set('from', auditFrom.trim());
            if (auditTo.trim()) p.set('to', auditTo.trim());
            if (auditActor !== 'ALL') p.set('actorUserId', auditActor);
            if (auditTarget !== 'ALL') p.set('targetUserId', auditTarget);
            if (auditAction.trim()) p.set('action', auditAction.trim());
            const res = await apiFetch(`/api/security/audit/query?${p.toString()}`);
            const data = await res.json().catch(() => ([]));
            if (!res.ok) throw new Error('Error al cargar logs');
            setAudit(Array.isArray(data) ? data : []);
        } catch (e: any) {
            messageApi.error(String(e?.message || 'Error al cargar logs'));
        } finally {
            setLoadingAudit(false);
        }
    };

    useEffect(() => {
        if (!open) return;
        void loadMe();
        void loadSessions();
        if (me?.role === 'ADMIN' || me?.role === 'OWNER') void loadUserStats();
        void loadAudit();
        if (me?.role === 'ADMIN' || me?.role === 'OWNER') void loadUsers();
    }, [open]);

    const submitPasswordChange = async () => {
        if (changingPassword) return;
        if (me?.role === 'OWNER') {
            messageApi.error('La contraseña del propietario del sistema no puede modificarse desde la interfaz web.');
            return;
        }
        if (!currentPassword.trim()) {
            messageApi.error('Ingresá tu contraseña actual');
            return;
        }
        if (newPassword !== confirmNewPassword) {
            messageApi.error('Las contraseñas no coinciden');
            return;
        }
        setChangingPassword(true);
        try {
            const res = await apiFetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al cambiar contraseña'));
            messageApi.success('Contraseña actualizada. Se cerrarán sesiones activas.');
            setCurrentPassword('');
            setNewPassword('');
            setConfirmNewPassword('');
        } catch (error: any) {
            messageApi.error(String(error?.message || 'Error al cambiar contraseña'));
        } finally {
            setChangingPassword(false);
        }
    };

    const canManageUsers = me?.role === 'OWNER' || me?.role === 'ADMIN';
    const canEmergency = me?.role === 'OWNER';

    const userColumns = useMemo(() => {
        return [
            { title: 'Usuario', dataIndex: 'username', key: 'username' },
            { title: 'Email', dataIndex: 'email', key: 'email', render: (v: any) => v || '-' },
            { title: 'Rol', dataIndex: 'role', key: 'role' },
            {
                title: 'Activo',
                key: 'disabled',
                render: (_: any, r: any) => (
                    <Switch
                        checked={!r.disabled}
                        disabled={me?.role === 'ADMIN' && r.role !== 'USER'}
                        onChange={async (checked) => {
                            try {
                                const res = await apiFetch(`/api/security/users/${r.id}`, {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ disabled: !checked })
                                });
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                setUsers((prev) => prev.map((u) => (u.id === r.id ? data.user : u)));
                            } catch (e: any) {
                                messageApi.error(String(e?.message || 'Error'));
                            }
                        }}
                    />
                )
            },
            {
                title: 'Acciones',
                key: 'actions',
                render: (_: any, r: any) => (
                    <Space>
                        {me?.role === 'OWNER' && (
                            <Select
                                value={r.role}
                                style={{ width: 110 }}
                                onChange={async (val) => {
                                    try {
                                        const res = await apiFetch(`/api/security/users/${r.id}`, {
                                            method: 'PATCH',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ role: val })
                                        });
                                        const data = await res.json().catch(() => ({}));
                                        if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                        setUsers((prev) => prev.map((u) => (u.id === r.id ? data.user : u)));
                                    } catch (e: any) {
                                        messageApi.error(String(e?.message || 'Error'));
                                    }
                                }}
                                options={[
                                    { value: 'USER', label: 'USER' },
                                    { value: 'ADMIN', label: 'ADMIN' }
                                ]}
                            />
                        )}
                        <Button
                            size="small"
                            onClick={async () => {
                                try {
                                    const res = await apiFetch(`/api/security/users/${r.id}/close-sessions`, { method: 'POST' });
                                    const data = await res.json().catch(() => ({}));
                                    if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                    messageApi.success('Sesiones cerradas');
                                    void loadSessions();
                                } catch (e: any) {
                                    messageApi.error(String(e?.message || 'Error'));
                                }
                            }}
                        >
                            Cerrar sesiones
                        </Button>
                        <Button
                            size="small"
                            disabled={me?.role === 'ADMIN' && r.role !== 'USER'}
                            onClick={async () => {
                                const np = prompt('Nueva contraseña');
                                if (!np) return;
                                try {
                                    const res = await apiFetch(`/api/security/users/${r.id}/reset-password`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ newPassword: np })
                                    });
                                    const data = await res.json().catch(() => ({}));
                                    if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                    messageApi.success('Contraseña reseteada');
                                } catch (e: any) {
                                    messageApi.error(String(e?.message || 'Error'));
                                }
                            }}
                        >
                            Reset Pass
                        </Button>
                        <Button
                            danger
                            size="small"
                            disabled={me?.role === 'ADMIN' && r.role !== 'USER'}
                            onClick={async () => {
                                const ok = window.confirm(`Eliminar usuario ${r.username}?`);
                                if (!ok) return;
                                try {
                                    const res = await apiFetch(`/api/security/users/${r.id}`, { method: 'DELETE' });
                                    const data = await res.json().catch(() => ({}));
                                    if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                    messageApi.success('Usuario eliminado');
                                    void loadUsers();
                                    void loadSessions();
                                } catch (e: any) {
                                    messageApi.error(String(e?.message || 'Error'));
                                }
                            }}
                        >
                            Eliminar
                        </Button>
                    </Space>
                )
            }
        ];
    }, [me?.role, users]);

    const sessionColumns = useMemo(() => {
        return [
            { title: 'Session', dataIndex: 'id', key: 'id', width: 120, render: (v: any) => String(v).slice(0, 8) },
            { title: 'Usuario', key: 'user', width: 180, render: (_: any, r: any) => `${r?.user?.username || r.userId} (${r?.user?.role || '-'})` },
            { title: 'Inicio', dataIndex: 'createdAt', key: 'createdAt', render: (v: any) => formatTime(Number(v) || 0) },
            { title: 'Último', dataIndex: 'lastSeenAt', key: 'lastSeenAt', render: (v: any) => formatTime(Number(v) || 0) },
            { title: 'IP', dataIndex: 'ip', key: 'ip', render: (v: any) => v || '-' },
            { title: 'UA', dataIndex: 'userAgent', key: 'userAgent', render: (v: any) => (v ? String(v).slice(0, 40) : '-') },
            { title: 'Revocada', dataIndex: 'revokedAt', key: 'revokedAt', render: (v: any) => (v ? formatTime(Number(v)) : '-') },
            {
                title: 'Acción',
                key: 'action',
                render: (_: any, r: any) => (
                    <Button
                        size="small"
                        disabled={Boolean(r.revokedAt)}
                        onClick={async () => {
                            try {
                                const res = await apiFetch(`/api/security/sessions/${r.id}/revoke`, { method: 'POST' });
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                messageApi.success('Sesión revocada');
                                void loadSessions();
                            } catch (e: any) {
                                messageApi.error(String(e?.message || 'Error'));
                            }
                        }}
                    >
                        Revocar
                    </Button>
                )
            }
        ];
    }, [sessions]);

    const filteredUserStats = useMemo(() => {
        const q = statsQ.trim().toLowerCase();
        return (userStats || []).filter((r: any) => {
            if (statsRole !== 'ALL' && String(r?.role || '') !== statsRole) return false;
            if (!q) return true;
            const hay = `${r?.username || ''} ${r?.email || ''} ${r?.role || ''}`.toLowerCase();
            return hay.includes(q);
        });
    }, [userStats, statsRole, statsQ]);

    const userOptions = useMemo(() => {
        const base = (users || []).map((u: any) => ({ value: String(u.id), label: `${u.username} (${u.role})` }));
        return [{ value: 'ALL', label: 'Todos' }, ...base];
    }, [users]);

    return (
        <Modal open={open} title="Seguridad" onCancel={onClose} footer={null} width={900}>
            {contextHolder}
            <Tabs
                items={[
                    {
                        key: 'auth',
                        label: 'Autenticación',
                        children: (
                            <div>
                                <Typography.Title level={5}>Política de contraseñas</Typography.Title>
                                <Text style={{ color: '#8696a0' }}>
                                    Mínimo recomendado: 10+ caracteres con letras y números. Cambios de contraseña invalidan sesiones.
                                </Text>
                                <Divider />
                                <Typography.Title level={5}>Cambio de contraseña</Typography.Title>
                                {me?.role === 'OWNER' ? (
                                    <Text>La contraseña del propietario del sistema no puede modificarse desde la interfaz web.</Text>
                                ) : (
                                    <Space direction="vertical" style={{ width: 380 }}>
                                        <Input.Password value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Contraseña actual" />
                                        <Input.Password value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Nueva contraseña" />
                                        <Input.Password value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} placeholder="Confirmar nueva contraseña" onPressEnter={submitPasswordChange} />
                                        <Button type="primary" onClick={submitPasswordChange} loading={changingPassword}>
                                            Cambiar contraseña
                                        </Button>
                                    </Space>
                                )}
                            </div>
                        )
                    },
                    canManageUsers
                        ? {
                              key: 'users',
                              label: 'Usuarios',
                              children: (
                                  <div>
                                      <Space direction="vertical" style={{ width: '100%' }}>
                                          <Typography.Title level={5}>Crear usuario</Typography.Title>
                                          <Space wrap>
                                              <Input value={createUsername} onChange={(e) => setCreateUsername(e.target.value)} placeholder="username" style={{ width: 160 }} />
                                              <Input value={createEmail} onChange={(e) => setCreateEmail(e.target.value)} placeholder="email (opcional)" style={{ width: 220 }} />
                                              <Select
                                                  value={createRole}
                                                  onChange={(v) => setCreateRole(v)}
                                                  style={{ width: 120 }}
                                                  options={me?.role === 'OWNER'
                                                      ? [
                                                            { value: 'USER', label: 'USER' },
                                                            { value: 'ADMIN', label: 'ADMIN' }
                                                        ]
                                                      : [{ value: 'USER', label: 'USER' }]}
                                                  disabled={me?.role !== 'OWNER'}
                                              />
                                              <Input.Password value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} placeholder="password" style={{ width: 200 }} />
                                              <Button
                                                  type="primary"
                                                  loading={creatingUser}
                                                  onClick={async () => {
                                                      if (creatingUser) return;
                                                      if (!createUsername.trim() || !createPassword.trim()) {
                                                          messageApi.error('username y password requeridos');
                                                          return;
                                                      }
                                                      setCreatingUser(true);
                                                      try {
                                                          const res = await apiFetch('/api/security/users', {
                                                              method: 'POST',
                                                              headers: { 'Content-Type': 'application/json' },
                                                              body: JSON.stringify({
                                                                  username: createUsername,
                                                                  email: createEmail.trim() || undefined,
                                                                  role: me?.role === 'OWNER' ? createRole : 'USER',
                                                                  password: createPassword
                                                              })
                                                          });
                                                          const data = await res.json().catch(() => ({}));
                                                          if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                                          messageApi.success('Usuario creado');
                                                          setCreateUsername('');
                                                          setCreateEmail('');
                                                          setCreatePassword('');
                                                          void loadUsers();
                                                      } catch (e: any) {
                                                          messageApi.error(String(e?.message || 'Error'));
                                                      } finally {
                                                          setCreatingUser(false);
                                                      }
                                                  }}
                                              >
                                                  Crear
                                              </Button>
                                          </Space>
                                          <Divider />
                                          <Typography.Title level={5}>Usuarios</Typography.Title>
                                          <Table rowKey="id" loading={loadingUsers} dataSource={users} columns={userColumns as any} pagination={{ pageSize: 8 }} />
                                      </Space>
                                  </div>
                              )
                          }
                        : null,
                    {
                        key: 'sessions',
                        label: 'Sesiones',
                        children: (
                            <div>
                                <Space style={{ marginBottom: 12 }}>
                                    <Button onClick={loadSessions} loading={loadingSessions}>
                                        Recargar
                                    </Button>
                                    {me?.role === 'OWNER' && (
                                        <Button
                                            danger
                                            loading={revokingAll}
                                            onClick={async () => {
                                                if (revokingAll) return;
                                                setRevokingAll(true);
                                                try {
                                                    const res = await apiFetch('/api/security/sessions/revoke-all', { method: 'POST' });
                                                    const data = await res.json().catch(() => ({}));
                                                    if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                                    messageApi.success('Sesiones revocadas');
                                                    void loadSessions();
                                                } catch (e: any) {
                                                    messageApi.error(String(e?.message || 'Error'));
                                                } finally {
                                                    setRevokingAll(false);
                                                }
                                            }}
                                        >
                                            Cerrar TODAS las sesiones
                                        </Button>
                                    )}
                                </Space>
                                <Table rowKey="id" loading={loadingSessions} dataSource={sessions} columns={sessionColumns as any} pagination={{ pageSize: 8 }} />
                            </div>
                        )
                    },
                    {
                        key: 'stats',
                        label: 'Estadísticas',
                        children: (
                            <div>
                                <Space style={{ marginBottom: 12 }}>
                                    <Button onClick={loadUserStats} loading={loadingUserStats}>
                                        Recargar
                                    </Button>
                                    <Select
                                        value={statsRole}
                                        style={{ width: 140 }}
                                        onChange={(v) => setStatsRole(v)}
                                        options={[
                                            { value: 'ALL', label: 'Todos' },
                                            { value: 'OWNER', label: 'OWNER' },
                                            { value: 'ADMIN', label: 'ADMIN' },
                                            { value: 'USER', label: 'USER' }
                                        ]}
                                    />
                                    <Input
                                        value={statsQ}
                                        onChange={(e) => setStatsQ(e.target.value)}
                                        placeholder="Buscar usuario"
                                        style={{ width: 220 }}
                                    />
                                    <Button
                                        onClick={() => {
                                            const rows = filteredUserStats.map((r: any) => ({
                                                username: r.username,
                                                role: r.role,
                                                messagesSent: r.messagesSent,
                                                quickRepliesUsed: r.quickRepliesUsed,
                                                responseAvgSec: r.responseAvgMs ? Math.round(Number(r.responseAvgMs) / 1000) : '',
                                                responseSamples: r.responseSamples,
                                                connectedCurrent: formatDuration(Number(r.connectedMsCurrent) || 0),
                                                connectedTotal: formatDuration(Number(r.connectedMsTotal) || 0),
                                                activeSessions: r.activeSessions,
                                                lastSeenAt: r.lastSeenAt ? formatTime(Number(r.lastSeenAt)) : ''
                                            }));
                                            downloadExcel(`estadisticas-usuarios.xls`, rows);
                                        }}
                                    >
                                        Exportar Excel
                                    </Button>
                                    <Text style={{ color: '#8696a0' }}>Mensajes enviados, tiempos y uso de respuestas rápidas.</Text>
                                </Space>
                                <Table
                                    rowKey="id"
                                    loading={loadingUserStats}
                                    dataSource={filteredUserStats}
                                    columns={[
                                        { title: 'Usuario', dataIndex: 'username', key: 'username' },
                                        { title: 'Rol', dataIndex: 'role', key: 'role', width: 90 },
                                        { title: 'Conectado', dataIndex: 'connectedMsCurrent', key: 'connectedMsCurrent', render: (v: any) => formatDuration(Number(v) || 0) },
                                        { title: 'Total', dataIndex: 'connectedMsTotal', key: 'connectedMsTotal', render: (v: any) => formatDuration(Number(v) || 0) },
                                        { title: 'Sesiones', dataIndex: 'activeSessions', key: 'activeSessions', width: 90 },
                                        { title: 'Msgs', dataIndex: 'messagesSent', key: 'messagesSent', width: 80 },
                                        { title: 'Resp. rápidas', dataIndex: 'quickRepliesUsed', key: 'quickRepliesUsed', width: 120 },
                                        {
                                            title: 'Prom. respuesta',
                                            dataIndex: 'responseAvgMs',
                                            key: 'responseAvgMs',
                                            render: (v: any, r: any) => (v ? `${Math.round(Number(v) / 1000)}s (${Number(r?.responseSamples || 0)})` : '-')
                                        },
                                        { title: 'Último', dataIndex: 'lastSeenAt', key: 'lastSeenAt', render: (v: any) => (v ? formatTime(Number(v)) : '-') }
                                    ]}
                                    pagination={{ pageSize: 10 }}
                                />
                            </div>
                        )
                    },
                    {
                        key: 'logs',
                        label: 'Logs',
                        children: (
                            <div>
                                <Space style={{ marginBottom: 12 }}>
                                    <Button onClick={loadAudit} loading={loadingAudit}>
                                        Recargar
                                    </Button>
                                    <Input
                                        type="number"
                                        value={String(auditLimit)}
                                        onChange={(e) => setAuditLimit(Math.max(100, Math.min(10000, Number(e.target.value) || 2000)))}
                                        style={{ width: 110 }}
                                    />
                                    <Input type="datetime-local" value={auditFrom} onChange={(e) => setAuditFrom(e.target.value)} style={{ width: 210 }} />
                                    <Input type="datetime-local" value={auditTo} onChange={(e) => setAuditTo(e.target.value)} style={{ width: 210 }} />
                                    <Select value={auditActor} onChange={(v) => setAuditActor(v)} style={{ width: 220 }} options={userOptions} />
                                    <Select value={auditTarget} onChange={(v) => setAuditTarget(v)} style={{ width: 220 }} options={userOptions} />
                                    <Input value={auditAction} onChange={(e) => setAuditAction(e.target.value)} placeholder="Acción contiene..." style={{ width: 180 }} />
                                    <Button
                                        onClick={() => {
                                            const rows = (audit || []).map((e: any) => ({
                                                at: e.at ? formatTime(Number(e.at)) : '',
                                                actor: e.actor ? `${e.actor.username} (${e.actor.role})` : e.actorUserId || '',
                                                action: e.action,
                                                target: e.target ? `${e.target.username} (${e.target.role})` : e.targetUserId || '',
                                                ip: e.ip || '',
                                                userAgent: e.userAgent || '',
                                                meta: e.meta ? JSON.stringify(e.meta) : ''
                                            }));
                                            downloadExcel(`logs.xls`, rows);
                                        }}
                                    >
                                        Exportar Excel
                                    </Button>
                                    <Text style={{ color: '#8696a0' }}>Inmutables (no se borran desde la UI)</Text>
                                </Space>
                                <Table
                                    rowKey={(r: any) => `${r.at}-${r.action}-${r.actorUserId}`}
                                    loading={loadingAudit}
                                    dataSource={audit}
                                    columns={[
                                        { title: 'Fecha', dataIndex: 'at', key: 'at', render: (v: any) => formatTime(Number(v) || 0) },
                                        { title: 'Actor', key: 'actor', render: (_: any, r: any) => (r?.actor ? `${r.actor.username} (${r.actor.role})` : r.actorUserId || '-') },
                                        { title: 'Acción', dataIndex: 'action', key: 'action' },
                                        { title: 'Target', key: 'target', render: (_: any, r: any) => (r?.target ? `${r.target.username} (${r.target.role})` : r.targetUserId || '-') },
                                        { title: 'IP', dataIndex: 'ip', key: 'ip', render: (v: any) => v || '-' },
                                        { title: 'Meta', key: 'meta', render: (_: any, r: any) => (r?.meta ? String(JSON.stringify(r.meta)).slice(0, 80) : '-') }
                                    ]}
                                    pagination={{ pageSize: 10 }}
                                />
                            </div>
                        )
                    },
                    {
                        key: 'logo',
                        label: '🖼️ Logo',
                        children: (
                            <div>
                                <Typography.Title level={5}>Logo del Panel</Typography.Title>
                                <Text style={{ color: '#8696a0', display: 'block', marginBottom: 16 }}>
                                    Personaliza el panel con tu logo. Aparecerá en el header del modal principal.
                                </Text>
                                
                                <div style={{ 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    gap: 20, 
                                    padding: 20, 
                                    background: 'rgba(255,255,255,0.05)', 
                                    borderRadius: 8,
                                    marginBottom: 20
                                }}>
                                    {panelLogo ? (
                                        <img 
                                            src={panelLogo} 
                                            alt="Logo actual" 
                                            style={{ 
                                                height: 60, 
                                                width: 'auto', 
                                                maxWidth: 180, 
                                                objectFit: 'contain', 
                                                borderRadius: 4, 
                                                border: '1px solid #444' 
                                            }} 
                                        />
                                    ) : (
                                        <div style={{ 
                                            width: 120, 
                                            height: 60, 
                                            border: '2px dashed #444', 
                                            borderRadius: 4, 
                                            display: 'flex', 
                                            alignItems: 'center', 
                                            justifyContent: 'center',
                                            color: '#666'
                                        }}>
                                            Sin logo
                                        </div>
                                    )}
                                    <div>
                                        <Text style={{ color: panelLogo ? '#52c41a' : '#8696a0' }}>
                                            {panelLogo ? '✓ Logo configurado' : 'No hay logo configurado'}
                                        </Text>
                                    </div>
                                </div>

                                <Space direction="vertical" style={{ width: '100%' }}>
                                    <Upload
                                        accept="image/*"
                                        showUploadList={false}
                                        beforeUpload={(file) => {
                                            const reader = new FileReader();
                                            reader.onload = (e) => {
                                                const base64 = e.target?.result as string;
                                                setPanelLogo(base64);
                                                localStorage.setItem('panelLogo', base64);
                                                messageApi.success('Logo actualizado correctamente');
                                            };
                                            reader.readAsDataURL(file);
                                            return false;
                                        }}
                                    >
                                        <Button type="primary" style={{ width: 200 }}>
                                            📷 Subir logo
                                        </Button>
                                    </Upload>
                                    
                                    {panelLogo && (
                                        <Button 
                                            danger 
                                            style={{ width: 200 }}
                                            onClick={() => {
                                                setPanelLogo(null);
                                                localStorage.removeItem('panelLogo');
                                                messageApi.info('Logo eliminado');
                                            }}
                                        >
                                            🗑️ Eliminar logo
                                        </Button>
                                    )}
                                </Space>

                                <Divider />
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                    Formatos soportados: PNG, JPG, GIF, SVG. El logo se guarda en tu navegador.
                                </Text>
                            </div>
                        )
                    },
                    canEmergency
                        ? {
                              key: 'emergency',
                              label: 'Emergencia',
                              children: (
                                  <div>
                                      <Typography.Title level={5}>Emergency Lock</Typography.Title>
                                      <Text style={{ color: '#8696a0' }}>
                                          Cierra sesiones, bloquea usuarios y mantiene solo OWNER activo.
                                      </Text>
                                      <Divider />
                                      <Button
                                          danger
                                          onClick={async () => {
                                              const ok = window.confirm('Activar Emergency Lock?');
                                              if (!ok) return;
                                              try {
                                                  const res = await apiFetch('/api/security/emergency-lock', { method: 'POST' });
                                                  const data = await res.json().catch(() => ({}));
                                                  if (!res.ok) throw new Error(String(data?.error || 'Error'));
                                                  messageApi.success('Emergency Lock activado');
                                              } catch (e: any) {
                                                  messageApi.error(String(e?.message || 'Error'));
                                              }
                                          }}
                                      >
                                          Activar Emergency Lock
                                      </Button>
                                      
                                      <Divider />
                                      <Typography.Title level={5}>🔄 Reset de Cache de Dispositivos</Typography.Title>
                                      <Text style={{ color: '#8696a0', display: 'block', marginBottom: 12 }}>
                                          Limpia el cache de chats, contactos y mensajes de todos los dispositivos. Útil si ves nombres incorrectos o datos mezclados.
                                      </Text>
                                      <Button
                                          danger
                                          onClick={async () => {
                                              const ok = window.confirm('¿Resetear cache de TODOS los dispositivos? Los chats se recargarán con datos frescos.');
                                              if (!ok) return;
                                              try {
                                                  // Obtener lista de dispositivos
                                                  const devRes = await apiFetch('/api/devices');
                                                  const devices = await devRes.json();
                                                  if (!Array.isArray(devices) || devices.length === 0) {
                                                      messageApi.warning('No hay dispositivos para resetear');
                                                      return;
                                                  }
                                                  
                                                  let resetCount = 0;
                                                  for (const dev of devices) {
                                                      try {
                                                          const res = await apiFetch(`/api/devices/${dev.id}/reset-cache`, { method: 'POST' });
                                                          const data = await res.json();
                                                          if (data.success) resetCount++;
                                                      } catch {
                                                          // Ignorar errores individuales
                                                      }
                                                  }
                                                  
                                                  messageApi.success(`Cache reseteado en ${resetCount}/${devices.length} dispositivo(s). Recargando...`);
                                                  setTimeout(() => window.location.reload(), 2000);
                                              } catch (e: any) {
                                                  messageApi.error(String(e?.message || 'Error al resetear cache'));
                                              }
                                          }}
                                      >
                                          Resetear Cache de Todos los Dispositivos
                                      </Button>
                                  </div>
                              )
                          }
                        : null
                ].filter(Boolean) as any}
            />
        </Modal>
    );
};
