'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  /** Hand back the photos the user kept, as JPEG files ready to upload. */
  onCapture: (files: File[]) => void;
  onClose:   () => void;
  /** How many more photos the caller can still accept. */
  remaining: number;
  title?: string;
}

/**
 * In-app camera for product photos.
 *
 * Deliberately NOT `<input capture>`: that hands off to the OS camera app, which
 * loses the form on some Android browsers, allows only one shot per trip, and
 * returns a full-resolution 4–6 MB original. Sellers photograph several angles
 * of a product in a row, on a metered connection — so this keeps them in the
 * form, lets them shoot, review and retake before committing, and downscales
 * every frame before it leaves the device.
 */

/** Long edge of a saved photo. Plenty for a product listing; ~10× smaller than
 *  a modern phone's full-resolution JPEG, which matters on mobile data. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

interface Shot { id: string; url: string; file: File; }

export default function CameraCapture({ onCapture, onClose, remaining, title = 'Take Photos' }: Props) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status,   setStatus]   = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [shots,    setShots]    = useState<Shot[]>([]);
  const [facing,   setFacing]   = useState<'environment' | 'user'>('environment');
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  const [torchOn,  setTorchOn]  = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [busy,     setBusy]     = useState(false);

  const canTakeMore = shots.length < remaining;

  /* ── Camera lifecycle ─────────────────────────────────────────── */
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      setStatus('loading');
      stopStream();                       // switching cameras: release the old one first
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facing },
            width:  { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }

        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // iOS Safari needs an explicit play() and refuses to inline a video
          // that isn't muted + playsInline (see the JSX below).
          await video.play().catch(() => {});
        }

        // Torch is a per-track capability and mostly Android Chrome only.
        const track = stream.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        setTorchSupported(Boolean(caps.torch));
        setTorchOn(false);

        // Only offer the flip button when there's something to flip to.
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) {
            setHasMultipleCameras(devices.filter(d => d.kind === 'videoinput').length > 1);
          }
        } catch { /* label/enumeration blocked — just hide the button */ }

        if (!cancelled) setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string })?.name ?? '';
        setStatus('error');
        setErrorMsg(
          name === 'NotAllowedError'  ? 'Camera permission was denied. Allow camera access in your browser settings, or use "Choose from gallery" instead.'
          : name === 'NotFoundError'  ? 'No camera found on this device. Use "Choose from gallery" instead.'
          : name === 'NotReadableError' ? 'The camera is already in use by another app. Close it and try again.'
          : !window.isSecureContext   ? 'The camera needs a secure (https) connection.'
          :                             'Camera not available on this device. Use "Choose from gallery" instead.'
        );
      }
    }

    start();
    return () => { cancelled = true; stopStream(); };
  }, [facing, stopStream]);

  // Release the camera as soon as this modal goes away, whatever the reason.
  useEffect(() => () => {
    stopStream();
    // Revoke preview URLs so the blobs can be collected.
    setShots(prev => { prev.forEach(s => URL.revokeObjectURL(s.url)); return prev; });
  }, [stopStream]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* ── Capture ──────────────────────────────────────────────────── */
  async function takePhoto() {
    const video = videoRef.current;
    if (!video || status !== 'ready' || !canTakeMore || busy) return;
    setBusy(true);
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // Draw the TRUE image even when the preview is mirrored for the selfie
      // camera — a mirrored product photo would have backwards labels.
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob: Blob | null = await new Promise(res =>
        canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
      if (!blob) return;

      const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setShots(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, url: URL.createObjectURL(blob), file }]);
    } finally {
      setBusy(false);
    }
  }

  function discard(id: string) {
    setShots(prev => {
      const gone = prev.find(s => s.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter(s => s.id !== id);
    });
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      // `torch` is a real capability on Android Chrome but isn't in the DOM
      // typings, hence the cast through unknown.
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch { setTorchSupported(false); }
  }

  function useShots() {
    if (!shots.length) return;
    onCapture(shots.map(s => s.file));
    // The parent owns the files now; only the preview URLs are ours to free.
    shots.forEach(s => URL.revokeObjectURL(s.url));
    setShots([]);
    onClose();
  }

  /* ── UI ───────────────────────────────────────────────────────── */
  return (
    <div className="modal-overlay barcode-modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-box barcode-modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1.2rem' }}>📸</span>
            <span style={{ fontWeight: 700 }}>{title}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          <div className="barcode-viewport">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              style={{
                width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                // Mirror only the preview of the selfie camera, so moving left
                // moves left. The captured file stays un-mirrored.
                transform: facing === 'user' ? 'scaleX(-1)' : undefined,
              }}
            />

            {status === 'loading' && (
              <div className="barcode-overlay">
                <div className="spinner" style={{ width: 28, height: 28 }} />
                <span style={{ fontSize: '.85rem', marginTop: 8 }}>Starting camera…</span>
              </div>
            )}

            {status === 'error' && (
              <div className="barcode-overlay">
                <span style={{ fontSize: '1.8rem' }}>📷</span>
                <span style={{ fontSize: '.82rem', textAlign: 'center', padding: '0 18px', opacity: .85 }}>
                  Camera unavailable
                </span>
              </div>
            )}

            {/* Camera controls, floated over the preview */}
            {status === 'ready' && (
              <div style={{
                position: 'absolute', top: 10, right: 10, display: 'flex', gap: 8, zIndex: 2,
              }}>
                {torchSupported && (
                  <button type="button" onClick={toggleTorch} className="cam-chip"
                    aria-pressed={torchOn} title="Flashlight">
                    {torchOn ? '🔦' : '💡'}
                  </button>
                )}
                {hasMultipleCameras && (
                  <button type="button" className="cam-chip" title="Switch camera"
                    onClick={() => setFacing(f => (f === 'environment' ? 'user' : 'environment'))}>
                    🔄
                  </button>
                )}
              </div>
            )}
          </div>

          {status === 'error' && <div className="auth-error" style={{ marginBottom: 12 }}>{errorMsg}</div>}

          {/* Shutter */}
          {status === 'ready' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginTop: 12 }}>
              <button
                type="button"
                className="cam-shutter"
                onClick={takePhoto}
                disabled={!canTakeMore || busy}
                aria-label="Take photo"
              />
              <span style={{ fontSize: '.75rem', color: 'var(--text-muted)' }}>
                {canTakeMore
                  ? `Tap to capture · ${shots.length}/${remaining} taken`
                  : `Maximum ${remaining} photo${remaining === 1 ? '' : 's'} reached`}
              </span>
            </div>
          )}

          {/* Review strip — retake anything that came out badly BEFORE uploading */}
          {shots.length > 0 && (
            <div className="pimg-grid" style={{ marginTop: 14 }}>
              {shots.map(s => (
                <div key={s.id} className="pimg-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.url} alt="Captured photo" />
                  <button className="pimg-remove" type="button" onClick={() => discard(s.id)} title="Discard">✕</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" style={{ flex: 2 }}
              onClick={useShots} disabled={!shots.length}>
              {shots.length
                ? `Use ${shots.length} photo${shots.length === 1 ? '' : 's'}`
                : 'Use photos'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
