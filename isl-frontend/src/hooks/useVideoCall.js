/**
 * useVideoCall.js — WebRTC mesh hook for N-user ISL video call (up to 6).
 * v7 — production hardening for Render + Vercel.
 *
 *  • Wakes the (possibly sleeping) Render backend before opening sockets and
 *    fails loudly if the backend has no WebSocket support.
 *  • Fetches TURN credentials from the backend (/turn-credentials).
 *  • Signaling messages are processed strictly in order (async queue) — no more
 *    offer/answer/ICE races.
 *  • Deterministic roles: the newcomer offers, existing peers answer. The
 *    offerer performs ICE restarts on failure (restartIce() alone does nothing
 *    without renegotiation).
 *  • Receives media even when the local camera/mic is missing (recvonly transceivers).
 *  • Names are kept per peer id, independent of the order the two sockets deliver.
 *  • Keepalive + dead-socket detection on both sockets, automatic re-join with backoff.
 *
 * Exported state:
 *   status        — 'idle' | 'connecting' | 'waiting' | 'connected' | 'full' | 'error'
 *   error         — human-readable error string (or null)
 *   turnConfigured— whether the backend served real (non-public-fallback) TURN creds
 *   myId          — this user's server-assigned UUID
 *   remotePeers   — Map<peerId, { stream: MediaStream|null, name: string, state: string }>
 *   peerSentence / peerWord / peerSuggestion / peerName / peerChat
 *
 * Exported actions:
 *   joinRoom(roomId, localStream, userName)
 *   leaveRoom()
 *   sendTranslation(word, sentence)
 *   sendSuggestion(text)
 *   sendChatMessage(text)  → boolean (false if the chat socket is not open)
 *   replaceVideoTrack(newTrack)
 *   setLocalMedia({ video, audio }) — tell peers our camera/mic are on/off
 */

import { useRef, useState, useCallback, useEffect } from "react";

// ── HTTP and WebSocket base URLs ──────────────────────────────────────────────
const getHttpBase = () => {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl) return apiUrl.trim().replace(/\/+$/, "");
  return ""; // relative → Vite dev proxy
};

const getWsBase = () => {
  const httpBase = getHttpBase();
  if (httpBase) return httpBase.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
};

// ── Fallback ICE servers (only if /turn-credentials is unreachable) ──────────
const FALLBACK_ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
      "turns:openrelay.metered.ca:443",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

const KEEPALIVE_MS        = 20000;  // ping both sockets
const DEAD_SOCKET_MS      = 50000;  // no pong for this long → treat socket as dead
const DISCONNECT_GRACE_MS = 5000;   // 'disconnected' often self-heals; wait before restarting ICE
const MAX_REJOIN_ATTEMPTS = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchWithTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal, cache: "no-store" }).finally(() => clearTimeout(t));
}

/** Render free tier sleeps after ~15 min idle and takes ~30-60 s to wake. */
async function wakeBackend(isCancelled, maxWaitMs = 90000) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < maxWaitMs) {
    if (isCancelled()) return null;
    try {
      const res = await fetchWithTimeout(`${getHttpBase()}/health`, 15000);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(2500);
  }
  throw new Error(`Backend unreachable (${lastErr?.message || "timeout"})`);
}

async function fetchIceServers() {
  try {
    const res = await fetchWithTimeout(`${getHttpBase()}/turn-credentials`, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      console.log(`[WebRTC] ICE servers from backend (${data.source}):`, data.iceServers.length, "entries");
      if (!data.turnConfigured) {
        console.warn("[WebRTC] Backend has no TURN configured — calls across different networks may fail.");
      }
      return { servers: data.iceServers, turnConfigured: !!data.turnConfigured };
    }
  } catch (err) {
    console.warn("[WebRTC] Could not fetch TURN credentials, using fallback:", err.message);
  }
  return { servers: FALLBACK_ICE_SERVERS, turnConfigured: false };
}

