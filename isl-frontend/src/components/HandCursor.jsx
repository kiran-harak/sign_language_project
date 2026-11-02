/**
 * HandCursor.jsx — v3 (Hands-Off)
 *
 *  - GPU-accelerated cursor dot, moved directly by useHandCursor (no per-frame re-render)
 *  - Dwell-click progress ring (only shown over clickable elements)
 *  - Ripple burst on every hand click
 *  - Scroll-zone HUD bars (top/bottom) + two-finger scroll mode
 *  - Hover highlight on the element the hand is pointing at
 *  - Toggle docked into the top bar, with loading / tracking / no-hand state
 */

import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import useHandCursor from '../hooks/useHandCursor'
import { useApp } from '../context/AppContext'

const RADIUS = 22
const STROKE = 3
const CIRCUM = 2 * Math.PI * RADIUS

const STATUS_TEXT = {
  off:      'Control the app with your hand',
  loading:  'Starting hand tracking…',
  nohand:   'Show one hand to the camera',
  tracking: 'Tracking — pinch to click, hover the edges to scroll',
  paused:   'Camera is off — turn it on to use hand control',
  error:    'Hand control could not start',
}

function ScrollZoneBar({ zone }) {
  if (!zone) return null
  const isUp = zone === 'up'
  return (
    <div className="hc-zone" data-zone={zone}>
      <div className="hc-zone-pill">
        <span aria-hidden="true">{isUp ? '↑' : '↓'}</span>
        {isUp ? 'SCROLL UP' : 'SCROLL DOWN'}
        <span aria-hidden="true">{isUp ? '↑' : '↓'}</span>
      </div>
    </div>
  )
}

