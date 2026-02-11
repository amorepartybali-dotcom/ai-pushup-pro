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

    const [debugInfo, setDebugInfo] = useState<string>("Initializing...");

    const onCameraLoad = () => {
        setDebugInfo(val => val + " | Loaded");
    };

    useEffect(() => {
        const interval = setInterval(() => {
            const ref = webcamRef.current;
            const video = ref?.video;
            setDebugInfo(prev => `Ref: ${!!ref}, Video: ${!!video}, Ready: ${video?.readyState}`);
        }, 500);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="relative w-full h-screen bg-slate-900 flex flex-col items-center justify-center overflow-hidden">
            {/* Debug Info */}
            <div className="absolute top-0 right-0 bg-red-600 text-white p-4 z-50 font-mono text-xs max-w-[50%] opacity-80 pointer-events-none">
                DEBUG: {debugInfo}
            </div>

            {/* Background Status (Visible when camera is off or loading) */}
            <div className="absolute z-0 flex flex-col items-center justify-center text-gray-500">
                <h1 className="text-2xl font-bold mb-2 opacity-50">AI PUSHUP PRO</h1>
                <p className="text-sm">System Ready. Waiting for Camera...</p>
                <div className="mt-4 w-12 h-12 border-4 border-gray-700 border-t-green-500 rounded-full animate-spin"></div>
            </div>

            {/* Error Message */}
            {errorMessage && (
                <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center bg-black/90 z-50 p-4 text-center">
                    <div className="bg-red-900/80 p-6 rounded-xl border-2 border-red-500 max-w-sm">
                        <h3 className="text-red-400 text-xl font-bold mb-2">Camera Error</h3>
                        <p className="text-white text-lg">{errorMessage}</p>
                    </div>
                </div>
            )}

            {/* Camera Feed - Force Visibility */}
            <Webcam
                ref={webcamRef}
                className={`absolute top-0 left-0 w-full h-full object-cover z-10 transition-opacity duration-500 ${isCameraActive ? 'opacity-100' : 'opacity-0'}`}
                mirrored={true}
                onUserMediaError={onCameraError}
                onUserMedia={onCameraLoad}
                playsInline={true}
                autoPlay={true}
                muted={true}
                videoConstraints={{
                    facingMode: "user"
                }}
            />

            {/* Canvas Overlay */}
            <canvas
                ref={canvasRef}
                className="absolute top-0 left-0 w-full h-full object-cover z-20 pointer-events-none"
            />

            {/* HUD */}
            <div className="absolute top-10 left-0 w-full flex flex-col items-center z-30 pointer-events-none">
                {/* ... (keep HUD content) */}
                <div className="bg-black/50 px-6 py-2 rounded-full mb-4 backdrop-blur-sm">
                    <span className="text-white text-xl font-bold">{feedback}</span>
                </div>
                <div className="text-8xl font-black drop-shadow-[0_0_15px_rgba(0,255,0,0.8)]" style={{ color: '#39ff14', textShadow: '0 0 10px #39ff14' }}>
                    {count}
                </div>
            </div>

            {/* Controls */}
            {!isCameraActive && (
                <div className="absolute bottom-20 z-40 pointer-events-auto flex flex-col items-center gap-4">
                    <button
                        onClick={() => setIsCameraActive(true)}
                        className="bg-[#39ff14] text-black font-bold py-6 px-12 rounded-full text-2xl hover:bg-[#32e012] transition shadow-[0_0_30px_rgba(57,255,20,0.6)] cursor-pointer active:scale-95"
                    >
                        START CAMERA
                    </button>
                    <p className="text-gray-400 text-sm">Press to enable AI Vision</p>
                </div>
            )}
        </div>
    );
};