/** Open a WebSocket; handlers are attached BEFORE open so no early message is lost. */
function openSocket(url, { onMessage, onClose }, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`WebSocket timeout: ${url}`));
    }, timeoutMs);

    ws.onmessage = onMessage;
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.lastPong = Date.now();
      resolve(ws);
    };
    ws.onerror = () => { /* the close event carries the useful info */ };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket closed before open (code ${ev.code}): ${url}`));
        return;
      }
      onClose?.(ev);
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export function useVideoCall() {
  const localStreamRef       = useRef(null);
  const signalWsRef          = useRef(null);
  const chatWsRef            = useRef(null);
  const myIdRef              = useRef(null);
  const myNameRef            = useRef("User");
  const roomRef              = useRef(null);       // active room id, null when not in a call
  const sessionRef           = useRef(0);          // bumps on every (re)join → stale callbacks bail out
  const keepaliveTimerRef    = useRef(null);
  const rejoinAttemptsRef    = useRef(0);
  const rejoinTimerRef       = useRef(null);
  const chatRetryTimerRef    = useRef(null);
  const iceServersRef        = useRef(FALLBACK_ICE_SERVERS);
  const signalQueueRef       = useRef(Promise.resolve());
  // Map<peerId, { pc, stream, name, isOfferer, disconnectTimer }>
  const peersRef             = useRef(new Map());
  const pendingCandidatesRef = useRef(new Map());  // Map<peerId, RTCIceCandidateInit[]>
  const namesRef             = useRef(new Map());  // Map<peerId, displayName>
  const mediaRef             = useRef(new Map());  // Map<peerId, { video, audio }>
  const localMediaRef        = useRef({ video: true, audio: true });

  const [status,         setStatus]         = useState("idle");
  const [error,          setError]          = useState(null);
  const [turnConfigured, setTurnConfigured] = useState(null);
  const [myId,           setMyId]           = useState(null);
  const [remotePeers,    setRemotePeers]    = useState(new Map());
  const [peerSentence,   setPeerSentence]   = useState("");
  const [peerWord,       setPeerWord]       = useState("");
  const [peerSuggestion, setPeerSuggestion] = useState("");
  const [peerName,       setPeerName]       = useState("");
  const [peerChat,       setPeerChat]       = useState(null);

  // ── Derived status + React sync ─────────────────────────────────────────────
  const syncPeers = useCallback(() => {
    const peers = peersRef.current;
    setRemotePeers(new Map(
      [...peers.entries()].map(([id, p]) => {
        const media = mediaRef.current.get(id) || { video: true, audio: true };
        return [id, { stream: p.stream, name: p.name, state: p.pc.connectionState, videoOff: media.video === false, audioOff: media.audio === false }];
      })
    ));
    const first = peers.values().next().value;
    setPeerName(first?.name || "");

    if (!roomRef.current || !myIdRef.current) return;
    const states = [...peers.values()].map((p) => p.pc.connectionState);
    if (states.includes("connected")) setStatus("connected");
    else if (peers.size === 0) setStatus("waiting");
    else setStatus("connecting");
  }, []);

  const sendSignal = useCallback((payload) => {
    const ws = signalWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const sendChatRaw = useCallback((payload) => {
    const ws = chatWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const announceName = useCallback((isReply = false) => {
    if (!myIdRef.current) return;
    sendChatRaw({ type: "name", name: myNameRef.current, peer_id: myIdRef.current, isReply, media: localMediaRef.current });
  }, [sendChatRaw]);

  // ── Peer lifecycle ──────────────────────────────────────────────────────────
  const closePeer = useCallback((peerId) => {
    const entry = peersRef.current.get(peerId);
    if (entry) {
      clearTimeout(entry.disconnectTimer);
      try { entry.pc.close(); } catch { /* ignore */ }
      peersRef.current.delete(peerId);
    }
    pendingCandidatesRef.current.delete(peerId);
  }, []);

  /** Close sockets + peer connections but keep the "we are in room X" intent. */
  const teardownConnections = useCallback(() => {
    clearInterval(keepaliveTimerRef.current);
    keepaliveTimerRef.current = null;
    clearTimeout(chatRetryTimerRef.current);
    for (const id of [...peersRef.current.keys()]) closePeer(id);
    pendingCandidatesRef.current.clear();
    signalQueueRef.current = Promise.resolve();
    for (const ref of [signalWsRef, chatWsRef]) {
      const ws = ref.current;
      ref.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "leave" }));
          ws.close(1000, "leave");
        } catch { /* ignore */ }
      }
    }
    myIdRef.current = null;
  }, [closePeer]);

  const cleanup = useCallback(() => {
    sessionRef.current += 1;
    roomRef.current = null;
    clearTimeout(rejoinTimerRef.current);
    rejoinAttemptsRef.current = 0;
    teardownConnections();
    namesRef.current.clear();
    mediaRef.current.clear();
    setMyId(null);
    setRemotePeers(new Map());
    setStatus("idle");
    setPeerSentence("");
    setPeerWord("");
    setPeerSuggestion("");
    setPeerName("");
    setPeerChat(null);
  }, [teardownConnections]);

  const flushPendingCandidates = useCallback(async (peerId, pc) => {
    const buffered = pendingCandidatesRef.current.get(peerId) || [];
    pendingCandidatesRef.current.delete(peerId);
    for (const c of buffered) {
      try { await pc.addIceCandidate(c); } catch (e) { console.warn("[WebRTC] buffered ICE rejected", e.message); }
    }
  }, []);

  const makeOffer = useCallback(async (peerId, { iceRestart = false } = {}) => {
    const entry = peersRef.current.get(peerId);
    if (!entry) return;
    const { pc } = entry;
    if (pc.signalingState !== "stable") return; // an offer is already in flight
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    sendSignal({ type: "offer", to_id: peerId, sdp: pc.localDescription });
    console.log(`[WebRTC] offer → ${peerId.slice(0, 8)}${iceRestart ? " (ICE restart)" : ""}`);
  }, [sendSignal]);

  const createPeerConnection = useCallback((peerId, isOfferer) => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing.pc;

    const pc = new RTCPeerConnection({
      iceServers: iceServersRef.current,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });

    // Local media — and recvonly transceivers for anything we don't send,
    // otherwise the SDP has no m-line for it and we'd never receive it either.
    const stream = localStreamRef.current;
    const tracks = stream ? stream.getTracks() : [];
    tracks.forEach((t) => pc.addTrack(t, stream));
    if (!tracks.some((t) => t.kind === "audio")) pc.addTransceiver("audio", { direction: "recvonly" });
    if (!tracks.some((t) => t.kind === "video")) pc.addTransceiver("video", { direction: "recvonly" });

    const entry = {
      pc,
      stream: null,
      name: namesRef.current.get(peerId) || "",
      isOfferer,
      disconnectTimer: null,
    };
    peersRef.current.set(peerId, entry);

    pc.ontrack = (e) => {
      const cur = peersRef.current.get(peerId);
      if (!cur) return;
      const tracksNow = cur.stream ? cur.stream.getTracks() : [];
      if (!tracksNow.some((t) => t.id === e.track.id)) tracksNow.push(e.track);
      // New MediaStream object → <video> effect re-runs and re-attaches (Safari-safe)
      cur.stream = new MediaStream(tracksNow);
      e.track.onunmute = () => syncPeers();
      syncPeers();
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ type: "ice", to_id: peerId, candidate: e.candidate.toJSON() });
      }
    };

    pc.onicecandidateerror = (e) => {
      // 701 = STUN/TURN host unreachable; noisy but useful when TURN is misconfigured
      if (e.errorCode && e.errorCode !== 701) {
        console.warn(`[WebRTC] ICE candidate error ${e.errorCode} ${e.url || ""} ${e.errorText || ""}`);
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log(`[WebRTC] peer=${peerId.slice(0, 8)} connectionState=${s}`);
      const cur = peersRef.current.get(peerId);
      if (!cur) return;
      clearTimeout(cur.disconnectTimer);

      if (s === "failed" && cur.isOfferer) {
        makeOffer(peerId, { iceRestart: true }).catch((err) => console.warn("[WebRTC] ICE restart failed", err));
      } else if (s === "disconnected" && cur.isOfferer) {
        cur.disconnectTimer = setTimeout(() => {
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            makeOffer(peerId, { iceRestart: true }).catch(() => {});
          }
        }, DISCONNECT_GRACE_MS);
      }
      syncPeers();
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] peer=${peerId.slice(0, 8)} iceConnectionState=${pc.iceConnectionState}`);
    };

    return pc;
  }, [makeOffer, sendSignal, syncPeers]);

  // ── Signaling message handler (always run through the queue) ────────────────
  const handleSignal = useCallback(async (msg) => {
    switch (msg.type) {
      case "pong":
        break;

      case "joined": {
        myIdRef.current = msg.peer_id;
        setMyId(msg.peer_id);
        rejoinAttemptsRef.current = 0;
        setError(null);
        announceName(false);
        const existing = Array.isArray(msg.existing_peers) ? msg.existing_peers : [];
        console.log(`[Signal] joined as ${msg.peer_id.slice(0, 8)}, ${existing.length} peer(s) already in room`);
        // We are the newcomer → we send offers to everyone already present
        for (const existingId of existing) {
          createPeerConnection(existingId, true);
          try { await makeOffer(existingId); } catch (e) { console.error("[WebRTC] offer failed", e); }
        }
        syncPeers();
        break;
      }

      case "peer_joined": {
        console.log(`[Signal] peer_joined ${msg.peer_id.slice(0, 8)}`);
        createPeerConnection(msg.peer_id, false); // they will send us an offer
        announceName(false);
        syncPeers();
        break;
      }

      case "offer": {
        const fromId = msg.from_id;
        if (!fromId || !msg.sdp) break;
        const pc = createPeerConnection(fromId, false);
        if (pc.signalingState !== "stable") {
          // Glare (both sides restarting ICE at once): the peer with the larger id yields
          const polite = (myIdRef.current || "") > fromId;
          if (!polite) break;
          await pc.setLocalDescription({ type: "rollback" });
        }
        await pc.setRemoteDescription(msg.sdp);
        await flushPendingCandidates(fromId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ type: "answer", to_id: fromId, sdp: pc.localDescription });
        syncPeers();
        break;
      }

      case "answer": {
        const fromId = msg.from_id;
        const pc = peersRef.current.get(fromId)?.pc;
        if (!pc || !msg.sdp || pc.signalingState !== "have-local-offer") break;
        await pc.setRemoteDescription(msg.sdp);
        await flushPendingCandidates(fromId, pc);
        break;
      }

      case "ice": {
        const fromId = msg.from_id;
        if (!fromId || !msg.candidate) break;
        const pc = peersRef.current.get(fromId)?.pc;
        if (!pc || !pc.remoteDescription) {
          const buf = pendingCandidatesRef.current.get(fromId) || [];
          buf.push(msg.candidate);
          pendingCandidatesRef.current.set(fromId, buf);
          break;
        }
        try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn("[WebRTC] ICE rejected", e.message); }
        break;
      }

      case "peer_left": {
        console.log(`[Signal] peer_left ${msg.peer_id?.slice(0, 8)}`);
        closePeer(msg.peer_id);
        syncPeers();
        break;
      }

      case "full": {
        setError("This room is full (max 6 people).");
        const s = sessionRef.current;
        cleanup();
        if (sessionRef.current === s + 1) setStatus("full");
        break;
      }

      case "error": {
        setError(msg.detail === "invalid_room" ? "Invalid room code." : `Server error: ${msg.detail}`);
        break;
      }

      default:
        break;
    }
  }, [announceName, cleanup, closePeer, createPeerConnection, flushPendingCandidates, makeOffer, sendSignal, syncPeers]);

  const enqueueSignal = useCallback((msg) => {
    signalQueueRef.current = signalQueueRef.current
      .then(() => handleSignal(msg))
      .catch((e) => console.error("[Signal] handler error", msg.type, e));
  }, [handleSignal]);

  // ── Chat message handler ────────────────────────────────────────────────────
  const handleChat = useCallback((e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "pong") {
      if (chatWsRef.current) chatWsRef.current.lastPong = Date.now();
      return;
    }
    if (msg.peer_id && msg.peer_id === myIdRef.current) return;

    switch (msg.type) {
      case "name": {
        if (!msg.peer_id) break;
        namesRef.current.set(msg.peer_id, msg.name || "Partner");
        if (msg.media) mediaRef.current.set(msg.peer_id, { video: msg.media.video !== false, audio: msg.media.audio !== false });
        const entry = peersRef.current.get(msg.peer_id);
        if (entry) entry.name = msg.name || "Partner";
        syncPeers();
        if (!msg.isReply) announceName(true);
        break;
      }
      case "media":
        if (!msg.peer_id) break;
        mediaRef.current.set(msg.peer_id, { video: msg.video !== false, audio: msg.audio !== false });
        syncPeers();
        break;
      case "translation":
        if (msg.sentence !== undefined) setPeerSentence(msg.sentence);
        if (msg.word !== undefined) setPeerWord(msg.word);
        break;
      case "suggestion":
        setPeerSuggestion(msg.text || "");
        setTimeout(() => setPeerSuggestion(""), 7000);
        break;
      case "chat":
        setPeerChat({
          text: msg.text,
          sender: msg.name || namesRef.current.get(msg.peer_id) || "Partner",
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        });
        break;
      default:
        break;
    }
  }, [announceName, syncPeers]);

  // ── Socket connection / reconnection ────────────────────────────────────────
  const connectRef = useRef(null);

  const scheduleRejoin = useCallback((reason) => {
    const roomId = roomRef.current;
    if (!roomId) return;
    const attempt = rejoinAttemptsRef.current + 1;
    rejoinAttemptsRef.current = attempt;
    teardownConnections();
    sessionRef.current += 1;
    const session = sessionRef.current;

    if (attempt > MAX_REJOIN_ATTEMPTS) {
      console.error("[Signal] giving up reconnecting:", reason);
      setError("Lost connection to the call server. Please rejoin.");
      setStatus("error");
      setRemotePeers(new Map());
      return;
    }
    const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
    console.warn(`[Signal] ${reason} — rejoining in ${delay} ms (attempt ${attempt})`);
    setStatus("connecting");
    setRemotePeers(new Map());
    rejoinTimerRef.current = setTimeout(() => {
      if (sessionRef.current === session && roomRef.current === roomId) connectRef.current?.(roomId, session);
    }, delay);
  }, [teardownConnections]);

  const openChat = useCallback(async (roomId, session) => {
    try {
      const ws = await openSocket(`${getWsBase()}/ws/chat/${encodeURIComponent(roomId)}`, {
        onMessage: handleChat,
        onClose: (ev) => {
          if (sessionRef.current !== session || !roomRef.current) return;
          console.warn(`[Chat WS] closed code=${ev.code} — reopening`);
          chatWsRef.current = null;
          chatRetryTimerRef.current = setTimeout(() => openChat(roomId, session), 2000);
        },
      });
      if (sessionRef.current !== session) { ws.onclose = null; ws.close(); return; }
      chatWsRef.current = ws;
      announceName(false);
    } catch (e) {
      if (sessionRef.current !== session || !roomRef.current) return;
      console.warn("[Chat WS] open failed:", e.message);
      chatRetryTimerRef.current = setTimeout(() => openChat(roomId, session), 3000);
    }
  }, [announceName, handleChat]);

  const connect = useCallback(async (roomId, session) => {
    try {
      const ws = await openSocket(`${getWsBase()}/ws/signal/${encodeURIComponent(roomId)}`, {
        onMessage: (e) => {
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }
          if (msg.type === "pong") { ws.lastPong = Date.now(); return; }
          if (sessionRef.current === session) enqueueSignal(msg);
        },
        onClose: (ev) => {
          console.warn(`[Signal WS] closed code=${ev.code} reason=${ev.reason || "-"}`);
          if (sessionRef.current !== session || !roomRef.current) return;
          if (ev.code === 4403 || ev.code === 4400) return; // full / invalid — handled via message
          scheduleRejoin(`signal socket closed (${ev.code})`);
        },
      });
      if (sessionRef.current !== session) { ws.onclose = null; ws.close(); return; }
      signalWsRef.current = ws;
      openChat(roomId, session);

      clearInterval(keepaliveTimerRef.current);
      keepaliveTimerRef.current = setInterval(() => {
        const now = Date.now();
        const sig = signalWsRef.current;
        if (sig && sig.readyState === WebSocket.OPEN) {
          if (now - (sig.lastPong || now) > DEAD_SOCKET_MS) {
            console.warn("[Signal WS] no pong — forcing reconnect");
            try { sig.close(4000, "dead"); } catch { /* ignore */ }
            return;
          }
          sig.send(JSON.stringify({ type: "ping", t: now }));
        }
        const chat = chatWsRef.current;
        if (chat && chat.readyState === WebSocket.OPEN) {
          if (now - (chat.lastPong || now) > DEAD_SOCKET_MS) {
            try { chat.close(4000, "dead"); } catch { /* ignore */ }
          } else {
            chat.send(JSON.stringify({ type: "ping" }));
          }
        }
      }, KEEPALIVE_MS);
    } catch (e) {
      if (sessionRef.current !== session || !roomRef.current) return;
      scheduleRejoin(e.message);
    }
  }, [enqueueSignal, openChat, scheduleRejoin]);

  connectRef.current = connect;

  // ── Join a room ─────────────────────────────────────────────────────────────
  const joinRoom = useCallback(async (roomId, localStream, userName) => {
    cleanup();
    const session = sessionRef.current;
    const room = String(roomId || "").trim().toUpperCase();
    roomRef.current = room;
    localStreamRef.current = localStream || null;
    myNameRef.current = (userName || "").trim() || "User";
    setError(null);
    setStatus("connecting");

    try {
      const health = await wakeBackend(() => sessionRef.current !== session);
      if (sessionRef.current !== session) return;
      if (health && health.websocket_support === false) {
        throw new Error("Backend is running without WebSocket support (install uvicorn[standard]).");
      }
      if (health && health.signaling !== true) {
        console.warn("[Signal] /health does not report signaling — backend may be an old deployment.");
      }
      const { servers, turnConfigured: hasTurn } = await fetchIceServers();
      if (sessionRef.current !== session) return;
      iceServersRef.current = servers;
      setTurnConfigured(hasTurn);
      await connect(room, session);
    } catch (e) {
      if (sessionRef.current !== session) return;
      console.error("[Call] join failed:", e);
      setError(e.message || "Could not join the call.");
      setStatus("error");
    }
  }, [cleanup, connect]);

  const leaveRoom = useCallback(() => cleanup(), [cleanup]);

  // ── Screen share: swap the outgoing video track on every connection ─────────
  const replaceVideoTrack = useCallback((newTrack) => {
    for (const { pc } of peersRef.current.values()) {
      const sender =
        pc.getSenders().find((s) => s.track?.kind === "video") ||
        pc.getTransceivers().find((t) => t.receiver.track?.kind === "video")?.sender;
      if (sender) sender.replaceTrack(newTrack).catch((e) => console.warn("[WebRTC] replaceTrack", e));
    }
  }, []);

  // ── Chat / translation senders ──────────────────────────────────────────────
  const sendTranslation = useCallback((word, sentence) =>
    sendChatRaw({ type: "translation", peer_id: myIdRef.current, word, sentence }), [sendChatRaw]);

  const sendSuggestion = useCallback((text) =>
    sendChatRaw({ type: "suggestion", peer_id: myIdRef.current, text }), [sendChatRaw]);

  const setLocalMedia = useCallback(({ video, audio }) => {
    localMediaRef.current = {
      video: video ?? localMediaRef.current.video,
      audio: audio ?? localMediaRef.current.audio,
    };
    if (myIdRef.current) sendChatRaw({ type: "media", peer_id: myIdRef.current, ...localMediaRef.current });
  }, [sendChatRaw]);

  const sendChatMessage = useCallback((text) =>
    sendChatRaw({ type: "chat", peer_id: myIdRef.current, name: myNameRef.current, text }), [sendChatRaw]);

  // Close sockets on tab close so the other side gets peer_left immediately
  useEffect(() => {
    const onUnload = () => teardownConnections();
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [teardownConnections]);

  useEffect(() => () => cleanup(), [cleanup]);

  return {
    status,
    error,
    turnConfigured,
    myId,
    remotePeers,
    peerSentence,
    peerWord,
    peerSuggestion,
    peerName,
    peerChat,
    joinRoom,
    leaveRoom,
    replaceVideoTrack,
    setLocalMedia,
    sendTranslation,
    sendSuggestion,
    sendChatMessage,
  };
}
