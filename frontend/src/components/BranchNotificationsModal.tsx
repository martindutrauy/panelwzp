import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Divider, Modal, Radio, Select, Slider, Space, Switch, Typography, message } from 'antd';
import { Play } from 'lucide-react';
import { getBranchNotificationSettings, setBranchNotificationSettings, subscribeBranchNotificationSettings } from '../services/branchNotificationSettings.service';
import { CUSTOM_TONE_ID, playCustomNotificationTone, playNotificationTone, revokeCustomToneCache, unlockNotificationAudio } from '../services/notificationSound.service';
import { deleteCustomNotificationTone, loadCustomNotificationTone, saveCustomNotificationTone } from '../services/customNotificationToneStorage.service';
import { getTtsVoices, initTts } from '../services/tts.service';
import { enqueueTts } from '../services/notificationQueueManager.service';

const { Text } = Typography;

export const BranchNotificationsModal = ({
    open,
    branchId,
    branchName,
    onClose
}: {
    open: boolean;
    branchId: string;
    branchName: string;
    onClose: () => void;
}) => {
    const [messageApi, contextHolder] = message.useMessage();
    const [settings, setSettings] = useState(() => getBranchNotificationSettings(branchId));
    const [voicesVersion, setVoicesVersion] = useState(0);
    const [hasCustomTone, setHasCustomTone] = useState(false);
    const [recording, setRecording] = useState(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        setSettings(getBranchNotificationSettings(branchId));
        void loadCustomNotificationTone(branchId)
            .then((b) => setHasCustomTone(Boolean(b)))
            .catch(() => setHasCustomTone(false));
        return subscribeBranchNotificationSettings((id, s) => {
            if (id !== branchId) return;
            setSettings(s);
        });
    }, [branchId]);

    useEffect(() => {
        if (!open) return;
        initTts();
        const bump = () => setVoicesVersion(v => v + 1);
        try {
            window.speechSynthesis?.addEventListener?.('voiceschanged', bump);
        } catch {}
        const t = setTimeout(bump, 200);
        return () => {
            clearTimeout(t);
            try {
                window.speechSynthesis?.removeEventListener?.('voiceschanged', bump);
            } catch {}
        };
    }, [open]);

    const voices = useMemo(() => {
        void voicesVersion;
        return getTtsVoices();
    }, [voicesVersion]);

    const volumePercent = Math.round((settings.toneVolume || 0) * 100);

    const testNotification = () => {
        unlockNotificationAudio();
        if (settings.toneId === CUSTOM_TONE_ID) {
            void playCustomNotificationTone({ branchId, volume: settings.toneVolume });
        } else {
            playNotificationTone({ toneId: settings.toneId, volume: settings.toneVolume });
        }
        const text = `${branchName}, mensaje de Juan Pérez`;
        window.setTimeout(() => {
            enqueueTts({
                text,
                voiceURI: settings.ttsVoiceURI,
                lang: settings.ttsLang === 'auto' ? null : settings.ttsLang,
                rate: settings.ttsRate,
                pitch: settings.ttsPitch
            });
        }, 5000);
        messageApi.success('Notificación enviada (voz en 5s)');
    };

    const stopRecording = () => {
        const mr = mediaRecorderRef.current;
        if (mr && mr.state !== 'inactive') {
            try { mr.stop(); } catch {}
        }
        const st = mediaStreamRef.current;
        if (st) {
            for (const t of st.getTracks()) {
                try { t.stop(); } catch {}
            }
        }
        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;
        setRecording(false);
    };

    useEffect(() => {
        if (open) return;
        stopRecording();
    }, [open]);

    const startRecording = async () => {
        if (recording) return;
        if (!('MediaRecorder' in window)) {
            messageApi.error('Tu navegador no soporta grabación de audio');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            const chunks: BlobPart[] = [];
            const mr = new MediaRecorder(stream);
            mediaRecorderRef.current = mr;
            mr.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) chunks.push(e.data);
            };
            mr.onstop = async () => {
                const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
                await saveCustomNotificationTone(branchId, blob);
                revokeCustomToneCache(branchId);
                setHasCustomTone(true);
                setBranchNotificationSettings(branchId, { toneId: CUSTOM_TONE_ID });
                unlockNotificationAudio();
                void playCustomNotificationTone({ branchId, volume: settings.toneVolume });
            };
            mr.start();
            setRecording(true);
        } catch (e: any) {
            messageApi.error(String(e?.message || 'No se pudo acceder al micrófono'));
            stopRecording();
        }
    };

    const onPickFile = () => {
        fileInputRef.current?.click();
    };

    const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        if (!String(f.type || '').startsWith('audio/')) {
            messageApi.error('Elegí un archivo de audio');
            return;
        }
        await saveCustomNotificationTone(branchId, f);
        revokeCustomToneCache(branchId);
        setHasCustomTone(true);
        setBranchNotificationSettings(branchId, { toneId: CUSTOM_TONE_ID });
        unlockNotificationAudio();
        void playCustomNotificationTone({ branchId, volume: settings.toneVolume });
        messageApi.success('Tono personalizado guardado');
    };

    const clearCustom = async () => {
        stopRecording();
        await deleteCustomNotificationTone(branchId).catch(() => {});
        revokeCustomToneCache(branchId);
        setHasCustomTone(false);
        if (settings.toneId === CUSTOM_TONE_ID) {
            setBranchNotificationSettings(branchId, { toneId: 1 });
        }
        messageApi.success('Tono personalizado eliminado');
    };

    return (
        <Modal open={open} title={`Notificaciones (${branchName})`} onCancel={onClose} footer={null} width={440}>
            {contextHolder}
            <input ref={fileInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={onFileChange} />
            <Typography.Title level={5}>Tono</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: '#e9edef' }}>Reproducir tono al llegar mensaje</Text>
                    <Switch
                        checked={settings.toneEnabled}
                        onChange={(v) => setBranchNotificationSettings(branchId, { toneEnabled: v })}
                    />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: '#e9edef' }}>Sonar incluso si estoy viendo el chat</Text>
                    <Switch
                        checked={settings.playToneWhileChatOpen}
                        onChange={(v) => setBranchNotificationSettings(branchId, { playToneWhileChatOpen: v })}
                    />
                </div>
                <div>
                    <Text style={{ color: '#e9edef' }}>Volumen</Text>
                    <Slider
                        min={0}
                        max={100}
                        value={volumePercent}
                        onChange={(v) => setBranchNotificationSettings(branchId, { toneVolume: Number(v) / 100 })}
                    />
                </div>
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    <Radio.Group
                        onChange={(e) => {
                            const val = e.target.value;
                            localStorage.setItem('notificationTone', String(val));
                            setBranchNotificationSettings(branchId, { toneId: val });
                            unlockNotificationAudio();
                            if (val === CUSTOM_TONE_ID) {
                                void playCustomNotificationTone({ branchId, volume: settings.toneVolume });
                            } else {
                                playNotificationTone({ toneId: val, volume: settings.toneVolume });
                            }
                        }}
                        value={settings.toneId}
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
                            { id: 13, name: 'Lokita (Bananero)' }
                            ,
                            { id: CUSTOM_TONE_ID, name: 'Personalizado' }
                        ].map(tone => (
                            <div key={tone.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', background: '#202c33', borderRadius: 8, border: '1px solid #2a3942' }}>
                                <Radio value={tone.id} style={{ color: '#e9edef' }}>{tone.name}</Radio>
                                <Button
                                    size="small"
                                    icon={<Play size={14} color="#8696a0" />}
                                    type="text"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        unlockNotificationAudio();
                                        if (tone.id === CUSTOM_TONE_ID) {
                                            void playCustomNotificationTone({ branchId, volume: settings.toneVolume });
                                        } else {
                                            playNotificationTone({ toneId: tone.id, volume: settings.toneVolume });
                                        }
                                    }}
                                />
                            </div>
                        ))}
                    </Radio.Group>
                </div>
                <div style={{ padding: 12, background: '#111b21', border: '1px solid #2a3942', borderRadius: 8 }}>
                    <Text style={{ color: '#e9edef', display: 'block', marginBottom: 8 }}>Tono personalizado</Text>
                    <Space wrap>
                        <Button onClick={onPickFile}>Subir audio</Button>
                        {!recording ? (
                            <Button onClick={startRecording}>Grabar</Button>
                        ) : (
                            <Button danger onClick={stopRecording}>Detener</Button>
                        )}
                        <Button disabled={!hasCustomTone} onClick={() => void playCustomNotificationTone({ branchId, volume: settings.toneVolume })}>
                            Escuchar
                        </Button>
                        <Button disabled={!hasCustomTone} danger onClick={() => void clearCustom()}>
                            Borrar
                        </Button>
                    </Space>
                    <div style={{ marginTop: 8 }}>
                        <Text style={{ color: '#8696a0', fontSize: 12 }}>
                            {recording ? 'Grabando... (usa Detener para guardar)' : hasCustomTone ? 'Guardado para esta sucursal' : 'Aún no hay audio cargado'}
                        </Text>
                    </div>
                </div>
            </Space>
            <Divider />
            <Typography.Title level={5}>Voz artificial</Typography.Title>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: '#e9edef' }}>Leer mensaje con voz artificial</Text>
                    <Switch
                        checked={settings.ttsEnabled}
                        onChange={(v) => {
                            setBranchNotificationSettings(branchId, { ttsEnabled: v });
                            if (v) initTts();
                        }}
                    />
                </div>
                <div>
                    <Text style={{ color: '#e9edef' }}>Voz</Text>
                    <Select
                        value={settings.ttsVoiceURI || 'auto'}
                        onChange={(v) => setBranchNotificationSettings(branchId, { ttsVoiceURI: v === 'auto' ? null : String(v) })}
                        style={{ width: '100%' }}
                        options={[
                            { value: 'auto', label: 'Auto' },
                            ...voices.map(v => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` }))
                        ]}
                    />
                </div>
                <div>
                    <Text style={{ color: '#e9edef' }}>Idioma</Text>
                    <Select
                        value={settings.ttsLang || 'auto'}
                        onChange={(v) => setBranchNotificationSettings(branchId, { ttsLang: String(v) })}
                        style={{ width: '100%' }}
                        options={[
                            { value: 'auto', label: 'Auto' },
                            { value: 'es-UY', label: 'es-UY' },
                            { value: 'es-AR', label: 'es-AR' },
                            { value: 'es-ES', label: 'es-ES' }
                        ]}
                    />
                </div>
                <div>
                    <Text style={{ color: '#e9edef' }}>Velocidad</Text>
                    <Slider min={60} max={160} value={Math.round(settings.ttsRate * 100)} onChange={(v) => setBranchNotificationSettings(branchId, { ttsRate: Number(v) / 100 })} />
                </div>
                <div>
                    <Text style={{ color: '#e9edef' }}>Tono de voz</Text>
                    <Slider min={0} max={200} value={Math.round(settings.ttsPitch * 100)} onChange={(v) => setBranchNotificationSettings(branchId, { ttsPitch: Number(v) / 100 })} />
                </div>
                <div style={{ padding: 10, background: '#111b21', border: '1px solid #2a3942', borderRadius: 8 }}>
                    <Text style={{ color: '#8696a0' }}>{`"${branchName}, mensaje de {CONTACTO}"`}</Text>
                </div>
                <Button type="primary" onClick={testNotification}>
                    Probar notificación
                </Button>
            </Space>
        </Modal>
    );
};
