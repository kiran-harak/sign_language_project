/**
 * Translator.jsx — MudraVani ISL Translator (v3 — Premium UI)
 * Modes:
 *   solo — single-user translator with live webcam ML detection
 *   call — 2-user video call with real-time ISL translation relay
 *
 * Suggestion-share fix: when user selects a grammar suggestion in call mode,
 * it is relayed to the partner via a 'suggestion' type message on the chat WS.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useSpring, useMotionValue } from 'framer-motion';
import {
  Video, VideoOff, RotateCcw, Copy, Save, Volume2, VolumeX,
  AlertCircle, Wifi, WifiOff, Lightbulb,
  Phone, PhoneOff, Users, User, Link2, Loader2, UserCheck,
  Sparkles, Zap, MessageSquare, CheckCircle2, Send, Settings, Monitor, MonitorOff, Mic, MicOff, Maximize2, Minimize2,
  Lock, Shuffle, PanelRight, ArrowUpRight,
} from 'lucide-react';
import { useWebcam }           from '../hooks/useWebcam';
import { useVideoCall }         from '../hooks/useVideoCall';
import { useApp }               from '../context/AppContext';
import MeetingReadyModal        from '../components/MeetingReadyModal';
import Segmented                from '../components/ui/Segmented';
import HandLandmarks            from '../components/ui/HandLandmarks';

const MIN_CONFIDENCE = 0.60;

// ── Language config ────────────────────────────────────────────────────────────
const LANG_CONFIG = {
  en: { label: 'EN', full: 'English',  bcp47: 'en-IN', mmLang: 'en',   voiceHints: ['en-IN', 'en_IN', 'English India', 'Ravi', 'Lekha'] },
  hi: { label: 'HI', full: 'Hindi',    bcp47: 'hi-IN', mmLang: 'hi',   voiceHints: ['hi-IN', 'hi_IN', 'Hindi',  'Lekha'] },
  mr: { label: 'MR', full: 'Marathi',  bcp47: 'mr-IN', mmLang: 'mr',   voiceHints: ['mr-IN', 'mr_IN', 'Marathi'] },
};

// ── Translation — Google Translate (primary) + MyMemory (fallback) ───────────
// Google Translate unofficial endpoint always returns the target script (Devanagari)
async function translateViaGoogle(text, targetLang, source = 'en') {
  const tl = LANG_CONFIG[targetLang]?.mmLang || targetLang; // 'hi', 'mr', etc.
  // Use the unofficial single-text endpoint (no API key needed)
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${tl}` +
    `&dt=t&q=${encodeURIComponent(text)}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  const data = await res.json();
  // Response shape: [ [[translated, original, ...], ...], ... ]
  if (Array.isArray(data) && Array.isArray(data[0])) {
    const translated = data[0]
      .filter(Boolean)
      .map(chunk => chunk[0])
      .join('')
      .trim();
    if (translated) return translated;
  }
  throw new Error('Empty response');
}

async function translateViaMyMemory(text, targetLang) {
  const langPair = `en|${LANG_CONFIG[targetLang]?.mmLang || targetLang}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = await res.json();
  if (data.responseStatus === 200 && data.responseData?.translatedText) {
    return cleanDevanagari(data.responseData.translatedText, targetLang);
  }
  if (data.matches?.length) return cleanDevanagari(data.matches[0].translation || text, targetLang);
  throw new Error('No translation');
}

async function translateText(text, targetLang, source = 'en') {
  if (!text || (targetLang === 'en' && source === 'en')) return text;
  try {
    // Primary: Google Translate (always gives Devanagari for hi/mr)
    return await translateViaGoogle(text, targetLang, source);
  } catch (err) {
    console.warn('[translateText] Google failed, trying MyMemory:', err.message);
    if (source !== 'en') return text; // MyMemory needs an explicit source language
    try {
      return await translateViaMyMemory(text, targetLang);
    } catch (err2) {
      console.warn('[translateText] MyMemory also failed:', err2.message);
      return text; // graceful fallback
    }
  }
}

// ── Cached translation: every visible string (suggestions, chat, partner captions)
// follows the selected output language. Results are cached per language, so
// switching back and forth is instant and each phrase is fetched only once.
const tCache   = new Map();
const tPending = new Map();
const needsTranslation = (text, lang, source) =>
  !!text && !(lang === 'en' && (source === 'en' || /^[\x00-\x7F]*$/.test(text)));

function translateCached(text, lang, source = 'en') {
  if (!needsTranslation(text, lang, source)) return Promise.resolve(text);
  const key = `${source}|${lang}|${text}`;
  if (tCache.has(key)) return Promise.resolve(tCache.get(key));
  if (!tPending.has(key)) {
    tPending.set(key, translateText(text, lang, source)
      .then(r => { const out = r || text; tCache.set(key, out); return out; })
      .finally(() => tPending.delete(key)));
  }
  return tPending.get(key);
}

function useTranslated(text, lang, source = 'en') {
  const key = `${source}|${lang}|${text}`;
  const [state, setState] = useState(() => ({ key, value: needsTranslation(text, lang, source) ? tCache.get(key) : text }));
  useEffect(() => {
    if (!needsTranslation(text, lang, source)) { setState({ key, value: text }); return; }
    if (tCache.has(key)) { setState({ key, value: tCache.get(key) }); return; }
    let alive = true;
    setState({ key, value: undefined });
    translateCached(text, lang, source).then(v => { if (alive) setState({ key, value: v }); });
    return () => { alive = false; };
  }, [key, text, lang, source]);
  const ready = state.key === key && state.value !== undefined;
  return { value: ready ? state.value : text, pending: !ready };
}

/** Renders `text` in the selected output language (original shown faintly while loading). */
function TText({ text, lang, source = 'en', className = '', style, as: Tag = 'span' }) {
  const { value, pending } = useTranslated(text, lang, source);
  const deva = lang === 'hi' || lang === 'mr';
  return (
    <Tag className={`${deva && !pending ? 'deva' : ''} ${className}`.trim()} style={{ opacity: pending ? 0.55 : 1, transition: 'opacity .2s ease', ...style }} lang={pending ? undefined : LANG_CONFIG[lang]?.bcp47}>
      {value}
    </Tag>
  );
}

// ── Extract Devanagari from mixed MyMemory responses ─────────────────────────
// Only needed as a fallback — Google always returns proper script.
function cleanDevanagari(raw, targetLang) {
  if (!raw || targetLang === 'en') return raw;
  const isDevanagari = targetLang === 'hi' || targetLang === 'mr';
  if (!isDevanagari) return raw;

  // If the string already starts with Devanagari, return as-is
  if (/^[\u0900-\u097F]/.test(raw.trim())) return raw.trim();

  // Extract Devanagari from inside parentheses
  const parenMatches = [...raw.matchAll(/\(([^)]+)\)/g)]
    .map(m => m[1].trim())
    .filter(s => /[\u0900-\u097F]/.test(s));
  if (parenMatches.length > 0) {
    const parts  = parenMatches.join(' ').split(',').map(s => s.trim()).filter(Boolean);
    const unique = [...new Set(parts)];
    return unique.join(', ');
  }

  // Extract all Devanagari runs
  const runs = raw.match(/[\u0900-\u097F][\u0900-\u097F\s,।.!?]*/g);
  if (runs) {
    const joined = runs.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length > 1) return joined;
  }

  return raw; // last resort
}

