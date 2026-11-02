/**
 * useHandCursor.js — v3 "Hands-Off" control
 *
 * Control the whole app with one hand in front of the camera.
 *
 *   Point      move the cursor (thumb–index midpoint, so it doesn't jump on pinch)
 *   Pinch      thumb + index together → click
 *   Dwell      hold still over a button/link for ~1.1 s → click
 *   Edges      hover the top/bottom 10% of the screen → scroll
 *   Two-finger index + middle up (ring + pinky folded), move up/down → scroll
 *
 * Why v3:
 *   • @mediapipe/hands (legacy) breaks in Vite production builds
 *     ("Hands is not a constructor") and loaded scripts from a CDN that the
 *     app's Content-Security-Policy blocks → the feature never worked when
 *     deployed. v3 uses @mediapipe/tasks-vision (proper ES module, GPU
 *     delegate, CPU fallback) with self-hosted wasm + model.
 *   • One-Euro filter instead of a double EMA → smooth when still, no lag when moving.
 *   • Pinch threshold is normalised by hand size → works near and far from the camera.
 *   • A comfortable "active box" of the camera frame maps to the full screen,
 *     so screen edges are reachable without leaving the frame.
 *   • Cursor is moved by writing to the DOM directly — no React re-render per frame.
 *   • Shares the translator's camera stream (cameraHub) instead of opening the
 *     camera twice, which fails or freezes video on iOS/Android.
 *   • Robust start/stop: no leaked camera, no zombie loops, StrictMode safe.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import wasmNoSimdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url'
import wasmNoSimdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url'
import { getSharedCamera, onCameraChange } from '../lib/cameraHub'

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const MODEL_URL         = '/models/hand_landmarker.task'
const DETECT_INTERVAL   = 1000 / 30    // cap inference at ~30 fps
// Part of the (mirrored) camera frame that maps to the full screen
const BOX               = { x0: 0.18, x1: 0.82, y0: 0.14, y1: 0.72 }
const PINCH_ON          = 0.30         // thumb-index distance / hand size
const PINCH_OFF         = 0.45         // hysteresis
const PINCH_FRAMES      = 2            // consecutive frames to confirm a pinch
const CLICK_COOLDOWN_MS = 450
const ARM_DELAY_MS      = 900          // no clicks right after enabling / hand re-appearing
const DWELL_MS          = 1100
const DWELL_RADIUS_PX   = 26
const EDGE_ZONE         = 0.10         // top/bottom 10% of viewport
const EDGE_DELAY_MS     = 350          // must stay in the zone this long before scrolling
const EDGE_MAX_SPEED    = 1100         // px / s at the very edge
const SWIPE_GAIN        = 2.2
const HAND_LOST_MS      = 250

const ACTIONABLE = 'button, a[href], [role="button"], [role="tab"], [role="link"], [role="menuitem"], input, select, textarea, label, summary, [data-hand-click]'
const TEXT_INPUT = 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select, [contenteditable="true"]'

// ---------------------------------------------------------------------------
// One-Euro filter (Casiez et al. 2012) — adaptive low-pass for pointers
// ---------------------------------------------------------------------------
class OneEuro {
  constructor(minCutoff = 1.4, beta = 0.012, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff
    this.reset()
  }
  reset() { this.x = null; this.dx = 0; this.t = null }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt) }
  filter(value, tSec) {
    if (this.x === null) { this.x = value; this.t = tSec; return value }
    const dt = Math.max(1e-3, tSec - this.t)
    this.t = tSec
    const rawDx = (value - this.x) / dt
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx)
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx)
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x)
    return this.x
  }
}

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// ---------------------------------------------------------------------------
// Landmarker — one per delegate, loaded once and reused across toggles
// ---------------------------------------------------------------------------
const landmarkers = {}       // { GPU?: Promise<HandLandmarker>, CPU?: Promise<HandLandmarker> }
const GPU_SLOW_MS = 60        // GPU slower than this per frame → software GPU, switch to CPU

/** Software-rendered WebGL (SwiftShader / llvmpipe) makes the GPU delegate ~100× slower. */
function hasRealGpu() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')
    if (!gl) return false
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)
  } catch { return false }
}

let preferredDelegate = null
function pickDelegate() {
  if (!preferredDelegate) preferredDelegate = hasRealGpu() ? 'GPU' : 'CPU'
  return preferredDelegate
}

