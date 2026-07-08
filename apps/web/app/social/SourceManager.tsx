'use client';

// FlowRadar — Social source manager (Task E, spec §8). Client component:
// add / edit / enable-toggle / delete SocialSource rows via
// /api/social/sources, then router.refresh() so the server-rendered /social
// page re-fetches (same pattern as ImportForm + SourceHealthTable).
//
// apiKeyEnvName is entered/edited as an env-var NAME ONLY (never a secret
// value) — the field label says so and the route re-validates it.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

export interface ManagedSource {
  id: string;
  name: string;
  platform: string;
  trustTier: string;
  enabled: boolean;
  apiKeyEnvName: string | null;
  rateLimitPerMinute: number;
  notes: string | null;
}

interface SourceManagerProps {
  sources: ManagedSource[];
}

const PLATFORMS = ['telegram', 'discord', 'manual'] as const;
const TRUST_TIERS = ['high', 'medium', 'low'] as const;

type OpState = { status: 'idle' } | { status: 'busy' } | { status: 'error'; message: string };

export function SourceManager({ sources }: SourceManagerProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>('telegram');
  const [trustTier, setTrustTier] = useState<(typeof TRUST_TIERS)[number]>('medium');
  const [apiKeyEnvName, setApiKeyEnvName] = useState('');
  const [addState, setAddState] = useState<OpState>({ status: 'idle' });

  async function handleAdd(): Promise<void> {
    if (!name.trim()) return;
    setAddState({ status: 'busy' });
    try {
      const response = await fetch('/api/social/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          platform,
          trustTier,
          apiKeyEnvName: apiKeyEnvName.trim() ? apiKeyEnvName.trim() : undefined
        })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? `request failed (HTTP ${response.status})`);
      }
      setName('');
      setApiKeyEnvName('');
      setAddState({ status: 'idle' });
      router.refresh();
    } catch (err) {
      setAddState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Add form */}
      <div className="rounded-lg border border-border p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="alpha-callers-tg" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Platform</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Trust tier</label>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={trustTier}
              onChange={(e) => setTrustTier(e.target.value as (typeof TRUST_TIERS)[number])}
            >
              {TRUST_TIERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">API key env NAME (not a value)</label>
            <Input
              value={apiKeyEnvName}
              onChange={(e) => setApiKeyEnvName(e.target.value)}
              placeholder="SOCIAL_TELEGRAM_READ_TOKEN"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" disabled={!name.trim() || addState.status === 'busy'} onClick={() => void handleAdd()}>
            {addState.status === 'busy' ? 'Adding…' : 'Add source'}
          </Button>
          {addState.status === 'error' && <span className="text-sm text-red-400">{addState.message}</span>}
        </div>
      </div>

      {/* Existing sources — enable toggle + delete */}
      {sources.length > 0 && (
        <ul className="flex flex-col gap-2">
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceRow({ source }: { source: ManagedSource }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(source.enabled);
  const [state, setState] = useState<OpState>({ status: 'idle' });

  async function handleToggle(next: boolean): Promise<void> {
    const prev = enabled;
    setEnabled(next);
    setState({ status: 'busy' });
    try {
      const response = await fetch('/api/social/sources', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, enabled: next })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? `request failed (HTTP ${response.status})`);
      }
      setState({ status: 'idle' });
      router.refresh();
    } catch (err) {
      setEnabled(prev);
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleDelete(): Promise<void> {
    setState({ status: 'busy' });
    try {
      const response = await fetch('/api/social/sources', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id })
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? `request failed (HTTP ${response.status})`);
      }
      router.refresh();
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
      <span className="font-medium">{source.name}</span>
      <span className="text-xs text-muted-foreground">{source.platform}</span>
      <span className="text-xs text-muted-foreground">trust: {source.trustTier}</span>
      {source.apiKeyEnvName && <code className="text-xs text-muted-foreground">{source.apiKeyEnvName}</code>}
      <label className="ml-auto flex items-center gap-2">
        <Switch checked={enabled} disabled={state.status === 'busy'} onCheckedChange={handleToggle} aria-label={`Toggle ${source.name}`} />
        <span className="text-xs text-muted-foreground">{enabled ? 'enabled' : 'disabled'}</span>
      </label>
      <Button type="button" variant="outline" disabled={state.status === 'busy'} onClick={() => void handleDelete()}>
        Delete
      </Button>
      {state.status === 'error' && <span className="w-full text-xs text-red-400">{state.message}</span>}
    </li>
  );
}