export default function HandCursor() {
  const { enabled, toggle, status, errorMsg, isPinching, scrollZone, mode, dotRef, ringRef } = useHandCursor()
  const { showToast } = useApp()
  const [ripples, setRipples] = useState([])
  const rippleId = useRef(0)

  // Ripple wherever a hand click lands
  useEffect(() => {
    const onClick = (e) => {
      const id = ++rippleId.current
      setRipples((r) => [...r.slice(-3), { id, x: e.detail.x, y: e.detail.y }])
      setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 700)
    }
    window.addEventListener('handcursor:click', onClick)
    return () => window.removeEventListener('handcursor:click', onClick)
  }, [])

  // One-time usage hint when tracking starts; error toast if it fails
  const hinted = useRef(false)
  useEffect(() => {
    if (status === 'nohand' && !hinted.current) {
      hinted.current = true
      showToast('Hand control on — pinch or hold over a button to click', 'success')
    }
    if (status === 'error' && errorMsg) showToast(errorMsg, 'error')
  }, [status, errorMsg, showToast])

  // Navbar renders #hand-cursor-slot; mount the toggle there so it never covers page content
  const [slot, setSlot] = useState(null)
  useEffect(() => {
    const find = () => setSlot(document.getElementById('hand-cursor-slot'))
    find()
    // The navbar can remount (route/layout changes) — keep the portal target fresh
    const mo = new MutationObserver(() => {
      const el = document.getElementById('hand-cursor-slot')
      setSlot((cur) => (cur === el ? cur : el))
    })
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

  const loading = enabled && status === 'loading'
  const live = enabled && status === 'tracking'

  const button = (
    <button
      id="hand-cursor-toggle"
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={enabled ? 'Disable hand control' : 'Enable hand control'}
      title={enabled ? `${STATUS_TEXT[status] || ''} · Shift+Esc to stop` : STATUS_TEXT.off}
      className={`hc-toggle${slot ? '' : ' hc-toggle-floating'}`}
      data-on={enabled}
    >
      {loading ? (
        <span className="hc-spinner" aria-hidden="true" />
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
          <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
          <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
      )}
      <span className="hc-label">{loading ? 'Starting…' : 'Hand control'}</span>
      <span aria-hidden="true" className="hc-led" data-state={enabled ? status : 'off'} />
      <span className="sr-only" aria-live="polite">{enabled ? STATUS_TEXT[status] : ''}</span>
    </button>
  )

  return (
    <>
      <style>{`
        @keyframes hc-ripple {
          0%   { transform: translate(-50%,-50%) scale(0); opacity: 0.85; }
          100% { transform: translate(-50%,-50%) scale(3); opacity: 0; }
        }
        @keyframes hc-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes hc-spin { to { transform: rotate(360deg); } }
        @keyframes hc-blink { 50% { opacity: 0.35; } }
        .hc-toggle {
          display: flex; align-items: center; gap: 7px; height: 34px; min-width: 34px; padding: 0 11px; border-radius: 10px;
          border: 1px solid var(--border-hover); background: var(--bg-panel); color: var(--text-muted);
          font-size: 0.78rem; font-weight: 500; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
          transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
        }
        .hc-toggle[data-on="true"] { border-color: var(--accent-border); background: var(--accent-soft); color: var(--accent); }
        .hc-toggle-floating { position: fixed; bottom: 1.25rem; left: 1.25rem; z-index: 100000; box-shadow: var(--shadow-md); }
        .hc-led { width: 6px; height: 6px; border-radius: 50%; background: var(--text-ghost); flex-shrink: 0; }
        .hc-led[data-state="tracking"] { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .hc-led[data-state="nohand"], .hc-led[data-state="loading"] { background: var(--yellow, #F2C14E); animation: hc-blink 1.2s ease-in-out infinite; }
        .hc-led[data-state="paused"], .hc-led[data-state="error"] { background: var(--red, #E5483B); }
        .hc-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: hc-spin 0.8s linear infinite; }
        .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        @media (max-width: 1100px) { .hc-toggle { padding: 0 9px; } }
        @media (pointer: coarse) { .hc-toggle { height: 40px; min-width: 40px; } }
        [data-hand-hover] { outline: 2px solid var(--accent) !important; outline-offset: 2px; }
        #hand-cursor-dot {
          position: absolute; left: 0; top: 0; width: 0; height: 0; opacity: 0; will-change: transform;
          transition: opacity 180ms ease;
        }
        #hand-cursor-dot .hc-core {
          position: absolute; left: -7px; top: -7px; width: 14px; height: 14px; border-radius: 50%;
          background: radial-gradient(circle, #FF8A4C 0%, #E5642A 60%, transparent 100%);
          box-shadow: 0 0 12px 4px rgba(255,138,76,0.6), 0 0 0 2px rgba(255,255,255,0.85);
          transition: transform 100ms ease, box-shadow 100ms ease;
        }
        #hand-cursor-dot[data-pinch="true"] .hc-core {
          transform: scale(1.6);
          background: radial-gradient(circle, #ffffff 0%, #FF8A4C 55%, transparent 100%);
          box-shadow: 0 0 24px 10px rgba(255,138,76,0.9), 0 0 0 2px #fff;
        }
        #hand-cursor-dot[data-mode="scroll"] .hc-core { border-radius: 6px; transform: scale(1.2, 1.6); }
        .hc-zone {
          position: fixed; left: 0; right: 0; height: 12vh; pointer-events: none; z-index: 99990;
          display: flex; justify-content: center; padding: 10px 0; animation: hc-fade-in 0.2s ease;
        }
        .hc-zone[data-zone="up"] { top: 0; align-items: flex-start; background: linear-gradient(to bottom, rgba(255,138,76,0.18), transparent); }
        .hc-zone[data-zone="down"] { bottom: 0; align-items: flex-end; background: linear-gradient(to top, rgba(255,138,76,0.18), transparent); }
        .hc-zone-pill {
          display: flex; align-items: center; gap: 8px; background: rgba(10,10,25,0.65); backdrop-filter: blur(10px);
          border: 1px solid rgba(255,138,76,0.35); border-radius: 24px; padding: 5px 14px;
          color: rgba(255,138,76,0.95); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.05em;
        }
      `}</style>

      <ScrollZoneBar zone={enabled ? scrollZone : null} />

      {/* Cursor overlay — never intercepts real pointer events */}
      <div id="hand-cursor-root" aria-hidden="true" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 99999, overflow: 'hidden' }}>
        <div id="hand-cursor-dot" ref={dotRef} data-pinch={isPinching} data-mode={mode}>
          <svg
            width={(RADIUS + STROKE) * 2} height={(RADIUS + STROKE) * 2}
            style={{ position: 'absolute', left: -(RADIUS + STROKE), top: -(RADIUS + STROKE), opacity: 0, transition: 'opacity 120ms ease' }}
          >
            <circle cx={RADIUS + STROKE} cy={RADIUS + STROKE} r={RADIUS} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={STROKE} />
            <circle
              ref={ringRef} data-circ={CIRCUM}
              cx={RADIUS + STROKE} cy={RADIUS + STROKE} r={RADIUS} fill="none"
              stroke="rgba(255,138,76,0.95)" strokeWidth={STROKE} strokeLinecap="round"
              strokeDasharray={CIRCUM} strokeDashoffset={CIRCUM}
              transform={`rotate(-90 ${RADIUS + STROKE} ${RADIUS + STROKE})`}
            />
          </svg>
          <div className="hc-core" />
        </div>
      </div>

      {ripples.map((r) => (
        <div key={r.id} style={{ position: 'fixed', left: r.x, top: r.y, width: 0, height: 0, pointerEvents: 'none', zIndex: 99998 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{
              position: 'absolute', width: 60, height: 60, borderRadius: '50%',
              border: '2px solid rgba(255,138,76,0.7)', transform: 'translate(-50%,-50%) scale(0)',
              animation: `hc-ripple 0.6s ${i * 0.1}s ease-out forwards`,
            }} />
          ))}
        </div>
      ))}

      {slot ? createPortal(button, slot) : button}
    </>
  )
}
