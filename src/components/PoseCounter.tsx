import React, { useRef, useEffect, useState } from 'react';
import Webcam from 'react-webcam';
import { Pose, type Results } from '@mediapipe/pose';
import { Camera } from '@mediapipe/camera_utils';
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';
import { POSE_CONNECTIONS } from '@mediapipe/pose';

const calculateAngle = (a: { x: number, y: number }, b: { x: number, y: number }, c: { x: number, y: number }) => {
    const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let angle = Math.abs(radians * 180.0 / Math.PI);

    if (angle > 180.0) {
        angle = 360 - angle;
    }
    return angle;
};

export const PoseCounter: React.FC = () => {
    const webcamRef = useRef<Webcam>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [count, setCount] = useState(0);
    const [feedback, setFeedback] = useState("Get Ready");
    const [isCameraActive, setIsCameraActive] = useState(false);

    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // State machine refs to avoid closure staleness in onResults
    const countRef = useRef(0);
    const stageRef = useRef<"UP" | "DOWN">("UP");

    useEffect(() => {
        const pose = new Pose({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
            }
        });

        pose.setOptions({
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        pose.onResults(onResults);

        if (typeof webcamRef.current !== "undefined" && webcamRef.current !== null) {
            const camera = new Camera(webcamRef.current.video!, {
                onFrame: async () => {
                    if (webcamRef.current?.video) {
                        await pose.send({ image: webcamRef.current.video });
                    }
                },
                width: 640,
                height: 480
            });
            camera.start();
        }
    }, [isCameraActive]); // Restart camera if active state changes logic (though we just hide button)

    const onCameraError = (error: string | DOMException) => {
        console.error("Camera Error:", error);
        setErrorMessage(typeof error === 'string' ? error : error.message || "Unknown Camera Error");
    };

    const onResults = (results: Results) => {
        if (!canvasRef.current || !webcamRef.current?.video) return;

        const videoWidth = webcamRef.current.video.videoWidth;
        const videoHeight = webcamRef.current.video.videoHeight;

        canvasRef.current.width = videoWidth;
        canvasRef.current.height = videoHeight;

        const canvasCtx = canvasRef.current.getContext('2d');
        if (!canvasCtx) return;

        canvasCtx.save();
        canvasCtx.clearRect(0, 0, videoWidth, videoHeight);

        if (results.poseLandmarks) {
            // Draw skeleton
            drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS,
                { color: '#00FF00', lineWidth: 4 });
            drawLandmarks(canvasCtx, results.poseLandmarks,
                { color: '#FF0000', lineWidth: 2 });

            // Logic
            const landmarks = results.poseLandmarks;

            // Indices: 11: Left Shoulder, 13: Left Elbow, 15: Left Wrist
            const shoulder = landmarks[11];
            const elbow = landmarks[13];
            const wrist = landmarks[15];

            // Visibility check (optional but good)
            if (shoulder.visibility! > 0.5 && elbow.visibility! > 0.5 && wrist.visibility! > 0.5) {
                const angle = calculateAngle(shoulder, elbow, wrist);

                // State Machine
                if (angle > 160) {
                    stageRef.current = "UP";
                    setFeedback("Go Lower!");
                }
                if (angle < 90 && stageRef.current === "UP") {
                    stageRef.current = "DOWN";
                    setFeedback("UP!"); // User reached bottom
                }

                // Note: The logic in prompt was:
                // If angle < 90 -> Switch state to "DOWN"
                // If angle > 160 AND state was "DOWN" -> Increment Count + Switch state to "UP"

                if (angle < 90) {
                    stageRef.current = "DOWN";
                    setFeedback("Good Depth!");
                }

                if (angle > 160 && stageRef.current === "DOWN") {
                    stageRef.current = "UP";
                    countRef.current += 1;
                    setCount(countRef.current);
                    setFeedback("Good Rep!");
                }

                // Visualizing angle (optional)
                canvasCtx.font = "30px Arial";
                canvasCtx.fillStyle = "white";
                canvasCtx.fillText(Math.round(angle).toString(), elbow.x * videoWidth, elbow.y * videoHeight);
            }
        }
        canvasCtx.restore();
    };

    const [debugInfo, setDebugInfo] = useState<string>("");

    // ... (keep error handling)

    useEffect(() => {
        const interval = setInterval(() => {
            if (webcamRef.current?.video) {
                const v = webcamRef.current.video;
                setDebugInfo(`State: ${v.readyState}, Paused: ${v.paused}, Ended: ${v.ended}, Muted: ${v.muted}`);
            }
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="relative w-full h-screen bg-black flex flex-col items-center justify-center overflow-hidden">
            {/* Debug Info (Temporary) */}
            <div className="absolute top-0 right-0 bg-black/50 text-xs text-white p-2 z-50 pointer-events-none font-mono">
                {debugInfo}
            </div>

            {/* Error Message */}
            {errorMessage && (
                // ... (keep error message)
                <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center bg-black/80 z-50 p-4 text-center">
                    <div className="bg-red-900/50 p-6 rounded-xl border border-red-500">
                        <h3 className="text-red-500 text-xl font-bold mb-2">Camera Error</h3>
                        <p className="text-white">{errorMessage}</p>
                    </div>
                </div>
            )}

            {/* Camera Feed */}
            <Webcam
                ref={webcamRef}
                className="absolute top-0 left-0 w-full h-full object-cover z-0"
                mirrored={true}
                onUserMediaError={onCameraError}
                playsInline={true}
                autoPlay={true}
                muted={true}
                videoConstraints={{
                    facingMode: "user",
                    width: 640,
                    height: 480
                }}
            />

            {/* Canvas Overlay */}
            <canvas
                ref={canvasRef}
                className="absolute top-0 left-0 w-full h-full object-cover z-10"
            />

            {/* HUD */}
            <div className="absolute top-10 left-0 w-full flex flex-col items-center z-20 pointer-events-none">
                <div className="bg-black/50 px-6 py-2 rounded-full mb-4 backdrop-blur-sm">
                    <span className="text-white text-xl font-bold">{feedback}</span>
                </div>
                <div className="text-8xl font-black drop-shadow-[0_0_15px_rgba(0,255,0,0.8)]" style={{ color: '#39ff14', textShadow: '0 0 10px #39ff14' }}>
                    {count}
                </div>
            </div>

            {/* Controls */}
            {!isCameraActive && (
                <div className="absolute bottom-10 z-30 pointer-events-auto">
                    <button
                        onClick={() => setIsCameraActive(true)}
                        className="bg-[#39ff14] text-black font-bold py-4 px-10 rounded-full text-xl hover:bg-[#32e012] transition shadow-[0_0_20px_rgba(57,255,20,0.6)] cursor-pointer"
                    >
                        Start Camera
                    </button>
                </div>
            )}
        </div>
    );
};
