import React, { useEffect, useState } from 'react';
import { Button, Card, Space, Typography, message } from 'antd';
import { Download } from 'lucide-react';
import { apiFetch } from '../lib/runtime';

const { Text, Title } = Typography;

export const ImportMessagesPanel = ({ deviceId, onImported }: { deviceId: string; onImported?: () => void }) => {
    const [messageApi, contextHolder] = message.useMessage();
    const [checking, setChecking] = useState(false);
    const [importing, setImporting] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [status, setStatus] = useState<any | null>(null);

    const refreshStatus = async () => {
        setChecking(true);
        try {
            const res = await apiFetch(`/api/devices/${deviceId}/import-messages/status`);
            const data = await res.json().catch(() => null);
            setStatus(data || null);
        } catch {
            setStatus(null);
        } finally {
            setChecking(false);
        }
    };

    useEffect(() => {
        void refreshStatus();
    }, [deviceId]);

    const doImport = async () => {
        setImporting(true);
        const key = `import-${deviceId}`;
        try {
            messageApi.loading({ content: 'Iniciando importación...', key });
            const res = await apiFetch(`/api/devices/${deviceId}/import-messages`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Error al importar');
            messageApi.success({ content: 'Importación iniciada', key });
            await refreshStatus();
            onImported?.();
        } catch (e: any) {
            messageApi.error({ content: String(e?.message || 'Error al importar'), key });
        } finally {
            setImporting(false);
        }
    };

    const stopImport = async () => {
        setStopping(true);
        const key = `stop-${deviceId}`;
        try {
            messageApi.loading({ content: 'Deteniendo importación...', key });
            const res = await apiFetch(`/api/devices/${deviceId}/import-messages/stop`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Error al detener');
            messageApi.success({ content: 'Detención solicitada', key });
            await refreshStatus();
        } catch (e: any) {
            messageApi.error({ content: String(e?.message || 'Error al detener'), key });
        } finally {
            setStopping(false);
        }
    };

    useEffect(() => {
        if (!status || status?.status !== 'running') return;
        const t = setInterval(() => {
            void refreshStatus();
        }, 2000);
        return () => clearInterval(t);
    }, [status?.status, deviceId]);

    const totalMessages = typeof status?.totalMessages === 'number' ? Number(status.totalMessages) : null;
    const chatsWithMessages = typeof status?.chatsWithMessages === 'number' ? Number(status.chatsWithMessages) : null;
    const isRunning = status?.status === 'running';
    const isEmpty = totalMessages === 0;

    return (
        <div style={{ padding: 20 }}>
            {contextHolder}
            <Card style={{ background: '#111b21', borderColor: '#222e35' }}>
                <Title level={4} style={{ color: '#e9edef', marginTop: 0 }}>
                    <Space>
                        <Download size={18} />
                        Importar mensajes
                    </Space>
                </Title>
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    <Text style={{ color: '#8696a0' }}>
                        Importa todos los mensajes posibles desde el dispositivo (según el máximo que WhatsApp permita).
                    </Text>
                    <Text style={{ color: '#8696a0' }}>
                        Solo se habilita si el dispositivo está vacío en el panel.
                    </Text>
                    {status && (
                        <Text style={{ color: '#8696a0' }}>
                            Estado: <span style={{ color: '#e9edef' }}>{String(status?.status || '—')}</span>
                            {status?.phase ? <span style={{ color: '#8696a0' }}> · Fase: <span style={{ color: '#e9edef' }}>{String(status.phase)}</span></span> : null}
                        </Text>
                    )}
                    {typeof status?.progress === 'number' && (
                        <Text style={{ color: '#8696a0' }}>
                            Progreso sync: <span style={{ color: '#e9edef' }}>{Math.round(Number(status.progress) * 100)}%</span>
                        </Text>
                    )}
                    {status?.currentChatId && (
                        <Text style={{ color: '#8696a0' }}>
                            Chat actual: <span style={{ color: '#e9edef' }}>{String(status.currentChatId)}</span>
                        </Text>
                    )}
                    {typeof status?.chatsTotal === 'number' && typeof status?.chatsProcessed === 'number' && (
                        <Text style={{ color: '#8696a0' }}>
                            Chats: <span style={{ color: '#e9edef' }}>{Number(status.chatsProcessed)}/{Number(status.chatsTotal)}</span>
                        </Text>
                    )}
                    <Space wrap>
                        <Button onClick={() => void refreshStatus()} loading={checking}>
                            Rechequear
                        </Button>
                        <Button
                            type="primary"
                            onClick={() => void doImport()}
                            disabled={checking || importing || isRunning || totalMessages == null || totalMessages > 0}
                            loading={importing}
                        >
                            Importar ahora
                        </Button>
                        <Button danger onClick={() => void stopImport()} disabled={!isRunning || stopping} loading={stopping}>
                            Detener
                        </Button>
                    </Space>
                    {isEmpty === true && <Text style={{ color: '#00a884' }}>Dispositivo vacío: importación habilitada.</Text>}
                    {totalMessages != null && totalMessages > 0 && (
                        <Text style={{ color: '#faad14' }}>
                            Mensajes importados: <span style={{ color: '#e9edef' }}>{totalMessages}</span>
                            {chatsWithMessages != null ? <span style={{ color: '#8696a0' }}> · Chats: <span style={{ color: '#e9edef' }}>{chatsWithMessages}</span></span> : null}
                        </Text>
                    )}
                    {status?.error && <Text style={{ color: '#ff7875' }}>{String(status.error)}</Text>}
                    {!status && <Text style={{ color: '#8696a0' }}>No se pudo obtener estado de importación.</Text>}
                </Space>
            </Card>
        </div>
    );
};
