import React, { useState, useEffect, useRef } from 'react';
import { Card, Badge, Avatar, List, Typography, Button } from 'antd';
import { MessageSquare, Maximize2 } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { apiFetch, assetUrl } from '../lib/runtime';

const { Text } = Typography;

interface Device {
    id: string;
    name: string;
    status: string;
    phoneNumber?: string | null;
    number?: string | null;
}

interface Chat {
    id: string;
    name: string;
    lastMessageTime: number;
    unreadCount: number;
    isGroup: boolean;
    profilePhotoUrl?: string | null;
}

interface BranchCardProps {
    device: Device;
    onOpenFull: () => void;
    onRename?: (name: string) => void;
    headerActions?: React.ReactNode;
    onPin?: () => void;
    isPinned?: boolean;
    dragHandle?: React.ReactNode;
}

export const BranchCard: React.FC<BranchCardProps> = ({ device, onOpenFull, onRename, headerActions, onPin, isPinned, dragHandle }) => {
    const socket = useSocket();
    const [chats, setChats] = useState<Chat[]>([]);
    const [totalUnread, setTotalUnread] = useState(0);
    const notificationAudioCtxRef = useRef<AudioContext | null>(null);
    const lastNotificationKeyRef = useRef<string>('');
    const lastNotificationAtRef = useRef<number>(0);

    const getAudioCtx = () => {
        const w = window as any;
        if (w.__wzpAudioCtx) return w.__wzpAudioCtx as AudioContext;
        if (notificationAudioCtxRef.current) return notificationAudioCtxRef.current;
        try {
            notificationAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            return notificationAudioCtxRef.current;
        } catch {
            return null;
        }
    };

    const playNotificationSound = (toneId: number) => {
        try {
            if (toneId === 11) {
                const audio = new Audio('https://www.myinstants.com/media/sounds/sape.mp3');
                audio.volume = 0.5;
                audio.play().catch(() => {});
                return;
            }

            const audioCtx = getAudioCtx();
            if (!audioCtx) return;
            if (audioCtx.state !== 'running') return;
            const now = audioCtx.currentTime;

            const createOsc = (type: OscillatorType, freq: number, start: number, dur: number, vol: number = 0.1) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = type;
                osc.frequency.setValueAtTime(freq, start);
                gain.gain.setValueAtTime(vol, start);
                gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(start);
                osc.stop(start + dur);
            };

            switch (toneId) {
                case 1:
                    createOsc('sine', 880, now, 0.08, 0.08);
                    createOsc('sine', 660, now + 0.09, 0.08, 0.08);
                    break;
                case 2:
                    createOsc('triangle', 1046, now, 0.06, 0.06);
                    createOsc('triangle', 1318, now + 0.07, 0.06, 0.06);
                    break;
                case 3:
                    createOsc('sine', 740, now, 0.05, 0.06);
                    createOsc('sine', 988, now + 0.06, 0.05, 0.06);
                    break;
                case 4:
                    createOsc('square', 523, now, 0.06, 0.04);
                    createOsc('square', 659, now + 0.07, 0.06, 0.04);
                    break;
                case 5:
                    createOsc('sine', 880, now, 0.06, 0.07);
                    createOsc('sine', 1174, now + 0.07, 0.09, 0.07);
                    break;
                case 6:
                    createOsc('sawtooth', 1200, now, 0.05, 0.05);
                    createOsc('sawtooth', 900, now + 0.05, 0.05, 0.05);
                    break;
                case 7:
                    createOsc('triangle', 988, now, 0.04, 0.05);
                    createOsc('triangle', 740, now + 0.05, 0.04, 0.05);
                    break;
                case 8:
                    createOsc('sine', 660, now, 0.05, 0.05);
                    createOsc('sine', 880, now + 0.06, 0.05, 0.05);
                    break;
                case 9:
                    createOsc('triangle', 880, now, 0.06, 0.06);
                    createOsc('triangle', 1320, now + 0.07, 0.08, 0.06);
                    break;
                case 10:
                    createOsc('sine', 220, now, 0.12, 0.1);
                    break;
                case 12: {
                    const freqs = [1568, 1760, 1976];
                    freqs.forEach((f, idx) => createOsc('sine', f, now + idx * 0.03, 0.03, 0.04));
                    break;
                }
                default:
                    createOsc('sine', 880, now, 0.08, 0.08);
            }
        } catch {}
    };

    // Cargar chats
    useEffect(() => {
        const fetchChats = async () => {
            if (device.status !== 'CONNECTED') return;
            try {
                const res = await apiFetch(`/api/devices/${device.id}/chats`);
                const text = await res.text();
                const data = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
                if (!res.ok) {
                    setChats([]);
                    setTotalUnread(0);
                    return;
                }
                if (Array.isArray(data)) {
                    setChats(data.slice(0, 5)); // Solo los 5 más recientes
                    setTotalUnread(data.reduce((sum: number, c: Chat) => sum + (c.unreadCount || 0), 0));
                }
            } catch (error) {
                console.error('Error:', error);
            }
        };
        
        fetchChats();
        const interval = setInterval(fetchChats, 10000);
        return () => clearInterval(interval);
    }, [device.id, device.status]);

    // Socket para mensajes nuevos
    useEffect(() => {
        if (!socket) return;
        
        const handleNewMessage = (data: any) => {
            if (data.deviceId === device.id && !data.msg.fromMe) {
                const tone = (() => {
                    const saved = localStorage.getItem('notificationTone');
                    const parsed = saved ? parseInt(saved, 10) : 1;
                    return Number.isFinite(parsed) ? parsed : 1;
                })();
                const key = `${data.deviceId}:${data.chatId}:${data.msg?.id || data.msg?.timestamp || ''}`;
                const now = Date.now();
                if (key && key !== lastNotificationKeyRef.current && now - lastNotificationAtRef.current > 250) {
                    lastNotificationKeyRef.current = key;
                    lastNotificationAtRef.current = now;
                    playNotificationSound(tone);
                }
                setTotalUnread(prev => prev + 1);
            }
        };

        const handleUnreadUpdate = (data: any) => {
            if (data.deviceId !== device.id) return;
            if (typeof data.totalUnread === 'number') {
                setTotalUnread(data.totalUnread);
            }
        };
        
        socket.on('message:new', handleNewMessage);
        socket.on('device:unread:update', handleUnreadUpdate);
        return () => { 
            socket.off('message:new', handleNewMessage); 
            socket.off('device:unread:update', handleUnreadUpdate);
        };
    }, [socket, device.id]);

    const isConnected = device.status === 'CONNECTED';
    const nameEditable = onRename
        ? {
            onChange: (value: string) => onRename(value),
            triggerType: ['icon'] as ('text' | 'icon')[],
            tooltip: 'Editar nombre',
            maxLength: 60
        }
        : false;

    return (
        <Card
            hoverable
            onClick={onOpenFull}
            style={{
                background: '#111b21',
                borderColor: isConnected ? '#00a884' : '#3b4a54',
                borderWidth: isConnected ? 2 : 1,
                cursor: 'pointer',
                height: '100%',
                display: 'flex',
                flexDirection: 'column'
            }}
            styles={{ body: { padding: 0, flex: 1, display: 'flex', flexDirection: 'column' } }}
        >
            {/* Header */}
            <div style={{
                padding: '10px 12px',
                background: isConnected ? '#00a884' : '#202c33',
                borderBottom: '1px solid #222e35',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge status={isConnected ? 'success' : 'default'} />
                    <div>
                        <div onClick={(e) => e.stopPropagation()}>
                            <Text strong style={{ color: '#fff', fontSize: 13 }} editable={nameEditable}>
                                {device.name}
                            </Text>
                        </div>
                        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)' }}>
                            {isConnected 
                                ? (device.phoneNumber || device.number || 'Conectado')
                                : device.status === 'QR_READY' ? 'Escanear QR' : 'Sin vincular'
                            }
                        </div>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {dragHandle}
                    {onPin && (
                        <Button
                            type="text"
                            size="small"
                            onClick={(e) => {
                                e.stopPropagation();
                                onPin();
                            }}
                            icon={
                                <div style={{ 
                                    transform: isPinned ? 'rotate(45deg)' : 'rotate(0deg)', 
                                    transition: 'transform 0.2s',
                                    color: isConnected ? '#fff' : (isPinned ? '#00a884' : '#8696a0') 
                                }}>
                                    📌
                                </div>
                            }
                            style={{ padding: 0, minWidth: 24 }}
                            title={isPinned ? "Desfijar" : "Fijar al inicio"}
                        />
                    )}
                    {isConnected && totalUnread > 0 && (
                        <Badge
                            count={totalUnread}
                            size="small"
                            style={{ backgroundColor: '#00a884', boxShadow: '0 0 0 1px #111b21' }}
                        />
                    )}
                    <div onClick={(e) => e.stopPropagation()}>{headerActions}</div>
                </div>
            </div>

            {/* Chats Preview */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
                {!isConnected ? (
                    <div style={{ 
                        height: '100%', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center',
                        color: '#8696a0',
                        fontSize: 12,
                        padding: 20,
                        textAlign: 'center'
                    }}>
                        {device.status === 'QR_READY' 
                            ? 'Haz clic para escanear QR'
                            : 'Haz clic para conectar'
                        }
                    </div>
                ) : chats.length === 0 ? (
                    <div style={{ 
                        height: '100%', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center',
                        color: '#8696a0',
                        fontSize: 12
                    }}>
                        Sin chats recientes
                    </div>
                ) : (
                    <List
                        size="small"
                        dataSource={chats}
                        renderItem={chat => (
                            <List.Item style={{ 
                                padding: '6px 10px', 
                                borderBottom: '1px solid #222e35',
                                background: 'transparent'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                                    <Avatar size="small" shape="square" src={chat.profilePhotoUrl ? assetUrl(chat.profilePhotoUrl) : undefined} style={{ backgroundColor: chat.isGroup ? '#25D366' : '#6a7175', flexShrink: 0 }}>
                                        {chat.name.substring(0, 1).toUpperCase()}
                                    </Avatar>
                                    <div style={{ flex: 1, overflow: 'hidden' }}>
                                        <div style={{ 
                                            fontSize: 11, 
                                            color: '#e9edef',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap'
                                        }}>
                                            {chat.name}
                                        </div>
                                        <div style={{ fontSize: 9, color: '#8696a0' }}>
                                            {new Date(chat.lastMessageTime).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>
                                </div>
                            </List.Item>
                        )}
                    />
                )}
            </div>

            {/* Footer */}
            <div style={{
                padding: '8px 10px',
                background: '#202c33',
                borderTop: '1px solid #222e35',
                display: 'flex',
                justifyContent: 'center'
            }}>
                <Button 
                    type="text" 
                    size="small"
                    icon={<Maximize2 size={14} />}
                    style={{ color: '#00a884', fontSize: 11 }}
                >
                    Abrir completo
                </Button>
            </div>
        </Card>
    );
};
