import { useRef, useState } from 'react';

type Landmark = { x: number; y: number; visibility?: number };

const calcAngle = (a: Landmark, b: Landmark, c: Landmark) => {
    const rad = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let deg = Math.abs(rad * 180 / Math.PI);
    if (deg > 180) deg = 360 - deg;
    return deg;
};

const isVisible = (lm: Landmark, threshold = 0.4) => (lm.visibility ?? 0) > threshold;

// MediaPipe Pose landmark indices
const LM = {
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
    LEFT_WRIST: 15, RIGHT_WRIST: 16,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
    LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
};

export const PoseCounter: React.FC = () => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [status, setStatus] = useState("Tap START to begin");
    const [count, setCount] = useState(0);
    const [isCameraActive, setIsCameraActive] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [isBodyReady, setIsBodyReady] = useState(false);

    // Refs for state machine
    const countRef = useRef(0);
    const stageRef = useRef<"UP" | "DOWN">("UP");
    const bodyReadyRef = useRef(false);
    const bodyReadyFrames = useRef(0); // How many consecutive frames body was detected
    const lastRepTime = useRef(0); // Cooldown between reps (ms)
    const smoothAngle = useRef(160); // Smoothed elbow angle

    const BODY_READY_THRESHOLD = 10; // Frames needed to confirm body position
    const REP_COOLDOWN_MS = 300; // Min time between reps
    const DOWN_ANGLE = 100; // Angle to count as "down"
    const UP_ANGLE = 150; // Angle to count as "up"
    const SMOOTH_FACTOR = 0.4; // 0 = no smoothing, 1 = fully previous

    const startCamera = async () => {
        setIsCameraActive(true);
        setStatus("Starting camera...");

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user", width: 640, height: 480 },
                audio: false,
            });

            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.setAttribute('playsinline', 'true');
                videoRef.current.muted = true;
                await videoRef.current.play();
                setStatus("Camera active! Loading AI...");
                loadMediaPipe();
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg(msg);
            setStatus("Camera error");
        }
    };

    const loadMediaPipe = async () => {
        try {
            const { Pose } = await import('@mediapipe/pose');
            const { Camera } = await import('@mediapipe/camera_utils');

            const pose = new Pose({
                locateFile: (file: string) =>
                    `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
            });

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
                camera.start();
                setStatus("AI loaded! Get into position...");
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg("AI Error: " + msg);
            setStatus("AI failed to load.");
        }
    };

    const checkBodyReady = (landmarks: Landmark[]): boolean => {
        // Check that key body parts are visible
        const requiredParts = [
            LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
            LM.LEFT_ELBOW, LM.LEFT_WRIST,
            LM.LEFT_HIP, LM.RIGHT_HIP,
            LM.LEFT_KNEE, LM.LEFT_ANKLE,
        ];

        const allVisible = requiredParts.every(i => isVisible(landmarks[i]));
        if (!allVisible) return false;

        // Check that the body is roughly horizontal (pushup position)
        // Shoulder and hip should be at similar height
        const shoulderY = (landmarks[LM.LEFT_SHOULDER].y + landmarks[LM.RIGHT_SHOULDER].y) / 2;
        const hipY = (landmarks[LM.LEFT_HIP].y + landmarks[LM.RIGHT_HIP].y) / 2;
        const ankleY = landmarks[LM.LEFT_ANKLE].y;

        // In a pushup position, shoulder and hip are roughly at same height
        // and ankles are NOT far above shoulders (they're to the side or below)
        const heightDiff = Math.abs(shoulderY - hipY);
        const isHorizontalish = heightDiff < 0.25; // Normalized coordinates

        // Also check the person isn't standing upright
        // Standing: shoulders much higher (lower Y) than ankles
        const isNotStanding = Math.abs(shoulderY - ankleY) < 0.35;

        return isHorizontalish && isNotStanding;
    };

    const getElbowAngle = (landmarks: Landmark[]): number | null => {
        // Try left arm
        const ls = landmarks[LM.LEFT_SHOULDER];
        const le = landmarks[LM.LEFT_ELBOW];
        const lw = landmarks[LM.LEFT_WRIST];
        const leftOk = isVisible(ls) && isVisible(le) && isVisible(lw);

        // Try right arm
        const rs = landmarks[LM.RIGHT_SHOULDER];
        const re = landmarks[LM.RIGHT_ELBOW];
        const rw = landmarks[LM.RIGHT_WRIST];
        const rightOk = isVisible(rs) && isVisible(re) && isVisible(rw);

        if (leftOk && rightOk) {
            // Average both arms for better accuracy
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

        // --- Draw skeleton ---
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

        const skeletonColor = bodyReadyRef.current ? '#39ff14' : '#fbbf24'; // Green when ready, yellow when not

        // Draw body skeleton
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

        // Draw key dots
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
                ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 6, 0, 2 * Math.PI);
                ctx.fillStyle = skeletonColor;
                ctx.fill();
            }
        });

        // --- Body readiness check ---
        if (!bodyReadyRef.current) {
            const ready = checkBodyReady(landmarks);
            if (ready) {
                bodyReadyFrames.current++;
                if (bodyReadyFrames.current >= BODY_READY_THRESHOLD) {
                    bodyReadyRef.current = true;
                    setIsBodyReady(true);
                    stageRef.current = "UP";
                    smoothAngle.current = 160;
                    setStatus("✅ Position locked! Start pushing!");
                } else {
                    setStatus(`Getting ready... (${bodyReadyFrames.current}/${BODY_READY_THRESHOLD})`);
                }
            } else {
                bodyReadyFrames.current = Math.max(0, bodyReadyFrames.current - 1);
                setStatus("🔎 Get into pushup position...");
            }
            return; // Don't count until ready
        }

        // --- Count pushups ---
        const rawAngle = getElbowAngle(landmarks);
        if (rawAngle === null) return;

        // Smooth the angle to prevent jitter
        smoothAngle.current = SMOOTH_FACTOR * smoothAngle.current + (1 - SMOOTH_FACTOR) * rawAngle;
        const angle = smoothAngle.current;

        // Show angle on screen
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
            // Check cooldown
            if (now - lastRepTime.current > REP_COOLDOWN_MS) {
                stageRef.current = "UP";
                countRef.current += 1;
                lastRepTime.current = now;
                setCount(countRef.current);
                setStatus("⬆️ Rep " + countRef.current + "!");
            }
        }
    };

    return (
        <div
            style={{
                position: 'fixed',
                top: 0, left: 0, right: 0, bottom: 0,
                background: '#0f172a',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                fontFamily: 'system-ui, sans-serif',
            }}
        >
            {/* Video + Canvas */}
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    style={{
                        position: 'absolute',
                        top: 0, left: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        transform: 'scaleX(-1)',
                        display: isCameraActive ? 'block' : 'none',
                    }}
                />
                <canvas
                    ref={canvasRef}
                    style={{
                        position: 'absolute',
                        top: 0, left: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        transform: 'scaleX(-1)',
                        pointerEvents: 'none',
                        display: isCameraActive ? 'block' : 'none',
                    }}
                />
            </div>

            {/* HUD */}
            <div
                style={{
                    position: 'absolute',
                    top: 20, left: 0, right: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    zIndex: 30,
                    pointerEvents: 'none',
                }}
            >
                <div
                    style={{
                        background: isBodyReady ? 'rgba(0,80,0,0.7)' : 'rgba(0,0,0,0.6)',
                        padding: '8px 24px',
                        borderRadius: 50,
                        marginBottom: 12,
                        backdropFilter: 'blur(8px)',
                        border: isBodyReady ? '1px solid #39ff14' : '1px solid transparent',
                        transition: 'all 0.3s',
                    }}
                >
                    <span style={{ color: 'white', fontSize: 18, fontWeight: 'bold' }}>
                        {status}
                    </span>
                </div>
                {isBodyReady && (
                    <div
                        style={{
                            fontSize: 96,
                            fontWeight: 900,
                            color: '#39ff14',
                            textShadow: '0 0 20px #39ff14',
                        }}
                    >
                        {count}
                    </div>
                )}
            </div>

            {/* Error */}
            {errorMsg && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 100, left: 20, right: 20,
                        background: 'rgba(255,0,0,0.2)',
                        border: '1px solid red',
                        borderRadius: 12,
                        padding: 16,
                        zIndex: 40,
                        textAlign: 'center',
                    }}
                >
                    <p style={{ color: 'red', fontWeight: 'bold', margin: 0 }}>Error</p>
                    <p style={{ color: 'white', fontSize: 14, marginTop: 8 }}>{errorMsg}</p>
                </div>
            )}

            {/* Start Button */}
            {!isCameraActive && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 80, zIndex: 40,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 12,
                    }}
                >
                    <h1 style={{ color: 'white', fontSize: 28, fontWeight: 'bold', opacity: 0.5, margin: 0 }}>
                        AI PUSHUP PRO
                    </h1>
                    <button
                        onClick={startCamera}
                        style={{
                            background: '#39ff14',
                            color: 'black',
                            fontWeight: 'bold',
                            fontSize: 22,
                            padding: '18px 48px',
                            borderRadius: 50,
                            border: 'none',
                            cursor: 'pointer',
                            boxShadow: '0 0 30px rgba(57,255,20,0.6)',
                        }}
                    >
                        START CAMERA
                    </button>
                    <p style={{ color: '#94a3b8', fontSize: 14, margin: 0 }}>
                        Press to enable AI Vision
                    </p>
                </div>
            )}
        </div>
    );
};
