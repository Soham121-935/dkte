import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera, FileText, ImagePlus, QrCode, ScanSearch } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { useCameraStatus } from '@/lib/queries';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card, Skeleton, errorMessage, type Tone } from '@/components/ui';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CameraCapture, CameraStatus, CaptureConfidence } from '@/api/types';

const CONFIDENCE: Record<CaptureConfidence, { label: string; tone: Tone; hint: string }> = {
  high: { label: 'Sure', tone: 'brand', hint: 'A clear match – far more matching features than any other card, or the QR code was read.' },
  medium: { label: 'Fairly sure', tone: 'teal', hint: 'A clear winner, but with fewer matching features. Applied automatically.' },
  low: { label: 'Unsure', tone: 'amber', hint: 'The best card is barely ahead of the runner-up. Confirm it yourself or take a clearer photo.' },
};

const PHASE_SHORT: Record<string, string> = {
  colonising: 'Colonising',
  browning: 'Browning',
  pinning: 'Pinning',
  fruiting: 'Fruiting',
  harvest_ready: 'Ready to pick',
};

export function describeCapture(c: CameraCapture): string {
  if (c.status === 'matched' && c.card) return `${c.card.species} · ${PHASE_SHORT[c.card.phase_key] ?? c.card.phase}`;
  if (c.status === 'no_match') return 'No reference card recognised';
  if (c.status === 'unavailable') return 'Recognition is not available on the server';
  return 'The photo could not be read';
}

function Result({ capture }: { capture: CameraCapture }) {
  const matched = capture.status === 'matched' && capture.card;
  const conf = capture.confidence ? CONFIDENCE[capture.confidence] : null;
  return (
    <div className="min-w-0 flex-1 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={cn('text-[17px] font-semibold leading-tight', matched ? 'text-ink' : 'text-ink-2')}>{describeCapture(capture)}</h3>
        {conf && (
          <Badge tone={conf.tone} title={conf.hint} dot>
            {conf.label}
          </Badge>
        )}
        {matched && (
          <Badge tone="muted" title={capture.method === 'qr' ? `QR code read: ${capture.qr_text}` : `${capture.inliers} matching features (runner-up ${capture.second_inliers})`}>
            {capture.method === 'qr' ? <QrCode className="h-3 w-3" aria-hidden /> : <ScanSearch className="h-3 w-3" aria-hidden />}
            {capture.method === 'qr' ? 'by QR code' : 'by picture'}
          </Badge>
        )}
      </div>
      {matched && capture.card && (
        <p className="text-sm text-ink-2">
          <i className="not-italic text-ink-3">{capture.card.latin_name}</i> · profile stage <b className="font-medium">{capture.card.stage_key.replace('_', ' ')}</b>
        </p>
      )}
      <p className="text-[13px] text-ink-3">
        {capture.source === 'esp32cam' ? (capture.trigger === 'manual' ? 'Taken by the camera on request' : 'Taken automatically by the camera') : 'Uploaded from this browser'} · {fmtAgo(capture.captured_at)}
      </p>
      {capture.applied ? (
        <p className="text-[13px] text-brand">
          Applied – the chamber now follows this phase{capture.apply_note?.includes('switched to automatic') ? ' in Automatic mode' : ''}.
        </p>
      ) : matched ? (
        <p className="text-[13px] text-amber">Not applied yet{capture.apply_note ? ` – ${capture.apply_note.replace(/^Not applied: /, '')}` : '.'}</p>
      ) : (
        <p className="text-[13px] text-ink-3">{capture.message ?? 'Hold the printed card flat, fill the frame and avoid glare.'}</p>
      )}
    </div>
  );
}

function OnlinePill({ status }: { status: CameraStatus }) {
  if (!status.camera_has_token) return <Badge tone="amber">camera has no token</Badge>;
  return (
    <Badge tone={status.online ? 'brand' : 'muted'} dot title={status.last_seen_at ? `Last contact ${fmtAgo(status.last_seen_at)}` : 'The ESP32-CAM has not contacted the server yet'}>
      {status.online ? 'camera online' : 'camera offline'}
    </Badge>
  );
}

