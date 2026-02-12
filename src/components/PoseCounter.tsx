import { useRef, useState, useEffect } from 'react';

type Landmark = { x: number; y: number; visibility?: number };

const calcAngle = (a: Landmark, b: Landmark, c: Landmark) => {
    const rad = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let deg = Math.abs(rad * 180 / Math.PI);
    if (deg > 180) deg = 360 - deg;
    return deg;
};

const isVisible = (lm: Landmark, threshold = 0.35) => (lm.visibility ?? 0) > threshold;

const LM = {
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
    LEFT_WRIST: 15, RIGHT_WRIST: 16,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
};

// Telegram user info
interface TgUser {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
}

const getTelegramUser = (): TgUser | null => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tg = (window as any).Telegram?.WebApp;
        if (tg) {
            tg.ready();
            tg.expand();
            if (tg.initDataUnsafe?.user) {
                return tg.initDataUnsafe.user as TgUser;
            }
        }
    } catch {
        // Not in Telegram
    }
    return null;
};

// Simple localStorage history
const HISTORY_KEY = 'pushup_history';

interface WorkoutRecord {
    userId: number | null;
    userName: string;
    count: number;
    date: string;
    durationSec: number;
}

const saveWorkout = (record: WorkoutRecord) => {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const history: WorkoutRecord[] = raw ? JSON.parse(raw) : [];
        history.unshift(record);
        // Keep last 50
        if (history.length > 50) history.length = 50;
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
        // Storage might be unavailable
    }
};

const getHistory = (userId: number | null): WorkoutRecord[] => {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const history: WorkoutRecord[] = raw ? JSON.parse(raw) : [];
        if (userId) return history.filter(r => r.userId === userId);
        return history;
    } catch {
        return [];
    }
};

// ─── Audio System (HTML5 Audio + generated WAV — works in Telegram WebView) ───

// Generate a WAV file as base64 data URI from raw samples
const generateWav = (samples: number[], sampleRate = 22050): string => {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);  // block align
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    // Write samples
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s * 32767, true);
    }

    // Convert to base64
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return 'data:audio/wav;base64,' + btoa(binary);
};

// Generate a tone as an array of samples
const generateTone = (freq: number, duration: number, volume: number, sampleRate = 22050): number[] => {
    const samples: number[] = [];
    const numSamples = Math.floor(sampleRate * duration);
    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const envelope = Math.min(1, (numSamples - i) / (sampleRate * 0.05)); // fade out
        samples.push(Math.sin(2 * Math.PI * freq * t) * volume * envelope);
    }
    return samples;
};

// Pre-generated sound data URIs
const repBeepWav = generateWav(generateTone(880, 0.12, 0.6));

const milestoneWav = generateWav([
    ...generateTone(523, 0.1, 0.5),
    ...generateTone(659, 0.1, 0.5),
    ...generateTone(784, 0.12, 0.5),
    ...generateTone(1047, 0.2, 0.6),
]);

const countdownBeepWav = generateWav(generateTone(660, 0.15, 0.7));

const goBeepWav = generateWav([
    ...generateTone(880, 0.1, 0.6),
    ...generateTone(1100, 0.2, 0.7),
]);

// Audio pool for fast playback
const audioPool: HTMLAudioElement[] = [];
const POOL_SIZE = 4;

const initAudioPool = () => {
    if (audioPool.length > 0) return;
    for (let i = 0; i < POOL_SIZE; i++) {
        const audio = new Audio();
        audio.preload = 'auto';
        audioPool.push(audio);
    }
};

let poolIndex = 0;
const playSound = (dataUri: string) => {
    try {
        if (audioPool.length === 0) initAudioPool();
        const audio = audioPool[poolIndex % POOL_SIZE];
        poolIndex++;
        audio.src = dataUri;
        audio.currentTime = 0;
        audio.volume = 1.0;
        audio.play().catch(() => { /* autoplay blocked */ });
    } catch { /* */ }
};

// Unlock audio on user gesture — play a silent sound
const unlockAudio = () => {
    initAudioPool();
    const silent = generateWav(generateTone(1, 0.01, 0));
    audioPool.forEach(a => {
        a.src = silent;
        a.play().catch(() => { });
    });
};

const playRepSound = () => playSound(repBeepWav);
const playMilestoneSound = () => playSound(milestoneWav);
const playCountdownBeep = () => playSound(countdownBeepWav);
const playGoSound = () => playSound(goBeepWav);