// ── Pick the best TTS voice for a BCP-47 tag ─────────────────────────────────
function pickVoice(bcp47, hints) {
  if (!window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  // Exact locale match
  let v = voices.find(v => v.lang === bcp47);
  if (v) return v;
  // Hint substring match (e.g. 'hi-IN', 'Hindi', 'Lekha')
  for (const hint of (hints || [])) {
    v = voices.find(v => v.lang.includes(hint) || v.name.includes(hint));
    if (v) return v;
  }
  // Language prefix match
  const prefix = bcp47.split('-')[0];
  v = voices.find(v => v.lang.startsWith(prefix));
  return v || null;
}
// A sign is committed after it has been held steadily for HOLD_MS (≈1.5 s) —
// time-based, so it no longer depends on how many frames the network delivers.
const HOLD_MS          = 1500;
const MIN_HOLD_FRAMES  = 3;     // …and seen in at least this many predictions
const GRACE_FRAMES     = 1;     // one stray / no-hand frame doesn't restart the hold
const REPEAT_RESET_MS  = 1200;  // hand away this long → the same sign can be committed again

const STATUS_META = {
  idle:       { label: 'Not in call',        color: 'var(--text-faint)', dot: 'var(--text-faint)', glow: 'transparent' },
  connecting: { label: 'Connecting…',        color: 'var(--yellow)',     dot: 'var(--yellow)',      glow: 'var(--yellow)' },
  waiting:    { label: 'Waiting for partner',color: 'var(--blue)',       dot: 'var(--blue)',        glow: 'var(--blue)' },
  connected:  { label: 'Live',               color: 'var(--green)',      dot: 'var(--green)',       glow: 'var(--green)' },
  full:       { label: 'Room full',           color: 'var(--red)',        dot: 'var(--red)',         glow: 'var(--red)' },
  error:      { label: 'Error',               color: 'var(--red)',        dot: 'var(--red)',         glow: 'var(--red)' },
};

const RADIUS = 26;
const CIRC   = 2 * Math.PI * RADIUS;

const normalizeRoomCode = (v) =>
  v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function confColor(pct) {
  if (pct >= 90) return 'var(--green)';
  if (pct >= 75) return 'var(--yellow)';
  return 'var(--red)';
}

/* ─── Animated confidence ring ─────────────────────────────────────────────── */
function ConfidenceRing({ pct, sign, hasHand }) {
  const springPct = useSpring(pct, { stiffness: 120, damping: 18 });
  const offset    = useMotionValue(CIRC);

  useEffect(() => {
    offset.set(CIRC - (CIRC * pct) / 100);
  }, [pct]);

  const color = hasHand ? confColor(pct) : 'var(--text-ghost)';

  return (
    <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
      {hasHand && pct >= 90 && (
        <motion.div
          animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ duration: 1.6, repeat: Infinity }}
          style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1px solid var(--green)', pointerEvents: 'none' }}
        />
      )}
      <svg width={64} height={64} viewBox="0 0 72 72" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={36} cy={36} r={RADIUS} fill="none" stroke="var(--border-hover)" strokeWidth={4} />
        <motion.circle
          cx={36} cy={36} r={RADIUS} fill="none"
          stroke={color} strokeWidth={4} strokeLinecap="round"
          strokeDasharray={CIRC}
          style={{ strokeDashoffset: offset, transition: 'stroke 0.3s ease' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="mono" style={{ fontSize: '0.78rem', fontWeight: 500, color: hasHand ? 'var(--text-primary)' : 'var(--text-ghost)' }}>
          {pct}<span style={{ fontSize: '0.6rem', color: 'var(--text-faint)' }}>%</span>
        </span>
      </div>
    </div>
  );
}

/* ─── Word chip with bounce-in ─────────────────────────────────────────────── */
function WordChip({ word, index, color = 'accent' }) {
  return (
    <motion.span
      key={`${word}-${index}`}
      initial={{ opacity: 0, scale: 0.6, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 22 }}
      style={{
        display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 11px', borderRadius: 9,
        fontSize: '0.84rem', fontWeight: 500,
        background: color === 'accent' ? 'var(--accent-soft)' : 'var(--blue-soft)',
        border: `1px solid ${color === 'accent' ? 'var(--accent-border)' : 'var(--blue-border)'}`,
        color: color === 'accent' ? 'var(--accent)' : 'var(--blue)',
      }}
    >
      {word}
    </motion.span>
  );
}

/* ─── Incoming suggestion toast (peer sent) ─────────────────────────────────── */
function IncomingSuggestionBanner({ text, onDismiss }) {
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(onDismiss, 7000);
    return () => clearTimeout(t);
  }, [text, onDismiss]);

  return (
    <AnimatePresence>
      {text && (
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          className="card"
          style={{ display: 'flex', alignItems: 'flex-start', gap: 12, borderColor: 'var(--blue-border)' }}
        >
          <MessageSquare size={16} style={{ color: 'var(--blue)', marginTop: 3, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <p className="section-label" style={{ marginBottom: 6, color: 'var(--blue)' }}>Partner wants to say</p>
            <p style={{ fontFamily: 'var(--font-serif)', fontSize: '1.3rem', lineHeight: 1.2 }}>“{text}”</p>
          </div>
          <button onClick={onDismiss} className="icon-btn" style={{ width: 26, height: 26 }} aria-label="Dismiss">×</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ─── VideoTile ─────────────────────────────────────────────────────────────── */
function VideoTile({ stream, name, isPinned, onPin, videoOff, audioOff }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
      ref.current.play?.().catch(() => {});
    }
  }, [stream]);

  const showAvatar = !stream || videoOff;

  return (
    <div
      onClick={onPin}
      title={isPinned ? 'Click to unpin' : 'Click to pin'}
      style={{
        position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', cursor: 'pointer',
        borderRadius: 18, background: '#161513',
        border: `1px solid ${isPinned ? '#FF8A4C' : 'var(--stage-border)'}`,
        boxShadow: isPinned ? '0 0 0 3px rgba(255,138,76,0.18)' : 'none',
        transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
      }}
    >
      <video ref={ref} autoPlay playsInline muted={false} className="vtile-video" style={{ opacity: videoOff ? 0 : 1 }} />
      {showAvatar && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--stage-muted)' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--stage-raised)', border: '1px solid var(--stage-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-serif)', fontSize: '1.8rem', color: 'var(--stage-text)' }}>
            {name?.[0]?.toUpperCase() || '?'}
          </div>
          <span style={{ fontSize: '0.74rem' }}>{stream ? 'Camera off' : 'Connecting…'}</span>
        </div>
      )}
      <div className="stage-chip vtile-name" style={{ position: 'absolute', bottom: 12, left: 12, pointerEvents: 'none' }}>
        {audioOff && <MicOff size={11} style={{ color: '#FF9A90' }} />}
        {name || 'Partner'}
      </div>
      {isPinned && (
        <div className="stage-chip mono" style={{ position: 'absolute', top: 12, right: 12, pointerEvents: 'none', fontSize: '0.62rem', letterSpacing: '0.1em', color: '#FF8A4C' }}>
          PINNED
        </div>
      )}
    </div>
  );
}

