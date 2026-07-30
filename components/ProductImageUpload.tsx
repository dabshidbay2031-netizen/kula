'use client';

import { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { getSupabase } from '@/lib/supabase';

// Kept out of the main bundle — the camera is only loaded when someone opens it.
const CameraCapture = dynamic(() => import('@/components/CameraCapture'), { ssr: false });

interface Props {
  /** Current array of photo URLs */
  urls:       string[];
  /** Called whenever the list changes (add or remove) */
  onChange:   (urls: string[]) => void;
  /** Max photos allowed (default 8) */
  maxPhotos?: number;
}

export default function ProductImageUpload({ urls, onChange, maxPhotos = 8 }: Props) {
  const fileRef            = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error,     setError]     = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);

  const remaining = maxPhotos - urls.length;

  /** Upload files to storage and append the resulting public URLs. */
  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    if (remaining <= 0) {
      setError(`Maximum ${maxPhotos} photos allowed`);
      return;
    }
    const toUpload = files.slice(0, remaining);
    setError('');
    setUploading(true);

    const sb       = getSupabase();
    const newUrls: string[] = [];

    for (const file of toUpload) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > 20 * 1024 * 1024) {
        setError('Each photo must be under 20 MB');
        continue;
      }
      const ext  = file.name.split('.').pop() ?? 'jpg';
      const path = `products/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const { error: upErr } = await sb.storage
        .from('product-images')
        .upload(path, file, { upsert: false });

      if (upErr) {
        setError(`Upload failed: ${upErr.message}`);
        continue;
      }
      const { data } = sb.storage.from('product-images').getPublicUrl(path);
      newUrls.push(data.publicUrl);
    }

    if (newUrls.length) onChange([...urls, ...newUrls]);
    setUploading(false);
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    await uploadFiles(Array.from(e.target.files ?? []));
    // Clear the input so picking the SAME file again still fires a change event.
    if (fileRef.current) fileRef.current.value = '';
  }

  function removeUrl(idx: number) {
    onChange(urls.filter((_, i) => i !== idx));
  }

  return (
    <div className="pimg-wrap">
      {/* Thumbnails */}
      {urls.length > 0 && (
        <div className="pimg-grid">
          {urls.map((url, i) => (
            <div key={url} className={`pimg-thumb${i === 0 ? ' primary' : ''}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={`Product photo ${i + 1}`} />
              {i === 0 && <span className="pimg-primary-badge">Cover</span>}
              <button
                className="pimg-remove"
                type="button"
                onClick={() => removeUrl(i)}
                title="Remove photo"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add buttons — camera first: photographing the item in front of you is
          the common case, and hunting through a gallery for a photo you haven't
          taken yet was the only option before. */}
      {remaining > 0 && (
        <div className="pimg-actions">
          <button
            type="button"
            className="pimg-add-btn pimg-cam-btn"
            onClick={() => setCameraOpen(true)}
            disabled={uploading}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
            Take Photo
          </button>

          <button
            type="button"
            className="pimg-add-btn"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <><span className="btn-spinner" /> Uploading…</>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <path d="M21 15l-5-5L5 21"/>
                </svg>
                Gallery ({urls.length}/{maxPhotos})
              </>
            )}
          </button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFiles}
      />

      {cameraOpen && (
        <CameraCapture
          remaining={remaining}
          onClose={() => setCameraOpen(false)}
          onCapture={files => { uploadFiles(files); }}
          title={maxPhotos === 1 ? 'Take a Photo' : 'Take Product Photos'}
        />
      )}

      {error && (
        <div className="auth-error" style={{ marginTop: 8, fontSize: '.8rem' }}>{error}</div>
      )}

      {urls.length > 0 && (
        <p style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginTop: 6 }}>
          First photo is the cover image. Drag to reorder coming soon.
        </p>
      )}
    </div>
  );
}
