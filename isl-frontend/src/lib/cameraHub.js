/**
 * cameraHub.js — one camera, many consumers.
 *
 * Mobile browsers (iOS Safari in particular, many Android devices too) allow
 * only ONE active camera capture per page: a second getUserMedia() call mutes
 * or ends the first stream. The translator webcam (useWebcam) and the
 * Hands-Off cursor (useHandCursor) both need frames, so whoever owns the
 * "real" camera stream publishes it here and the other side reads frames from
 * the same track instead of opening the camera again.
 */

let current = null
const listeners = new Set()

const liveVideoTrack = (stream) =>
  stream?.getVideoTracks().find((t) => t.readyState === 'live') || null

/** Called by useWebcam whenever its stream starts (stream) or stops (null). */
export function publishCamera(stream) {
  current = stream && liveVideoTrack(stream) ? stream : null
  listeners.forEach((fn) => {
    try { fn(current) } catch (e) { console.warn('[cameraHub] listener error', e) }
  })
}

/** The currently shared stream with a live video track, or null. */
export function getSharedCamera() {
  if (current && !liveVideoTrack(current)) current = null
  return current
}

/** Subscribe to publish events. Returns an unsubscribe function. */
export function onCameraChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
