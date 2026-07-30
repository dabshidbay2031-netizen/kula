/**
 * The photo picker in the product form — camera path end to end.
 *
 * ProductImageUpload is the single uploader behind the product add/edit form
 * AND the store-logo / avatar pickers, so wiring the camera here is what makes
 * "take a picture while adding a product" work everywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/* Storage is stubbed — we're testing the wiring, not Supabase. */
const upload = vi.fn(async () => ({ error: null }));
let uploadedNames: string[] = [];
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({
    storage: {
      from: () => ({
        upload: (path: string, file: File) => { uploadedNames.push(file.name); return upload(); },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  }),
}));

/* next/dynamic doesn't resolve under vitest; React.lazy + Suspense does the
   same job and keeps the component genuinely lazily loaded. */
/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  return {
    default: (loader: () => Promise<{ default: React.ComponentType<any> }>) => {
      const Lazy = React.lazy(loader);
      const Wrapped = (props: any) =>
        React.createElement(React.Suspense, { fallback: null }, React.createElement(Lazy, props));
      return Wrapped;
    },
  };
});
/* eslint-enable @typescript-eslint/no-explicit-any */

import ProductImageUpload from '@/components/ProductImageUpload';

let tracks: Array<{ stop: ReturnType<typeof vi.fn> }>;

beforeEach(() => {
  uploadedNames = [];
  tracks = [];

  vi.stubGlobal('navigator', Object.assign(Object.create(Object.getPrototypeOf(navigator)), navigator, {
    mediaDevices: {
      getUserMedia: async () => {
        const track = { kind: 'video', stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: async () => {} };
        tracks.push(track);
        return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
      },
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'cam0' }],
    },
  }));
  vi.stubGlobal('isSecureContext', true);

  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth',  { configurable: true, get: () => 1280 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 960 });
  HTMLVideoElement.prototype.play = vi.fn(async () => {});
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['x'], { type: 'image/jpeg' }));
  } as typeof HTMLCanvasElement.prototype.toBlob;
  // Stub only the two statics — replacing global URL breaks `new URL(...)`,
  // which Next and the router both rely on.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('taking a photo from the product form', () => {
  it('offers a camera button alongside the gallery picker', () => {
    render(<ProductImageUpload urls={[]} onChange={() => {}} />);
    expect(screen.getByText('Take Photo')).toBeInTheDocument();
    expect(screen.getByText(/Gallery/)).toBeInTheDocument();
  });

  it('uploads the captured photo and adds its URL to the product', async () => {
    const onChange = vi.fn();
    render(<ProductImageUpload urls={[]} onChange={onChange} />);

    await userEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => expect(screen.getByLabelText('Take photo')).toBeInTheDocument());

    await act(async () => { await userEvent.click(screen.getByLabelText('Take photo')); });
    await act(async () => { await userEvent.click(screen.getByText('Use 1 photo')); });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toEqual([expect.stringContaining('https://cdn.test/products/')]);
    expect(uploadedNames[0]).toMatch(/^photo-\d+\.jpg$/);
  });

  it('only lets the camera take as many as the product has room for', async () => {
    // 7 of 8 slots already used.
    const urls = Array.from({ length: 7 }, (_, i) => `https://cdn.test/p${i}.jpg`);
    render(<ProductImageUpload urls={urls} onChange={() => {}} />);

    await userEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => expect(screen.getByLabelText('Take photo')).toBeInTheDocument());

    await act(async () => { await userEvent.click(screen.getByLabelText('Take photo')); });
    expect(screen.getByLabelText('Take photo')).toBeDisabled();
  });

  it('hides both buttons once the photo limit is reached', () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://cdn.test/p${i}.jpg`);
    render(<ProductImageUpload urls={urls} onChange={() => {}} />);
    expect(screen.queryByText('Take Photo')).not.toBeInTheDocument();
  });

  it('releases the camera when the sheet is cancelled', async () => {
    render(<ProductImageUpload urls={[]} onChange={() => {}} />);
    await userEvent.click(screen.getByText('Take Photo'));
    await waitFor(() => expect(tracks).toHaveLength(1));

    await userEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(tracks[0].stop).toHaveBeenCalled());
  });
});