/* ─── Lobby demo: hand skeleton + a live caption assembling word by word ────── */
const DEMO_WORDS = ['Hello', 'How', 'You'];
const DEMO_SENTENCE = 'Hello, how are you?';
function LobbyDemo() {
  const [step, setStep] = useState(0); // 0..3 words shown, 4 = full sentence
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setStep(4); return; }
    const t = setInterval(() => setStep(s => (s + 1) % 6), 1100);
    return () => clearInterval(t);
  }, []);
  const shown = Math.min(step, 3);
  return (
    <div className="tr-lobby-demo" aria-hidden="true">
      <div className="tr-lobby-hand">
        <span className="tr-lobby-hand-glow" />
        <HandLandmarks size={150} color="#F3EFE8" accent="#FF8A4C" />
      </div>
      <div className="tr-lobby-caption">
        <p className="tr-lobby-caption-label">
          <span className="status-dot" data-live="true" style={{ color: '#FF8A4C' }} /> Live caption
        </p>
        <div className="tr-lobby-caption-body">
          <AnimatePresence mode="wait">
            {step >= 4 ? (
              <motion.p key="sentence" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} className="tr-lobby-sentence">
                {DEMO_SENTENCE}
              </motion.p>
            ) : (
              <motion.div key="words" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="tr-lobby-words">
                {DEMO_WORDS.slice(0, shown).map((w, i) => (
                  <motion.span key={w} initial={{ opacity: 0, scale: 0.7, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 22 }} className="tr-lobby-word" data-current={i === shown - 1}>
                    {w}
                  </motion.span>
                ))}
                {shown < 3 && <span className="tr-lobby-cursor" />}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ─── VideoGrid ─────────────────────────────────────────────────────────────── */
// Auto-adjusting grid for remote peers (local video is always a separate PiP).
// When a peer is pinned: featured (big) + strip (others on right).
// When nothing pinned: equal-size CSS grid.
function VideoGrid({ remotePeers, pinnedPeerId, onPinToggle }) {
  const peerList = [...remotePeers.entries()]; // [[id, {stream,name}], ...]

  if (peerList.length === 0) return null;

  if (pinnedPeerId && remotePeers.has(pinnedPeerId)) {
    const pinned = remotePeers.get(pinnedPeerId);
    const others = peerList.filter(([id]) => id !== pinnedPeerId);
    return (
      <div className="vgrid-pinned">
        <div className="vgrid-main">
          <VideoTile stream={pinned.stream} name={pinned.name || 'Partner'} videoOff={pinned.videoOff} audioOff={pinned.audioOff} isPinned onPin={() => onPinToggle(null)} />
        </div>
        {others.length > 0 && (
          <div className="vgrid-strip">
            {others.map(([id, peer]) => (
              <div key={id} className="vgrid-strip-item">
                <VideoTile stream={peer.stream} name={peer.name || 'Partner'} videoOff={peer.videoOff} audioOff={peer.audioOff} isPinned={false} onPin={() => onPinToggle(id)} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Column count comes from CSS (data-count) so portrait phones stack tiles vertically
  const count = peerList.length;

  return (
    <div className="vgrid" data-count={Math.min(count, 5)}>
      {peerList.map(([id, peer]) => (
        <VideoTile key={id} stream={peer.stream} name={peer.name || 'Partner'} videoOff={peer.videoOff} audioOff={peer.audioOff} isPinned={false} onPin={() => onPinToggle(id)} />
      ))}
    </div>
  );
}

/* ─── Main ──────────────────────────────────────────────────────────────────── */
export default function Translator() {
  const {
    videoRef, canvasRef, isActive, isDetecting, error,
    fps, prediction, backendReady, start, stop, startDetection, stopDetection, getStream,
    setDetectionFps, setTrackEnabled,
  } = useWebcam();

  const {
    status: callStatus, error: callError, myId,
    remotePeers,
    peerSentence, peerWord, peerSuggestion, peerName, peerChat,
    joinRoom, leaveRoom, sendTranslation, sendSuggestion, sendChatMessage,
    replaceVideoTrack, setLocalMedia,
  } = useVideoCall();

  const { addToHistory, showToast, getSuggestions } = useApp();

  const [mode, setMode]               = useState('solo');
  const [roomInput, setRoomInput]     = useState('');
  const [inRoom, setInRoom]           = useState(false);
  const [showMeetingModal, setShowMeetingModal] = useState(false);
  const [pinnedPeerId, setPinnedPeerId]         = useState(null); // peerId pinned to fullscreen, null = equal grid
  const [userName, setUserName]       = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab]   = useState('transcript');
  const [isMuted, setIsMuted]         = useState(false);
  const [isVideoOn, setIsVideoOn]     = useState(true);
  const [isAslActive, setIsAslActive] = useState(true);
  const [currentTime, setCurrentTime] = useState('');
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const screenStreamRef = useRef(null);
  const stageRef        = useRef(null);
  const panelRef        = useRef(null);
  // Screen sharing isn't available in mobile browsers — hide the button there
  const canShareScreen  = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

  // Meeting links (/translate?room=CODE) pre-fill the room code in call mode
  useEffect(() => {
    const room = new URLSearchParams(window.location.search).get('room');
    if (room) {
      setMode('call');
      setRoomInput(normalizeRoomCode(room));
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => setCurrentTime(new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})), 1000);
    return () => clearInterval(t);
  }, []);

  const [sentence, setSentence]             = useState([]);
  const [language, setLanguage]             = useState('en');
  const [translatedText, setTranslatedText] = useState('');
  const [isTranslating, setIsTranslating]   = useState(false);
  const [isSpeaking, setIsSpeaking]         = useState(false);
  const [speechRate, setSpeechRate]         = useState(1.25);  // Web Speech API: 0.1–10, 1=normal
  const lastWordRef   = useRef('');
  const holdRef       = useRef({ sign: null, since: 0, frames: 0, misses: 0, conf: 0 });
  const lastHandAtRef = useRef(0);
  const [holdPct, setHoldPct]               = useState(0);
  const [suggestions, setSuggestions]       = useState([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(null);
  
  // Chat and History
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const sentenceRef   = useRef([]);
  const translateAbortRef = useRef(null);

  useEffect(() => { sentenceRef.current = sentence; }, [sentence]);

  // ── Auto-translate whenever sentence or language changes ──────────────────
  useEffect(() => {
    const english = sentence.map(s => s.word).join(' ');
    if (!english) { setTranslatedText(''); return; }
    if (language === 'en') { setTranslatedText(english); return; }
    // Debounce: cancel previous in-flight translation
    const timer = setTimeout(async () => {
      setIsTranslating(true);
      const result = await translateCached(english, language);
      setTranslatedText(result);
      setIsTranslating(false);
    }, 400); // wait 400ms after last word added
    return () => clearTimeout(timer);
  }, [sentence, language]);

  // ── Sign detection ─────────────────────────────────────────────────────────
  const resetHold = useCallback(() => {
    holdRef.current = { sign: null, since: 0, frames: 0, misses: 0, conf: 0 };
    setHoldPct(0);
  }, []);

  const commitWord = useCallback((sign, confidence) => {
    const updated = [...sentenceRef.current, { word: sign, confidence }];
    sentenceRef.current = updated;
    setSentence(updated);
    setSuggestions(getSuggestions(updated.map(x => x.word)));
    // Relayed over the chat WebSocket — no need to wait for the WebRTC media path
    if (mode === 'call' && inRoom) sendTranslation(sign, updated.map(x => x.word).join(' '));
    lastWordRef.current = sign;
  }, [getSuggestions, mode, inRoom, sendTranslation]);

  useEffect(() => {
    if (!prediction) return;
    const now = performance.now();
    const h = holdRef.current;
    const { sign, confidence, hand_detected } = prediction;

    if (hand_detected) lastHandAtRef.current = now;
    else if (lastWordRef.current && now - lastHandAtRef.current > REPEAT_RESET_MS) lastWordRef.current = '';

    const usable = hand_detected && confidence >= MIN_CONFIDENCE && sign !== lastWordRef.current;
    if (!usable || (h.sign && sign !== h.sign)) {
      // Tolerate a single stray frame (motion blur, a flicker to another class)
      if (h.sign && h.misses < GRACE_FRAMES) { h.misses += 1; return; }
      if (!usable) { resetHold(); return; }
    }
    if (h.sign !== sign) {
      holdRef.current = { sign, since: now, frames: 1, misses: 0, conf: confidence };
      setHoldPct(0);
      return;
    }
    h.frames += 1; h.misses = 0; h.conf = Math.max(h.conf, confidence);
    const progress = Math.min(1, (now - h.since) / HOLD_MS);
    setHoldPct(progress * 100);
    if (progress >= 1 && h.frames >= MIN_HOLD_FRAMES) {
      commitWord(sign, h.conf);
      resetHold();
    }
  }, [prediction, commitWord, resetHold]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getText = () => sentence.map(s => s.word).join(' ');
  const getDisplayText = () => translatedText || getText();

  const handleStart = useCallback(async (opts) => {
    lastWordRef.current = ''; resetHold();
    return await start(opts);
  }, [start]);

  const handleStop  = useCallback(() => stop(), [stop]);

  const handleReset = useCallback(() => {
    setSentence([]); sentenceRef.current = []; lastWordRef.current = ''; resetHold(); setSuggestions([]); setSelectedSuggestion(null);
    setTranslatedText(''); setIsTranslating(false);
  }, []);

  const handleCopy = () =>
    navigator.clipboard.writeText(getDisplayText() || getText()).then(() => showToast('Copied!', 'success'));

  const handleSave = () => {
    if (!sentence.length) return showToast('Nothing to save yet', 'error');
    const avgConf = sentence.reduce((a, s) => a + s.confidence, 0) / sentence.length;
    addToHistory({
      sentence: getDisplayText(),
      originalEnglish: getText(),
      words: sentence.map(s => s.word),
      lang: language,
      confidence: avgConf,
    });
    showToast('Saved to history ✓', 'success');
  };

  const handleSpeak = useCallback(() => {
    const textToSpeak = translatedText || sentence.map(s => s.word).join(' ');
    if (!textToSpeak || isSpeaking) return;
    // Cancel any ongoing speech
    speechSynthesis.cancel();
    const cfg = LANG_CONFIG[language] || LANG_CONFIG.en;
    const u   = new SpeechSynthesisUtterance(textToSpeak);
    u.lang    = cfg.bcp47;
    // Try to find a matching Indian-accent voice
    const doSpeak = () => {
      const bestVoice = pickVoice(cfg.bcp47, cfg.voiceHints);
      if (bestVoice) u.voice = bestVoice;
      u.rate   = speechRate;
      u.pitch  = 1.0;
      u.volume = 1.0;
      u.onstart = () => setIsSpeaking(true);
      u.onend   = () => setIsSpeaking(false);
      u.onerror = () => setIsSpeaking(false);
      speechSynthesis.speak(u);
    };
    // Voices may not be loaded yet on first call — wait for them
    if (speechSynthesis.getVoices().length > 0) {
      doSpeak();
    } else {
      speechSynthesis.onvoiceschanged = () => { doSpeak(); speechSynthesis.onvoiceschanged = null; };
    }
  }, [language, isSpeaking, translatedText, sentence, speechRate]);

  // Stop any speech still playing when leaving the page
  useEffect(() => () => speechSynthesis.cancel(), []);

  // Apply suggestion — and relay to partner in call mode
  const applySuggestion = (text) => {
    setSentence([]);
    setSuggestions([]);
    setSelectedSuggestion(text);
    showToast('Suggestion applied', 'success');

    const msg = { id: Date.now(), sender: 'Me', text, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) };
    setChatMessages(p => [...p, msg]);

    // Relay the chosen suggestion to partner as a chat message
    if (mode === 'call' && inRoom && sendChatMessage) {
      if (!sendChatMessage(text)) showToast('Chat not connected yet — message not delivered', 'error');
    }
  };

  const handleSendChat = () => {
    if (!chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput('');
    const msg = { id: Date.now(), sender: 'Me', text, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) };
    setChatMessages(p => [...p, msg]);
    if (mode === 'call' && inRoom && sendChatMessage) {
      if (!sendChatMessage(text)) showToast('Chat not connected yet — message not delivered', 'error');
    }
  };

  useEffect(() => {
    if (peerChat) {
      setChatMessages(p => [...p, { id: peerChat.id, sender: peerName || 'Partner', text: peerChat.text, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) }]);
    }
  }, [peerChat, peerName]);

  // Surface signaling / connection errors from the call hook
  useEffect(() => {
    if (callError) showToast(callError, 'error');
  }, [callError, showToast]);

  // ── Pre-call device preferences (lobby) ─────────────────────────────────────
  // The lobby shows a live preview; camera / mic toggles here decide how you join.
  const lobbyVisible   = mode === 'call' && !inRoom;
  const previewTriedRef = useRef(false);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!lobbyVisible) { previewTriedRef.current = false; return; }
    if (isVideoOn && !isActive && !previewTriedRef.current) {
      previewTriedRef.current = true;
      handleStart({ detect: false, video: true, audio: !isMuted });
    }
  }, [lobbyVisible, isVideoOn, isActive, isMuted, handleStart]);

  const handleJoinRoom = async () => {
    if (joining) return;
    const roomId = normalizeRoomCode(roomInput);
    if (!roomId) return showToast('Enter a room code', 'error');
    setRoomInput(roomId);
    setJoining(true);
    try {
      if (!isActive) {
        await handleStart({ detect: false, video: isVideoOn, audio: !isMuted });
      } else {
        setTrackEnabled('video', isVideoOn);
        setTrackEnabled('audio', !isMuted);
      }
      // Give a just-started camera a moment to hand over its stream
      let stream = getStream();
      for (let i = 0; !stream && i < 10; i++) {
        await new Promise(r => setTimeout(r, 100));
        stream = getStream();
      }
      if (!stream) showToast('Camera unavailable — joining to watch and chat', 'error');
      const hasVideo = !!stream?.getVideoTracks().length;
      const hasAudio = !!stream?.getAudioTracks().length;
      if (stream && !hasAudio && !isMuted) showToast('No microphone found — joining without audio', 'error');
      setLocalMedia({ video: isVideoOn && hasVideo, audio: !isMuted && hasAudio });
      await joinRoom(roomId, stream || null, userName);
      setInRoom(true);
    } finally {
      setJoining(false);
    }
  };

  // Show "Your meeting's ready" modal when host is alone waiting for others.
  // Auto-dismiss once the first person joins.
  useEffect(() => {
    if (callStatus === 'waiting' && remotePeers.size === 0) {
      setShowMeetingModal(true);
    }
    if (remotePeers.size > 0) {
      setShowMeetingModal(false);
    }
  }, [callStatus, remotePeers.size]);

  // ── Full-screen focus mode ────────────────────────────────────────────────────
  // The stage becomes a fixed full-viewport layer with only the essentials. The
  // browser Fullscreen API is used where available (hides browser chrome);
  // iPhone Safari has no document fullscreen, so the CSS layer alone is used there.
  const [isFull, setIsFull]   = useState(false);
  const [isIdle, setIsIdle]   = useState(false);
  const [fsChat, setFsChat]   = useState(null);   // last incoming chat, shown briefly in full screen
  const apiFullRef = useRef(false);
  const idleTimerRef = useRef(null);

  const exitFull = useCallback(() => {
    setIsFull(false);
    setIsIdle(false);
    const d = document;
    if (apiFullRef.current && (d.fullscreenElement || d.webkitFullscreenElement)) {
      (d.exitFullscreen || d.webkitExitFullscreen)?.call(d)?.catch?.(() => {});
    }
    apiFullRef.current = false;
  }, []);

  const enterFull = useCallback(() => {
    setIsFull(true);
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        const r = req.call(el, { navigationUI: 'hide' });
        apiFullRef.current = true;
        r?.catch?.(() => { apiFullRef.current = false; });
      } catch { apiFullRef.current = false; }
    }
  }, []);

  const toggleFull = useCallback(() => (isFull ? exitFull() : enterFull()), [isFull, exitFull, enterFull]);

  // Leaving browser fullscreen (Esc / system gesture) also leaves focus mode
  useEffect(() => {
    const onChange = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fsEl && apiFullRef.current) { apiFullRef.current = false; setIsFull(false); setIsIdle(false); }
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // Keyboard: F toggles, Esc exits
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleFull(); }
      else if (e.key === 'Escape' && isFull) exitFull();   // also leaves browser fullscreen if still active
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFull, toggleFull, exitFull]);

  // Auto-hide the controls after 3 s without pointer / touch / key activity
  const pokeControls = useCallback(() => {
    setIsIdle(false);
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIsIdle(true), 3000);
  }, []);
  useEffect(() => {
    if (!isFull) { clearTimeout(idleTimerRef.current); setIsIdle(false); return; }
    pokeControls();
    const evs = ['pointermove', 'pointerdown', 'keydown', 'touchstart'];
    evs.forEach(ev => window.addEventListener(ev, pokeControls, { passive: true }));
    // The app shell / page must not scroll underneath the full-screen layer
    document.documentElement.classList.add('tr-fullscreen');
    return () => {
      clearTimeout(idleTimerRef.current);
      evs.forEach(ev => window.removeEventListener(ev, pokeControls));
      document.documentElement.classList.remove('tr-fullscreen');
    };
  }, [isFull, pokeControls]);

  // Make sure focus mode never outlives the page
  useEffect(() => () => {
    document.documentElement.classList.remove('tr-fullscreen');
    if (apiFullRef.current && (document.fullscreenElement || document.webkitFullscreenElement)) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
    }
  }, []);

  // Incoming chat can't be read in the hidden panel → show it on the stage for a few seconds
  useEffect(() => {
    if (!isFull || !peerChat) return;
    setFsChat(peerChat);
    const t = setTimeout(() => setFsChat(null), 6000);
    return () => clearTimeout(t);
  }, [peerChat, isFull]);

  // The lobby has no stage — never stay in focus mode there
  useEffect(() => { if (lobbyVisible && isFull) exitFull(); }, [lobbyVisible, isFull, exitFull]);

  const handleLeaveRoom = () => {
    if (isFull) exitFull();
    leaveRoom();
    setInRoom(false);
    setRoomInput('');
    setShowMeetingModal(false);
  };


  const handleModeSwitch = (m) => {
    if (m === 'solo' && inRoom) handleLeaveRoom();
    if (m === 'solo' && !isVideoOn) {
      // Camera was switched off for the call — solo translation needs it back on
      setTrackEnabled('video', true);
      setIsVideoOn(true);
    }
    if (m === 'call') stopDetection();
    setMode(m); handleReset();
  };

  // ── Real mic mute: toggle the audio track on the live stream ─────────────────
  const handleMicToggle = useCallback(() => {
    const nextMuted = !isMuted;
    setTrackEnabled('audio', !nextMuted);
    setLocalMedia({ audio: !nextMuted });
    setIsMuted(nextMuted);
  }, [isMuted, setTrackEnabled, setLocalMedia]);

  // ── Camera on/off ────────────────────────────────────────────────────────────
  // In a call (and in the lobby) the track is only disabled, never stopped: stopping
  // it would end the track the peers receive, freezing your video for good.
  const handleVideoToggle = useCallback(() => {
    const next = !isVideoOn;
    if (mode === 'call') {
      const had = setTrackEnabled('video', next);
      if (!had && next) {
        if (inRoom) return showToast('No camera available in this call — rejoin to add one', 'error');
        handleStart({ detect: false, video: true, audio: !isMuted });
      }
      if (inRoom) setLocalMedia({ video: next });
      setIsVideoOn(next);
      return;
    }
    setIsVideoOn(next);
    next ? handleStart() : handleStop();   // solo: fully release the camera
  }, [isVideoOn, mode, inRoom, isMuted, setTrackEnabled, setLocalMedia, handleStart, handleStop, showToast]);

  const handlePanelToggle = useCallback(() => {
    const next = !isSidebarOpen;
    setIsSidebarOpen(next);
    // Below 1000px the panel sits under the stage — bring it into view when opened
    if (next && window.matchMedia('(max-width: 1000px)').matches) {
      setTimeout(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    }
  }, [isSidebarOpen]);

  // ── Real screen share ─────────────────────────────────────────────────────────
  const handleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
      }
      // Restore camera track on all peer connections
      const camStream = getStream();
      if (camStream) {
        const videoTrack = camStream.getVideoTracks()[0];
        if (videoTrack) replaceVideoTrack(videoTrack);
      }
      setIsScreenSharing(false);
      return;
    }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: 15 },
        audio: false,
      });
      screenStreamRef.current = screenStream;
      const screenTrack = screenStream.getVideoTracks()[0];
      // Replace video track on every peer connection at once
      replaceVideoTrack(screenTrack);
      // Auto-stop when user clicks browser's 'Stop sharing'
      screenTrack.onended = () => {
        screenStreamRef.current = null;
        setIsScreenSharing(false);
        const camStream = getStream();
        if (camStream) {
          const videoTrack = camStream.getVideoTracks()[0];
          if (videoTrack) replaceVideoTrack(videoTrack);
        }
      };
      setIsScreenSharing(true);
    } catch (err) {
      if (err.name !== 'NotAllowedError') console.warn('Screen share error:', err);
    }
  }, [isScreenSharing, getStream, replaceVideoTrack]);

  useEffect(() => {
    if (mode !== 'call' || !inRoom || !isActive) return;
    // Start detection whenever camera is active in a room, regardless of connection status
    // so predictions are ready the moment the peer connects
    if (!isDetecting) startDetection();
  }, [mode, inRoom, isActive, isDetecting, startDetection]);

  useEffect(() => {
    // Use 4 fps in call mode — enough for smooth sign detection without spiking encode CPU
    setDetectionFps(4);
  }, [mode, setDetectionFps]);

  useEffect(() => () => stop(), [stop]);

  // Solo video and call-mode PiP are never mounted together; whichever is mounted
  // is the frame-capture source, and gets the stream re-attached when it remounts.
  const attachLocalVideo = useCallback((el) => {
    videoRef.current = el;
    const s = getStream();
    if (el && s && el.srcObject !== s) el.srcObject = s;
  }, [videoRef, getStream]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const pct  = prediction ? Math.round(prediction.confidence * 100) : 0;
  const meta = STATUS_META[callStatus] || STATUS_META.idle;

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  const hasHand     = !!prediction?.hand_detected;
  const displayText = getDisplayText() || getText();
  const inCall      = mode === 'call';

  return (
    <div className="tr-root">

      {showMeetingModal && (
        <MeetingReadyModal roomCode={roomInput} onDismiss={() => setShowMeetingModal(false)} />
      )}

      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="tr-toolbar enter-fade">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <h1 className="display" style={{ fontSize: '1.9rem', lineHeight: 1 }}>
            Translate
          </h1>
          {inCall && inRoom ? (
            <span className="badge" style={{ color: meta.color, borderColor: 'var(--border-hover)' }}>
              <span className="status-dot" data-live={callStatus === 'connected'} />
              <span style={{ color: 'var(--text-secondary)' }}>{meta.label}</span>
            </span>
          ) : (
            <span className="badge" style={{ color: backendReady ? 'var(--green)' : 'var(--text-faint)' }}>
              <span className="status-dot" data-live={backendReady} />
              <span style={{ color: 'var(--text-secondary)' }}>{backendReady ? 'Model ready' : 'Model offline'}</span>
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Segmented
            ariaLabel="Mode"
            value={mode}
            onChange={handleModeSwitch}
            options={[{ value: 'solo', label: 'Solo', icon: User }, { value: 'call', label: 'Call', icon: Users }]}
          />
          <Segmented
            ariaLabel="Output language"
            value={language}
            onChange={setLanguage}
            options={Object.entries(LANG_CONFIG).map(([code, cfg]) => ({ value: code, label: cfg.label }))}
          />
          {inCall && (
            <span className="badge tr-hide-sm" title="WebRTC media is encrypted in transit (DTLS-SRTP)">
              <Lock size={11} /> Transport Encrypted
            </span>
          )}
          <span className="mono tr-hide-sm" style={{ fontSize: '0.76rem', color: 'var(--text-faint)', minWidth: 44, textAlign: 'right' }}>{currentTime}</span>
        </div>
      </div>

      {/* ── Lobby ─────────────────────────────────────────────────────────── */}
      {!inRoom && inCall ? (
        <div className="tr-lobby-wrap">
          <motion.div
            initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="tr-lobby"
          >
            <div className="tr-lobby-art">
              <div>
                <span className="eyebrow" style={{ color: 'var(--stage-muted)' }}>Group call</span>
                <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 'clamp(2.2rem, 3.6vw, 3rem)', lineHeight: 1, marginTop: 18, color: 'var(--stage-text)' }}>
                  Sign together,<br /><em style={{ color: '#FF8A4C' }}>see every word.</em>
                </h2>
                <ul className="tr-lobby-list">
                  {['Up to 6 people per room', 'Live ISL captions shared with everyone', 'Chat and suggestions alongside video'].map(t => (
                    <li key={t}>
                      <CheckCircle2 size={15} style={{ color: '#FF8A4C', flexShrink: 0 }} /> {t}
                    </li>
                  ))}
                </ul>
              </div>
              <LobbyDemo />
            </div>

            <div className="tr-lobby-form">
              <div>
                <h3 className="display" style={{ fontSize: '2rem' }}>Join a room</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', marginTop: 8 }}>
                  Share the same code with the people you’re calling.
                </p>
              </div>

              {/* Pre-call preview + device toggles */}
              <div className="tr-preview">
                <video ref={attachLocalVideo} autoPlay playsInline muted className="tr-preview-video" style={{ opacity: isVideoOn && isActive ? 1 : 0 }} />
                {!(isVideoOn && isActive) && (
                  <div className="tr-preview-off">
                    {isVideoOn ? <Loader2 size={20} className="spin" /> : <VideoOff size={22} />}
                    <span>{isVideoOn ? (error || 'Starting camera…') : 'Camera is off'}</span>
                  </div>
                )}
                <div className="tr-preview-ctrls">
                  <button
                    type="button" className="tr-pre-btn" data-off={!isVideoOn} aria-pressed={isVideoOn}
                    onClick={handleVideoToggle}
                    aria-label={isVideoOn ? 'Turn camera off before joining' : 'Turn camera on before joining'}
                    title={isVideoOn ? 'Camera on' : 'Camera off'}
                  >
                    {isVideoOn ? <Video size={18} /> : <VideoOff size={18} />}
                  </button>
                  <button
                    type="button" className="tr-pre-btn" data-off={isMuted} aria-pressed={!isMuted}
                    onClick={handleMicToggle}
                    aria-label={isMuted ? 'Turn microphone on before joining' : 'Turn microphone off before joining'}
                    title={isMuted ? 'Mic off' : 'Mic on'}
                  >
                    {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                  </button>
                </div>
              </div>
              <p className="tr-pre-status">
                Join with camera <b data-off={!isVideoOn}>{isVideoOn ? 'on' : 'off'}</b> and mic <b data-off={isMuted}>{isMuted ? 'off' : 'on'}</b>
              </p>
              <label style={{ display: 'grid', gap: 8 }}>
                <span className="section-label" style={{ margin: 0 }}>Your name</span>
                <input className="input-field" style={{ height: 46 }} value={userName} onChange={e => setUserName(e.target.value)} placeholder="How others will see you" autoComplete="nickname" enterKeyHint="next" maxLength={40} />
              </label>
              <label style={{ display: 'grid', gap: 8 }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="section-label" style={{ margin: 0 }}>Room code</span>
                  <button
                    type="button"
                    onClick={() => setRoomInput(normalizeRoomCode(Math.random().toString(36).slice(2, 8)))}
                    className="tr-newcode"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 0, color: 'var(--accent)', fontSize: '0.76rem', fontWeight: 500, cursor: 'pointer' }}
                  >
                    <Shuffle size={12} /> New code
                  </button>
                </span>
                <input
                  className="input-field mono"
                  value={roomInput}
                  onChange={e => setRoomInput(normalizeRoomCode(e.target.value))}
                  onKeyDown={e => e.key === 'Enter' && handleJoinRoom()}
                  placeholder="ABCD1234"
                  maxLength={8}
                  autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                  style={{ height: 56, fontSize: '1.3rem', letterSpacing: '0.32em', textAlign: 'center', textTransform: 'uppercase' }}
                />
              </label>
              <button onClick={handleJoinRoom} disabled={joining} className="btn-primary btn-lg" style={{ width: '100%' }}>
                {joining ? <Loader2 size={16} className="spin" /> : <Phone size={16} />} {joining ? 'Joining…' : 'Join call'}
              </button>
              <p style={{ fontSize: '0.74rem', color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Lock size={11} /> You can change camera and mic any time during the call.
              </p>
            </div>
          </motion.div>
        </div>
      ) : (
        /* ── Workspace ────────────────────────────────────────────────────── */
        <div className="tr-body">

          {/* STAGE */}
          <div
            ref={stageRef}
            className={`stage tr-stage ${!inCall ? 'viewfinder' : ''} ${isFull ? 'tr-stage-full' : ''}`}
            data-call={inCall} data-idle={isFull && isIdle}
            role={isFull ? 'dialog' : undefined} aria-modal={isFull || undefined} aria-label={isFull ? 'Full-screen translator' : undefined}
          >

            {inCall ? (
              remotePeers.size > 0 ? (
                <VideoGrid remotePeers={remotePeers} pinnedPeerId={pinnedPeerId} onPinToggle={setPinnedPeerId} />
              ) : (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, color: 'var(--stage-muted)', zIndex: 4 }}>
                  <div style={{ position: 'relative', width: 72, height: 72 }}>
                    {[0, 1, 2].map(k => (
                      <motion.span key={k}
                        animate={{ scale: [1, 2.2], opacity: [0.5, 0] }}
                        transition={{ duration: 2.4, repeat: Infinity, delay: k * 0.8, ease: 'easeOut' }}
                        style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1px solid rgba(255,138,76,0.6)' }}
                      />
                    ))}
                    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--stage-raised)', border: '1px solid var(--stage-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Users size={24} style={{ color: 'var(--stage-text)' }} />
                    </div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ fontFamily: 'var(--font-serif)', fontSize: '1.7rem', color: 'var(--stage-text)' }}>
                      {callStatus === 'waiting' ? 'Waiting for others to join' : 'Connecting…'}
                    </p>
                    <p className="mono" style={{ fontSize: '0.72rem', marginTop: 8, letterSpacing: '0.2em' }}>ROOM {roomInput}</p>
                  </div>
                  {callStatus === 'waiting' && (
                    <button onClick={() => setShowMeetingModal(true)} className="stage-chip" style={{ cursor: 'pointer', height: 36, padding: '0 14px' }}>
                      <Link2 size={13} /> Share invite link
                    </button>
                  )}
                </div>
              )
            ) : (
              <>
                <video ref={attachLocalVideo} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', backfaceVisibility: 'hidden' }} />
                <canvas ref={canvasRef} style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }} />
                {!isActive && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, zIndex: 10, background: 'radial-gradient(ellipse at center, #1A1816 0%, var(--stage) 70%)', padding: '24px 24px 96px', textAlign: 'center' }}>
                    <HandLandmarks size={130} color="#F3EFE8" accent="#FF8A4C" />
                    <div>
                      <p style={{ fontFamily: 'var(--font-serif)', fontSize: 'clamp(1.7rem, 3vw, 2.3rem)', color: 'var(--stage-text)', lineHeight: 1.05 }}>
                        Raise a hand to begin.
                      </p>
                      <p style={{ color: 'var(--stage-muted)', fontSize: '0.86rem', marginTop: 10, maxWidth: '40ch' }}>
                        Turn on your camera, sign at chest height, and hold each sign for a moment.
                      </p>
                    </div>
                    <button onClick={handleStart} className="btn-primary btn-lg" style={{ background: '#FF8A4C', color: '#1C0E05' }}>
                      <Video size={16} /> Start camera
                    </button>
                    {error && (
                      <p style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#FF9A90', fontSize: '0.8rem' }}>
                        <AlertCircle size={14} /> {error}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Grade for legibility */}
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '50%', background: 'linear-gradient(to top, rgba(11,10,9,0.92) 0%, rgba(11,10,9,0.45) 45%, transparent 100%)', pointerEvents: 'none', zIndex: 5 }} />

            {/* Top-left chips */}
            <div className="tr-chips" data-call={inCall}>
              {inCall && remotePeers.size > 0 && (
                <span className="stage-chip">
                  <span style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 11 }}>
                    {[1, 2, 3, 4].map(k => <motion.span key={k} animate={{ height: ['3px', '11px', '3px'] }} transition={{ duration: 1, repeat: Infinity, delay: k * 0.12 }} style={{ width: 2, background: '#5FD3A6', borderRadius: 2, display: 'block' }} />)}
                  </span>
                  {remotePeers.size === 1 ? (peerName || 'Partner') : `${remotePeers.size + 1} participants`}
                </span>
              )}
              {isAslActive && (isActive || remotePeers.size > 0) && (
                <span className="stage-chip">
                  <span className="status-dot" data-live={isDetecting} style={{ color: isDetecting ? '#FF8A4C' : 'var(--stage-muted)' }} />
                  {isDetecting ? 'Reading signs' : 'Detection paused'}
                  {isDetecting && <span className="mono" style={{ color: 'var(--stage-muted)', fontSize: '0.66rem' }}>{fps} fps</span>}
                </span>
              )}
              {isScreenSharing && (
                <span className="stage-chip" style={{ color: '#8AB4FF' }}>
                  <Monitor size={12} /> Sharing screen
                  <button onClick={handleScreenShare} style={{ background: 'none', border: 0, color: 'var(--stage-text)', cursor: 'pointer', textDecoration: 'underline', fontSize: '0.72rem' }}>Stop</button>
                </span>
              )}
            </div>

            {/* Local PiP */}
            {inCall && (
              <motion.div
                drag dragConstraints={stageRef} dragElastic={0.08} dragMomentum={false}
                whileDrag={{ scale: 1.03 }}
                className="tr-pip"
              >
                <video ref={attachLocalVideo} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', pointerEvents: 'none', opacity: isVideoOn ? 1 : 0 }} />
                {!isVideoOn && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--stage-muted)', pointerEvents: 'none' }}>
                    <VideoOff size={20} />
                  </div>
                )}
                <div style={{ position: 'absolute', bottom: 8, left: 8, right: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', pointerEvents: 'none' }}>
                  <span className="stage-chip" style={{ height: 24, fontSize: '0.66rem', padding: '0 8px' }}>{userName || 'You'}</span>
                  {isMuted && <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'rgba(255,122,110,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><MicOff size={11} color="#fff" /></span>}
                </div>
              </motion.div>
            )}

            {/* Full screen: partner's live captions + incoming chat (the side panel is hidden) */}
            {isFull && inCall && (
              <div className="tr-fs-peer">
                <AnimatePresence>
                  {peerSentence && isAslActive && (
                    <motion.div key="peer-caption" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="tr-fs-bubble">
                      <span className="tr-fs-who">{peerName || 'Partner'} is signing</span>
                      <TText className="tr-fs-text" text={peerSentence} lang={language} />
                    </motion.div>
                  )}
                  {fsChat && (
                    <motion.div key={fsChat.id} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="tr-fs-bubble tr-fs-chat">
                      <MessageSquare size={13} />
                      <span className="tr-fs-who">{fsChat.sender || peerName || 'Partner'}</span>
                      <TText className="tr-fs-text" text={fsChat.text} lang={language} source="auto" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* Caption */}
            <AnimatePresence>
              {(sentence.length > 0 || translatedText) && isAslActive && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className="tr-caption"
                >
                  <p className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.62rem', letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--stage-muted)', marginBottom: 10 }}>
                    <span style={{ width: 14, height: 1, background: '#FF8A4C' }} />
                    {inCall && remotePeers.size > 0 ? `${userName || 'You'} · ISL → ${LANG_CONFIG[language].full}` : `ISL → ${LANG_CONFIG[language].full}`}
                    {isTranslating && (
                      <span style={{ display: 'inline-flex', gap: 3 }}>
                        {[0, 0.15, 0.3].map((d, k) => <motion.span key={k} animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 0.9, repeat: Infinity, delay: d }} style={{ width: 4, height: 4, borderRadius: '50%', background: '#FF8A4C', display: 'inline-block' }} />)}
                      </span>
                    )}
                  </p>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={displayText}
                      initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0 }}
                      transition={{ duration: 0.35 }}
                      className={language === 'en' ? '' : 'deva'}
                      style={{ fontFamily: language === 'en' ? 'var(--font-serif)' : undefined, fontSize: language === 'en' ? 'clamp(1.6rem, 3.2vw, 2.6rem)' : 'clamp(1.4rem, 2.8vw, 2.2rem)', color: '#F3EFE8', lineHeight: 1.15 }}
                    >
                      {displayText}
                    </motion.p>
                  </AnimatePresence>
                  {suggestions.length > 0 && (
                    <div className="no-scrollbar" style={{ display: 'flex', gap: 6, marginTop: 14, overflowX: 'auto' }}>
                      {suggestions.map((s, k) => (
                        <button key={k} onClick={() => applySuggestion(s)} className="stage-chip tr-sugg-chip" style={{ cursor: 'pointer', flexShrink: 0 }}>
                          <Lightbulb size={11} style={{ color: '#F2C14E' }} /> <TText text={s} lang={language} />
                        </button>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Dock */}
            <div className="dock tr-dock">
              {inCall && (
                <>
                  <CtrlBtn state={isMuted ? 'danger' : undefined} title={isMuted ? 'Unmute mic' : 'Mute mic'} onClick={handleMicToggle}>
                    {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                  </CtrlBtn>
                  {canShareScreen && (
                    <CtrlBtn state={isScreenSharing ? 'on' : undefined} title={isScreenSharing ? 'Stop sharing' : 'Share screen'} onClick={handleScreenShare} className="dock-share">
                      {isScreenSharing ? <MonitorOff size={18} /> : <Monitor size={18} />}
                    </CtrlBtn>
                  )}
                  {inRoom && (
                    <CtrlBtn title="Share meeting link" onClick={() => setShowMeetingModal(true)} className="dock-invite">
                      <Link2 size={18} />
                    </CtrlBtn>
                  )}
                  <span className="dock-sep" />
                </>
              )}
              <CtrlBtn state={!isVideoOn ? 'danger' : undefined} title={isVideoOn ? 'Turn camera off' : 'Turn camera on'} onClick={handleVideoToggle}>
                {isVideoOn ? <Video size={18} /> : <VideoOff size={18} />}
              </CtrlBtn>
              <CtrlBtn state={isAslActive ? 'accent' : undefined} title={isAslActive ? 'Hide ISL captions' : 'Show ISL captions'} onClick={() => setIsAslActive(!isAslActive)}>
                <Sparkles size={18} />
              </CtrlBtn>
              <CtrlBtn state={isSidebarOpen ? 'on' : undefined} title="Transcript panel" onClick={handlePanelToggle} className="dock-panel">
                <PanelRight size={18} />
              </CtrlBtn>
              <CtrlBtn state={isFull ? 'on' : undefined} title={isFull ? 'Exit full screen (F)' : 'Full screen (F)'} onClick={toggleFull} className="dock-full">
                {isFull ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </CtrlBtn>
              {inCall && (
                <>
                  <span className="dock-sep" />
                  <motion.button onClick={handleLeaveRoom} whileTap={{ scale: 0.96 }} className="dock-leave" aria-label="Leave call">
                    <PhoneOff size={16} /> <span className="dock-leave-label">Leave</span>
                  </motion.button>
                </>
              )}
            </div>
          </div>

          {/* PANEL */}
          <AnimatePresence initial={false}>
            {isSidebarOpen && (
              <motion.aside
                initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="tr-panel"
                ref={panelRef}
              >
                {inCall && (
                  <div style={{ padding: '12px 12px 0' }}>
                    <Segmented
                      ariaLabel="Panel"
                      value={sidebarTab}
                      onChange={setSidebarTab}
                      options={[{ value: 'transcript', label: 'Transcript' }, { value: 'chat', label: 'Chat' }]}
                      style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr' }}
                    />
                  </div>
                )}

                <div key={sidebarTab} className="stagger" style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 18, '--stagger': '60ms' }}>
                  {(!inCall || sidebarTab === 'transcript') && (
                    <>
                      {/* Live reading */}
                      <section>
                        <p className="section-label">Live reading</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                          <ConfidenceRing pct={pct} hasHand={hasHand} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <AnimatePresence mode="wait">
                              <motion.p
                                key={hasHand ? prediction.sign : 'none'}
                                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                                transition={{ duration: 0.18 }}
                                style={{ fontFamily: 'var(--font-serif)', fontSize: '1.9rem', lineHeight: 1, color: hasHand ? 'var(--text-primary)' : 'var(--text-ghost)' }}
                              >
                                {hasHand ? prediction.sign : 'No hand'}
                              </motion.p>
                            </AnimatePresence>
                            <p className="mono" style={{ fontSize: '0.66rem', color: 'var(--text-faint)', marginTop: 8 }}>
                              {hasHand ? `${prediction.inference_ms ?? '–'} ms · hold to commit` : 'Show a sign to the camera'}
                            </p>
                            <div style={{ height: 3, borderRadius: 3, background: 'var(--bg-inset)', marginTop: 8, overflow: 'hidden' }}>
                              <motion.div animate={{ width: `${holdPct}%` }} transition={{ duration: 0.2 }} style={{ height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
                            </div>
                          </div>
                        </div>
                      </section>

                      <hr className="hairline" />

                      {/* Sentence */}
                      <section>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <p className="section-label">Your sentence</p>
                          {sentence.length > 0 && <span className="mono" style={{ fontSize: '0.64rem', color: 'var(--text-faint)' }}>{sentence.length} {sentence.length === 1 ? 'word' : 'words'}</span>}
                        </div>
                        {sentence.length > 0 || translatedText ? (
                          <>
                            {sentence.length > 0 && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {sentence.map((s, k) => <WordChip key={`${s.word}-${k}`} word={s.word} index={k} />)}
                              </div>
                            )}
                            {language !== 'en' && translatedText && (
                              <p className="deva" style={{ fontSize: '1.25rem', lineHeight: 1.45, marginTop: 14, color: 'var(--text-primary)' }}>{translatedText}</p>
                            )}
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 16 }}>
                              {[
                                { icon: Copy,    label: 'Copy',  action: handleCopy  },
                                { icon: Save,    label: 'Save',  action: handleSave  },
                                { icon: isSpeaking ? VolumeX : Volume2, label: isSpeaking ? 'Stop' : 'Speak', action: handleSpeak },
                                { icon: RotateCcw, label: 'Reset', action: handleReset },
                              ].map(({ icon: Icon, label, action }) => (
                                <button key={label} onClick={action} className="tr-action">
                                  <Icon size={15} strokeWidth={1.75} />
                                  <span>{label}</span>
                                </button>
                              ))}
                            </div>
                          </>
                        ) : (
                          <p style={{ fontSize: '0.84rem', color: 'var(--text-faint)', lineHeight: 1.6 }}>
                            Words appear here as you sign. Hold each sign until the bar above fills.
                          </p>
                        )}
                      </section>

                      {suggestions.length > 0 && (
                        <section>
                          <p className="section-label">Suggestions</p>
                          <div style={{ display: 'grid', gap: 4 }}>
                            {suggestions.map((s, k) => (
                              <button key={k} onClick={() => applySuggestion(s)} className="tr-suggestion">
                                <TText text={s} lang={language} />
                                <ArrowUpRight size={14} />
                              </button>
                            ))}
                          </div>
                        </section>
                      )}

                      {inCall && peerSentence && (
                        <section className="card" style={{ padding: 14, borderColor: 'var(--blue-border)' }}>
                          <p className="section-label" style={{ color: 'var(--blue)', marginBottom: 8 }}>{peerName || 'Partner'} is signing</p>
                          <TText as="p" text={peerSentence} lang={language} style={{ fontFamily: language === 'en' ? 'var(--font-serif)' : undefined, fontSize: '1.35rem', lineHeight: 1.25 }} />
                        </section>
                      )}
                    </>
                  )}

                  {/* Conversation log */}
                  {(!inCall || sidebarTab === 'chat') && (
                    <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {(!inCall ? chatMessages.length > 0 : true) && <p className="section-label" style={{ margin: 0 }}>Conversation</p>}
                      {inCall && chatMessages.length === 0 && (
                        <p style={{ fontSize: '0.84rem', color: 'var(--text-faint)' }}>No messages yet. Type below, or pick a suggestion to send it.</p>
                      )}
                      {chatMessages.map(msg => {
                        const me = msg.sender === 'Me';
                        return (
                          <motion.div key={msg.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start', gap: 4 }}>
                            <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>
                              {me ? (userName || 'You') : msg.sender} · <span className="mono">{msg.time}</span>
                            </span>
                            <p style={{
                              maxWidth: '88%', padding: '9px 13px', fontSize: '0.86rem', lineHeight: 1.5,
                              borderRadius: me ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                              background: me ? 'var(--accent)' : 'var(--bg-elevated)',
                              color: me ? 'var(--accent-ink)' : 'var(--text-primary)',
                              border: me ? 'none' : '1px solid var(--border)',
                            }}><TText text={msg.text} lang={language} source="auto" /></p>
                          </motion.div>
                        );
                      })}
                    </section>
                  )}
                </div>

                {inCall && sidebarTab === 'chat' && (
                  <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="text" className="input-field" value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSendChat()}
                        placeholder="Message everyone…"
                        enterKeyHint="send"
                        style={{ height: 46, paddingRight: 54 }}
                      />
                      <button onClick={handleSendChat} aria-label="Send" className="btn-primary" style={{ position: 'absolute', right: 4, top: 4, width: 38, height: 38, padding: 0, borderRadius: 10 }}>
                        <Send size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </motion.aside>
            )}
          </AnimatePresence>
        </div>
      )}

      <style>{`
        .tr-root { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
        .tr-toolbar {
          display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
          padding: 14px clamp(12px, 2vw, 20px) 0;
        }
        .tr-body { flex: 1; min-height: 0; display: flex; gap: 12px; padding: 14px clamp(12px, 2vw, 20px) clamp(12px, 2vw, 20px); }
        .tr-stage { flex: 1; min-width: 0; min-height: 420px; display: flex; align-items: center; justify-content: center; }
        .tr-caption {
          /* centred with margins, NOT translateX(-50%): the entry animation writes its own
             transform, which used to drop the centring and push the caption off the stage */
          position: absolute; left: 0; right: 0; margin: 0 auto; bottom: 92px; z-index: 20;
          width: calc(100% - 40px); max-width: 780px; box-sizing: border-box; padding: 18px 22px; border-radius: 20px;
          background: rgba(11,10,9,0.58); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
          border: 1px solid var(--stage-border);
        }
        .tr-panel {
          width: 360px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden;
          background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--r-xl); box-shadow: var(--shadow-sm);
        }
        .tr-action {
          display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 10px 4px; border-radius: 12px;
          background: var(--bg-inset); border: 1px solid var(--border); color: var(--text-secondary);
          font-size: 0.7rem; cursor: pointer; transition: all .2s ease;
        }
        .tr-action:hover { color: var(--accent); border-color: var(--accent-border); background: var(--accent-softer); transform: translateY(-2px); }
        .tr-action { transition: color var(--dur-sm) ease, border-color var(--dur-sm) ease, background var(--dur-sm) ease, transform var(--dur-md) var(--ease-spring) !important; }
        .tr-action:active { transform: scale(0.95); transition-duration: 80ms !important; }
        .tr-action svg { transition: transform var(--dur-md) var(--ease-spring); }
        .tr-action:hover svg { transform: scale(1.15); }
        .tr-suggestion svg { transition: transform var(--dur-md) var(--ease-out), color var(--dur-sm) ease; }
        .tr-suggestion:hover svg { transform: translate(2px, -2px); }
        .tr-lobby-art::after { content: ""; position: absolute; inset: -40%; background: conic-gradient(from 0deg at 70% 80%, transparent, rgba(255,138,76,0.12), transparent 30%); animation: spin 18s linear infinite; pointer-events: none; }
        .tr-lobby-art > * { position: relative; z-index: 1; }
        .tr-suggestion {
          display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left;
          padding: 10px 12px; border-radius: 10px; background: transparent; border: 1px solid transparent;
          color: var(--text-secondary); font-size: 0.86rem; cursor: pointer; transition: all .2s ease;
        }
        .tr-suggestion:hover { background: var(--bg-inset); border-color: var(--border); color: var(--text-primary); }
        .tr-suggestion svg { color: var(--text-faint); flex-shrink: 0; }
        .tr-suggestion:hover svg { color: var(--accent); }
        .tr-lobby-wrap { flex: 1; overflow-y: auto; display: flex; align-items: center; justify-content: center; padding: 24px clamp(12px, 3vw, 32px); }
        .tr-lobby {
          display: grid; grid-template-columns: 1fr 1fr; width: 100%; max-width: 920px; overflow: hidden;
          border-radius: var(--r-xl); border: 1px solid var(--border-hover); background: var(--bg-panel); box-shadow: var(--shadow-lg);
        }
        .tr-lobby-art {
          position: relative; overflow: hidden; padding: 40px; background: var(--stage); min-height: 420px;
          display: flex; flex-direction: column; justify-content: space-between; gap: 32px;
        }
        .tr-lobby-list { list-style: none; margin-top: 28px; display: grid; gap: 12px; color: var(--stage-muted); font-size: 0.86rem; }
        .tr-lobby-list li { display: flex; gap: 10px; align-items: center; }
        .tr-lobby-demo { display: flex; align-items: flex-end; gap: 22px; }
        .tr-lobby-hand { position: relative; flex-shrink: 0; width: 150px; padding: 12px 6px 0; }
        .tr-lobby-hand svg { display: block; position: relative; }
        .tr-lobby-hand-glow {
          position: absolute; left: 50%; top: 55%; width: 190px; height: 190px; transform: translate(-50%, -50%);
          background: radial-gradient(circle, rgba(255,138,76,0.22) 0%, rgba(255,138,76,0.06) 45%, transparent 70%);
          pointer-events: none;
        }
        .tr-lobby-caption {
          flex: 1; min-width: 0; margin-bottom: 14px; padding: 14px 16px; border-radius: 16px;
          background: rgba(243,239,232,0.05); border: 1px solid var(--stage-border);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        }
        .tr-lobby-caption-label {
          display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 0.6rem;
          letter-spacing: 0.16em; text-transform: uppercase; color: var(--stage-muted); margin-bottom: 10px;
        }
        .tr-lobby-caption-body { min-height: 34px; display: flex; align-items: center; }
        .tr-lobby-words { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
        .tr-lobby-word {
          display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border-radius: 8px; font-size: 0.8rem; font-weight: 500;
          color: var(--stage-text); background: rgba(243,239,232,0.08); border: 1px solid var(--stage-border);
        }
        .tr-lobby-word[data-current="true"] { color: #FF8A4C; background: rgba(255,138,76,0.14); border-color: rgba(255,138,76,0.4); }
        .tr-lobby-cursor { width: 2px; height: 18px; background: #FF8A4C; border-radius: 2px; animation: hc-blink-lobby 1s steps(2) infinite; }
        @keyframes hc-blink-lobby { 50% { opacity: 0; } }
        .tr-lobby-sentence { font-family: var(--font-serif); font-size: 1.45rem; line-height: 1.15; color: var(--stage-text); }
        .tr-lobby-form { padding: 40px; display: flex; flex-direction: column; gap: 20px; justify-content: center; }
        /* ── Stage furniture ─────────────────────────────────────────────── */
        .tr-dock { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 30; max-width: calc(100% - 16px); }
        .dock-sep { width: 1px; height: 26px; background: var(--stage-border); margin: 0 4px; flex-shrink: 0; }
        .dock-btn { flex-shrink: 0; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
        .dock-leave {
          display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 16px; border-radius: 14px; flex-shrink: 0;
          background: #E5483B; color: #fff; border: none; cursor: pointer; font-weight: 500; font-size: 0.84rem;
          touch-action: manipulation; -webkit-tap-highlight-color: transparent;
        }
        .tr-chips { position: absolute; top: 16px; left: 52px; right: 16px; display: flex; gap: 8px; z-index: 12; flex-wrap: wrap; pointer-events: none; }
        .tr-chips > * { pointer-events: auto; }
        .tr-chips[data-call="true"] { left: 16px; right: 200px; }
        .tr-pip {
          position: absolute; top: 16px; right: 16px; width: 168px; aspect-ratio: 3 / 4; z-index: 20;
          background: #161513; border-radius: 16px; overflow: hidden; border: 1px solid rgba(243,239,232,0.22);
          box-shadow: 0 16px 40px -8px rgba(0,0,0,0.7); cursor: grab; touch-action: none;
        }
        .vgrid { position: absolute; inset: 10px; display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr); }
        .vgrid[data-count="1"] { inset: 0; grid-template-columns: 1fr; }
        .vgrid[data-count="5"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .vgrid-pinned { position: absolute; inset: 10px; display: flex; gap: 10px; }
        .vgrid-main { flex: 1; min-width: 0; min-height: 0; }
        .vgrid-strip { display: flex; flex-direction: column; gap: 10px; width: 200px; flex-shrink: 0; }
        .vgrid-strip-item { flex: 1; min-height: 0; }
        .vtile-video { width: 100%; height: 100%; object-fit: cover; transition: opacity .2s ease; }
        .tr-sugg-chip { min-height: 30px; }

        /* ── Full-screen focus mode ───────────────────────────────────────── */
        html.tr-fullscreen .app-main { z-index: 60; }            /* above the sidebar rail */
        html.tr-fullscreen .app-scroll { overflow: hidden; }
        .tr-stage-full {
          position: fixed !important; inset: 0; z-index: 1000; width: 100vw; height: 100vh; height: 100dvh;
          min-height: 0 !important; border-radius: 0 !important; border: 0 !important; box-shadow: none !important;
        }
        .tr-stage-full.viewfinder::before, .tr-stage-full.viewfinder::after { display: none; }
        .tr-stage-full .dock-panel, .tr-stage-full .dock-share, .tr-stage-full .dock-invite { display: none !important; }
        .tr-stage-full .tr-dock { bottom: max(16px, env(safe-area-inset-bottom)); }
        .tr-stage-full .tr-caption { bottom: calc(max(16px, env(safe-area-inset-bottom)) + 76px); max-width: 900px; }
        .tr-stage-full .tr-chips { top: max(16px, env(safe-area-inset-top)); left: 16px; }
        .tr-stage-full .tr-pip { top: max(16px, env(safe-area-inset-top)); }
        .tr-stage-full .tr-dock, .tr-stage-full .tr-chips { transition: opacity .35s ease, transform .35s ease; }
        .tr-stage-full[data-idle="true"] { cursor: none; }
        .tr-stage-full[data-idle="true"] .tr-dock { opacity: 0; pointer-events: none; transform: translateX(-50%) translateY(12px); }
        .tr-stage-full[data-idle="true"] .tr-chips { opacity: 0; pointer-events: none; }
        .tr-stage-full[data-idle="true"] .tr-fs-peer { top: max(16px, env(safe-area-inset-top)); }
        .tr-stage-full[data-idle="true"] .tr-caption { bottom: max(20px, env(safe-area-inset-bottom)); transition: bottom .35s ease; }
        .tr-fs-peer {
          position: absolute; top: calc(max(16px, env(safe-area-inset-top)) + 40px); left: 16px; z-index: 25;
          width: min(560px, calc(100% - 220px)); display: grid; gap: 8px; pointer-events: none; transition: top .35s ease;
        }
        .tr-fs-bubble {
          display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-radius: 14px;
          background: rgba(11,10,9,0.62); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
          border: 1px solid var(--stage-border); color: #F3EFE8;
        }
        .tr-fs-chat { align-items: center; border-color: rgba(138,180,255,0.35); }
        .tr-fs-chat svg { color: #8AB4FF; flex-shrink: 0; }
        .tr-fs-who { font-size: 0.66rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--stage-muted); }
        .tr-fs-text { font-family: var(--font-serif); font-size: 1.2rem; line-height: 1.2; }
        @media (max-width: 640px) {
          .tr-fs-peer { width: calc(100% - 120px); left: 12px; top: 48px; }
          .tr-fs-text { font-size: 1rem; }
        }

        /* ── Lobby preview + pre-call toggles ────────────────────────────── */
        .tr-preview { position: relative; aspect-ratio: 16 / 10; border-radius: 16px; overflow: hidden; background: var(--stage); border: 1px solid var(--border-hover); }
        .tr-preview-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); transition: opacity .2s ease; }
        .tr-preview-off { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--stage-muted); font-size: 0.8rem; text-align: center; padding: 0 16px 48px; }
        .tr-preview-ctrls { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); display: flex; gap: 10px; }
        .tr-pre-btn {
          width: 46px; height: 46px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
          border: 1px solid rgba(243,239,232,0.25); background: rgba(20,19,17,0.72); color: #F3EFE8; cursor: pointer;
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); touch-action: manipulation; -webkit-tap-highlight-color: transparent;
          transition: background .2s ease, color .2s ease, transform .15s ease;
        }
        .tr-pre-btn:hover { background: rgba(255,255,255,0.16); }
        .tr-pre-btn:active { transform: scale(0.94); }
        .tr-pre-btn[data-off="true"] { background: #E5483B; border-color: #E5483B; color: #fff; }
        .tr-pre-status { margin-top: -10px; font-size: 0.76rem; color: var(--text-faint); text-align: center; }
        .tr-pre-status b { font-weight: 600; color: var(--green); }
        .tr-pre-status b[data-off="true"] { color: var(--red); }
        .tr-newcode { padding: 6px 2px; margin: -6px 0; min-height: 32px; }
        .spin { animation: spin 0.9s linear infinite; }
        .btn-primary:disabled { opacity: 0.7; cursor: progress; }

        /* Desktop: the whole lobby card fits in the viewport without scrolling */
        @media (min-width: 1001px) {
          .tr-lobby-wrap { padding-top: 16px; padding-bottom: 16px; }
          .tr-lobby-form { padding: 32px 36px; gap: 16px; }
          .tr-lobby-art { padding: 36px; min-height: 0; }
          .tr-preview { aspect-ratio: auto; height: clamp(140px, calc(100dvh - 600px), 240px); }
          .tr-lobby-form .input-field { height: 44px !important; }
          .tr-lobby-form input.mono { height: 50px !important; }
          .tr-lobby-form h3 { font-size: 1.8rem !important; }
        }
        @media (min-width: 1001px) and (max-height: 760px) {
          .tr-lobby-form { padding-top: 26px; padding-bottom: 24px; gap: 14px; }
          .tr-lobby-list { margin-top: 18px; gap: 8px; }
          .tr-lobby-hand { width: 120px; }
          .tr-lobby-hand svg { width: 120px; height: 132px; }
        }
        @media (max-width: 1000px) {
          .tr-root { overflow-y: auto; height: auto; }
          .tr-body { flex-direction: column; }
          .tr-stage { min-height: min(68vh, 680px); min-height: min(68dvh, 680px); }
          .tr-panel { width: 100%; max-height: none; scroll-margin-top: 64px; }
          .tr-lobby { grid-template-columns: 1fr; }
          .tr-lobby-art { min-height: 0; }
          .tr-lobby-demo { max-width: 520px; }
          .tr-preview { max-height: 300px; width: 100%; }
        }
        /* Tablets: headline + features on the left, hand on the right — a compact banner */
        @media (min-width: 641px) and (max-width: 1000px) {
          .tr-lobby-art { flex-direction: row; align-items: center; justify-content: space-between; padding: 32px 36px; }
          .tr-lobby-caption { display: none; }
          .tr-lobby-demo { flex-shrink: 0; }
        }
        @media (max-width: 640px) {
          .tr-hide-sm { display: none !important; }
          .tr-toolbar h1 { font-size: 1.6rem !important; }
          .tr-body { padding: 10px 10px 14px; gap: 10px; }
          .tr-stage { min-height: calc(100dvh - 190px); border-radius: 20px; }
          .tr-caption { bottom: 76px; padding: 12px 14px; width: calc(100% - 20px); }
          .tr-lobby-wrap { padding: 12px 10px 24px; align-items: flex-start; }
          .tr-lobby-art { min-height: 0; padding: 22px 22px 20px; }
          .tr-lobby-art h2 { font-size: 1.9rem !important; margin-top: 10px !important; }
          .tr-lobby-list, .tr-lobby-demo { display: none !important; }
          .tr-lobby-form { padding: 20px; gap: 16px; }
          .tr-dock { bottom: 10px; }
          .dock { gap: 4px !important; padding: 5px !important; border-radius: 18px !important; }
          .dock-btn { width: 42px !important; height: 42px !important; border-radius: 12px !important; }
          .dock-sep { margin: 0 1px; }
          .dock-leave { width: 42px; height: 42px; padding: 0; justify-content: center; border-radius: 12px; }
          .dock-leave-label { display: none; }
          .tr-chips { top: 10px; left: 12px; right: 12px; gap: 6px; }
          .tr-chips[data-call="true"] { right: 112px; }
          .tr-chips .stage-chip { height: 28px; font-size: 0.68rem; padding: 0 0.6rem; }
          .tr-pip { width: 92px; top: 10px; right: 10px; border-radius: 12px; }
          .vgrid, .vgrid-pinned { inset: 6px; gap: 6px; }
          .vgrid[data-count="1"] { inset: 0; }
          .vtile-video { object-fit: contain; background: #0B0A09; }
          .vtile-name { bottom: 8px !important; left: 8px !important; }
          .vgrid-pinned { flex-direction: column; }
          .vgrid-strip { flex-direction: row; width: auto; height: 96px; }
        }
        /* Very small phones (≈320–360px): keep every control on screen at ≥40px */
        @media (max-width: 360px) {
          .dock { gap: 3px !important; padding: 4px !important; }
          .dock-sep { display: none; }
          .dock-invite { display: none !important; } /* invite link stays on the waiting screen + modal */
          .dock-btn, .dock-leave { width: 40px !important; height: 40px !important; }
          .tr-pip { width: 78px; }
          .tr-chips[data-call="true"] { right: 96px; }
        }
        /* Portrait phones: stack two people vertically instead of two thin columns */
        @media (max-width: 640px) and (orientation: portrait) {
          .vgrid[data-count="2"] { grid-template-columns: 1fr; }
          .vgrid[data-count="5"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        /* Landscape phones: give the video the full height */
        @media (max-height: 520px) and (orientation: landscape) {
          .tr-toolbar { padding-top: 8px; }
          .tr-toolbar h1 { font-size: 1.4rem !important; }
          .tr-body { padding: 8px 10px 10px; }
          .tr-stage { min-height: calc(100dvh - 72px); }
          .tr-caption { bottom: 70px; max-width: 70%; padding: 10px 14px; }
          .tr-caption p { font-size: 1.25rem !important; }
          .tr-pip { width: 86px; aspect-ratio: 4 / 3; top: 10px; right: 10px; }
          .tr-chips[data-call="true"] { right: 110px; }
          .tr-dock { bottom: 8px; }
          .dock-btn { width: 40px !important; height: 40px !important; }
          .dock-leave { height: 40px; }
          .vtile-video { object-fit: contain; background: #0B0A09; }
        }
        @media (pointer: coarse) {
          .tr-sugg-chip { min-height: 36px; }
          .tr-action { min-height: 56px; }
          .tr-suggestion { min-height: 44px; }
        }
      `}</style>
    </div>
  );
}

function CtrlBtn({ children, onClick, title, state, className = '' }) {
  return (
    <button onClick={onClick} data-tip={title} aria-label={title} aria-pressed={state === 'on' || state === 'accent' ? true : undefined} className={`dock-btn ${className}`} data-state={state}>
      {children}
    </button>
  );
}
