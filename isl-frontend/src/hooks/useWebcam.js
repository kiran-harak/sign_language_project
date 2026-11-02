// isl-frontend/src/hooks/useWebcam.js

import { useRef, useState, useCallback, useEffect } from 'react'
import { publishCamera } from '../lib/cameraHub'

// Empty string = relative URL — Vite proxy routes it to localhost:8000
// Works on both PC (localhost:5173) and Android (192.168.x.x:5173)
const API_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, '') ?? ''
const DEFAULT_FPS   = 4
const CALL_FPS      = 2   // halved during active WebRTC call to free CPU for video encoding
const DEFAULT_JPEG  = 0.7
const CALL_JPEG     = 0.5  // lower quality during call reduces encode CPU further

export function useWebcam() {
  const videoRef          = useRef(null)
  const canvasRef         = useRef(null)
  const offscreenRef      = useRef(null)          // private offscreen canvas for frame capture
  const streamRef         = useRef(null)
  const timerRef          = useRef(null)             // setTimeout handle
  const lastTickRef       = useRef(0)
  const isDetectingRef    = useRef(false)
  const frameIntervalRef  = useRef(1000 / DEFAULT_FPS)  // dynamic — updated by setDetectionFps
  const jpegQualityRef    = useRef(DEFAULT_JPEG)         // dynamic — lowered during calls

  const [isActive,     setIsActive]     = useState(false)
  const [error,        setError]        = useState(null)
  const [fps,          setFps]          = useState(0)
  const [prediction,   setPrediction]   = useState(null)
  const [backendReady, setBackendReady] = useState(false)
  const [isDetecting,  setIsDetecting]  = useState(false)

  // Check backend health on mount
  useEffect(() => {
    // Render's free tier sleeps; keep polling (up to ~3 min) until the model is loaded
    let cancelled = false
    let timer = null
    let attempts = 0
    const check = () => {
      fetch(`${API_URL}/health`, { cache: 'no-store' })
        .then(r => r.json())
        .then(d => {
          if (cancelled) return
          const ready = d.model_loaded === true
          setBackendReady(ready)
          if (!ready && ++attempts < 36) timer = setTimeout(check, 5000)
        })
        .catch(() => {
          if (cancelled) return
          setBackendReady(false)
          if (++attempts < 36) timer = setTimeout(check, 5000)
        })
    }
    check()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])

  const captureFrame = useCallback(() => {
    const video  = videoRef.current
    if (!video || video.readyState < 2 || !video.videoWidth) return null
    // Camera switched off (track disabled) → frames are black; don't waste a /predict call
    const vt = streamRef.current?.getVideoTracks()[0]
    if (!vt || !vt.enabled || vt.readyState !== 'live') return null

    const W = video.videoWidth  || 480
    const H = video.videoHeight || 360

    // Use an offscreen canvas so the visible canvas can be hidden
    if (!offscreenRef.current) {
      offscreenRef.current = document.createElement('canvas')
    }
    const oc = offscreenRef.current
    oc.width  = W
    oc.height = H
    const ctx = oc.getContext('2d')
    ctx.drawImage(video, 0, 0, W, H)
    return oc.toDataURL('image/jpeg', jpegQualityRef.current).split(',')[1]
  }, [])

  const sendFrame = useCallback(async (base64) => {
    try {
      const res = await fetch(`${API_URL}/predict`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json", 
  },
  body: JSON.stringify({
    image: base64,
  }),
});
      if (!res.ok) return
      const data = await res.json()
      setPrediction(data)
    } catch {
      // silently skip — don't crash the detection loop
    }
  }, [])

  // ── Detection loop via setTimeout (non-blocking, no rAF competition with WebRTC) ──
  const detectionTick = useCallback(async () => {
    if (!isDetectingRef.current) return

    const t0 = performance.now()
    const frame = captureFrame()
    if (frame) await sendFrame(frame)
    const elapsed = performance.now() - t0

    // Compute display FPS based on actual interval
    const interval = frameIntervalRef.current
    setFps(Math.min(Math.round(1000 / interval), Math.round(1000 / Math.max(elapsed, 1))))

    // Schedule next tick — subtract processing time to stay on target
    if (isDetectingRef.current) {
      timerRef.current = setTimeout(detectionTick, Math.max(0, interval - elapsed))
    }
  }, [captureFrame, sendFrame])

  const startDetection = useCallback(() => {
    if (!streamRef.current || isDetectingRef.current) return false
    isDetectingRef.current = true
    lastTickRef.current = 0
    setIsDetecting(true)
    detectionTick()   // kick off the loop
    return true
  }, [detectionTick])

  const stopDetection = useCallback(() => {
    isDetectingRef.current = false
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setIsDetecting(false)
    setFps(0)
  }, [])

  const start = useCallback(async (options = {}) => {
    const detect = options.detect !== false
    // Pre-call preferences: tracks are always acquired (so they can be switched on
    // mid-call without renegotiation) but start enabled/disabled as requested.
    const videoOn = options.video !== false
    const audioOn = options.audio !== false
    setError(null)

    // Already running (e.g. lobby preview → join): just re-apply preferences
    if (streamRef.current && streamRef.current.getVideoTracks().some(t => t.readyState === 'live')) {
      streamRef.current.getVideoTracks().forEach(t => { t.enabled = videoOn })
      streamRef.current.getAudioTracks().forEach(t => { t.enabled = audioOn })
      if (detect) startDetection()
      return true
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(window.isSecureContext === false
        ? 'Camera needs a secure (https) connection.'
        : 'This browser does not support camera access.')
      return false
    }

    const video = {
      width:       { ideal: 480 },
      height:      { ideal: 360 },
      facingMode:  'user',
      frameRate:   { ideal: 20, max: 24 },  // limit source fps → less WebRTC encode CPU
    }
    let stream = null
    try {
      // mic track must be in the stream so WebRTC can send it to the peer
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video })
    } catch (err) {
      // No microphone / mic permission denied → still allow signing with video only
      if (err.name === 'NotFoundError' || err.name === 'NotAllowedError' || err.name === 'OverconstrainedError') {
        try { stream = await navigator.mediaDevices.getUserMedia({ video }) } catch (err2) { err = err2 }
      }
      if (!stream) {
        const msg = err.name === 'NotAllowedError'
          ? 'Camera permission denied — allow it in your browser settings.'
          : err.name === 'NotReadableError'
            ? 'Camera is in use by another app.'
            : (err.message || 'Camera access denied')
        setError(msg)
        return false
      }
    }

    stream.getVideoTracks().forEach(t => { t.enabled = videoOn })
    stream.getAudioTracks().forEach(t => { t.enabled = audioOn })
    streamRef.current = stream
    publishCamera(stream)
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      try { await videoRef.current.play() } catch { /* autoplay policies — muted video still renders */ }
    }
    setIsActive(true)
    if (detect) startDetection()
    return true
  }, [startDetection])

  // Switch the camera / mic on or off WITHOUT stopping the device, so an
  // active call keeps sending the same tracks (peers see black / hear silence).
  const setTrackEnabled = useCallback((kind, on) => {
    const s = streamRef.current
    if (!s) return false
    const tracks = kind === 'video' ? s.getVideoTracks() : s.getAudioTracks()
    tracks.forEach(t => { t.enabled = on })
    return tracks.length > 0
  }, [])

  const hasTrack = useCallback((kind) => {
    const s = streamRef.current
    return !!s && (kind === 'video' ? s.getVideoTracks() : s.getAudioTracks()).some(t => t.readyState === 'live')
  }, [])

  const stop = useCallback(() => {
    stopDetection()
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
      publishCamera(null)
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setIsActive(false)
    setPrediction(null)
  }, [stopDetection])

  // Expose the raw stream so useVideoCall can use it for peer connection
  const getStream = useCallback(() => streamRef.current, [])

  // Called by Translator when call status changes to throttle detection and save CPU
  const setDetectionFps = useCallback((fps) => {
    frameIntervalRef.current = 1000 / fps
    jpegQualityRef.current   = fps <= CALL_FPS ? CALL_JPEG : DEFAULT_JPEG
  }, [])

  return {
    videoRef, canvasRef,
    isActive, isDetecting, error, fps,
    prediction, backendReady,
    start, stop, startDetection, stopDetection, getStream, setDetectionFps,
    setTrackEnabled, hasTrack,
  }
}
