import { CUSTOM_TONE_ID, playCustomNotificationTone, playNotificationTone } from './notificationSound.service';
import { isChatInFocus } from './notificationFocus.service';
import { getBranchNotificationSettings } from './branchNotificationSettings.service';
import { enqueueTts } from './notificationQueueManager.service';
import { isTtsSupported } from './tts.service';

type IncomingMessageEvent = {
    branchId: string;
    branchName: string;
    chatId: string;
    fromMe: boolean;
    msgId?: string | null;
    timestamp?: number;
    senderName?: string | null;
};

const playedByMsg = new Map<string, number>();

type SpeakState = { lastAt: number; pending: number; timer: number | null; lastName: string; lastChatId: string };
const speakByContact = new Map<string, SpeakState>();

const normalizeName = (name: string) => String(name || '').trim();

const contactKeyOf = (chatId: string) => {
    if (!chatId) return '';
    if (chatId.includes('@g.us')) return chatId;
    const prefix = chatId.split('@')[0] || chatId;
    return prefix.split(':')[0] || prefix;
};

const getFallbackName = (chatId: string, readNumber: boolean) => {
    if (readNumber) return chatId.split('@')[0] || chatId;
    return 'Número desconocido';
};

const debug = (branchId: string, enabled: boolean, msg: string) => {
    if (!enabled) return;
    try { console.log(msg); } catch {}
};

export const notifyIncomingMessage = (evt: IncomingMessageEvent) => {
    if (evt.fromMe) return;

    const branchId = String(evt.branchId || '');
    const branchName = String(evt.branchName || '').trim();
    const chatId = String(evt.chatId || '');
    if (!branchId || !chatId) return;

    const msgId = String(evt.msgId || '');
    const msgKey = msgId ? `${branchId}:${chatId}:${msgId}` : `${branchId}:${chatId}:${String(evt.timestamp || '')}`;
    const now = Date.now();
    const lastPlayed = playedByMsg.get(msgKey) || 0;
    if (msgKey && now - lastPlayed < 1000) return;
    if (msgKey) playedByMsg.set(msgKey, now);

    const s = getBranchNotificationSettings(branchId);
    debug(branchId, s.debugLogs, `[branchId=${branchId}] settings loaded`);

    const focused = isChatInFocus(branchId, chatId);
    debug(branchId, s.debugLogs, `[branchId=${branchId}] nuevo mensaje: chat=${chatId} focus=${focused}`);

    if (s.toneEnabled) {
        if (!focused || s.playToneWhileChatOpen) {
            if (s.toneId === CUSTOM_TONE_ID) {
                void playCustomNotificationTone({ branchId, volume: s.toneVolume });
            } else {
                playNotificationTone({ toneId: s.toneId, volume: s.toneVolume });
            }
            debug(branchId, s.debugLogs, `[branchId=${branchId}] tone played`);
        } else {
            debug(branchId, s.debugLogs, `[branchId=${branchId}] tone suppressed (focus)`);
        }
    }

    if (!s.ttsEnabled) return;
    if (!isTtsSupported()) return;
    if (focused) {
        debug(branchId, s.debugLogs, `[branchId=${branchId}] voice suppressed (focus)`);
        return;
    }

    const contactKey = `${branchId}:${contactKeyOf(chatId)}`;
    const state = speakByContact.get(contactKey) || { lastAt: 0, pending: 0, timer: null, lastName: '', lastChatId: chatId };
    const nameRaw = normalizeName(String(evt.senderName || ''));
    const name = nameRaw || getFallbackName(chatId, s.ttsReadNumberWhenUnknown);
    state.lastName = name;
    state.lastChatId = chatId;
    state.pending += 1;

    const schedule = (delayMs: number) => {
        if (state.timer != null) return;
        if (delayMs === 5000) debug(branchId, s.debugLogs, `[branchId=${branchId}] voice scheduled (5000ms)`);
        state.timer = window.setTimeout(() => {
            const st = speakByContact.get(contactKey);
            if (!st) return;
            const count = Math.max(1, st.pending);
            const now2 = Date.now();
            const cooldownMs = 10000;
            const wait = Math.max(0, cooldownMs - (now2 - st.lastAt));
            if (wait > 0) {
                st.timer = null;
                speakByContact.set(contactKey, st);
                schedule(wait + 20);
                return;
            }

            if (isChatInFocus(branchId, st.lastChatId)) {
                st.pending = 0;
                st.timer = null;
                speakByContact.set(contactKey, st);
                debug(branchId, s.debugLogs, `[branchId=${branchId}] voice suppressed (focus)`);
                return;
            }

            const branchPrefix = branchName || branchId;
            const phrase = count > 1 ? 'mensajes de' : 'mensaje de';
            const text = `${branchPrefix}, ${phrase} ${st.lastName}`;
            enqueueTts({
                text,
                voiceURI: s.ttsVoiceURI,
                lang: s.ttsLang === 'auto' ? null : s.ttsLang,
                rate: s.ttsRate,
                pitch: s.ttsPitch
            });

            debug(branchId, s.debugLogs, `[branchId=${branchId}] speaking: "${text}"`);
            if (count > 1) debug(branchId, s.debugLogs, `[branchId=${branchId}] grouped messages: ${count}`);

            st.lastAt = Date.now();
            st.pending = 0;
            st.timer = null;
            speakByContact.set(contactKey, st);
        }, delayMs);
    };

    speakByContact.set(contactKey, state);
    schedule(5000);
};
