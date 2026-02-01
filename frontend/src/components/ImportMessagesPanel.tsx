import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Space, Typography, message } from 'antd';
import { Download } from 'lucide-react';
import { apiFetch } from '../lib/runtime';

const { Text, Title } = Typography;

export const ImportMessagesPanel = ({ deviceId, activeChatId, onImported }: { deviceId: string; activeChatId: string | null; onImported?: () => void }) => {
    const [messageApi, contextHolder] = message.useMessage();
    const [checking, setChecking] = useState(false);
    const [importing, setImporting] = useState(false);
    const [isEmpty, setIsEmpty] = useState<boolean | null>(null);

    const encodedChatId = useMemo(() => {
        if (!activeChatId) return null;
        return encodeURIComponent(activeChatId);
    }, [activeChatId]);

    const checkEmpty = async () => {
        if (!activeChatId) {
            setIsEmpty(null);
            return;
        }
        setChecking(true);
        try {
            const res = await apiFetch(`/api/devices/${deviceId}/chats/${encodedChatId}/messages?limit=1`);
            const data = await res.json().catch(() => []);
            setIsEmpty(Array.isArray(data) ? data.length === 0 : true);
        } catch {
            setIsEmpty(null);
        } finally {
            setChecking(false);
        }
    };

    useEffect(() => {
        void checkEmpty();
    }, [deviceId, activeChatId]);

    const doImport = async () => {
        if (!activeChatId) return;
        setImporting(true);
        const key = `import-${deviceId}-${activeChatId}`;
        try {
            messageApi.loading({ content: 'Importando mensajes...', key });
            const res = await apiFetch(`/api/devices/${deviceId}/chats/${encodedChatId}/import-messages`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Error al importar');
            if (data?.success) {
                messageApi.success({ content: `Importados: ${Number(data?.imported || 0)}`, key });
            } else {
                messageApi.warning({ content: data?.error || 'No se pudieron importar mensajes', key });
            }
            await checkEmpty();
            onImported?.();
        } catch (e: any) {
            messageApi.error({ content: String(e?.message || 'Error al importar'), key });
        } finally {
            setImporting(false);
        }
    };

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
                {!activeChatId ? (
                    <Text style={{ color: '#8696a0' }}>Abrí un chat en la pestaña Chats para poder importar.</Text>
                ) : (
                    <Space direction="vertical" style={{ width: '100%' }} size={12}>
                        <Text style={{ color: '#8696a0' }}>
                            Chat seleccionado: <span style={{ color: '#e9edef' }}>{activeChatId}</span>
                        </Text>
                        <Text style={{ color: '#8696a0' }}>
                            Solo se habilita si el chat está vacío en el panel.
                        </Text>
                        <Space wrap>
                            <Button onClick={() => void checkEmpty()} loading={checking}>
                                Rechequear
                            </Button>
                            <Button
                                type="primary"
                                onClick={() => void doImport()}
                                disabled={checking || importing || isEmpty === false || isEmpty == null}
                                loading={importing}
                            >
                                Importar ahora
                            </Button>
                        </Space>
                        {isEmpty === true && <Text style={{ color: '#00a884' }}>Chat vacío: importación habilitada.</Text>}
                        {isEmpty === false && <Text style={{ color: '#faad14' }}>Este chat ya tiene mensajes en el panel.</Text>}
                        {isEmpty == null && <Text style={{ color: '#8696a0' }}>No se pudo validar si está vacío.</Text>}
                    </Space>
                )}
            </Card>
        </div>
    );
};

