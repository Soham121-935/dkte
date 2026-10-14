import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '@/api/endpoints';
import { useProfiles } from '@/lib/queries';
import { useDevice } from '@/providers/DeviceProvider';
import { useToast } from '@/providers/ToastProvider';
import { Button, Field, Input, Modal, Notice, Select, Textarea, errorMessage } from '@/components/ui';
import { SourceTag } from '@/components/domain';
import { fromLocalInput, toIsoLocalInput } from '@/lib/utils';
import type { Batch } from '@/api/types';

interface Props {
  open: boolean;
  onClose: () => void;
  batch?: Batch | null;
  onSaved?: (b: Batch) => void;
}

const STATUSES = ['planned', 'active', 'harvested', 'failed', 'archived'];

export function BatchForm({ open, onClose, batch, onSaved }: Props) {
  const { data: profiles } = useProfiles();
  const { devices } = useDevice();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    name: '',
    species: '',
    strain: '',
    substrate_type: '',
    substrate_details: '',
    inoculation_date: '',
    spawn_details: '',
    profile_id: '',
    device_id: '',
    status: 'active',
    initial_stage_key: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (batch) {
      setForm({
        name: batch.name,
        species: batch.species,
        strain: batch.strain ?? '',
        substrate_type: batch.substrate_type ?? '',
        substrate_details: batch.substrate_details ?? '',
        inoculation_date: toIsoLocalInput(batch.inoculation_date),
        spawn_details: batch.spawn_details ?? '',
        profile_id: batch.profile_id ? String(batch.profile_id) : '',
        device_id: batch.device_id ?? '',
        status: batch.status,
        initial_stage_key: '',
        notes: batch.notes ?? '',
      });
    } else {
      setForm((f) => ({ ...f, name: '', species: '', strain: '', substrate_type: '', substrate_details: '', inoculation_date: '', spawn_details: '', profile_id: '', device_id: '', status: 'active', initial_stage_key: '', notes: '' }));
    }
  }, [open, batch]);

  const selectedProfile = useMemo(() => profiles?.find((p) => String(p.id) === form.profile_id) ?? null, [profiles, form.profile_id]);

  useEffect(() => {
    // Pre-fill species from the profile when creating a new batch.
    if (!batch && selectedProfile && !form.species) setForm((f) => ({ ...f, species: selectedProfile.species, substrate_type: f.substrate_type || selectedProfile.substrate_type || '' }));
  }, [selectedProfile, batch, form.species]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Name is required';
    if (!form.species.trim()) e.species = 'Species is required';
    if (form.inoculation_date && new Date(form.inoculation_date).getTime() > Date.now()) e.inoculation_date = 'Inoculation date cannot be in the future';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        species: form.species.trim(),
        strain: form.strain.trim() || null,
        substrate_type: form.substrate_type.trim() || null,
        substrate_details: form.substrate_details.trim() || null,
        inoculation_date: fromLocalInput(form.inoculation_date),
        spawn_details: form.spawn_details.trim() || null,
        profile_id: form.profile_id ? Number(form.profile_id) : null,
        device_id: form.device_id || null,
        status: form.status,
        notes: form.notes.trim() || null,
      };
      if (!batch && form.initial_stage_key) body.initial_stage_key = form.initial_stage_key;
      return batch ? endpoints.updateBatch(batch.id, body) : endpoints.createBatch(body);
    },
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['batches'] });
      toast.success(batch ? 'Batch updated' : `Batch ${b.code} created`);
      onSaved?.(b);
      onClose();
    },
    onError: (e) => toast.error('Could not save batch', errorMessage(e)),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={batch ? `Edit batch ${batch.code}` : 'New cultivation batch'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => validate() && save.mutate()}>
            {batch ? 'Save changes' : 'Create batch'}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (validate()) save.mutate();
        }}
      >
        <Field label="Batch name" required error={errors.name} htmlFor="b-name" className="sm:col-span-2">
          <Input id="b-name" value={form.name} onChange={set('name')} placeholder="e.g. Oyster bucket #3" />
        </Field>
        <Field label="Species profile" hint="Profiles define stages and target ranges. Reference profiles are literature values – verify for your strain." htmlFor="b-profile">
          <Select id="b-profile" value={form.profile_id} onChange={set('profile_id')}>
            <option value="">No profile (generic defaults)</option>
            {profiles?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.source})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Device" hint="Readings and control targets will be linked to this device." htmlFor="b-device">
          <Select id="b-device" value={form.device_id} onChange={set('device_id')}>
            <option value="">No device</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.id}){d.kind === 'simulated' ? ' – simulated' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Species" required error={errors.species} htmlFor="b-species">
          <Input id="b-species" value={form.species} onChange={set('species')} placeholder="Pleurotus ostreatus" />
        </Field>
        <Field label="Strain" htmlFor="b-strain">
          <Input id="b-strain" value={form.strain} onChange={set('strain')} placeholder="optional" />
        </Field>
        <Field label="Substrate type" htmlFor="b-substrate">
          <Input id="b-substrate" value={form.substrate_type} onChange={set('substrate_type')} placeholder="Pasteurised straw" />
        </Field>
        <Field label="Inoculation date" error={errors.inoculation_date} htmlFor="b-inoc">
          <Input id="b-inoc" type="datetime-local" value={form.inoculation_date} onChange={set('inoculation_date')} max={toIsoLocalInput(new Date().toISOString())} />
        </Field>
        <Field label="Substrate details" htmlFor="b-subdetails" className="sm:col-span-2">
          <Input id="b-subdetails" value={form.substrate_details} onChange={set('substrate_details')} placeholder="weight, hydration, container, supplementation" />
        </Field>
        <Field label="Spawn details" htmlFor="b-spawn">
          <Input id="b-spawn" value={form.spawn_details} onChange={set('spawn_details')} placeholder="grain type, amount, spawn rate" />
        </Field>
        <Field label="Status" htmlFor="b-status">
          <Select id="b-status" value={form.status} onChange={set('status')}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        {!batch && selectedProfile && (
          <Field label="Current stage (confirmed by you)" hint="Only stages you have observed. Leave empty to start at the first stage." htmlFor="b-stage" className="sm:col-span-2">
            <Select id="b-stage" value={form.initial_stage_key} onChange={set('initial_stage_key')}>
              <option value="">First stage: {selectedProfile.stages[0]?.name}</option>
              {selectedProfile.stages.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Notes" htmlFor="b-notes" className="sm:col-span-2">
          <Textarea id="b-notes" value={form.notes} onChange={set('notes')} />
        </Field>
        {selectedProfile && (
          <Notice tone="neutral" className="sm:col-span-2" icon={<SourceTag source={selectedProfile.source} compact />}>
            {selectedProfile.source === 'reference' ? 'Reference profile: ' : 'User profile: '}
            {selectedProfile.source_notes ?? 'no notes'}
          </Notice>
        )}
        <button type="submit" className="hidden" aria-hidden />
      </form>
    </Modal>
  );
}
