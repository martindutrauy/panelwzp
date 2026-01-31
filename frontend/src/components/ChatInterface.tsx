import React, { useState, useEffect, useRef } from 'react';
import { Layout, List, Input, Avatar, Space, Button, Badge, Typography, Tooltip, Modal, Spin, Empty, Popconfirm, message, Radio, Divider, notification } from 'antd';
import { Search, Send, Paperclip, Mic, CheckCheck, X, Trash2, Settings, Play, PhoneCall } from 'lucide-react';
import QRCode from 'react-qr-code';
import { useSocket } from '../hooks/useSocket';
import { apiFetch, assetUrl } from '../lib/runtime';
import { PairingCodeModal } from './PairingCodeModal';

const { Sider, Content } = Layout;
const { Text } = Typography;

interface Device {
    id: string;
    name: string;
    status: 'CONNECTED' | 'DISCONNECTED' | 'QR_READY' | 'CONNECTING' | string;
    qr?: string | null;
    phoneNumber?: string | null;
    number?: string | null;
}

interface MediaMetadata {
    id: string;
    fileName: string;
    mimeType: string;
    url: string;
    size: number;
    timestamp: number;
}

interface Message {
    id: string;
    text: string | null;
    fromMe: boolean;
    timestamp: number;
    source: 'panel' | 'whatsapp' | 'phone' | 'contact';
    media?: MediaMetadata | null;
    location?: { latitude: number; longitude: number; name?: string | null; address?: string | null } | null;
}

interface Chat {
    id: string;
    name: string;
    lastMessageTime: number;
    unreadCount: number;
    isGroup: boolean;
}

interface SearchResult {
    id: string;
    chatId: string;
    chatName: string;
    text: string;
    fromMe: boolean;
    timestamp: number;
    matchHighlight: string;
}