export function CameraCard({ deviceId }: { deviceId: string }) {
  const status = useCameraStatus();
  const toast = useToast();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['vision'] });
    qc.invalidateQueries({ queryKey: ['batches'] });
    qc.invalidateQueries({ queryKey: ['control'] });
    qc.invalidateQueries({ queryKey: ['devices'] });
    qc.invalidateQueries({ queryKey: ['telemetry'] });
    qc.invalidateQueries({ queryKey: ['ai', 'insight'] });
  };

  const request = useMutation({
    mutationFn: () => endpoints.cameraCaptureRequest(deviceId),
    onSuccess: (r) => {
      setWaitingSince(Date.now());
      qc.invalidateQueries({ queryKey: ['vision'] });
      if (r.camera_online) toast.info('Photo requested', 'The camera takes it on its next check-in, usually within a few seconds.');
      else toast.warning('The camera is offline', 'The request is stored, but the ESP32-CAM has not checked in recently. You can upload a photo instead.');
    },
    onError: (e) => toast.error('Could not reach the server', errorMessage(e)),
  });
  const upload = useMutation({
    mutationFn: (file: File) => endpoints.cameraUpload(file, deviceId, true),
    onSuccess: (c) => {
      refreshAll();
      if (c.status === 'matched') toast.success(describeCapture(c), c.applied ? 'The chamber now follows this phase.' : 'Confirm it below to apply the phase.');
      else toast.warning('No card recognised', c.message ?? undefined);
    },
    onError: (e) => toast.error('Upload failed', errorMessage(e)),
  });
  const apply = useMutation({
    mutationFn: (c: CameraCapture) => endpoints.cameraApply(c.id, c.confidence === 'low', deviceId),
    onSuccess: ({ result }) => {
      refreshAll();
      toast.success(`Phase applied to ${result.batch_code}`, result.notes.join('; '));
    },
    onError: (e) => toast.error('Could not apply the phase', errorMessage(e)),
  });

  const data = status.data;
  const last = data?.last_capture ?? null;
  const pending = !!data?.manual_pending;
  const lastAt = last ? new Date(last.captured_at).getTime() : null;
  useEffect(() => {
    // the requested photo has arrived (or the request timed out) -> release the button
    if (waitingSince === null) return;
    if (lastAt !== null && lastAt >= waitingSince) setWaitingSince(null);
    const t = window.setTimeout(() => setWaitingSince(null), 30000);
    return () => window.clearTimeout(t);
  }, [waitingSince, lastAt]);
  const waiting = pending || waitingSince !== null;
  const needsConfirm = last && last.status === 'matched' && !last.applied;

  return (
    <Card
      title="Chamber camera"
      subtitle="Photographs the reference card and sets the growth phase the chamber works towards"
      actions={data ? <OnlinePill status={data} /> : null}
    >
      {status.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : status.isError ? (
        <p className="text-sm text-danger">Camera status unavailable: {errorMessage(status.error)}</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="relative shrink-0 overflow-hidden rounded-xl border border-line bg-surface-2 sm:w-[240px]">
              {last ? (
                <img src={last.image_url} alt={`Camera capture ${last.id}`} className="aspect-[4/3] w-full object-cover" />
              ) : (
                <div className="grid aspect-[4/3] w-full place-items-center text-ink-3">
                  <Camera className="h-8 w-8" aria-hidden />
                </div>
              )}
              {last?.card && (
                <img
                  src={last.card.image_url}
                  alt={`Reference card ${last.card.species} ${last.card.phase}`}
                  title={`Matched card: ${last.card.species} – ${last.card.phase}`}
                  className="absolute bottom-2 right-2 h-14 w-14 rounded-lg border-2 border-white object-cover shadow-card"
                />
              )}
            </div>
            {last ? (
              <Result capture={last} />
            ) : (
              <div className="flex-1 text-sm text-ink-2">
                <p className="font-medium text-ink">No photo yet.</p>
                <p className="mt-1 text-ink-3">
                  Hold a printed reference card in front of the ESP32-CAM and press <b className="font-medium text-ink-2">Take a photo now</b>, or upload a photo of the card from this device.
                  {data && !data.recognition.available ? ' Recognition is unavailable on the server (OpenCV missing).' : ''}
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Camera className="h-4 w-4" />} onClick={() => request.mutate()} loading={request.isPending} disabled={waiting}>
              {waiting ? 'Waiting for the camera…' : 'Take a photo now'}
            </Button>
            <Button variant="outline" icon={<ImagePlus className="h-4 w-4" />} onClick={() => fileInput.current?.click()} loading={upload.isPending}>
              Upload a photo
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              className="sr-only"
              aria-label="Upload a photo of the reference card"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
                e.target.value = '';
              }}
            />
            {needsConfirm && last && (
              <Button variant="secondary" onClick={() => apply.mutate(last)} loading={apply.isPending}>
                Use this phase anyway
              </Button>
            )}
            <a href="/api/vision/reference.pdf" target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1.5 text-[13px] font-medium text-brand hover:underline">
              <FileText className="h-4 w-4" aria-hidden /> Printable reference cards
            </a>
          </div>

          {data && (
            <p className="text-[12px] text-ink-3">
              Automatic photo every {Math.round(data.auto_interval_seconds / 60)} min · {data.recognition.indexed} of {data.reference_cards} cards indexed
              {data.recognition.missing.length ? ` (missing: ${data.recognition.missing.join(', ')})` : ''} · recognises the printed cards only, not mushrooms in general.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
