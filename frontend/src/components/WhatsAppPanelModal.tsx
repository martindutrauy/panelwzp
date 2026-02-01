import React, { useEffect, useRef, useState } from 'react';
import { Modal, Button, Badge, Space, Tabs, Popconfirm, message, Typography } from 'antd';
import { Plus, Smartphone, MessageSquare, Files, FileText, BarChart3, Trash2, ArrowLeft, X, Settings, Lock } from 'lucide-react';
import { ChatInterface } from './ChatInterface';
import { BranchCard } from './BranchCard';
import { FilePanel } from './FilePanel';
import { TemplatesPanel } from './TemplatesPanel';
import { StatsPanel } from './StatsPanel';
import { apiFetch } from '../lib/runtime';
import { PairingCodeModal } from './PairingCodeModal';
import { BranchNotificationsModal } from './BranchNotificationsModal';
import { GlobalSecurityModal } from './GlobalSecurityModal';
import { useSocket } from '../hooks/useSocket';
import { notifyIncomingMessage } from '../services/notificationDispatcher.service';
import { getBranchChatName } from '../services/branchChatDirectory.service';
import './WhatsAppPanelModal.retro.css';

interface Device {
    id: string;
    name: string;
    phoneNumber: string | null;
    number?: string | null;
    status: 'CONNECTED' | 'DISCONNECTED' | 'QR_READY' | 'CONNECTING' | 'PAIRING_CODE_READY' | string;
    qr: string | null;
    unreadCount?: number;
}

const { Text } = Typography;