function getLandmarker(delegate = pickDelegate()) {
  if (!landmarkers[delegate]) {
    landmarkers[delegate] = (async () => {
      // Loaded on first use so the ~140 KB library isn't in the initial bundle
      const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision')
      const simd = await FilesetResolver.isSimdSupported()
      const fileset = simd
        ? { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl }
        : { wasmLoaderPath: wasmNoSimdLoaderUrl, wasmBinaryPath: wasmNoSimdBinaryUrl }
      const options = (d) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate: d },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      })
      try {
        const lm = await HandLandmarker.createFromOptions(fileset, options(delegate))
        lm.__delegate = delegate
        return lm
      } catch (e) {
        if (delegate !== 'GPU') throw e
        console.warn('[HandCursor] GPU delegate unavailable, using CPU:', e?.message || e)
        preferredDelegate = 'CPU'
        const lm = await HandLandmarker.createFromOptions(fileset, options('CPU'))
        lm.__delegate = 'CPU'
        return lm
      }
    })().catch((e) => { delete landmarkers[delegate]; throw e })
  }
  return landmarkers[delegate]
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function actionableAt(x, y) {
  const el = document.elementFromPoint(x, y)
  if (!el) return null
  const target = el.closest(ACTIONABLE)
  if (!target) return null
  if (target.disabled || target.getAttribute('aria-disabled') === 'true') return null
  return target
}

function clickAt(x, y) {
  const el = document.elementFromPoint(x, y)
  if (!el) return false
  const target = el.closest(ACTIONABLE) || el
  if (target.disabled || target.getAttribute('aria-disabled') === 'true') return false
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 }
  const ptr = { ...base, pointerId: 77, pointerType: 'mouse', isPrimary: true }
  try {
    target.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }))
    target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
    target.dispatchEvent(new PointerEvent('pointerup', ptr))
    target.dispatchEvent(new MouseEvent('mouseup', base))
  } catch { /* old browsers without PointerEvent constructor */ }
  if (target.matches(TEXT_INPUT)) target.focus({ preventScroll: true })
  if (typeof target.click === 'function') target.click()
  else target.dispatchEvent(new MouseEvent('click', base))
  return true
}