export const ChatInterface = ({ device, onClose }: { device: Device; onClose?: () => void }) => {
    const [messageApi, contextHolder] = message.useMessage();
    const [notificationApi, notificationContextHolder] = notification.useNotification();
    const socket = useSocket();
    const [currentDevice, setCurrentDevice] = useState<Device>(device);
    const [chats, setChats] = useState<Chat[]>([]);
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputText, setInputText] = useState('');
    const [loading, setLoading] = useState(false);
    const [uploadingFile, setUploadingFile] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [presence, setPresence] = useState<string | null>(null);
    const [activeChat, setActiveChat] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [showSearchModal, setShowSearchModal] = useState(false);
    const [templates, setTemplates] = useState<{id: string, shortcut: string, content: string}[]>([]);
    const [showPairingModal, setShowPairingModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmNewPassword, setConfirmNewPassword] = useState('');
    const [changingPassword, setChangingPassword] = useState(false);
    const [selectedTone, setSelectedTone] = useState<number>(() => {
        const saved = localStorage.getItem('notificationTone');
        return saved ? parseInt(saved, 10) : 1;
    });

    const scrollRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const notificationAudioCtxRef = useRef<AudioContext | null>(null);
    const lastNotificationSoundKeyRef = useRef<string>('');

    const getChatKey = (chatId: string | null | undefined) => {
        if (!chatId) return '';
        if (chatId.includes('@g.us')) return chatId;
        const prefix = chatId.split('@')[0] || chatId;
        return prefix.split(':')[0] || prefix;
    };

    useEffect(() => {
        const unlock = () => {
            try {
                if (!notificationAudioCtxRef.current) {
                    notificationAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
                }
                if (notificationAudioCtxRef.current.state === 'suspended') {
                    notificationAudioCtxRef.current.resume().catch(() => {});
                }
            } catch {}
        };

        window.addEventListener('pointerdown', unlock, true);
        return () => window.removeEventListener('pointerdown', unlock, true);
    }, []);

    // Cargar plantillas para atajos
    useEffect(() => {
        const fetchTemplates = async () => {
            try {
                const res = await apiFetch('/api/templates');
                const data = await res.json();
                if (Array.isArray(data)) {
                    setTemplates(data.map((t: any) => ({ id: t.id, shortcut: t.shortcut, content: t.content })));
                }
            } catch (error) {
                console.error('Error al cargar plantillas:', error);
            }
        };
        fetchTemplates();
    }, []);

    // Cargar chats disponibles
    useEffect(() => {
        const fetchChats = async () => {
            try {
                const res = await apiFetch(`/api/devices/${device.id}/chats`);
                const data = await res.json();
                // Solo actualizar si es un array válido
                if (Array.isArray(data)) {
                    setChats(data);
                } else {
                    console.log('Respuesta no es un array:', data);
                    setChats([]);
                }
            } catch (error) {
                console.error('Error al cargar chats:', error);
                setChats([]);
            }
        };

        if (currentDevice.status === 'CONNECTED') {
            fetchChats();
            // Refrescar cada 10 segundos
            const interval = setInterval(fetchChats, 10000);
            return () => clearInterval(interval);
        } else {
            setChats([]);
        }
    }, [device.id, currentDevice.status]);

    // Cargar mensajes cuando se selecciona un chat
    useEffect(() => {
        const fetchMessages = async () => {
            if (!activeChat) return;

            try {
                const res = await apiFetch(`/api/devices/${device.id}/chats/${activeChat}/messages`);
                const data = await res.json();
                setMessages(data);

                // Scroll to bottom
                setTimeout(() => {
                    if (scrollRef.current) {
                        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                    }
                }, 100);
            } catch (error) {
                console.error('Error al cargar mensajes:', error);
            }
        };

        fetchMessages();
    }, [activeChat, device.id]);

    // Sonido de notificación simple (beep suave)
    const playNotificationSound = (toneId: number = selectedTone) => {
        try {
            // Tono especial: Sapeee
            if (toneId === 11) {
                const audio = new Audio('https://www.myinstants.com/media/sounds/sape.mp3');
                audio.volume = 0.5;
                audio.play().catch(() => {});
                return;
            }

            if (!notificationAudioCtxRef.current) {
                notificationAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }
            const audioCtx = notificationAudioCtxRef.current;
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
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
                case 1: // Default Beep
                    createOsc('sine', 800, now, 0.15);
                    break;
                case 2: // Crystal
                    createOsc('sine', 1200, now, 0.5);
                    break;
                case 3: // Bubble
                    {
                        const osc = audioCtx.createOscillator();
                        const gain = audioCtx.createGain();
                        osc.connect(gain);
                        gain.connect(audioCtx.destination);
                        osc.frequency.setValueAtTime(400, now);
                        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
                        gain.gain.setValueAtTime(0.1, now);
                        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
                        osc.start(now);
                        osc.stop(now + 0.15);
                    }
                    break;
                case 4: // Notification
                    createOsc('sine', 600, now, 0.1);
                    createOsc('sine', 800, now + 0.1, 0.2);
                    break;
                case 5: // Success
                    createOsc('sine', 523.25, now, 0.3);
                    createOsc('sine', 659.25, now + 0.05, 0.3);
                    createOsc('sine', 783.99, now + 0.1, 0.4);
                    break;
                case 6: // Laser
                    {
                        const osc = audioCtx.createOscillator();
                        const gain = audioCtx.createGain();
                        osc.type = 'sawtooth';
                        osc.connect(gain);
                        gain.connect(audioCtx.destination);
                        osc.frequency.setValueAtTime(800, now);
                        osc.frequency.exponentialRampToValueAtTime(100, now + 0.2);
                        gain.gain.setValueAtTime(0.05, now);
                        gain.gain.linearRampToValueAtTime(0, now + 0.2);
                        osc.start(now);
                        osc.stop(now + 0.2);
                    }
                    break;
                case 7: // Coin
                    createOsc('square', 987.77, now, 0.08, 0.05);
                    createOsc('square', 1318.51, now + 0.08, 0.3, 0.05);
                    break;
                case 8: // Pluck
                    createOsc('triangle', 440, now, 0.3);
                    break;
                case 9: // Chime
                    createOsc('sine', 880, now, 1.5, 0.05);
                    createOsc('sine', 1100, now, 1.5, 0.03);
                    break;
                case 10: // Deep
                    createOsc('square', 150, now, 0.3, 0.05);
                    break;
                case 12: // Bird (Ave)
                    {
                        const osc = audioCtx.createOscillator();
                        const gain = audioCtx.createGain();
                        osc.connect(gain);
                        gain.connect(audioCtx.destination);
                        
                        // Primer pío
                        osc.frequency.setValueAtTime(2000, now);
                        osc.frequency.linearRampToValueAtTime(3000, now + 0.1);
                        gain.gain.setValueAtTime(0.1, now);
                        gain.gain.linearRampToValueAtTime(0, now + 0.1);
                        
                        // Segundo pío
                        const osc2 = audioCtx.createOscillator();
                        const gain2 = audioCtx.createGain();
                        osc2.connect(gain2);
                        gain2.connect(audioCtx.destination);
                        
                        osc2.frequency.setValueAtTime(2500, now + 0.15);
                        osc2.frequency.linearRampToValueAtTime(3500, now + 0.25);
                        gain2.gain.setValueAtTime(0.1, now + 0.15);
                        gain2.gain.linearRampToValueAtTime(0, now + 0.25);

                        osc.start(now);
                        osc.stop(now + 0.1);
                        osc2.start(now + 0.15);
                        osc2.stop(now + 0.25);
                    }
                    break;
                default:
                    createOsc('sine', 800, now, 0.15);
            }
        } catch (e) {
            console.error('Error playing sound:', e);
        }
    };

    // Anunciar llamada con voz (TTS)
    const announceCall = () => {
        if (!('speechSynthesis' in window)) return;

        // Cancelar cualquier speech anterior
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance("Llamada, atender en dispositivo");
        utterance.rate = 0.9; // Un poco más lento para formalidad
        utterance.pitch = 1.0;
        
        // Buscar voz femenina en español
        const voices = window.speechSynthesis.getVoices();
        // Preferencias: Google Español, Microsoft Helena/Sabina, o genérica femenina 'es'
        const femaleVoice = voices.find(v => 
            v.lang.includes('es') && 
            (v.name.includes('Google') || v.name.includes('Microsoft') || v.name.toLowerCase().includes('female'))
        );

        if (femaleVoice) {
            utterance.voice = femaleVoice;
        }

        window.speechSynthesis.speak(utterance);
    };

    useEffect(() => {
        if (!socket) return;

        // Cargar voces al inicio para asegurar que estén disponibles
        if ('speechSynthesis' in window) {
            window.speechSynthesis.getVoices();
        }

        socket.on('call:incoming', (data: { deviceId: string, from: string, isVideo: boolean }) => {
            if (data.deviceId === device.id) {
                console.log('Llamada entrante detectada:', data);
                
                // 1. Notificación Visual Persistente
                notificationApi.open({
                    message: 'Llamada Entrante',
                    description: (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <div style={{ fontWeight: 'bold', fontSize: 16 }}>
                                {data.from.split('@')[0]}
                            </div>
                            <div style={{ color: '#ff4d4f', display: 'flex', alignItems: 'center', gap: 5 }}>
                                <PhoneCall size={16} className="blink" />
                                <span>Atender en dispositivo físico</span>
                            </div>
                        </div>
                    ),
                    icon: <PhoneCall style={{ color: '#108ee9' }} />,
                    duration: 15, // Mantener visible 15 segundos
                    key: `call-${Date.now()}`,
                    style: { background: '#fff', border: '1px solid #1890ff' }
                });

                // 2. Anuncio de Voz
                announceCall();
            }
        });

        socket.on('message:new', (data: { deviceId: string, chatId: string, msg: Message }) => {
            if (data.deviceId === device.id) {
                console.log('Mensaje nuevo recibido:', data);

                // Reproducir sonido si el mensaje NO es enviado por mí
                if (!data.msg.fromMe) {
                    const soundKey = `${data.deviceId}:${getChatKey(data.chatId)}:${data.msg.id || data.msg.timestamp}`;
                    if (soundKey !== lastNotificationSoundKeyRef.current) {
                        lastNotificationSoundKeyRef.current = soundKey;
                        playNotificationSound();
                    }
                }

                const incomingKey = getChatKey(data.chatId);
                const activeKey = getChatKey(activeChat);
                if (incomingKey && activeKey && incomingKey === activeKey) {
                    setMessages(prev => {
                        const isDuplicate = prev.some(m => m.id === data.msg.id);
                        if (isDuplicate) return prev; // Evitar duplicados
                        return [...prev, data.msg];
                    });
                    if (scrollRef.current) {
                        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                    }
                }

                // Actualizar lista de chats - unificar solo por clave segura (evita mezclar LIDs/grupos)
                setChats(prev => {
                    const incomingKey = getChatKey(data.chatId);
                    const existingChat = prev.find(c => getChatKey(c.id) === incomingKey);
                    if (existingChat) {
                        // Actualizar chat existente y moverlo al principio
                        return [
                            { ...existingChat, lastMessageTime: data.msg.timestamp },
                            ...prev.filter(c => getChatKey(c.id) !== incomingKey)
                        ];
                    } else {
                        // Agregar nuevo chat
                        const newChat: Chat = {
                            id: data.chatId,
                            name: data.chatId.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@g.us', ''),
                            lastMessageTime: data.msg.timestamp,
                            unreadCount: data.msg.fromMe ? 0 : 1,
                            isGroup: data.chatId.includes('@g.us')
                        };
                        return [newChat, ...prev];
                    }
                });
            }
        });

        socket.on('presence:update', (data: { deviceId: string, id: string, presences: any }) => {
            if (data.deviceId === device.id && data.id === activeChat) {
                const state = Object.values(data.presences)[0] as any;
                setPresence(state?.lastKnownPresence || null);
                setTimeout(() => setPresence(null), 3000);
            }
        });

        return () => {
            socket.off('message:new');
            socket.off('presence:update');
        };
    }, [socket, device.id, activeChat]);

    useEffect(() => {
        setCurrentDevice(device);
    }, [device]);

    useEffect(() => {
        if (!socket) return;

        const handler = (updated: Device) => {
            if (!updated?.id) return;
            if (updated.id !== device.id) return;
            setCurrentDevice(prev => ({ ...prev, ...updated }));
        };

        socket.on('device:update', handler);
        return () => {
            socket.off('device:update', handler);
        };
    }, [socket, device.id]);

    // Función de búsqueda de mensajes
    const handleSearch = async (query: string) => {
        setSearchQuery(query);

        // Debounce: esperar 500ms antes de buscar
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (!query.trim()) {
            setSearchResults([]);
            setShowSearchModal(false);
            return;
        }

        searchTimeoutRef.current = setTimeout(async () => {
            setIsSearching(true);
            setShowSearchModal(true);

            try {
                const res = await fetch(
                    `/api/devices/${device.id}/messages/search?q=${encodeURIComponent(query)}&limit=30`
                );
                const data = await res.json();

                if (Array.isArray(data)) {
                    setSearchResults(data);
                } else {
                    setSearchResults([]);
                }
            } catch (error) {
                console.error('Error al buscar mensajes:', error);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 500);
    };

    const goToSearchResult = (result: SearchResult) => {
        setActiveChat(result.chatId);
        setShowSearchModal(false);
        setSearchQuery('');
        setSearchResults([]);
        // Los mensajes se cargarán automáticamente por el useEffect
    };

    const sendMessage = async () => {
        if (!inputText || !activeChat) {
            console.log('No se puede enviar: inputText=', inputText, 'activeChat=', activeChat);
            return;
        }

        console.log('Enviando mensaje a:', activeChat, 'texto:', inputText);
        setLoading(true);

        try {
            const encodedChatId = encodeURIComponent(activeChat);
            const response = await apiFetch(`/api/devices/${device.id}/chats/${encodedChatId}/send-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: inputText })
            });

            const result = await response.json();
            console.log('Respuesta del servidor:', result);

            if (result.success) {
                // NO agregar mensaje localmente - el socket message:new lo hará
                // Esto evita duplicación
                setInputText('');
            } else {
                console.error('Error del servidor:', result.error);
            }
        } catch (err) {
            console.error('Error al enviar mensaje:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !activeChat) return;

        setUploadingFile(true);
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('caption', file.name);
            
            await apiFetch(`/api/devices/${device.id}/chats/${activeChat}/send-media`, {
                method: 'POST',
                body: formData
            });

            // Limpiar el input
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        } catch (err) {
            console.error('Error al enviar archivo:', err);
            alert('Error al enviar el archivo');
        } finally {
            setUploadingFile(false);
        }
    };

    const startRecording = async () => {
        if (!activeChat) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const preferredTypes = [
                'audio/ogg;codecs=opus',
                'audio/webm;codecs=opus',
                'audio/webm'
            ];
            const selectedType = preferredTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';
            const mediaRecorder = selectedType
                ? new MediaRecorder(stream, { mimeType: selectedType })
                : new MediaRecorder(stream);

            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                const audioMime = selectedType || 'audio/webm';
                const audioBlob = new Blob(audioChunksRef.current, { type: audioMime });
                await sendAudio(audioBlob);

                // Detener el stream
                stream.getTracks().forEach(track => track.stop());

                // Limpiar
                audioChunksRef.current = [];
                setRecordingTime(0);
                if (recordingIntervalRef.current) {
                    clearInterval(recordingIntervalRef.current);
                    recordingIntervalRef.current = null;
                }
            };

            mediaRecorder.start();
            setIsRecording(true);

            // Contador de tiempo
            recordingIntervalRef.current = setInterval(() => {
                setRecordingTime(prev => prev + 1);
            }, 1000);

        } catch (err) {
            console.error('Error al iniciar grabación:', err);
            alert('No se pudo acceder al micrófono. Por favor, permite el acceso.');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    const cancelRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            audioChunksRef.current = [];
            setRecordingTime(0);
            if (recordingIntervalRef.current) {
                clearInterval(recordingIntervalRef.current);
                recordingIntervalRef.current = null;
            }
        }
    };

    const sendAudio = async (audioBlob: Blob) => {
        if (!activeChat) return;

        setUploadingFile(true);
        try {
            const formData = new FormData();
            const ext = audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
            formData.append('file', audioBlob, `audio-nota-voz.${ext}`);
            formData.append('caption', 'Nota de voz');
            formData.append('isVoiceNote', 'true');

            await apiFetch(`/api/devices/${device.id}/chats/${activeChat}/send-media`, {
                method: 'POST',
                body: formData
            });
        } catch (err) {
            console.error('Error al enviar audio:', err);
            alert('Error al enviar la nota de voz');
        } finally {
            setUploadingFile(false);
        }
    };

    // Limpiar al desmontar
    useEffect(() => {
        return () => {
            if (recordingIntervalRef.current) {
                clearInterval(recordingIntervalRef.current);
            }
        };
    }, []);

    const handleDeleteChat = async (chatId: string) => {
        try {
            const res = await apiFetch(`/api/devices/${device.id}/chats/${chatId}`, {
                method: 'DELETE'
            });
            if (!res.ok) throw new Error('Error al eliminar chat');
            
            setChats(prev => prev.filter(c => c.id !== chatId));
            if (activeChat === chatId) setActiveChat(null);
            messageApi.success('Chat eliminado');
        } catch (error) {
            console.error('Error eliminando chat:', error);
            messageApi.error('No se pudo eliminar el chat');
        }
    };

    const startLinking = async () => {
        setCurrentDevice(prev => ({ ...prev, status: 'CONNECTING' }));
        try {
            const res = await apiFetch(`/api/devices/${device.id}/start`, { method: 'POST' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Error al iniciar sesión');
            }
            setTimeout(async () => {
                try {
                    const devRes = await apiFetch('/api/devices');
                    const devs = await devRes.json();
                    const updated = Array.isArray(devs) ? devs.find((d: any) => d?.id === device.id) : null;
                    if (updated) setCurrentDevice(prev => ({ ...prev, ...updated }));
                } catch {}
            }, 600);
        } catch (error) {
            console.error('Error al iniciar sesión:', error);
            alert((error as any)?.message || 'Error al iniciar sesión');
        }
    };

    const regenerateQR = async () => {
        try {
            // Detener la sesión actual
            await apiFetch(`/api/devices/${device.id}/stop`, { method: 'POST' });
            // Esperar un momento y reiniciar
            setTimeout(async () => {
                await apiFetch(`/api/devices/${device.id}/start`, { method: 'POST' });
                // No recargar - el polling del modal actualiza automáticamente
                console.log('QR regenerado, esperando nuevo QR...');
            }, 500);
        } catch (error) {
            console.error('Error al regenerar QR:', error);
        }
    };

    const openPairingModal = () => {
        setShowPairingModal(true);
    };

    const submitPasswordChange = async () => {
        if (changingPassword) return;
        if (!currentPassword.trim()) {
            messageApi.error('Ingresá tu contraseña actual');
            return;
        }
        if (newPassword.trim().length < 4) {
            messageApi.error('La nueva contraseña debe tener al menos 4 caracteres');
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
            messageApi.success('Contraseña actualizada');
            setCurrentPassword('');
            setNewPassword('');
            setConfirmNewPassword('');
            setShowSettingsModal(false);
        } catch (error: any) {
            messageApi.error(String(error?.message || 'Error al cambiar contraseña'));
        } finally {
            setChangingPassword(false);
        }
    };

    // Contenido del Modal de Configuración
    const settingsModalContent = (
        <Modal
            open={showSettingsModal}
            title="Configuración"
            onCancel={() => setShowSettingsModal(false)}
            footer={null}
            width={400}
        >
            <Typography.Title level={5}>Tono de notificación</Typography.Title>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                <Radio.Group 
                    onChange={(e) => {
                        const val = e.target.value;
                        setSelectedTone(val);
                        localStorage.setItem('notificationTone', val.toString());
                        playNotificationSound(val);
                    }} 
                    value={selectedTone}
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                    {[
                        { id: 1, name: 'Beep' },
                        { id: 2, name: 'Crystal' },
                        { id: 3, name: 'Bubble' },
                        { id: 4, name: 'Notification' },
                        { id: 5, name: 'Success' },
                        { id: 6, name: 'Laser' },
                        { id: 7, name: 'Coin' },
                        { id: 8, name: 'Pluck' },
                        { id: 9, name: 'Chime' },
                        { id: 10, name: 'Deep' },
                        { id: 11, name: 'Sapeee (Bananero)' },
                        { id: 12, name: 'Bird (Ave)' },
                    ].map(tone => (
                        <div key={tone.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', background: '#202c33', borderRadius: 8, border: '1px solid #2a3942' }}>
                            <Radio value={tone.id} style={{ color: '#e9edef' }}>{tone.name}</Radio>
                            <Button 
                                size="small" 
                                icon={<Play size={14} color="#8696a0" />} 
                                type="text"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    playNotificationSound(tone.id);
                                }}
                            />
                        </div>
                    ))}
                </Radio.Group>
            </div>
            <Divider />
            <Typography.Title level={5}>Seguridad</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Input.Password
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Contraseña actual"
                    autoComplete="current-password"
                />
                <Input.Password
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Nueva contraseña"
                    autoComplete="new-password"
                />
                <Input.Password
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Confirmar nueva contraseña"
                    autoComplete="new-password"
                    onPressEnter={submitPasswordChange}
                />
                <Button type="primary" onClick={submitPasswordChange} loading={changingPassword}>
                    Cambiar contraseña
                </Button>
            </Space>
        </Modal>
    );

    if (currentDevice.status === 'DISCONNECTED' || currentDevice.status === 'CONNECTING' || currentDevice.status === 'PAIRING_CODE_READY') {
        const statusLabel =
            currentDevice.status === 'CONNECTING'
                ? 'conectando...'
                : currentDevice.status === 'PAIRING_CODE_READY'
                    ? 'esperando confirmación'
                    : 'no está vinculado';
        return (
            <div style={{ padding: 40, textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                <h2 style={{ color: '#e9edef' }}>{currentDevice.name} {statusLabel}</h2>
                <p style={{ color: '#8696a0' }}>Podés vincular con QR o con código.</p>
                <Space>
                    <Button type="primary" size="large" onClick={startLinking} loading={currentDevice.status === 'CONNECTING'}>
                        {currentDevice.status === 'CONNECTING' ? 'Iniciando...' : 'Iniciar Sesión (QR)'}
                    </Button>
                    <Button type="default" size="large" onClick={openPairingModal} disabled={currentDevice.status === 'CONNECTING'}>
                        Vincular por código
                    </Button>
                </Space>
                <PairingCodeModal
                    open={showPairingModal}
                    deviceId={device.id}
                    onClose={() => setShowPairingModal(false)}
                />
                {settingsModalContent}
            </div>
        );
    }

    // Modal de Configuración (para reutilizar en todos los estados)
    const SettingsModal = () => (
        <Modal
            open={showSettingsModal}
            title="Configuración"
            onCancel={() => setShowSettingsModal(false)}
            footer={null}
            width={400}
        >
            <Typography.Title level={5}>Tono de notificación</Typography.Title>
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                <Radio.Group 
                    onChange={(e) => {
                        const val = e.target.value;
                        setSelectedTone(val);
                        localStorage.setItem('notificationTone', val.toString());
                        playNotificationSound(val);
                    }} 
                    value={selectedTone}
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                    {[
                        { id: 1, name: 'Beep' },
                        { id: 2, name: 'Crystal' },
                        { id: 3, name: 'Bubble' },
                        { id: 4, name: 'Notification' },
                        { id: 5, name: 'Success' },
                        { id: 6, name: 'Laser' },
                        { id: 7, name: 'Coin' },
                        { id: 8, name: 'Pluck' },
                        { id: 9, name: 'Chime' },
                        { id: 10, name: 'Deep' },
                    ].map(tone => (
                        <div key={tone.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px', background: '#f0f2f5', borderRadius: 8 }}>
                            <Radio value={tone.id}>{tone.name}</Radio>
                            <Button 
                                size="small" 
                                icon={<Play size={14} />} 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    playNotificationSound(tone.id);
                                }}
                            />
                        </div>
                    ))}
                </Radio.Group>
            </div>
            <Divider />
            <Typography.Title level={5}>Seguridad</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Input.Password
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Contraseña actual"
                    autoComplete="current-password"
                />
                <Input.Password
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Nueva contraseña"
                    autoComplete="new-password"
                />
                <Input.Password
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Confirmar nueva contraseña"
                    autoComplete="new-password"
                    onPressEnter={submitPasswordChange}
                />
                <Button type="primary" onClick={submitPasswordChange} loading={changingPassword}>
                    Cambiar contraseña
                </Button>
            </Space>
        </Modal>
    );

    if (currentDevice.status === 'QR_READY' && currentDevice.qr) {
        return (
            <div style={{ padding: 40, textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: '#fff', position: 'relative' }}>
                {onClose && (
                    <Button
                        type="text"
                        icon={<X size={24} />}
                        onClick={onClose}
                        style={{
                            position: 'absolute',
                            top: 10,
                            right: 10,
                            color: '#667781',
                            padding: 8
                        }}
                    />
                )}
                <h2 style={{ color: '#000' }}>Escanea el código QR</h2>
                <div style={{ background: 'white', padding: 20, borderRadius: 10, margin: '20px 0', border: '1px solid #eee' }}>
                    <QRCode value={currentDevice.qr} size={256} />
                </div>
                <p style={{ color: '#667781', marginBottom: '20px' }}>Abre WhatsApp en tu teléfono {'>'} Dispositivos vinculados {'>'} Vincular un dispositivo</p>
                <Space>
                    <Button type="default" size="large" onClick={regenerateQR}>
                        🔄 Regenerar QR
                    </Button>
                    <Button type="default" size="large" onClick={openPairingModal}>
                        Vincular por código
                    </Button>
                    <Button type="link" danger onClick={regenerateQR}>
                        ¿QR expirado? Haz clic aquí
                    </Button>
                </Space>
                <p style={{ color: '#ff4d4f', marginTop: '10px', fontSize: '12px' }}>⚠️ Los códigos QR expiran en 20 segundos</p>
                <PairingCodeModal
                    open={showPairingModal}
                    deviceId={device.id}
                    onClose={() => setShowPairingModal(false)}
                />
                {settingsModalContent}
            </div>
        );
    }

    return (
        <Layout style={{ height: '100%', background: '#0b141a' }}>
            {contextHolder}
            {notificationContextHolder}
            <Sider width={300} style={{ background: '#111b21', borderRight: '1px solid #222e35' }}>
                <div style={{ padding: '10px' }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <Input
                            prefix={<Search size={14} color="#8696a0" />}
                            suffix={searchQuery && (
                                <X
                                    size={14}
                                    color="#8696a0"
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => {
                                        setSearchQuery('');
                                        setSearchResults([]);
                                        setShowSearchModal(false);
                                    }}
                                />
                            )}
                            placeholder="Buscar mensajes..."
                            value={searchQuery}
                            onChange={(e) => handleSearch(e.target.value)}
                            style={{ borderRadius: '8px', background: '#202c33', color: '#d1d7db', border: 'none', flex: 1 }}
                        />
                        <Button 
                            icon={<Settings size={16} color="#8696a0" />} 
                            style={{ background: '#202c33', border: 'none' }}
                            onClick={() => setShowSettingsModal(true)}
                        />
                    </div>
                </div>
                <div style={{ overflowY: 'auto', height: 'calc(100% - 60px)' }}>
                    {chats.length === 0 ? (
                        <div style={{ padding: 40, textAlign: 'center', color: '#8696a0' }}>
                            <p>No hay chats disponibles</p>
                            <p style={{ fontSize: '12px' }}>Envía o recibe un mensaje para ver tus conversaciones</p>
                        </div>
                    ) : (
                        <List
                            dataSource={chats}
                            renderItem={chat => (
                                <List.Item
                                    onClick={() => {
                                        console.log('Chat seleccionado:', chat.id);
                                        setActiveChat(chat.id);
                                        // Resetear contador de no leídos al abrir el chat
                                        setChats(prev => prev.map(c => 
                                            c.id === chat.id ? { ...c, unreadCount: 0 } : c
                                        ));
                                    }}
                                    style={{
                                        padding: '12px 15px',
                                        borderBottom: '1px solid #222e35',
                                        cursor: 'pointer',
                                        background: activeChat === chat.id ? '#2a3942' : 'transparent',
                                        transition: 'background 0.2s'
                                    }}
                                >
                                    <List.Item.Meta
                                        avatar={
                                            <Avatar
                                                style={{ backgroundColor: chat.isGroup ? '#25D366' : '#6a7175' }}
                                            >
                                                {chat.name.substring(0, 2).toUpperCase()}
                                            </Avatar>
                                        }
                                        title={
                                            <div style={{ color: '#e9edef', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span>{chat.name}</span>
                                                <Space size={4}>
                                                    {chat.unreadCount > 0 && (
                                                        <Badge
                                                            count={chat.unreadCount}
                                                            style={{ backgroundColor: '#25D366' }}
                                                        />
                                                    )}
                                                    <span style={{ fontSize: '11px', color: '#8696a0' }}>
                                                        {new Date(chat.lastMessageTime).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                    <div onClick={(e) => e.stopPropagation()}>
                                                        <Popconfirm
                                                            title="¿Eliminar chat?"
                                                            description="Se eliminará de la lista pero no de WhatsApp"
                                                            onConfirm={() => handleDeleteChat(chat.id)}
                                                            okText="Sí"
                                                            cancelText="No"
                                                        >
                                                            <Button 
                                                                type="text" 
                                                                size="small" 
                                                                icon={<Trash2 size={14} color="#8696a0" />} 
                                                                style={{ minWidth: 24, padding: 0 }}
                                                            />
                                                        </Popconfirm>
                                                    </div>
                                                </Space>
                                            </div>
                                        }
                                        description={
                                            <Text ellipsis style={{ color: '#8696a0', fontSize: '13px' }}>
                                                {chat.isGroup ? '👥 Grupo' : 'Chat privado'}
                                            </Text>
                                        }
                                    />
                                </List.Item>
                            )}
                        />
                    )}
                </div>
            </Sider>
            <Content style={{ display: 'flex', flexDirection: 'column', background: '#0b141a' }}>
                {activeChat ? (
                    <>
                        {(() => {
                            const activeChatData = chats.find(c => c.id === activeChat);
                            const chatName = activeChatData?.name || activeChat.split('@')[0];
                            return (
                                <div style={{ padding: '10px 20px', background: '#202c33', display: 'flex', alignItems: 'center', borderBottom: '1px solid #222e35' }}>
                                    <Avatar style={{ backgroundColor: activeChatData?.isGroup ? '#25D366' : '#6a7175' }}>
                                        {chatName.substring(0, 2).toUpperCase()}
                                    </Avatar>
                                    <div style={{ marginLeft: 15 }}>
                                        <div style={{ color: '#e9edef', fontWeight: 'bold' }}>{chatName}</div>
                                        {presence && (
                                            <div style={{ color: '#25D366', fontSize: '11px' }}>
                                                {presence === 'composing' ? 'escribiendo...' : presence === 'recording' ? 'grabando audio...' : ''}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })()}

                        <div
                            ref={scrollRef}
                            style={{
                                flex: 1,
                                padding: 20,
                                overflowY: 'auto',
                                background: 'repeating-linear-gradient(45deg, #0b141a 0, #0b141a 12px, #0a1319 12px, #0a1319 24px)',
                                backgroundSize: 'auto'
                            }}
                        >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                {messages.map((m, i) => (
                                    <div key={i} style={{
                                        alignSelf: m.fromMe ? 'flex-end' : 'flex-start',
                                        background: m.fromMe ? (m.source === 'panel' ? '#005c4b' : '#1f3b2f') : '#202c33',
                                        padding: '5px',
                                        borderRadius: '8px',
                                        color: '#e9edef',
                                        maxWidth: '70%',
                                        boxShadow: '0 1px 0.5px rgba(0,0,0,0.13)',
                                        position: 'relative'
                                    }}>
                                        {m.location && Number.isFinite(m.location.latitude) && Number.isFinite(m.location.longitude) && (
                                            <div
                                                style={{
                                                    background: 'rgba(0,0,0,0.2)',
                                                    padding: '10px 12px',
                                                    borderRadius: 6,
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    gap: 6
                                                }}
                                            >
                                                <div style={{ fontSize: '13px', fontWeight: 600 }}>📍 Ubicación</div>
                                                {(m.location.name || m.location.address) && (
                                                    <div style={{ fontSize: '12px', color: '#d1d7db' }}>
                                                        {m.location.name && <div>{m.location.name}</div>}
                                                        {m.location.address && <div style={{ color: '#8696a0' }}>{m.location.address}</div>}
                                                    </div>
                                                )}
                                                <div style={{ fontSize: '11px', color: '#8696a0' }}>
                                                    {m.location.latitude.toFixed(5)}, {m.location.longitude.toFixed(5)}
                                                </div>
                                                <div>
                                                    <a
                                                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${m.location.latitude},${m.location.longitude}`)}`}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        style={{ color: '#25D366', fontSize: '12px' }}
                                                    >
                                                        Abrir en Google Maps
                                                    </a>
                                                </div>
                                            </div>
                                        )}
                                        {m.media && (
                                            <div style={{ marginBottom: 5, borderRadius: 4, overflow: 'hidden' }}>
                                                {m.media.mimeType.startsWith('image/') ? (
                                                    <img
                                                        src={assetUrl(m.media.url)}
                                                        alt={m.media.fileName}
                                                        style={{ maxWidth: '100%', maxHeight: 300, display: 'block', cursor: 'pointer' }}
                                                        onClick={() => window.open(assetUrl(m.media?.url || ''))}
                                                    />
                                                ) : m.media.mimeType.startsWith('video/') ? (
                                                    <video controls style={{ maxWidth: '100%', maxHeight: 300 }}>
                                                        <source src={assetUrl(m.media.url)} type={m.media.mimeType} />
                                                    </video>
                                                ) : m.media.mimeType.startsWith('audio/') ? (
                                                    <audio controls style={{ maxWidth: 250 }}>
                                                        <source src={assetUrl(m.media.url)} type={m.media.mimeType} />
                                                    </audio>
                                                ) : (
                                                    <div
                                                        style={{ background: 'rgba(0,0,0,0.2)', padding: '10px 15px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                                                        onClick={() => window.open(assetUrl(m.media?.url || ''))}
                                                    >
                                                        <Paperclip size={20} />
                                                        <div style={{ flex: 1, overflow: 'hidden' }}>
                                                            <div style={{ fontSize: '13px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{m.media.fileName}</div>
                                                            <div style={{ fontSize: '11px', color: '#8696a0' }}>{(m.media.size / 1024).toFixed(1)} KB</div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {m.text && <div style={{ padding: '3px 7px 0 7px' }}>{m.text}</div>}
                                        <div style={{ fontSize: '10px', color: '#8696a0', textAlign: 'right', marginTop: 4, padding: '0 5px 2px 7px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                                            {(m.source === 'panel' || m.source === 'phone' || m.source === 'whatsapp') && (
                                                <Tooltip title={`Enviado desde ${m.source === 'panel' ? 'el Panel' : 'el Dispositivo'}`}>
                                                    <span>
                                                        <Badge status="processing" text={m.source === 'panel' ? 'Panel' : 'Dispositivo'} style={{ fontSize: '9px', color: '#53bdeb' }} />
                                                    </span>
                                                </Tooltip>
                                            )}
                                            {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            {m.fromMe && <CheckCheck size={12} color="#53bdeb" />}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div style={{ padding: '10px', background: '#202c33', display: 'flex', alignItems: 'center', gap: 10 }}>
                            {isRecording ? (
                                <>
                                    <Tooltip title="Cancelar grabación">
                                        <Button
                                            type="text"
                                            danger
                                            icon={<span style={{ fontSize: '20px' }}>✕</span>}
                                            onClick={cancelRecording}
                                        />
                                    </Tooltip>
                                    <div style={{
                                        flex: 1,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 10,
                                        background: '#2a3942',
                                        padding: '10px 15px',
                                        borderRadius: '8px'
                                    }}>
                                        <div style={{
                                            width: 12,
                                            height: 12,
                                            borderRadius: '50%',
                                            background: '#ff4d4f',
                                            animation: 'pulse 1.5s ease-in-out infinite'
                                        }} />
                                        <span style={{ color: '#e9edef', fontSize: '14px' }}>
                                            Grabando... {Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}
                                        </span>
                                    </div>
                                    <Tooltip title="Enviar nota de voz">
                                        <Button
                                            type="text"
                                            onClick={stopRecording}
                                            icon={<Send size={20} color="#25D366" />}
                                        />
                                    </Tooltip>
                                </>
                            ) : (
                                <>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*,.pdf,application/pdf,video/*,audio/*"
                                        style={{ display: 'none' }}
                                        onChange={handleFileSelect}
                                    />
                                    <Tooltip title="Adjuntar archivo">
                                        <Button
                                            type="text"
                                            icon={<Paperclip size={20} color="#8696a0" />}
                                            onClick={() => fileInputRef.current?.click()}
                                            loading={uploadingFile}
                                            disabled={uploadingFile}
                                        />
                                    </Tooltip>
                                    <Input
                                        value={inputText}
                                        onChange={e => {
                                            const text = e.target.value;
                                            setInputText(text);
                                        }}
                                        onKeyDown={e => {
                                            // Detectar atajos cuando se presiona espacio o Enter
                                            if (e.key === ' ' || e.key === 'Enter') {
                                                const text = inputText.trim();
                                                if (text.startsWith('/')) {
                                                    const template = templates.find(t => t.shortcut === text);
                                                    if (template) {
                                                        e.preventDefault();
                                                        setInputText(template.content);
                                                        return;
                                                    }
                                                }
                                            }
                                        }}
                                        onPressEnter={e => {
                                            // Solo enviar si no es un atajo
                                            const text = inputText.trim();
                                            if (text.startsWith('/')) {
                                                const template = templates.find(t => t.shortcut === text);
                                                if (template) {
                                                    return; // No enviar, el onKeyDown ya manejó esto
                                                }
                                            }
                                            sendMessage();
                                        }}
                                        placeholder="Escribe un mensaje o usa /atajo + espacio"
                                        style={{ borderRadius: '8px', background: '#2a3942', color: '#d1d7db', border: 'none', height: '40px' }}
                                        disabled={uploadingFile}
                                    />
                                    {inputText ? (
                                        <Button type="text" onClick={sendMessage} loading={loading} icon={<Send size={20} color="#25D366" />} />
                                    ) : (
                                        <Tooltip title="Mantén presionado para grabar">
                                            <Button
                                                type="text"
                                                icon={<Mic size={20} color={uploadingFile ? "#8696a0" : "#25D366"} />}
                                                onClick={startRecording}
                                                disabled={uploadingFile}
                                            />
                                        </Tooltip>
                                    )}
                                </>
                            )}
                        </div>
                    </>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8696a0' }}>
                        Selecciona un chat para comenzar
                    </div>
                )}
            </Content>

            {/* Modal de resultados de búsqueda */}
            <Modal
                title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Search size={18} />
                        <span>Resultados de búsqueda: "{searchQuery}"</span>
                    </div>
                }
                open={showSearchModal}
                onCancel={() => {
                    setShowSearchModal(false);
                    setSearchQuery('');
                    setSearchResults([]);
                }}
                footer={null}
                width={600}
                styles={{
                    content: { background: '#111b21' },
                    header: { background: '#111b21', color: '#e9edef' },
                    body: { background: '#111b21', maxHeight: '60vh', overflowY: 'auto' }
                }}
            >
                {isSearching ? (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                        <Spin size="large" />
                        <div style={{ color: '#8696a0', marginTop: 16 }}>Buscando mensajes...</div>
                    </div>
                ) : searchResults.length === 0 ? (
                    <Empty
                        description={<span style={{ color: '#8696a0' }}>No se encontraron mensajes</span>}
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                ) : (
                    <List
                        dataSource={searchResults}
                        renderItem={(result) => (
                            <List.Item
                                onClick={() => goToSearchResult(result)}
                                style={{
                                    padding: '12px 16px',
                                    cursor: 'pointer',
                                    borderBottom: '1px solid #222e35',
                                    transition: 'background 0.2s'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = '#202c33'}
                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                <List.Item.Meta
                                    avatar={
                                        <Avatar style={{ background: result.fromMe ? '#005c4b' : '#202c33' }}>
                                            {result.chatName.charAt(0).toUpperCase()}
                                        </Avatar>
                                    }
                                    title={
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <Text style={{ color: '#e9edef' }}>
                                                {result.chatName}
                                            </Text>
                                            <Text style={{ color: '#8696a0', fontSize: '11px' }}>
                                                {new Date(result.timestamp).toLocaleString()}
                                            </Text>
                                        </div>
                                    }
                                    description={
                                        <div style={{ color: '#d1d7db' }}>
                                            <Badge
                                                status={result.fromMe ? 'processing' : 'default'}
                                                text={
                                                    <span style={{ color: '#8696a0', fontSize: '11px' }}>
                                                        {result.fromMe ? 'Tú' : 'Contacto'}
                                                    </span>
                                                }
                                            />
                                            <div style={{ marginTop: 4 }}>
                                                {result.text.length > 150
                                                    ? result.text.substring(0, 150) + '...'
                                                    : result.text
                                                }
                                            </div>
                                        </div>
                                    }
                                />
                            </List.Item>
                        )}
                    />
                )}
            </Modal>
            {settingsModalContent}
        </Layout>
    );
};