// ─── Share Card Generator ───
const generateShareCard = async (count: number, duration: string, totalAll: number): Promise<File> => {
    const W = 1080, H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0f1a');
    bg.addColorStop(0.5, '#0f172a');
    bg.addColorStop(1, '#1a2744');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Glow circle behind count
    const glow = ctx.createRadialGradient(W / 2, H * 0.38, 0, W / 2, H * 0.38, 300);
    glow.addColorStop(0, 'rgba(57,255,20,0.15)');
    glow.addColorStop(1, 'rgba(57,255,20,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Title
    ctx.textAlign = 'center';
    ctx.fillStyle = '#39ff14';
    ctx.font = 'bold 48px system-ui, sans-serif';
    ctx.fillText('WORKOUT COMPLETE', W / 2, H * 0.22);

    // Count
    ctx.fillStyle = '#39ff14';
    ctx.font = 'bold 220px system-ui, sans-serif';
    ctx.shadowColor = '#39ff14';
    ctx.shadowBlur = 60;
    ctx.fillText(String(count), W / 2, H * 0.42);
    ctx.shadowBlur = 0;

    // "push-ups" label
    ctx.fillStyle = '#94a3b8';
    ctx.font = '40px system-ui, sans-serif';
    ctx.fillText('push-ups', W / 2, H * 0.47);

    // Stats
    ctx.fillStyle = 'white';
    ctx.font = 'bold 52px system-ui, sans-serif';
    ctx.fillText(`${duration}  ·  ${totalAll} all-time`, W / 2, H * 0.56);

    // Divider
    ctx.strokeStyle = 'rgba(57,255,20,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W * 0.2, H * 0.62);
    ctx.lineTo(W * 0.8, H * 0.62);
    ctx.stroke();

    // App name
    ctx.fillStyle = '#39ff14';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillText('💪 AI PUSH-UP PRO', W / 2, H * 0.68);

    ctx.fillStyle = '#64748b';
    ctx.font = '30px system-ui, sans-serif';
    ctx.fillText('AI-powered push-up tracking', W / 2, H * 0.72);

    // Convert to file
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    return new File([blob], 'pushup-result.png', { type: 'image/png' });
};

export const PoseCounter: React.FC = () => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const [status, setStatus] = useState("Tap START to begin");
    const [count, setCount] = useState(0);
    const [phase, setPhase] = useState<'idle' | 'camera' | 'countdown' | 'exercise' | 'results'>('idle');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [isBodyReady, setIsBodyReady] = useState(false);
    const [tgUser, setTgUser] = useState<TgUser | null>(null);
    const [sessionStart, setSessionStart] = useState(0);
    const [history, setHistory] = useState<WorkoutRecord[]>([]);
    const [countdown, setCountdown] = useState(0);

    // Refs for state machine
    const countRef = useRef(0);
    const stageRef = useRef<"UP" | "DOWN">("UP");
    const bodyReadyRef = useRef(false);
    const bodyReadyFrames = useRef(0);
    const lastRepTime = useRef(0);
    const smoothAngle = useRef(160);
    const poseRef = useRef<{ close: () => void } | null>(null);
    const cameraRef = useRef<{ stop: () => void } | null>(null);
    const badFrameCount = useRef(0);

    // Tuned for fast pushups
    const BODY_READY_THRESHOLD = 5;
    const REP_COOLDOWN_MS = 150;    // Very short cooldown for fast reps
    const DOWN_ANGLE = 110;          // Easier to trigger "down"
    const UP_ANGLE = 145;            // Easier to trigger "up"
    const SMOOTH_FACTOR = 0.6;       // Higher = more smoothing (60% old, 40% new)
    const BAD_FRAME_TOLERANCE = 5;   // How many bad frames before pausing

    // Init Telegram user
    useEffect(() => {
        const user = getTelegramUser();
        setTgUser(user);
        setHistory(getHistory(user?.id ?? null));
    }, []);

    const startWorkout = async () => {
        // Unlock audio on user gesture (critical for iOS)
        unlockAudio();
        setPhase('camera');
        setCount(0);
        countRef.current = 0;
        stageRef.current = "UP";
        bodyReadyRef.current = false;
        bodyReadyFrames.current = 0;
        smoothAngle.current = 160;
        badFrameCount.current = 0;
        setIsBodyReady(false);
        setStatus("Starting camera...");

        try {
            // 1. Get camera access FIRST (triggers permission dialog)
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user", width: 640, height: 480 },
                audio: false,
            });
            streamRef.current = stream;

            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.setAttribute('playsinline', 'true');
                videoRef.current.muted = true;
                await videoRef.current.play();
            }

            // 2. Camera ready → start countdown
            setPhase('countdown');
            setCountdown(10);
            playCountdownBeep();
            let t = 10;
            await new Promise<void>((resolve) => {
                const interval = setInterval(() => {
                    t--;
                    if (t > 0) {
                        setCountdown(t);
                        playCountdownBeep();
                    } else {
                        clearInterval(interval);
                        setCountdown(0);
                        playGoSound();
                        resolve();
                    }
                }, 1000);
            });

            // 3. Countdown done → load AI
            setPhase('camera');
            setStatus("Loading AI...");
            setSessionStart(Date.now());
            loadMediaPipe();

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg(msg);
            setStatus("Camera error");
            setPhase('idle');
        }
    };

    const stopSession = () => {
        // Stop MediaPipe camera
        if (cameraRef.current) {
            try { cameraRef.current.stop(); } catch { /* */ }
        }

        // Stop video stream
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }

        const durationSec = Math.round((Date.now() - sessionStart) / 1000);
        const userName = tgUser
            ? `${tgUser.first_name}${tgUser.last_name ? ' ' + tgUser.last_name : ''}`
            : 'Guest';

        const record: WorkoutRecord = {
            userId: tgUser?.id ?? null,
            userName,
            count: countRef.current,
            date: new Date().toISOString(),
            durationSec,
        };

        saveWorkout(record);
        setHistory(getHistory(tgUser?.id ?? null));
        setPhase('results');
    };

    const loadMediaPipe = async () => {
        try {
            const { Pose } = await import('@mediapipe/pose');
            const { Camera } = await import('@mediapipe/camera_utils');

            const pose = new Pose({
                locateFile: (file: string) =>
                    `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
            });
            poseRef.current = pose;

            pose.setOptions({
                modelComplexity: 1,
                smoothLandmarks: true,
                enableSegmentation: false,
                smoothSegmentation: false,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5,
            });

            pose.onResults(onResults);

            if (videoRef.current) {
                const camera = new Camera(videoRef.current, {
                    onFrame: async () => {
                        if (videoRef.current) {
                            await pose.send({ image: videoRef.current });
                        }
                    },
                    width: 640,
                    height: 480,
                });
                cameraRef.current = camera;
                camera.start();
                setPhase('exercise');
                setStatus("AI ready! Get into pushup position...");
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg("AI Error: " + msg);
            setStatus("AI failed.");
        }
    };

    // Check if body is in a valid pushup/plank position
    const isInPushupPosition = (landmarks: Landmark[]): { ok: boolean; reason: string } => {
        const requiredParts = [
            LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
            LM.LEFT_ELBOW, LM.LEFT_WRIST,
            LM.LEFT_HIP, LM.RIGHT_HIP,
        ];
        if (!requiredParts.every(i => isVisible(landmarks[i]))) {
            return { ok: false, reason: "Can't see full body" };
        }

        const shoulderY = (landmarks[LM.LEFT_SHOULDER].y + landmarks[LM.RIGHT_SHOULDER].y) / 2;
        const hipY = (landmarks[LM.LEFT_HIP].y + landmarks[LM.RIGHT_HIP].y) / 2;

        // 1. Torso must be roughly horizontal (shoulder & hip at similar height)
        const torsoHeightDiff = Math.abs(shoulderY - hipY);
        if (torsoHeightDiff > 0.35) {
            return { ok: false, reason: "Body not horizontal — lie flat!" };
        }

        // 2. Wrists should be roughly at shoulder level or below (on the floor)
        //    In pushup: wrist.y ≈ shoulder.y (both near same height)
        //    Standing & bending arms: wrist.y << shoulder.y (wrists much higher)
        const wristY = (landmarks[LM.LEFT_WRIST].y + landmarks[LM.RIGHT_WRIST].y) / 2;
        const wristAboveShoulder = shoulderY - wristY;
        // If wrists are much higher than shoulders (>15% of frame), not a pushup
        if (wristAboveShoulder > 0.25) {
            return { ok: false, reason: "Hands too high — get on the floor!" };
        }

        // 3. Check body is not upright (standing)
        //    Standing: shoulders much higher (lower Y) than hips
        //    We check if the torso is more vertical than horizontal
        const shoulderX = (landmarks[LM.LEFT_SHOULDER].x + landmarks[LM.RIGHT_SHOULDER].x) / 2;
        const hipX = (landmarks[LM.LEFT_HIP].x + landmarks[LM.RIGHT_HIP].x) / 2;
        const horizontalSpread = Math.abs(shoulderX - hipX);
        const verticalSpread = Math.abs(shoulderY - hipY);
        // If vertical spread > horizontal spread, person is likely standing
        if (horizontalSpread < 0.03 && verticalSpread > 0.1) {
            return { ok: false, reason: "You're standing! Lie down for pushups" };
        }

        return { ok: true, reason: "" };
    };

    const getElbowAngle = (landmarks: Landmark[]): number | null => {
        const ls = landmarks[LM.LEFT_SHOULDER];
        const le = landmarks[LM.LEFT_ELBOW];
        const lw = landmarks[LM.LEFT_WRIST];
        const leftOk = isVisible(ls) && isVisible(le) && isVisible(lw);

        const rs = landmarks[LM.RIGHT_SHOULDER];
        const re = landmarks[LM.RIGHT_ELBOW];
        const rw = landmarks[LM.RIGHT_WRIST];
        const rightOk = isVisible(rs) && isVisible(re) && isVisible(rw);

        if (leftOk && rightOk) {
            return (calcAngle(ls, le, lw) + calcAngle(rs, re, rw)) / 2;
        } else if (leftOk) {
            return calcAngle(ls, le, lw);
        } else if (rightOk) {
            return calcAngle(rs, re, rw);
        }
        return null;
    };

    const onResults = (results: { poseLandmarks?: Landmark[] }) => {
        if (!canvasRef.current || !videoRef.current) return;

        const video = videoRef.current;
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!results.poseLandmarks) {
            if (bodyReadyRef.current) {
                bodyReadyFrames.current = 0;
            }
            return;
        }

        const landmarks = results.poseLandmarks;

        // Draw skeleton
        const drawLine = (from: number, to: number, color: string) => {
            const a = landmarks[from];
            const b = landmarks[to];
            if (isVisible(a) && isVisible(b)) {
                ctx.beginPath();
                ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
                ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
                ctx.strokeStyle = color;
                ctx.lineWidth = 3;
                ctx.stroke();
            }
        };

        const skeletonColor = bodyReadyRef.current ? '#39ff14' : '#fbbf24';

        const connections = [
            [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
            [LM.LEFT_SHOULDER, LM.LEFT_ELBOW], [LM.LEFT_ELBOW, LM.LEFT_WRIST],
            [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW], [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
            [LM.LEFT_SHOULDER, LM.LEFT_HIP], [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
            [LM.LEFT_HIP, LM.RIGHT_HIP],
            [LM.LEFT_HIP, LM.LEFT_KNEE], [LM.LEFT_KNEE, LM.LEFT_ANKLE],
            [LM.RIGHT_HIP, LM.RIGHT_KNEE], [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
        ];
        connections.forEach(([from, to]) => drawLine(from, to, skeletonColor));

        const allPoints = [
            LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
            LM.LEFT_ELBOW, LM.RIGHT_ELBOW,
            LM.LEFT_WRIST, LM.RIGHT_WRIST,
            LM.LEFT_HIP, LM.RIGHT_HIP,
            LM.LEFT_KNEE, LM.RIGHT_KNEE,
            LM.LEFT_ANKLE, LM.RIGHT_ANKLE,
        ];
        allPoints.forEach(i => {
            const lm = landmarks[i];
            if (isVisible(lm)) {
                ctx.beginPath();
                ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 5, 0, 2 * Math.PI);
                ctx.fillStyle = skeletonColor;
                ctx.fill();
            }
        });

        // Check pushup position (ALWAYS — both initially and during counting)
        const posCheck = isInPushupPosition(landmarks);

        if (!bodyReadyRef.current) {
            // Initial lock-in phase
            if (posCheck.ok) {
                bodyReadyFrames.current++;
                if (bodyReadyFrames.current >= BODY_READY_THRESHOLD) {
                    bodyReadyRef.current = true;
                    setIsBodyReady(true);
                    stageRef.current = "UP";
                    smoothAngle.current = 160;
                    setStatus("✅ GO! Start pushing!");
                } else {
                    setStatus(`Detecting pose... (${bodyReadyFrames.current}/${BODY_READY_THRESHOLD})`);
                }
            } else {
                bodyReadyFrames.current = Math.max(0, bodyReadyFrames.current - 1);
                setStatus(`🔎 ${posCheck.reason}`);
            }
            return;
        }

        // CONTINUOUS VALIDATION: If person leaves pushup position, tolerate brief glitches
        if (!posCheck.ok) {
            badFrameCount.current++;
            if (badFrameCount.current >= BAD_FRAME_TOLERANCE) {
                setStatus(`⚠️ ${posCheck.reason}`);
                // Don't reset bodyReady — just pause counting
                // They can resume without re-locking
                return;
            }
            // Under tolerance: keep counting through brief glitches
        } else {
            badFrameCount.current = 0;
        }

        // Count pushups (only reaches here if in valid pushup position)
        const rawAngle = getElbowAngle(landmarks);
        if (rawAngle === null) return;

        smoothAngle.current = SMOOTH_FACTOR * smoothAngle.current + (1 - SMOOTH_FACTOR) * rawAngle;
        const angle = smoothAngle.current;

        // Show angle
        const elbow = landmarks[LM.LEFT_ELBOW];
        ctx.font = "bold 28px monospace";
        ctx.fillStyle = "white";
        ctx.strokeStyle = "black";
        ctx.lineWidth = 3;
        const angleText = `${Math.round(angle)}°`;
        ctx.strokeText(angleText, elbow.x * canvas.width + 12, elbow.y * canvas.height);
        ctx.fillText(angleText, elbow.x * canvas.width + 12, elbow.y * canvas.height);

        const now = Date.now();

        if (angle < DOWN_ANGLE) {
            if (stageRef.current !== "DOWN") {
                stageRef.current = "DOWN";
                setStatus("⬇️ Good Depth!");
            }
        }

        if (angle > UP_ANGLE && stageRef.current === "DOWN") {
            if (now - lastRepTime.current > REP_COOLDOWN_MS) {
                stageRef.current = "UP";
                countRef.current += 1;
                lastRepTime.current = now;
                setCount(countRef.current);
                setStatus("⬆️ Rep " + countRef.current + "!");

                // Audio feedback
                const c = countRef.current;
                if (c % 10 === 0) {
                    playMilestoneSound();
                } else {
                    playRepSound();
                }
            }
        }
    };

    const formatDuration = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    // ─── RESULTS SCREEN ───
    if (phase === 'results') {
        const durationSec = Math.round((Date.now() - sessionStart) / 1000);
        const totalAll = history.reduce((sum, r) => sum + r.count, 0);

        return (
            <div style={{
                position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                background: 'linear-gradient(180deg, #0f172a 0%, #1e293b 100%)',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', fontFamily: 'system-ui, sans-serif',
                padding: 24, overflow: 'auto',
            }}>
                {/* User greeting */}
                {tgUser && (
                    <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 8px' }}>
                        👤 {tgUser.first_name}{tgUser.last_name ? ' ' + tgUser.last_name : ''}
                    </p>
                )}

                <h2 style={{ color: '#39ff14', fontSize: 20, margin: '0 0 4px', fontWeight: 800 }}>
                    WORKOUT COMPLETE
                </h2>

                <div style={{
                    fontSize: 100, fontWeight: 900, color: '#39ff14',
                    textShadow: '0 0 30px #39ff14', lineHeight: 1, margin: '12px 0',
                }}>
                    {count}
                </div>
                <p style={{ color: '#94a3b8', fontSize: 16, margin: 0 }}>push-ups</p>

                <div style={{
                    display: 'flex', gap: 24, margin: '20px 0',
                    color: 'white', fontSize: 14,
                }}>
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 22, fontWeight: 'bold' }}>
                            {formatDuration(durationSec)}
                        </div>
                        <div style={{ color: '#94a3b8' }}>Duration</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 22, fontWeight: 'bold' }}>{totalAll}</div>
                        <div style={{ color: '#94a3b8' }}>All-time</div>
                    </div>
                </div>

                {/* Recent history */}
                {history.length > 1 && (
                    <div style={{
                        width: '100%', maxWidth: 320, margin: '12px 0',
                        background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: 12,
                    }}>
                        <h3 style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 8px', textTransform: 'uppercase' }}>
                            Recent Workouts
                        </h3>
                        {history.slice(0, 5).map((r, i) => (
                            <div key={i} style={{
                                display: 'flex', justifyContent: 'space-between',
                                padding: '6px 0', borderBottom: i < 4 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                            }}>
                                <span style={{ color: '#cbd5e1', fontSize: 13 }}>
                                    {new Date(r.date).toLocaleDateString()}
                                </span>
                                <span style={{ color: '#39ff14', fontSize: 13, fontWeight: 'bold' }}>
                                    {r.count} reps · {formatDuration(r.durationSec)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Action Buttons */}
                <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button
                        onClick={() => { setPhase('idle'); setCount(0); setErrorMsg(null); setIsBodyReady(false); }}
                        style={{
                            background: '#39ff14', color: 'black', fontWeight: 'bold',
                            fontSize: 18, padding: '14px 36px', borderRadius: 50,
                            border: 'none', cursor: 'pointer',
                            boxShadow: '0 0 30px rgba(57,255,20,0.5)',
                        }}
                    >
                        NEW WORKOUT
                    </button>

                    {/* Share to Instagram Story */}
                    <button
                        onClick={async () => {
                            try {
                                const file = await generateShareCard(count, formatDuration(durationSec), totalAll);
                                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                                    await navigator.share({
                                        title: 'AI Push-Up Pro',
                                        text: `💪 Just did ${count} push-ups!`,
                                        files: [file],
                                    });
                                } else {
                                    // Fallback: download the image
                                    const url = URL.createObjectURL(file);
                                    const a = document.createElement('a');
                                    a.href = url;
                                    a.download = 'pushup-result.png';
                                    a.click();
                                    URL.revokeObjectURL(url);
                                    alert('Image saved! Share it to your Instagram Story 📸');
                                }
                            } catch {
                                alert('Could not share. Try taking a screenshot!');
                            }
                        }}
                        style={{
                            background: 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)',
                            color: 'white', fontWeight: 'bold',
                            fontSize: 18, padding: '14px 36px', borderRadius: 50,
                            border: 'none', cursor: 'pointer',
                        }}
                    >
                        📸 SHARE TO STORY
                    </button>
                </div>
            </div>
        );
    }

    // ─── MAIN SCREEN ───
    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: '#0f172a',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', overflow: 'hidden',
            fontFamily: 'system-ui, sans-serif',
        }}>
            {/* Video + Canvas */}
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <video
                    ref={videoRef}
                    playsInline muted autoPlay
                    style={{
                        position: 'absolute', top: 0, left: 0,
                        width: '100%', height: '100%',
                        objectFit: 'cover', transform: 'scaleX(-1)',
                        display: phase !== 'idle' ? 'block' : 'none',
                    }}
                />
                <canvas
                    ref={canvasRef}
                    style={{
                        position: 'absolute', top: 0, left: 0,
                        width: '100%', height: '100%',
                        objectFit: 'cover', transform: 'scaleX(-1)',
                        pointerEvents: 'none',
                        display: phase !== 'idle' ? 'block' : 'none',
                    }}
                />
            </div>

            {/* HUD */}
            <div style={{
                position: 'absolute', top: 20, left: 0, right: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                zIndex: 30, pointerEvents: 'none',
            }}>
                {/* User badge */}
                {tgUser && phase === 'idle' && (
                    <div style={{
                        background: 'rgba(255,255,255,0.08)', padding: '4px 16px',
                        borderRadius: 20, marginBottom: 8,
                    }}>
                        <span style={{ color: '#94a3b8', fontSize: 13 }}>
                            👤 {tgUser.first_name}
                        </span>
                    </div>
                )}

                <div style={{
                    background: isBodyReady ? 'rgba(0,80,0,0.7)' : 'rgba(0,0,0,0.6)',
                    padding: '8px 24px', borderRadius: 50, marginBottom: 12,
                    backdropFilter: 'blur(8px)',
                    border: isBodyReady ? '1px solid #39ff14' : '1px solid transparent',
                    transition: 'all 0.3s',
                }}>
                    <span style={{ color: 'white', fontSize: 18, fontWeight: 'bold' }}>
                        {status}
                    </span>
                </div>

                {isBodyReady && (
                    <div style={{
                        fontSize: 96, fontWeight: 900, color: '#39ff14',
                        textShadow: '0 0 20px #39ff14',
                    }}>
                        {count}
                    </div>
                )}
            </div>

            {/* STOP button (during exercise) */}
            {phase === 'exercise' && (
                <div style={{
                    position: 'absolute', bottom: 40, zIndex: 40,
                    pointerEvents: 'auto',
                }}>
                    <button
                        onClick={stopSession}
                        style={{
                            background: '#ef4444', color: 'white', fontWeight: 'bold',
                            fontSize: 18, padding: '14px 40px', borderRadius: 50,
                            border: 'none', cursor: 'pointer',
                            boxShadow: '0 0 20px rgba(239,68,68,0.5)',
                        }}
                    >
                        ⏹ STOP
                    </button>
                </div>
            )}

            {/* Error */}
            {errorMsg && (
                <div style={{
                    position: 'absolute', bottom: 100, left: 20, right: 20,
                    background: 'rgba(255,0,0,0.2)', border: '1px solid red',
                    borderRadius: 12, padding: 16, zIndex: 40, textAlign: 'center',
                }}>
                    <p style={{ color: 'red', fontWeight: 'bold', margin: 0 }}>Error</p>
                    <p style={{ color: 'white', fontSize: 14, marginTop: 8 }}>{errorMsg}</p>
                </div>
            )}

            {/* Start Screen — Premium Landing */}
            {phase === 'idle' && (
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40,
                    display: 'flex', flexDirection: 'column',
                    background: 'linear-gradient(170deg, #040d08 0%, #0a1a10 30%, #0d1f14 60%, #081a0e 100%)',
                    padding: '40px 24px 32px',
                    overflow: 'auto',
                    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
                }}>
                    {/* Animated network grid background */}
                    <div style={{
                        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                        overflow: 'hidden', pointerEvents: 'none', zIndex: 0,
                    }}>
                        <svg width="100%" height="100%" style={{ position: 'absolute', opacity: 0.15 }}>
                            {/* Grid lines */}
                            {Array.from({ length: 8 }).map((_, i) => (
                                <line key={`h${i}`} x1="0" y1={`${12.5 * (i + 1)}%`} x2="100%" y2={`${12.5 * (i + 1)}%`}
                                    stroke="#39ff14" strokeWidth="0.5" opacity="0.3" />
                            ))}
                            {Array.from({ length: 5 }).map((_, i) => (
                                <line key={`v${i}`} x1={`${20 * (i + 1)}%`} y1="0" x2={`${20 * (i + 1)}%`} y2="100%"
                                    stroke="#39ff14" strokeWidth="0.5" opacity="0.3" />
                            ))}
                            {/* Network connection lines */}
                            <line x1="10%" y1="15%" x2="35%" y2="25%" stroke="#39ff14" strokeWidth="0.8" opacity="0.4" />
                            <line x1="35%" y1="25%" x2="70%" y2="10%" stroke="#39ff14" strokeWidth="0.8" opacity="0.3" />
                            <line x1="70%" y1="10%" x2="90%" y2="30%" stroke="#39ff14" strokeWidth="0.8" opacity="0.4" />
                            <line x1="15%" y1="70%" x2="40%" y2="85%" stroke="#39ff14" strokeWidth="0.8" opacity="0.3" />
                            <line x1="40%" y1="85%" x2="75%" y2="75%" stroke="#39ff14" strokeWidth="0.8" opacity="0.4" />
                            <line x1="75%" y1="75%" x2="95%" y2="90%" stroke="#39ff14" strokeWidth="0.8" opacity="0.3" />
                            <line x1="5%" y1="40%" x2="25%" y2="55%" stroke="#39ff14" strokeWidth="0.8" opacity="0.2" />
                            <line x1="80%" y1="45%" x2="95%" y2="60%" stroke="#39ff14" strokeWidth="0.8" opacity="0.2" />
                            {/* Glowing dots at intersections */}
                            {[[10, 15], [35, 25], [70, 10], [90, 30], [15, 70], [40, 85], [75, 75], [95, 90], [5, 40], [25, 55], [80, 45], [95, 60], [50, 5], [50, 95]].map(([x, y], i) => (
                                <g key={`d${i}`}>
                                    <circle cx={`${x}%`} cy={`${y}%`} r="3" fill="#39ff14" opacity="0.6">
                                        <animate attributeName="opacity" values="0.3;0.8;0.3" dur={`${2 + i * 0.3}s`} repeatCount="indefinite" />
                                    </circle>
                                    <circle cx={`${x}%`} cy={`${y}%`} r="6" fill="none" stroke="#39ff14" strokeWidth="0.5" opacity="0.2">
                                        <animate attributeName="r" values="4;10;4" dur={`${3 + i * 0.2}s`} repeatCount="indefinite" />
                                        <animate attributeName="opacity" values="0.3;0;0.3" dur={`${3 + i * 0.2}s`} repeatCount="indefinite" />
                                    </circle>
                                </g>
                            ))}
                        </svg>
                    </div>

                    {/* Content */}
                    <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', flex: 1 }}>

                        {/* Title */}
                        <h1 style={{
                            color: 'white', fontSize: 36, fontWeight: 900, lineHeight: 1.1,
                            margin: '0 0 28px', letterSpacing: -0.5,
                        }}>
                            Next-Gen<br />
                            Fitness<br />
                            Tracking<br />
                            inside <span style={{ color: '#39ff14' }}>Telegram</span>
                        </h1>

                        {/* Body wireframe + phone mockup area */}
                        <div style={{
                            position: 'relative', width: '100%', height: 260,
                            display: 'flex', justifyContent: 'center', alignItems: 'center',
                            margin: '0 0 20px',
                        }}>
                            {/* AI Skeleton wireframe */}
                            <svg width="140" height="240" viewBox="0 0 140 240" style={{
                                position: 'absolute', left: '5%', opacity: 0.7,
                                filter: 'drop-shadow(0 0 8px rgba(57,255,20,0.4))',
                            }}>
                                {/* Head */}
                                <circle cx="70" cy="20" r="14" fill="none" stroke="#39ff14" strokeWidth="1.5" opacity="0.6" />
                                {/* Spine */}
                                <line x1="70" y1="34" x2="70" y2="120" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                {/* Shoulders */}
                                <line x1="30" y1="55" x2="110" y2="55" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                {/* Left arm */}
                                <line x1="30" y1="55" x2="15" y2="95" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                <line x1="15" y1="95" x2="10" y2="130" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                {/* Right arm */}
                                <line x1="110" y1="55" x2="125" y2="95" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                <line x1="125" y1="95" x2="130" y2="130" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                {/* Hips */}
                                <line x1="45" y1="120" x2="95" y2="120" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                {/* Left leg */}
                                <line x1="45" y1="120" x2="35" y2="175" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                <line x1="35" y1="175" x2="30" y2="230" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                {/* Right leg */}
                                <line x1="95" y1="120" x2="105" y2="175" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                <line x1="105" y1="175" x2="110" y2="230" stroke="#39ff14" strokeWidth="1.2" opacity="0.5" />
                                {/* Joint dots */}
                                {[[70, 20], [70, 55], [30, 55], [110, 55], [15, 95], [125, 95], [10, 130], [130, 130], [70, 120], [45, 120], [95, 120], [35, 175], [105, 175], [30, 230], [110, 230]].map(([x, y], i) => (
                                    <circle key={i} cx={x} cy={y} r="4" fill="#39ff14" opacity="0.9">
                                        <animate attributeName="opacity" values="0.5;1;0.5" dur={`${1.5 + i * 0.1}s`} repeatCount="indefinite" />
                                    </circle>
                                ))}
                            </svg>

                            {/* Phone mockup */}
                            <div style={{
                                position: 'absolute', right: '5%',
                                width: 140, height: 240,
                                background: '#111', borderRadius: 20,
                                border: '2px solid #333',
                                display: 'flex', flexDirection: 'column',
                                alignItems: 'center', justifyContent: 'center',
                                overflow: 'hidden',
                                boxShadow: '0 0 40px rgba(57,255,20,0.15), 0 20px 60px rgba(0,0,0,0.5)',
                            }}>
                                {/* Notch */}
                                <div style={{
                                    position: 'absolute', top: 6, width: 50, height: 6,
                                    background: '#222', borderRadius: 3,
                                }} />
                                {/* Count display */}
                                <div style={{
                                    fontSize: 56, fontWeight: 900, color: '#39ff14',
                                    textShadow: '0 0 20px #39ff14',
                                    lineHeight: 1,
                                }}>12</div>
                                {/* Mini skeleton in phone */}
                                <svg width="80" height="60" viewBox="0 0 80 60" style={{ marginTop: 8, opacity: 0.6 }}>
                                    {/* Pushup pose skeleton */}
                                    <line x1="15" y1="25" x2="30" y2="20" stroke="#39ff14" strokeWidth="1.5" />
                                    <line x1="30" y1="20" x2="50" y2="22" stroke="#39ff14" strokeWidth="1.5" />
                                    <line x1="50" y1="22" x2="65" y2="35" stroke="#39ff14" strokeWidth="1.5" />
                                    <line x1="65" y1="35" x2="75" y2="45" stroke="#39ff14" strokeWidth="1.5" />
                                    <line x1="30" y1="20" x2="25" y2="40" stroke="#39ff14" strokeWidth="1.5" />
                                    <line x1="25" y1="40" x2="20" y2="50" stroke="#39ff14" strokeWidth="1.5" />
                                    {[[15, 25], [30, 20], [50, 22], [65, 35], [75, 45], [25, 40], [20, 50]].map(([x, y], i) => (
                                        <circle key={i} cx={x} cy={y} r="2.5" fill="#39ff14" />
                                    ))}
                                </svg>
                                {/* Bottom bar */}
                                <div style={{
                                    position: 'absolute', bottom: 12,
                                    width: 36, height: 36, borderRadius: '50%',
                                    background: '#39ff14',
                                    boxShadow: '0 0 15px rgba(57,255,20,0.5)',
                                }} />
                            </div>
                        </div>

                        {/* Feature bullets */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 24 }}>
                            {[
                                { icon: '📷', title: 'No Wearables', sub: 'Required' },
                                { icon: '🤖', title: 'Computer Vision', sub: 'Anti-Cheat' },
                                { icon: '🌐', title: '900M+', sub: 'User Reach' },
                            ].map((f, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                    <div style={{
                                        width: 40, height: 40, borderRadius: 10,
                                        background: 'rgba(57,255,20,0.1)',
                                        border: '1px solid rgba(57,255,20,0.2)',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: 20,
                                    }}>{f.icon}</div>
                                    <div>
                                        <div style={{ color: 'white', fontSize: 15, fontWeight: 700 }}>{f.title}</div>
                                        <div style={{ color: '#64748b', fontSize: 13 }}>{f.sub}</div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Tagline */}
                        <h2 style={{
                            color: 'white', fontSize: 28, fontWeight: 900, lineHeight: 1.2,
                            margin: '0 0 24px', letterSpacing: 1,
                        }}>
                            YOUR <span style={{ color: '#39ff14' }}>BODY</span> IS<br />
                            THE CONTROLLER.
                        </h2>

                        {/* Quick stats */}
                        {history.length > 0 && (
                            <div style={{
                                background: 'rgba(57,255,20,0.06)',
                                border: '1px solid rgba(57,255,20,0.15)',
                                borderRadius: 12, padding: '8px 20px',
                                marginBottom: 16, alignSelf: 'center',
                            }}>
                                <span style={{ color: '#39ff14', fontSize: 14, fontWeight: 600 }}>
                                    🏆 {history.reduce((s, r) => s + r.count, 0)} push-ups · {history.length} workouts
                                </span>
                            </div>
                        )}

                        {/* START button */}
                        <button
                            onClick={startWorkout}
                            style={{
                                alignSelf: 'center',
                                background: '#39ff14', color: '#0a0f1a', fontWeight: 900,
                                fontSize: 20, padding: '16px 52px', borderRadius: 50,
                                border: 'none', cursor: 'pointer',
                                boxShadow: '0 0 30px rgba(57,255,20,0.5), 0 0 60px rgba(57,255,20,0.2)',
                                letterSpacing: 2, textTransform: 'uppercase',
                                animation: 'btnPulse 2s ease-in-out infinite',
                            }}
                        >
                            START WORKOUT
                        </button>
                    </div>

                    <style>{`
                        @keyframes btnPulse {
                            0%, 100% { box-shadow: 0 0 30px rgba(57,255,20,0.5), 0 0 60px rgba(57,255,20,0.2); }
                            50% { box-shadow: 0 0 40px rgba(57,255,20,0.7), 0 0 80px rgba(57,255,20,0.3); }
                        }
                    `}</style>
                </div>
            )}

            {/* Countdown Overlay */}
            {phase === 'countdown' && (
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50,
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(180deg, #0a0f1a 0%, #0f172a 100%)',
                }}>
                    <p style={{ color: '#94a3b8', fontSize: 18, margin: '0 0 16px', textTransform: 'uppercase', letterSpacing: 2 }}>
                        Get into position!
                    </p>
                    <div style={{
                        fontSize: 140, fontWeight: 900, color: '#39ff14',
                        textShadow: '0 0 60px #39ff14, 0 0 120px rgba(57,255,20,0.3)',
                        lineHeight: 1,
                        animation: 'pulse 1s ease-in-out infinite',
                    }}>
                        {countdown}
                    </div>
                    <p style={{ color: '#64748b', fontSize: 14, marginTop: 24 }}>
                        Lie down and place hands on floor
                    </p>
                    <style>{`@keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }`}</style>
                </div>
            )}
        </div>
    );
};
