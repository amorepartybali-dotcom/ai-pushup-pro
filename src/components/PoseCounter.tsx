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

            {/* Start Screen */}
            {phase === 'idle' && (
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 40,
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(180deg, #0a0f1a 0%, #0f172a 40%, #1a2744 100%)',
                    padding: 24,
                }}>
                    {/* User badge */}
                    {tgUser && (
                        <div style={{
                            position: 'absolute', top: 16,
                            background: 'rgba(255,255,255,0.08)', padding: '4px 16px',
                            borderRadius: 20,
                        }}>
                            <span style={{ color: '#94a3b8', fontSize: 13 }}>
                                👤 {tgUser.first_name}
                            </span>
                        </div>
                    )}

                    {/* Hero Image */}
                    <img
                        src="/hero.png"
                        alt="AI Push-Up Counter"
                        style={{
                            width: '90%',
                            maxWidth: 380,
                            borderRadius: 16,
                            marginBottom: 24,
                            boxShadow: '0 0 40px rgba(57,255,20,0.15), 0 8px 32px rgba(0,0,0,0.5)',
                        }}
                    />

                    {/* Quick stats */}
                    {history.length > 0 && (
                        <div style={{
                            background: 'rgba(57,255,20,0.08)',
                            border: '1px solid rgba(57,255,20,0.2)',
                            borderRadius: 12, padding: '8px 20px',
                            marginBottom: 20,
                        }}>
                            <span style={{ color: '#39ff14', fontSize: 14, fontWeight: 600 }}>
                                🏆 {history.reduce((s, r) => s + r.count, 0)} push-ups in {history.length} workouts
                            </span>
                        </div>
                    )}

                    <button
                        onClick={startWorkout}
                        style={{
                            background: '#39ff14', color: 'black', fontWeight: 'bold',
                            fontSize: 22, padding: '18px 48px', borderRadius: 50,
                            border: 'none', cursor: 'pointer',
                            boxShadow: '0 0 30px rgba(57,255,20,0.6)',
                        }}
                    >
                        START WORKOUT
                    </button>
                    <p style={{ color: '#64748b', fontSize: 13, margin: '12px 0 0' }}>
                        AI-powered push-up tracking
                    </p>
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
