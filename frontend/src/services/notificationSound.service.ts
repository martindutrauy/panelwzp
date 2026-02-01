import { loadCustomNotificationTone } from './customNotificationToneStorage.service';

type ToneRequest = {
    toneId: number;
    volume: number;
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export const CUSTOM_TONE_ID = 900;

let audioCtx: AudioContext | null = null;
let sapeAudio: HTMLAudioElement | null = null;
let lokitaAudio: HTMLAudioElement | null = null;
const customToneUrlByBranch = new Map<string, string>();

const getAudioCtx = () => {
    if (audioCtx) return audioCtx;
    try {
        const w = window as any;
        if (w.__wzpAudioCtx) {
            audioCtx = w.__wzpAudioCtx as AudioContext;
        } else {
            audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            w.__wzpAudioCtx = audioCtx;
        }
        return audioCtx;
    } catch {
        return null;
    }
};

export const unlockNotificationAudio = () => {
    try {
        const ctx = getAudioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        if (ctx.state !== 'running') return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.00001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        const now = ctx.currentTime;
        osc.start(now);
        osc.stop(now + 0.01);
    } catch {}
};

export const playNotificationTone = ({ toneId, volume }: ToneRequest) => {
    const vol = clamp(Number(volume) || 0, 0, 1);
    if (vol <= 0) return;

    try {
        if (toneId === 11) {
            if (!sapeAudio) {
                sapeAudio = new Audio('https://www.myinstants.com/media/sounds/sape.mp3');
                sapeAudio.preload = 'auto';
            }
            const a = sapeAudio.cloneNode(true) as HTMLAudioElement;
            a.volume = clamp(vol, 0, 1);
            a.play().catch(() => {});
            return;
        }
        if (toneId === 13) {
            if (!lokitaAudio) {
                lokitaAudio = new Audio('https://www.myinstants.com/media/sounds/mas-bien-loquita.mp3');
                lokitaAudio.preload = 'auto';
            }
            const a = lokitaAudio.cloneNode(true) as HTMLAudioElement;
            a.volume = clamp(vol, 0, 1);
            a.play().catch(() => {});
            return;
        }

        const ctx = getAudioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        if (ctx.state !== 'running') return;

        const now = ctx.currentTime;

        const createOsc = (type: OscillatorType, freq: number, start: number, dur: number, gainVol: number) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, start);
            gain.gain.setValueAtTime(gainVol, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + dur);
        };

        const base = clamp(vol, 0, 1);

        switch (toneId) {
            case 1:
                createOsc('sine', 880, now, 0.08, 0.08 * base);
                createOsc('sine', 660, now + 0.09, 0.08, 0.08 * base);
                break;
            case 2:
                createOsc('triangle', 1046, now, 0.06, 0.06 * base);
                createOsc('triangle', 1318, now + 0.07, 0.06, 0.06 * base);
                break;
            case 3:
                createOsc('sine', 740, now, 0.05, 0.06 * base);
                createOsc('sine', 988, now + 0.06, 0.05, 0.06 * base);
                break;
            case 4:
                createOsc('square', 523, now, 0.06, 0.04 * base);
                createOsc('square', 659, now + 0.07, 0.06, 0.04 * base);
                break;
            case 5:
                createOsc('sine', 880, now, 0.06, 0.07 * base);
                createOsc('sine', 1174, now + 0.07, 0.09, 0.07 * base);
                break;
            case 6:
                createOsc('sawtooth', 1200, now, 0.05, 0.05 * base);
                createOsc('sawtooth', 900, now + 0.05, 0.05, 0.05 * base);
                break;
            case 7:
                createOsc('triangle', 988, now, 0.04, 0.05 * base);
                createOsc('triangle', 740, now + 0.05, 0.04, 0.05 * base);
                break;
            case 8:
                createOsc('sine', 660, now, 0.05, 0.05 * base);
                createOsc('sine', 880, now + 0.06, 0.05, 0.05 * base);
                break;
            case 9:
                createOsc('triangle', 880, now, 0.06, 0.06 * base);
                createOsc('triangle', 1320, now + 0.07, 0.08, 0.06 * base);
                break;
            case 10:
                createOsc('sine', 220, now, 0.12, 0.1 * base);
                break;
            case 12: {
                const freqs = [1568, 1760, 1976];
                freqs.forEach((f, idx) => createOsc('sine', f, now + idx * 0.03, 0.03, 0.04 * base));
                break;
            }
            default:
                createOsc('sine', 880, now, 0.08, 0.08 * base);
        }
    } catch {}
};

const getCustomToneUrl = async (branchId: string) => {
    const id = String(branchId || '').trim();
    if (!id) return null;
    const cached = customToneUrlByBranch.get(id);
    if (cached) return cached;
    const blob = await loadCustomNotificationTone(id).catch(() => null);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    customToneUrlByBranch.set(id, url);
    return url;
};

export const revokeCustomToneCache = (branchId: string) => {
    const id = String(branchId || '').trim();
    if (!id) return;
    const url = customToneUrlByBranch.get(id);
    if (url) {
        try { URL.revokeObjectURL(url); } catch {}
    }
    customToneUrlByBranch.delete(id);
};

export const playCustomNotificationTone = async ({ branchId, volume }: { branchId: string; volume: number }) => {
    const vol = clamp(Number(volume) || 0, 0, 1);
    if (vol <= 0) return;
    const url = await getCustomToneUrl(branchId);
    if (!url) return;
    try {
        const a = new Audio(url);
        a.volume = clamp(vol, 0, 1);
        a.play().catch(() => {});
    } catch {}
};