function scrollableAt(x, y) {
  let node = document.elementFromPoint(x, y)
  while (node && node !== document.body && node !== document.documentElement) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  const main = document.getElementById('main-scroll')
  if (main && main.scrollHeight > main.clientHeight + 1) return main
  return document.scrollingElement || document.documentElement
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export default function useHandCursor() {
  const [enabled, setEnabled]       = useState(false)
  // 'off' | 'loading' | 'nohand' | 'tracking' | 'paused' | 'error'
  const [status, setStatus]         = useState('off')
  const [errorMsg, setErrorMsg]     = useState('')
  const [isPinching, setIsPinching] = useState(false)
  const [scrollZone, setScrollZone] = useState(null)  // 'up' | 'down' | null
  const [mode, setMode]             = useState('point') // 'point' | 'scroll'

  // Elements the component attaches; updated directly every frame
  const dotRef  = useRef(null)
  const ringRef = useRef(null)

  const sessionRef = useRef(0)
  const S = useRef(null) // per-session mutable state

  const setStatusOnce = useCallback((st) => {
    const s = S.current
    if (s && s.status === st) return
    if (s) s.status = st
    setStatus(st)
  }, [])

  const paint = useCallback((x, y, visible, dwell) => {
    const dot = dotRef.current
    if (dot) {
      dot.style.transform = `translate3d(${x}px, ${y}px, 0)`
      dot.style.opacity = visible ? '1' : '0'
    }
    const ring = ringRef.current
    if (ring) {
      const c = Number(ring.dataset.circ || 0)
      ring.style.strokeDashoffset = String(c * (1 - dwell))
      ring.parentNode.style.opacity = dwell > 0.02 ? '1' : '0'
    }
  }, [])

  const setHover = (s, el) => {
    if (s.hoverEl === el) return
    if (s.hoverEl) s.hoverEl.removeAttribute('data-hand-hover')
    s.hoverEl = el
    if (el) el.setAttribute('data-hand-hover', '')
  }

  // ── Frame processing ───────────────────────────────────────────────────
  const processResult = useCallback((s, result, now) => {
    const lms = result?.landmarks?.[0]
    const W = window.innerWidth
    const H = window.innerHeight

    if (!lms) {
      if (s.lastSeen && now - s.lastSeen > HAND_LOST_MS) {
        if (s.handVisible) {
          s.handVisible = false
          s.pinch = false; s.pinchFrames = 0
          s.dwell = { el: null, start: 0, x: 0, y: 0, done: false }
          s.edge = { zone: null, since: 0 }
          setHover(s, null)
          setIsPinching(false); setScrollZone(null); setMode('point')
          paint(s.x, s.y, false, 0)
        }
        setStatusOnce(s.trackPaused ? 'paused' : 'nohand')
      } else if (!s.lastSeen) {
        setStatusOnce(s.trackPaused ? 'paused' : 'nohand')
      }
      return
    }

    const tSec = now / 1000
    if (!s.handVisible) {
      // Re-appearing hand: start fresh so the cursor doesn't glide from the old spot
      if (now - s.lastSeen > 500) { s.fx.reset(); s.fy.reset(); s.armedAt = now + ARM_DELAY_MS * 0.6 }
      s.handVisible = true
    }
    s.lastSeen = now
    setStatusOnce('tracking')

    // Aspect-correct points (x scaled by frame aspect) for distance maths
    const vw = s.video.videoWidth || 640
    const vh = s.video.videoHeight || 480
    const ar = vw / vh
    const P = (i) => ({ x: lms[i].x * ar, y: lms[i].y })
    const wrist = P(0)
    const handSize = Math.max(1e-3, dist(wrist, P(9)))
    const pinchRatio = dist(P(4), P(8)) / handSize
    const extended = (tip, pip) => dist(wrist, P(tip)) > dist(wrist, P(pip)) * 1.12
    const twoFinger = extended(8, 6) && extended(12, 10) && !extended(16, 14) && !extended(20, 18) && pinchRatio > PINCH_OFF

    // Pointer = thumb–index midpoint (mirrored), mapped through the active box
    const mx = 1 - (lms[4].x + lms[8].x) / 2
    const my = (lms[4].y + lms[8].y) / 2
    const nx = clamp01((mx - BOX.x0) / (BOX.x1 - BOX.x0))
    const ny = clamp01((my - BOX.y0) / (BOX.y1 - BOX.y0))
    let x = s.fx.filter(nx * W, tSec)
    let y = s.fy.filter(ny * H, tSec)

    // ── Pinch (with hysteresis) ─────────────────────────────────────────
    const wasPinch = s.pinch
    if (!wasPinch) {
      s.pinchFrames = pinchRatio < PINCH_ON ? s.pinchFrames + 1 : 0
      if (s.pinchFrames >= PINCH_FRAMES) s.pinch = true
    } else if (pinchRatio > PINCH_OFF) {
      s.pinch = false; s.pinchFrames = 0
    }
    if (s.pinch) {
      // Freeze the cursor while pinched so the click lands where you aimed
      if (!wasPinch) s.pinchAt = { x: s.x, y: s.y }
      x = s.pinchAt.x; y = s.pinchAt.y
    }
    s.x = x; s.y = y
    if (s.pinch !== wasPinch) setIsPinching(s.pinch)

    const newMode = twoFinger ? 'scroll' : 'point'
    if (newMode !== s.mode) {
      s.mode = newMode; setMode(newMode); s.swipeY = null
    }

    const armed = now >= s.armedAt
    if (s.pinch && !wasPinch && !twoFinger && armed && now - s.lastClick > CLICK_COOLDOWN_MS) {
      if (clickAt(x, y)) { s.lastClick = now; s.dwell.done = true; s.clickFx?.(x, y) }
    }

    // ── Hover target + dwell-click (only over actionable elements) ──────
    const target = !twoFinger ? actionableAt(x, y) : null
    setHover(s, target)
    let dwellProgress = 0
    const d = s.dwell
    const inEdge = !s.pinch && (y / H < EDGE_ZONE || y / H > 1 - EDGE_ZONE) && !(target && target.closest('header, .topbar, .dock, [data-hand-noscroll]'))
    if (target && !s.pinch && !inEdge) {
      if (d.el !== target || Math.hypot(x - d.x, y - d.y) > DWELL_RADIUS_PX) {
        s.dwell = { el: target, start: now, x, y, done: false }
      } else if (!d.done) {
        dwellProgress = Math.min(1, (now - d.start) / DWELL_MS)
        if (dwellProgress >= 1 && armed && now - s.lastClick > CLICK_COOLDOWN_MS) {
          d.done = true
          if (clickAt(x, y)) { s.lastClick = now; s.clickFx?.(x, y) }
          dwellProgress = 0
        }
      }
    } else if (!target || inEdge) {
      s.dwell = { el: null, start: 0, x, y, done: false }
    }

    // ── Edge-zone scrolling ─────────────────────────────────────────────
    // Edges scroll even over content cards; only fixed controls (top bar, call dock) opt out
    const ry = y / H
    const fixedUi = target && target.closest('header, .topbar, .dock, [data-hand-noscroll]')
    const zone = !s.pinch && !twoFinger && !fixedUi ? (ry < EDGE_ZONE ? 'up' : ry > 1 - EDGE_ZONE ? 'down' : null) : null
    if (zone !== s.edge.zone) s.edge = { zone, since: now }
    const activeZone = zone && now - s.edge.since > EDGE_DELAY_MS ? zone : null
    if (activeZone !== s.scrollZone) { s.scrollZone = activeZone; setScrollZone(activeZone) }
    if (activeZone) {
      const depth = activeZone === 'up' ? 1 - ry / EDGE_ZONE : (ry - (1 - EDGE_ZONE)) / EDGE_ZONE
      const dt = Math.min(0.1, (now - (s.lastFrame || now)) / 1000)
      const delta = (activeZone === 'up' ? -1 : 1) * EDGE_MAX_SPEED * (0.25 + 0.75 * clamp01(depth)) * dt
      scrollableAt(x, y).scrollBy({ top: delta, behavior: 'instant' })
    }

    // ── Two-finger swipe scroll ─────────────────────────────────────────
    if (twoFinger) {
      if (s.swipeY !== null) {
        const dy = (y - s.swipeY) * SWIPE_GAIN
        if (Math.abs(dy) > 0.5) scrollableAt(x, y).scrollBy({ top: dy, behavior: 'instant' })
      }
      s.swipeY = y
    }

    s.lastFrame = now
    paint(x, y, true, dwellProgress)
  }, [paint, setStatusOnce])

  // ── Camera source (shared with the translator when possible) ───────────
  const attachSource = useCallback(async (s) => {
    const shared = getSharedCamera()
    const video = s.video
    if (shared) {
      const track = shared.getVideoTracks().find((t) => t.readyState === 'live')
      if (s.ownStream) { s.ownStream.getTracks().forEach((t) => t.stop()); s.ownStream = null }
      s.sharedTrack = track
      video.srcObject = new MediaStream([track])
    } else {
      s.sharedTrack = null
      if (!s.ownStream || !s.ownStream.getVideoTracks().some((t) => t.readyState === 'live')) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera not supported in this browser')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 30, max: 30 } },
          audio: false,
        })
        if (sessionRef.current !== s.id) { stream.getTracks().forEach((t) => t.stop()); return }
        s.ownStream = stream
      }
      video.srcObject = s.ownStream
    }
    s.lastVideoTime = -1
    try { await video.play() } catch { /* muted + playsInline: play() rejection is harmless */ }
  }, [])

  // ── Start / stop ───────────────────────────────────────────────────────
  const start = useCallback(async () => {
    const id = ++sessionRef.current
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.autoplay = true
    video.setAttribute('playsinline', '')
    video.setAttribute('aria-hidden', 'true')
    // Must stay "rendered" (not display:none) or some browsers stop decoding frames
    Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' })
    document.body.appendChild(video)

    const s = {
      id, video, status: null, ownStream: null, sharedTrack: null, raf: 0, unsub: null,
      landmarker: null, lastVideoTime: -1, lastDetect: 0, lastSeen: 0, lastFrame: 0,
      fx: new OneEuro(), fy: new OneEuro(), x: window.innerWidth / 2, y: window.innerHeight / 2,
      handVisible: false, pinch: false, pinchFrames: 0, pinchAt: { x: 0, y: 0 },
      mode: 'point', swipeY: null, scrollZone: null, edge: { zone: null, since: 0 },
      dwell: { el: null, start: 0, x: 0, y: 0, done: false }, hoverEl: null,
      lastClick: 0, armedAt: performance.now() + ARM_DELAY_MS, trackPaused: false, errors: 0,
      clickFx: (cx, cy) => window.dispatchEvent(new CustomEvent('handcursor:click', { detail: { x: cx, y: cy } })),
    }
    S.current = s
    setErrorMsg('')
    setStatusOnce('loading')

    try {
      const [landmarker] = await Promise.all([getLandmarker(), attachSource(s)])
      if (sessionRef.current !== id) return
      s.landmarker = landmarker
    } catch (err) {
      if (sessionRef.current !== id) return
      console.error('[HandCursor] start failed:', err)
      const msg = err?.name === 'NotAllowedError'
        ? 'Camera permission denied'
        : err?.name === 'NotReadableError' ? 'Camera is busy in another app' : 'Hand tracking could not start'
      setErrorMsg(msg)
      setStatusOnce('error')
      setEnabled(false)
      return
    }

    // Follow the translator's camera: switch to its stream when it starts,
    // and back to our own when it stops.
    s.unsub = onCameraChange(() => {
      if (sessionRef.current !== id) return
      attachSource(s).catch((e) => console.warn('[HandCursor] camera switch failed', e))
    })

    const loop = () => {
      if (sessionRef.current !== id) return
      s.raf = requestAnimationFrame(loop)
      if (document.hidden) return
      const v = s.video
      if (v.readyState < 2 || !v.videoWidth) return
      const now = performance.now()
      // Adaptive rate: inference runs on the main thread, so leave headroom for the UI on slow devices
      const interval = Math.max(DETECT_INTERVAL, (s.inferMs || 0) * 1.6)
      if (v.currentTime === s.lastVideoTime || now - s.lastDetect < interval) return
      s.lastVideoTime = v.currentTime
      s.lastDetect = now

      // Shared camera switched off mid-call → nothing to track
      s.trackPaused = !!s.sharedTrack && !s.sharedTrack.enabled
      if (s.sharedTrack && s.sharedTrack.readyState !== 'live') {
        attachSource(s).catch(() => {})
        return
      }

      let result
      try {
        const t0 = performance.now()
        // Dev-only test hook: synthetic landmarks instead of inference (stripped from production builds)
        const fake = import.meta.env.DEV && typeof window.__HC_FAKE__ === 'function' ? window.__HC_FAKE__(now) : null
        result = fake || s.landmarker.detectForVideo(v, now)
        const took = performance.now() - t0
        s.inferMs = s.inferMs ? s.inferMs * 0.8 + took * 0.2 : took
        s.frames = (s.frames || 0) + 1
        // GPU delegate running in software → switch to the (much faster) CPU path once
        if (s.landmarker.__delegate === 'GPU' && s.frames >= 4 && s.inferMs > GPU_SLOW_MS && !s.switching) {
          s.switching = true
          console.warn(`[HandCursor] GPU inference ${s.inferMs.toFixed(0)} ms/frame — switching to CPU`)
          preferredDelegate = 'CPU'
          getLandmarker('CPU').then((lm) => {
            if (sessionRef.current !== s.id) return
            s.landmarker = lm; s.inferMs = 0; s.frames = 0; s.lastVideoTime = -1
          }).catch(() => {}).finally(() => { s.switching = false })
        }
        if (import.meta.env.DEV) window.__HC_STATS__ = { inferMs: s.inferMs, status: s.status }
        s.errors = 0
      } catch (e) {
        if (++s.errors > 10) {
          console.error('[HandCursor] detection keeps failing:', e)
          setErrorMsg('Hand tracking stopped unexpectedly')
          setStatusOnce('error')
          setEnabled(false)
        }
        return
      }
      processResult(s, result, now)
    }
    s.raf = requestAnimationFrame(loop)
  }, [attachSource, processResult, setStatusOnce])

  const stop = useCallback(() => {
    sessionRef.current++
    const s = S.current
    S.current = null
    if (!s) return
    cancelAnimationFrame(s.raf)
    s.unsub?.()
    if (s.hoverEl) s.hoverEl.removeAttribute('data-hand-hover')
    if (s.ownStream) s.ownStream.getTracks().forEach((t) => t.stop())
    s.video.srcObject = null
    s.video.remove()
    // The landmarker is a singleton kept for instant re-enable (not closed)
    setIsPinching(false)
    setScrollZone(null)
    setMode('point')
    paint(-100, -100, false, 0)
  }, [paint])

  const toggle = useCallback(() => setEnabled((p) => !p), [])

  useEffect(() => {
    if (!enabled) {
      setStatus((st) => (st === 'error' ? st : 'off'))
      return
    }
    start()
    return () => stop()
  }, [enabled, start, stop])

  // Allow Esc to switch Hands-Off off (keyboard users / stuck states)
  useEffect(() => {
    if (!enabled) return
    const onKey = (e) => { if (e.key === 'Escape' && e.shiftKey) setEnabled(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])

  return { enabled, toggle, status, errorMsg, isPinching, scrollZone, mode, dotRef, ringRef }
}
