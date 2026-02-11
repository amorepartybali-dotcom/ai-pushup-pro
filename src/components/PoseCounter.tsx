import { useRef, useState } from 'react';

export const PoseCounter: React.FC = () => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [status, setStatus] = useState("Tap START to begin");
    const [count, setCount] = useState(0);
    const [isCameraActive, setIsCameraActive] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Refs for state machine (avoid stale closures)
    const countRef = useRef(0);
    const stageRef = useRef<"UP" | "DOWN">("UP");

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

                // Load MediaPipe dynamically after camera is confirmed working
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
                modelComplexity: 0, // Lightest model for mobile
                smoothLandmarks: true,
                enableSegmentation: false,
                smoothSegmentation: false,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5,
            });

            pose.onResults(onResults);
            setStatus("AI loaded! Start exercising!");

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
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMsg("AI Error: " + msg);
            setStatus("AI failed to load. Camera still works.");
        }
    };

    const calculateAngle = (
        a: { x: number; y: number },
        b: { x: number; y: number },
        c: { x: number; y: number }
    ) => {
        const radians =
            Math.atan2(c.y - b.y, c.x - b.x) -
            Math.atan2(a.y - b.y, a.x - b.x);
        let angle = Math.abs(radians * 180.0 / Math.PI);
        if (angle > 180.0) angle = 360 - angle;
        return angle;
    };

    const onResults = (results: { poseLandmarks?: Array<{ x: number; y: number; visibility?: number }> }) => {
        if (!canvasRef.current || !videoRef.current) return;

        const video = videoRef.current;
        const canvas = canvasRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (results.poseLandmarks) {
            const landmarks = results.poseLandmarks;

            // Draw key points
            [11, 13, 15].forEach((i) => {
                const lm = landmarks[i];
                ctx.beginPath();
                ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 8, 0, 2 * Math.PI);
                ctx.fillStyle = '#39ff14';
                ctx.fill();
            });

            // Draw lines between shoulder-elbow-wrist
            ctx.beginPath();
            ctx.moveTo(landmarks[11].x * canvas.width, landmarks[11].y * canvas.height);
            ctx.lineTo(landmarks[13].x * canvas.width, landmarks[13].y * canvas.height);
            ctx.lineTo(landmarks[15].x * canvas.width, landmarks[15].y * canvas.height);
            ctx.strokeStyle = '#39ff14';
            ctx.lineWidth = 4;
            ctx.stroke();

            const shoulder = landmarks[11];
            const elbow = landmarks[13];
            const wrist = landmarks[15];

            if (
                (shoulder.visibility ?? 0) > 0.5 &&
                (elbow.visibility ?? 0) > 0.5 &&
                (wrist.visibility ?? 0) > 0.5
            ) {
                const angle = calculateAngle(shoulder, elbow, wrist);

                if (angle < 90) {
                    stageRef.current = "DOWN";
                    setStatus("Good Depth!");
                }

                if (angle > 160 && stageRef.current === "DOWN") {
                    stageRef.current = "UP";
                    countRef.current += 1;
                    setCount(countRef.current);
                    setStatus("Good Rep!");
                }

                // Show angle
                ctx.font = "24px monospace";
                ctx.fillStyle = "white";
                ctx.fillText(
                    `${Math.round(angle)}°`,
                    elbow.x * canvas.width + 10,
                    elbow.y * canvas.height
                );
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
            {/* Video + Canvas Container */}
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
                    top: 20,
                    left: 0,
                    right: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    zIndex: 30,
                    pointerEvents: 'none',
                }}
            >
                <div
                    style={{
                        background: 'rgba(0,0,0,0.6)',
                        padding: '8px 24px',
                        borderRadius: 50,
                        marginBottom: 12,
                        backdropFilter: 'blur(8px)',
                    }}
                >
                    <span style={{ color: 'white', fontSize: 18, fontWeight: 'bold' }}>
                        {status}
                    </span>
                </div>
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
            </div>

            {/* Error */}
            {errorMsg && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 100,
                        left: 20,
                        right: 20,
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
                        bottom: 80,
                        zIndex: 40,
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