export const WhatsAppPanelModal = ({ visible, onClose }: { visible: boolean, onClose: () => void }) => {
    const socket = useSocket();
    const [devices, setDevices] = useState<Device[]>([]);
    const [currentDeviceIndex, setCurrentDeviceIndex] = useState<number | null>(null); // null = ningún dispositivo seleccionado
    const [showBranchNotifications, setShowBranchNotifications] = useState(false);
    const [showGlobalSecurity, setShowGlobalSecurity] = useState(false);
    const [pinnedDevices, setPinnedDevices] = useState<string[]>(() => {
        const saved = localStorage.getItem('pinnedDevices');
        const parsed = saved ? JSON.parse(saved) : [];
        return Array.isArray(parsed) ? parsed.map(String) : [];
    });
    const [manualOrder, setManualOrder] = useState<string[]>(() => {
        const saved = localStorage.getItem('manualOrder');
        const parsed = saved ? JSON.parse(saved) : [];
        return Array.isArray(parsed) ? parsed.map(String) : [];
    });
    const [draggedDeviceId, setDraggedDeviceId] = useState<string | null>(null);
    const [armedDragDeviceId, setArmedDragDeviceId] = useState<string | null>(null);
    const [pairingDeviceId, setPairingDeviceId] = useState<string | null>(null);
    const [messageApi, contextHolder] = message.useMessage();
    const devicesRef = useRef<Device[]>([]);

    useEffect(() => {
        devicesRef.current = devices;
    }, [devices]);

    useEffect(() => {
        if (!socket) return;
        if (!visible) return;

        const handleNewMessage = (data: any) => {
            const branchId = String(data?.deviceId || '');
            const chatId = String(data?.chatId || '');
            const fromMe = Boolean(data?.msg?.fromMe);
            if (!branchId || !chatId) return;
            if (fromMe) return;
            const branchName = devicesRef.current.find(d => d.id === branchId)?.name || branchId;
            const senderName = getBranchChatName(branchId, chatId);

            notifyIncomingMessage({
                branchId,
                branchName,
                chatId,
                fromMe: false,
                msgId: data?.msg?.id ? String(data.msg.id) : null,
                timestamp: typeof data?.msg?.timestamp === 'number' ? data.msg.timestamp : undefined,
                senderName,
                messageText: data?.msg?.text ? String(data.msg.text) : null
            });
        };

        socket.on('message:new', handleNewMessage);
        return () => {
            socket.off('message:new', handleNewMessage);
        };
    }, [socket, visible]);

    useEffect(() => {
        localStorage.removeItem('sortMode');
    }, []);

    // Persistir configuración
    useEffect(() => {
        localStorage.setItem('pinnedDevices', JSON.stringify(pinnedDevices));
    }, [pinnedDevices]);

    useEffect(() => {
        localStorage.setItem('manualOrder', JSON.stringify(manualOrder));
    }, [manualOrder]);

    const togglePin = (deviceId: string) => {
        setPinnedDevices(prev => 
            prev.includes(deviceId) ? prev.filter(id => id !== deviceId) : [...prev, deviceId]
        );
    };

    useEffect(() => {
        // Polling automático para actualizar estado de dispositivos
        const fetchDevices = async () => {
            try {
                const res = await apiFetch('/api/devices');
                const text = await res.text();
                const raw = text ? (() => { try { return JSON.parse(text); } catch { return []; } })() : [];
                const data: Device[] = Array.isArray(raw)
                    ? raw.map((d: any) => ({
                        ...d,
                        id: String(d?.id ?? ''),
                        name: String(d?.name ?? ''),
                        status: String(d?.status ?? 'DISCONNECTED') as any
                    }))
                    : [];
                if (!res.ok) return;
                setDevices(data);
                
                // Asegurar que todos los dispositivos estén en manualOrder para evitar saltos
                setManualOrder(prev => {
                    const existingIds = new Set(data.map(d => d.id));
                    const base = prev.map(String).filter(id => existingIds.has(id));
                    const missing = data
                        .filter(d => !base.includes(d.id))
                        .sort((a, b) => {
                            const nameCompare = a.name.localeCompare(b.name);
                            if (nameCompare !== 0) return nameCompare;
                            return a.id.localeCompare(b.id);
                        })
                        .map(d => d.id);

                    const newOrder = [...base, ...missing];
                    const changed = newOrder.length !== prev.length || newOrder.some((id, i) => id !== prev[i]);
                    
                    // Si se agregaron nuevos, persistir inmediatamente
                    if (changed) {
                        localStorage.setItem('manualOrder', JSON.stringify(newOrder));
                    }
                    
                    return changed ? newOrder : prev;
                });

                setPinnedDevices(prev => {
                    const existingIds = new Set(data.map(d => d.id));
                    const next = prev.map(String).filter(id => existingIds.has(id));
                    const changed = next.length !== prev.length || next.some((id, i) => id !== prev[i]);
                    return changed ? next : prev;
                });
            } catch (error) {
                return;
            }
        };

        if (visible) {
            fetchDevices(); // Cargar inmediatamente
            // Actualizar cada 3 segundos
            const interval = setInterval(fetchDevices, 3000);
            return () => clearInterval(interval);
        }
    }, [visible]);

    const addDevice = async () => {
        const name = `Sucursal ${devices.length + 1}`;
        try {
            const res = await apiFetch('/api/devices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const text = await res.text();
            const data = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
            if (!res.ok) throw new Error((data as any)?.error || `HTTP ${res.status}`);
            setDevices(prev => [...prev, data as any]);
        } catch (error: any) {
            messageApi.error({ content: error?.message || 'Error al agregar dispositivo' });
        }
    };

    const renameDevice = async (deviceId: string, name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName) return;

        const key = `rename-${deviceId}`;
        try {
            messageApi.loading({ content: 'Guardando...', key });
            const res = await apiFetch(`/api/devices/${deviceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmedName })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Error al renombrar');

            setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, name: data.name ?? trimmedName } : d));
            messageApi.success({ content: '✅ Nombre actualizado', key });
        } catch (error: any) {
            messageApi.error({ content: error?.message || 'Error al renombrar', key });
        }
    };

    const disconnectAndClean = async (deviceId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            messageApi.loading({ content: 'Desconectando y limpiando...', key: 'disconnect' });
            const res = await apiFetch(`/api/devices/${deviceId}/disconnect-clean`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                messageApi.success({ content: '✅ Dispositivo desconectado y limpiado', key: 'disconnect' });
            } else {
                messageApi.error({ content: data.error || 'Error al desconectar', key: 'disconnect' });
            }
        } catch (error) {
            messageApi.error({ content: 'Error al desconectar dispositivo', key: 'disconnect' });
        }
    };

    const deleteDevice = async (deviceId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            messageApi.loading({ content: 'Eliminando...', key: 'delete' });
            // Desconectar y limpiar datos de conexión
            await apiFetch(`/api/devices/${deviceId}/disconnect-clean`, { method: 'POST' });
            // Eliminar el dispositivo
            const res = await apiFetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
            const text = await res.text();
            const data = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
            if (data.success) {
                messageApi.success({ content: '✅ Dispositivo eliminado', key: 'delete' });
                setDevices(prev => prev.filter(d => d.id !== deviceId));
                setPinnedDevices(prev => prev.filter(id => id !== deviceId));
                setManualOrder(prev => prev.filter(id => id !== deviceId));
                if (currentDeviceIndex !== null && currentDeviceIndex >= devices.length - 1) {
                    setCurrentDeviceIndex(devices.length > 1 ? devices.length - 2 : null);
                }
            } else {
                messageApi.error({ content: data.error || 'Error al eliminar', key: 'delete' });
            }
        } catch (error) {
            messageApi.error({ content: 'Error al eliminar dispositivo', key: 'delete' });
        }
    };

    const currentDevice = currentDeviceIndex !== null ? devices[currentDeviceIndex] : undefined;
    const connectedCount = React.useMemo(() => devices.filter(d => d.status === 'CONNECTED').length, [devices]);

    const sortedDevices = React.useMemo(() => {
        return [...devices].sort((a, b) => {
            // 1. Fijados siempre primero
            const isPinnedA = pinnedDevices.includes(a.id);
            const isPinnedB = pinnedDevices.includes(b.id);
            if (isPinnedA && !isPinnedB) return -1;
            if (!isPinnedA && isPinnedB) return 1;
            
            // Si ambos están fijados, usamos el orden manual
            if (isPinnedA && isPinnedB) {
                const indexA = manualOrder.indexOf(a.id);
                const indexB = manualOrder.indexOf(b.id);
                if (indexA !== -1 && indexB !== -1) return indexA - indexB;
                if (indexA !== -1) return -1;
                if (indexB !== -1) return 1;
            }

            // 2. Orden manual (Drag & Drop) es el criterio principal para los no fijados
            const indexA = manualOrder.indexOf(a.id);
            const indexB = manualOrder.indexOf(b.id);
            
            // Si ambos están en la lista manual, ordenar por índice
            if (indexA !== -1 && indexB !== -1) return indexA - indexB;
            
            // Si solo uno está, ponerlo primero
            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;

            // 3. Orden alfabético por defecto (fallback)
            const nameCompare = a.name.localeCompare(b.name);
            if (nameCompare !== 0) return nameCompare;
            
            // 4. Fallback final a ID para garantizar estabilidad absoluta
            return a.id.localeCompare(b.id);
        });
    }, [devices, pinnedDevices, manualOrder]);

    // Drag and Drop handlers
    const handleDragStart = (e: React.DragEvent, deviceId: string) => {
        if (armedDragDeviceId !== deviceId) {
            e.preventDefault();
            return;
        }
        setDraggedDeviceId(deviceId);
        e.dataTransfer.effectAllowed = 'move';
        // Hack para que la imagen fantasma no incluya el fondo del navegador si es transparente
        // e.dataTransfer.setDragImage(e.currentTarget as Element, 20, 20);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault(); // Necesario para permitir drop
        e.dataTransfer.dropEffect = 'move';
    };

    const handleDrop = (e: React.DragEvent, targetDeviceId: string) => {
        if (!draggedDeviceId || draggedDeviceId === targetDeviceId) return;
        e.preventDefault();

        const newOrder = [...manualOrder];
        
        // Asegurar que todos los dispositivos actuales estén en la lista manual inicial si no estaban
        devices.forEach(d => {
            if (!newOrder.includes(d.id)) newOrder.push(d.id);
        });

        const fromIndex = newOrder.indexOf(draggedDeviceId);
        const toIndex = newOrder.indexOf(targetDeviceId);

        if (fromIndex !== -1 && toIndex !== -1) {
            newOrder.splice(fromIndex, 1);
            newOrder.splice(toIndex, 0, draggedDeviceId);
            setManualOrder(newOrder);
        }
        
        setDraggedDeviceId(null);
        setArmedDragDeviceId(null);
    };

    // ═══════════════════════════════════════════════════════════════════
    // VISTA DE CHAT INDIVIDUAL (cuando hay una sucursal seleccionada)
    // ═══════════════════════════════════════════════════════════════════
    const tabItems = React.useMemo(() => {
        if (!currentDevice) return [];
        return [
            {
                key: 'chats',
                label: <Space><MessageSquare size={16} /> Chats</Space>,
                children: (
                    <div style={{ height: 'calc(85vh - 110px)', overflow: 'auto' }}>
                        <ChatInterface
                            device={currentDevice}
                            onClose={() => setCurrentDeviceIndex(null)}
                        />
                    </div>
                )
            },
            {
                key: 'templates',
                label: <Space><FileText size={16} /> Plantillas</Space>,
                children: (
                    <div style={{ height: 'calc(85vh - 110px)', overflow: 'auto', padding: 20 }}>
                        <TemplatesPanel onSelectTemplate={(content) => console.log('Plantilla:', content)} />
                    </div>
                )
            },
            {
                key: 'files',
                label: <Space><Files size={16} /> Archivos</Space>,
                children: (
                    <div style={{ height: 'calc(85vh - 110px)', overflow: 'auto', padding: 20 }}>
                        <FilePanel deviceId={currentDevice.id} />
                    </div>
                )
            },
            {
                key: 'stats',
                label: <Space><BarChart3 size={16} /> Stats</Space>,
                children: (
                    <div style={{ height: 'calc(85vh - 110px)', overflow: 'auto', padding: 20 }}>
                        <StatsPanel deviceId={currentDevice.id} />
                    </div>
                )
            }
        ];
    }, [currentDevice?.id]); // Solo recrear tabs si cambia el ID del dispositivo (no sus props cambiantes como batería)

    if (currentDeviceIndex !== null && currentDevice) {
        return (
            <>
                {contextHolder}
                <Modal
                    open={visible}
                    onCancel={() => setCurrentDeviceIndex(null)}
                    footer={null}
                width="95%"
                style={{ top: 20 }}
                styles={{ body: { padding: 0, height: '85vh', backgroundColor: '#0b141a' } }}
                closable={false}
                title={
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 10 }}>
                        <Space>
                            <Button 
                                type="text" 
                                icon={<ArrowLeft size={18} />}
                                onClick={() => setCurrentDeviceIndex(null)}
                                style={{ color: '#8696a0' }}
                            />
                            <MessageSquare size={18} color="#00a884" />
                            <span>{currentDevice.name}</span>
                            {currentDevice.status === 'CONNECTED' && (
                                <Badge status="success" text={<span style={{ color: '#00a884', fontSize: 12 }}>{currentDevice.phoneNumber}</span>} />
                            )}
                        </Space>
                        <Button 
                            type="text" 
                            icon={<X size={20} />}
                            onClick={() => setCurrentDeviceIndex(null)}
                            style={{ color: '#8696a0' }}
                        />
                    </div>
                }
            >
                <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <Tabs
                        defaultActiveKey="chats"
                        centered
                        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
                        tabBarStyle={{ marginBottom: 0, background: '#111b21', padding: '0 10px' }}
                        tabBarExtraContent={{
                            right: (
                                <Button
                                    type="text"
                                    icon={<Settings size={18} />}
                                    onClick={() => setShowBranchNotifications(true)}
                                    style={{ color: '#8696a0' }}
                                    title="Notificaciones"
                                />
                            )
                        }}
                        items={tabItems}
                    />
                    <BranchNotificationsModal
                        open={showBranchNotifications}
                        branchId={currentDevice.id}
                        branchName={currentDevice.name}
                        onClose={() => setShowBranchNotifications(false)}
                    />
                </div>
            </Modal>
            </>
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // PANTALLA PRINCIPAL - Grid de Sucursales
    // ═══════════════════════════════════════════════════════════════════
    return (
        <>
        {contextHolder}
        <Modal
            open={visible}
            onCancel={onClose}
            footer={null}
            width="95%"
            style={{ top: 20 }}
            styles={{ body: { padding: 20, height: '85vh', backgroundColor: '#0b141a', overflow: 'auto' } }}
            title={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 40 }}>
                    <Space>
                        <Smartphone size={18} />
                        <span>Panel WhatsApp Multi-Dispositivo</span>
                        <span style={{ color: '#8696a0', fontSize: 12, marginLeft: 60 }}>Conectadas</span>
                        <Badge count={connectedCount} style={{ backgroundColor: '#00a884' }} />
                    </Space>
                    <Space>
                        <Button icon={<Lock size={16} />} onClick={() => setShowGlobalSecurity(true)}>
                            Seguridad
                        </Button>
                        <Button type="primary" icon={<Plus size={16} />} onClick={addDevice}>
                            Agregar
                        </Button>
                    </Space>
                </div>
            }
        >
            {devices.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8696a0' }}>
                    <Smartphone size={64} />
                    <h3 style={{ color: '#e9edef', marginTop: 20 }}>No hay sucursales configuradas</h3>
                    <p>Agrega tu primera sucursal para comenzar</p>
                    <Button type="primary" icon={<Plus size={16} />} onClick={addDevice} style={{ marginTop: 10 }}>
                        Agregar Dispositivo
                    </Button>
                </div>
            ) : (
                <>
                    <div style={{ marginBottom: 10 }}>
                        <span style={{ color: '#8696a0', fontWeight: 'bold', fontSize: 14 }}>
                            Sucursales ({devices.length})
                        </span>
                    </div>
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                        gap: 15,
                        marginBottom: 30
                    }}>
                        {sortedDevices.map((dev) => {
                            const idx = devices.findIndex(d => d.id === dev.id);
                            return (
                                <div
                                    key={dev.id}
                                    draggable
                                    onDragStart={(e) => handleDragStart(e, dev.id)}
                                    onDragOver={handleDragOver}
                                    onDrop={(e) => handleDrop(e, dev.id)}
                                    onDragEnd={() => {
                                        setDraggedDeviceId(null);
                                        setArmedDragDeviceId(null);
                                    }}
                                    style={{ cursor: 'default' }}
                                >
                                    <BranchCard
                                        device={dev}
                                        onOpenFull={() => {
                                            if (dev.status === 'DISCONNECTED') {
                                                apiFetch(`/api/devices/${dev.id}/start`, { method: 'POST' });
                                            }
                                            setCurrentDeviceIndex(idx);
                                        }}
                                        onRename={(name) => renameDevice(dev.id, name)}
                                        onPin={() => togglePin(dev.id)}
                                        isPinned={pinnedDevices.includes(dev.id)}
                                        dragHandle={
                                            <Button
                                                type="text"
                                                size="small"
                                                onMouseDown={(e) => {
                                                    e.stopPropagation();
                                                    setArmedDragDeviceId(dev.id);
                                                }}
                                                onMouseUp={(e) => {
                                                    e.stopPropagation();
                                                    setArmedDragDeviceId(null);
                                                }}
                                                onMouseLeave={() => setArmedDragDeviceId(null)}
                                                style={{ padding: 0, minWidth: 24, cursor: 'grab', color: dev.status === 'CONNECTED' ? '#fff' : '#8696a0' }}
                                                title="Arrastrar para reordenar"
                                            >
                                                ⋮⋮
                                            </Button>
                                        }
                                        headerActions={
                                            <Space size={4}>
                                                {dev.status !== 'CONNECTED' && (
                                                    <Button
                                                        type="text"
                                                        size="small"
                                                        icon={<Smartphone size={14} color={dev.status === 'CONNECTED' ? '#fff' : '#8696a0'} />}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setPairingDeviceId(dev.id);
                                                        }}
                                                        title="Vincular por código"
                                                    />
                                                )}
                                                <Popconfirm
                                                    title="¿Eliminar?"
                                                    onConfirm={(e) => deleteDevice(dev.id, e as unknown as React.MouseEvent)}
                                                    okText="Sí"
                                                    cancelText="No"
                                                >
                                                    <Button
                                                        type="text"
                                                        size="small"
                                                        icon={<Trash2 size={14} color="#ff4d4f" />}
                                                        onClick={(e) => e.stopPropagation()}
                                                    />
                                                </Popconfirm>
                                            </Space>
                                        }
                                    />
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
            <PairingCodeModal
                open={Boolean(pairingDeviceId)}
                deviceId={pairingDeviceId || ''}
                onClose={() => setPairingDeviceId(null)}
            />
            <GlobalSecurityModal open={showGlobalSecurity} onClose={() => setShowGlobalSecurity(false)} />
        </Modal>
        </>
    );
};
