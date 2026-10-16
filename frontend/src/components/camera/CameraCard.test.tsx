/**
 * The chamber camera card: shows the last ESP32-CAM photo with what was
 * recognised, the "take a photo now" request, the browser upload fallback and
 * honest wording when nothing matched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CameraCard, describeCapture } from './CameraCard';
import { FIXTURES, WebSocketStub, installFetchMock, json, renderApp, type FetchMock } from '@/test/helpers';
import type { CameraCapture } from '@/api/types';

const capture = FIXTURES.cameraCapture as unknown as CameraCapture;

describe('describeCapture', () => {
  it('uses grower words and never claims a match it does not have', () => {
    expect(describeCapture(capture)).toBe('Oyster · Pinning');
    expect(describeCapture({ ...capture, status: 'no_match', card: null })).toBe('No reference card recognised');
    expect(describeCapture({ ...capture, status: 'unreadable', card: null })).toBe('The photo could not be read');
  });
});

describe('camera card', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    WebSocketStub.instances.length = 0;
    vi.stubGlobal('WebSocket', WebSocketStub);
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    fetchMock.restore();
    vi.unstubAllGlobals();
  });

  it('shows the last photo, the recognised species/phase, how it was recognised and that it was applied', async () => {
    renderApp(<CameraCard deviceId="myco-esp32-01" />);
    const card = (await screen.findByText('Chamber camera')).closest('section')!;
    await within(card).findByText('Oyster · Pinning');
    expect(within(card).getByText('Sure')).toBeInTheDocument();
    expect(within(card).getByText('by picture')).toBeInTheDocument();
    expect(within(card).getByText(/Applied – the chamber now follows this phase/)).toBeInTheDocument();
    expect(within(card).getByText('camera offline')).toBeInTheDocument();
    expect(within(card).getByAltText(/Camera capture/)).toHaveAttribute('src', capture.image_url);
    expect(within(card).getByAltText(/Reference card Oyster Pinning/)).toHaveAttribute('src', '/api/vision/reference/oyster_pinning.jpg');
    expect(within(card).getByRole('link', { name: /Printable reference cards/ })).toHaveAttribute('href', '/api/vision/reference.pdf');
    expect(within(card).getByText(/recognises the printed cards only/)).toBeInTheDocument();
  });

  it('requests a photo from the ESP32-CAM for the selected chamber and tells the user when the camera is offline', async () => {
    fetchMock.on('POST', /^\/api\/vision\/capture-request$/, ({ body }) => {
      expect(body).toEqual({ device_id: 'myco-esp32-01' });
      return json(202, { requested: true, camera_online: false, target_device_id: 'myco-esp32-01', message: 'stored' });
    });
    renderApp(<CameraCard deviceId="myco-esp32-01" />);
    const button = await screen.findByRole('button', { name: /Take a photo now/ });
    await userEvent.click(button);
    await screen.findByText('The camera is offline');
    expect(fetchMock.calls.some((c) => c.method === 'POST' && c.url === '/api/vision/capture-request')).toBe(true);
    // while the request is pending the button waits for the camera instead of stacking requests
    expect(await screen.findByRole('button', { name: /Waiting for the camera/ })).toBeDisabled();
  });

  it('uploads a photo as fallback and reports an honest "no match" without applying anything', async () => {
    const noMatch: CameraCapture = { ...capture, id: 2, status: 'no_match', card: null, confidence: null, method: 'features', applied: false, inliers: 3, second_inliers: 2,
      message: 'Best candidate oyster_pinning has only 3 consistent feature matches (minimum 20).', source: 'upload', trigger: 'upload' };
    fetchMock.on('POST', /^\/api\/vision\/upload$/, ({ url, body }) => {
      expect(url.searchParams.get('device_id')).toBe('myco-esp32-01');
      expect(body).toBeInstanceOf(FormData);
      return json(201, noMatch);
    });
    fetchMock.on('GET', /^\/api\/vision\/status$/, () => ({ ...FIXTURES.cameraStatus, last_capture: null }));
    renderApp(<CameraCard deviceId="myco-esp32-01" />);
    await screen.findByText('No photo yet.');
    const input = screen.getByLabelText('Upload a photo of the reference card') as HTMLInputElement;
    expect(input).toHaveAttribute('capture', 'environment');
    fetchMock.on('GET', /^\/api\/vision\/status$/, () => ({ ...FIXTURES.cameraStatus, last_capture: noMatch }));
    await userEvent.upload(input, new File([new Uint8Array([0xff, 0xd8, 0xff])], 'card.jpg', { type: 'image/jpeg' }));
    await screen.findByText('No card recognised');
    await waitFor(() => expect(screen.getByText('No reference card recognised')).toBeInTheDocument());
    // the message appears in the toast and in the card – both are fine, as long as it is there
    expect(screen.getAllByText(/only 3 consistent feature matches/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Applied –/)).not.toBeInTheDocument();
  });

  it('offers to apply an unsure match explicitly instead of doing it silently', async () => {
    const unsure: CameraCapture = { ...capture, id: 3, confidence: 'low', applied: false, apply_note: null, inliers: 24, second_inliers: 19 };
    fetchMock.on('GET', /^\/api\/vision\/status$/, () => ({ ...FIXTURES.cameraStatus, last_capture: unsure }));
    fetchMock.on('POST', /^\/api\/vision\/captures\/3\/apply$/, ({ body }) => {
      expect(body).toEqual({ force: true, device_id: 'myco-esp32-01' });
      return json(200, { capture: { ...unsure, applied: true }, result: { batch_id: 1, batch_code: 'B-2026-001', stage_key: 'pinning', stage_changed: true, mode_changed: true, notes: ['B-2026-001: incubation -> pinning'] } });
    });
    renderApp(<CameraCard deviceId="myco-esp32-01" />);
    await screen.findByText('Unsure');
    expect(screen.getByText(/Not applied yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use this phase anyway' }));
    await screen.findByText('Phase applied to B-2026-001');
  });
});
