import React, { useEffect, useMemo, useState } from 'react';
import { Button, Divider, Input, Modal, Select, Space, Switch, Table, Tabs, Typography, message } from 'antd';
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

    const [otpInitSecret, setOtpInitSecret] = useState('');
    const [otpAuthUrl, setOtpAuthUrl] = useState('');
    const [otpCode, setOtpCode] = useState('');
    const [otpPassword, setOtpPassword] = useState('');
    const [otpBusy, setOtpBusy] = useState(false);

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

    const [audit, setAudit] = useState<any[]>([]);
    const [loadingAudit, setLoadingAudit] = useState(false);

    const formatTime = (ms: number) => {
        try {
            return new Date(ms).toLocaleString('es');
        } catch {
            return String(ms);
        }
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

    const loadAudit = async () => {
        if (loadingAudit) return;
        setLoadingAudit(true);
        try {
            const res = await apiFetch('/api/security/audit?limit=200');
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

    const start2faSetup = async () => {
        if (otpBusy) return;
        setOtpBusy(true);
        try {
            const res = await apiFetch('/api/security/2fa/init', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al iniciar 2FA'));
            setOtpInitSecret(String(data?.secret || ''));
            setOtpAuthUrl(String(data?.otpauthUrl || ''));
            messageApi.success('2FA listo para configurar');
        } catch (e: any) {
            messageApi.error(String(e?.message || 'Error al iniciar 2FA'));
        } finally {
            setOtpBusy(false);
        }
    };

    const confirm2faSetup = async () => {
        if (otpBusy) return;
        if (!otpInitSecret) {
            messageApi.error('Primero generá el secreto');
            return;
        }
        if (!otpPassword.trim()) {
            messageApi.error('Ingresá tu contraseña actual');
            return;
        }
        if (!otpCode.trim()) {
            messageApi.error('Ingresá el código 2FA');
            return;
        }
        setOtpBusy(true);
        try {
            const res = await apiFetch('/api/security/2fa/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ secret: otpInitSecret, code: otpCode, currentPassword: otpPassword })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(String(data?.error || 'Error al confirmar 2FA'));
            messageApi.success('2FA activado. Vas a tener que volver a iniciar sesión.');
            setOtpInitSecret('');
            setOtpAuthUrl('');
            setOtpCode('');
            setOtpPassword('');
        } catch (e: any) {
            messageApi.error(String(e?.message || 'Error al confirmar 2FA'));
        } finally {
            setOtpBusy(false);
        }
    };

    const canManageUsers = me?.role === 'OWNER' || me?.role === 'ADMIN';
    const canEmergency = me?.role === 'OWNER';

    const userColumns = useMemo(() => {
        return [
            { title: 'Usuario', dataIndex: 'username', key: 'username' },
            { title: 'Email', dataIndex: 'email', key: 'email', render: (v: any) => v || '-' },
            { title: 'Rol', dataIndex: 'role', key: 'role' },
            { title: '2FA', key: 'twoFactorEnabled', render: (_: any, r: any) => (r.twoFactorEnabled ? 'Sí' : 'No') },
            {
                title: 'Activo',
                key: 'disabled',
                render: (_: any, r: any) => (
                    <Switch
                        checked={!r.disabled}
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
                    </Space>
                )
            }
        ];
    }, [me?.role, users]);

    const sessionColumns = useMemo(() => {
        return [
            { title: 'Session', dataIndex: 'id', key: 'id', width: 120, render: (v: any) => String(v).slice(0, 8) },
            { title: 'User', dataIndex: 'userId', key: 'userId', width: 120 },
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
                                <Divider />
                                <Typography.Title level={5}>2FA (TOTP)</Typography.Title>
                                <Space direction="vertical" style={{ width: 520 }}>
                                    <Button onClick={start2faSetup} loading={otpBusy}>
                                        Generar secreto 2FA
                                    </Button>
                                    {otpInitSecret && (
                                        <>
                                            <Text copyable>{otpInitSecret}</Text>
                                            <Text copyable>{otpAuthUrl}</Text>
                                            <Input.Password value={otpPassword} onChange={(e) => setOtpPassword(e.target.value)} placeholder="Contraseña actual" />
                                            <Input value={otpCode} onChange={(e) => setOtpCode(e.target.value)} placeholder="Código 2FA (6 dígitos)" />
                                            <Button type="primary" onClick={confirm2faSetup} loading={otpBusy}>
                                                Confirmar 2FA
                                            </Button>
                                        </>
                                    )}
                                </Space>
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
                                                  options={[
                                                      { value: 'USER', label: 'USER' },
                                                      { value: 'ADMIN', label: 'ADMIN' }
                                                  ]}
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
                                                                  role: createRole,
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
                        key: 'logs',
                        label: 'Logs',
                        children: (
                            <div>
                                <Space style={{ marginBottom: 12 }}>
                                    <Button onClick={loadAudit} loading={loadingAudit}>
                                        Recargar
                                    </Button>
                                    <Text style={{ color: '#8696a0' }}>Inmutables (no se borran desde la UI)</Text>
                                </Space>
                                <Table
                                    rowKey={(r: any) => `${r.at}-${r.action}-${r.actorUserId}`}
                                    loading={loadingAudit}
                                    dataSource={audit}
                                    columns={[
                                        { title: 'Fecha', dataIndex: 'at', key: 'at', render: (v: any) => formatTime(Number(v) || 0) },
                                        { title: 'Actor', dataIndex: 'actorUserId', key: 'actorUserId', render: (v: any) => v || '-' },
                                        { title: 'Acción', dataIndex: 'action', key: 'action' },
                                        { title: 'Target', dataIndex: 'targetUserId', key: 'targetUserId', render: (v: any) => v || '-' },
                                        { title: 'IP', dataIndex: 'ip', key: 'ip', render: (v: any) => v || '-' }
                                    ]}
                                    pagination={{ pageSize: 10 }}
                                />
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
                                  </div>
                              )
                          }
                        : null
                ].filter(Boolean) as any}
            />
        </Modal>
    );
};
