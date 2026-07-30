/**
 * In-form camera.
 *
 * The two things that genuinely hurt users if they regress: leaving the camera
 * running after the sheet closes (the phone's camera light stays on and the
 * hardware is locked for other apps), and uploading full-resolution originals
 * over mobile data. Both are covered here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CameraCapture from '@/components/CameraCapture';

/* ── A fake camera ───────────────────────────────────────────────── */

let tracks: Array<{ stop: ReturnType<typeof vi.fn>; kind: string; getCapabilities: () => object; applyConstraints: () => Promise<void> }>;
let getUserMedia: ReturnType<typeof vi.fn>;
/** Dimensions the fake camera reports, so we can assert the downscale. */
let videoSize = { w: 4032, h: 3024 };
/** Canvas sizes the component asked for, in order. */
let canvasSizes: Array<{ w: number; h: number }>;
let toBlobCalls: Array<{ type: string; quality: number }>;

function installFakeCamera(opts: { fail?: string; cameras?: number } = {}) {
  tracks = [];
  canvasSizes = [];
  toBlobCalls = [];

  getUserMedia = vi.fn(async () => {
    if (opts.fail) throw Object.assign(new Error(opts.fail), { name: opts.fail });
    const track = {
      kind: 'video',
      stop: vi.fn(),
      getCapabilities: () => ({ torch: true }),
      applyConstraints: async () => {},
    };
    tracks.push(track);
    return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  });

  vi.stubGlobal('navigator', Object.assign(Object.create(Object.getPrototypeOf(navigator)), navigator, {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: async () =>
        Array.from({ length: opts.cameras ?? 1 }, (_, i) => ({ kind: 'videoinput', deviceId: `cam${i}` })),
    },
  }));
  vi.stubGlobal('isSecureContext', true);
}

beforeEach(() => {
  videoSize = { w: 4032, h: 3024 };
  installFakeCamera();

  // jsdom implements neither of these.
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth',  { configurable: true, get: () => videoSize.w });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => videoSize.h });
  HTMLVideoElement.prototype.play = vi.fn(async () => {});

  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, type?: string, quality?: number) {
    canvasSizes.push({ w: this.width, h: this.height });
    toBlobCalls.push({ type: type!, quality: quality! });
    cb(new Blob(['x'.repeat(120)], { type: 'image/jpeg' }));
  } as typeof HTMLCanvasElement.prototype.toBlob;

  // Stub only the two statics — replacing global URL breaks `new URL(...)`.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fake-${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const shutter = () => screen.getByLabelText('Take photo');

describe('starting the camera', () => {
  it('asks for the rear camera', async () => {
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    const constraints = getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
    expect((constraints.video as MediaTrackConstraints).facingMode).toEqual({ ideal: 'environment' });
    expect(constraints.audio).toBe(false);
  });

  it('explains a denied permission instead of failing silently', async () => {
    installFakeCamera({ fail: 'NotAllowedError' });
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/permission was denied/i)).toBeInTheDocument());
    // …and points at the way out, since the gallery picker is still available
    // behind this sheet.
    expect(screen.getByText(/Choose from gallery/i)).toBeInTheDocument();
    // No shutter to press when there's no picture to take.
    expect(screen.queryByLabelText('Take photo')).not.toBeInTheDocument();
  });

  it('names the "camera busy" case separately from a missing camera', async () => {
    installFakeCamera({ fail: 'NotReadableError' });
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/already in use/i)).toBeInTheDocument());
  });

  it('hides the flip button when the device has only one camera', async () => {
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(shutter()).toBeInTheDocument());
    expect(screen.queryByTitle('Switch camera')).not.toBeInTheDocument();
  });

  it('offers the flip button when there are two', async () => {
    installFakeCamera({ cameras: 2 });
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTitle('Switch camera')).toBeInTheDocument());
  });
});

describe('releasing the camera', () => {
  it('stops every track when the sheet unmounts', async () => {
    const { unmount } = render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(tracks).toHaveLength(1));

    unmount();

    // Leaving this running keeps the phone's camera indicator lit and locks the
    // hardware against other apps.
    expect(tracks.every(t => t.stop.mock.calls.length > 0)).toBe(true);
  });

  it('releases the old stream when switching cameras', async () => {
    installFakeCamera({ cameras: 2 });
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTitle('Switch camera')).toBeInTheDocument());

    await userEvent.click(screen.getByTitle('Switch camera'));

    await waitFor(() => expect(tracks.length).toBe(2));
    expect(tracks[0].stop).toHaveBeenCalled();
  });
});

describe('taking a photo', () => {
  it('downscales to 1600px on the long edge and encodes JPEG', async () => {
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(shutter()).toBeInTheDocument());

    await act(async () => { await userEvent.click(shutter()); });

    // 4032×3024 → long edge capped at 1600, aspect ratio preserved.
    expect(canvasSizes[0]).toEqual({ w: 1600, h: 1200 });
    expect(toBlobCalls[0].type).toBe('image/jpeg');
    expect(toBlobCalls[0].quality).toBeLessThan(1);
  });

  it('never upscales a camera smaller than the cap', async () => {
    videoSize = { w: 640, h: 480 };
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(shutter()).toBeInTheDocument());

    await act(async () => { await userEvent.click(shutter()); });

    expect(canvasSizes[0]).toEqual({ w: 640, h: 480 });
  });

  it('shows each shot for review and lets it be discarded before uploading', async () => {
    render(<CameraCapture remaining={8} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(shutter()).toBeInTheDocument());

    await act(async () => { await userEvent.click(shutter()); });
    await act(async () => { await userEvent.click(shutter()); });
    expect(screen.getAllByAltText('Captured photo')).toHaveLength(2);

    await userEvent.click(screen.getAllByTitle('Discard')[0]);
    expect(screen.getAllByAltText('Captured photo')).toHaveLength(1);
  });

  it('hands the kept photos back as JPEG files and closes', async () => {
    const onCapture = vi.fn();
    const onClose   = vi.fn();
    render(<CameraCapture remaining={8} onCapture={onCapture} onClose={onClose} />);
    await waitFor(() => expect(shutter()).toBeInTheDocument());

    await act(async () => { await userEvent.click(shutter()); });
    await userEvent.click(screen.getByText('Use 1 photo'));

    expect(onCapture).toHaveBeenCalledTimes(1);
    const files = onCapture.mock.calls[0][0] as File[];
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/jpeg');
    expect(files[0].name).toMatch(/\.jpg$/);
    expect(onClose).toHaveBeenCalled();
  });

  it('cannot hand back nothing', async () => {
    const onCapture = vi.fn();
    render(<CameraCapture remaining={8} onCapture={onCapture} onClose={() => {}} />);
    await waitFor(() => expect(shutter()).toBeInTheDocument());

    expect(screen.getByText('Use photos')).toBeDisabled();
  });

  it('stops at the caller’s remaining allowance', async () => {
    render(<CameraCapture remaining={1} onCapture={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(shutter()).toBeInTheDocument());

    await act(async () => { await userEvent.click(shutter()); });

    expect(shutter()).toBeDisabled();
    expect(screen.getByText(/Maximum 1 photo reached/)).toBeInTheDocument();
    expect(screen.getAllByAltText('Captured photo')).toHaveLength(1);
  });
});
