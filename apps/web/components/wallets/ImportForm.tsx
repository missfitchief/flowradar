'use client';

// FlowRadar — CSV wallet import upload form (Task 12 binding decision 4).
//
// Client component: a file input + upload button that POSTs the selected
// file to /api/import as multipart/form-data (field `file` — matches the
// route's own expectation), then renders a result panel with the returned
// ok/error counts and the per-row errors (message + 1-based row number).
// On a successful (2xx) response, router.refresh() re-runs the import
// history page's server component so the new ImportJob row appears without
// a full navigation — same pattern as components/AutoRefresh.tsx's
// router.refresh() usage.
//
// Deliberately does NOT attempt client-side file-size/extension validation
// beyond the native `accept=".csv"` filter hint — the route itself is the
// single source of truth for the 2MB/.csv rules (decision 5), so a rejected
// upload here surfaces the exact same JSON error message the route returns,
// with no risk of client/server validation drifting apart.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface ImportRowError {
  row: number;
  message: string;
}

interface ImportResult {
  importJobId: string;
  totalRows: number;
  okRows: number;
  errorRows: number;
  errors: ImportRowError[];
}

type UploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'success'; result: ImportResult }
  | { status: 'error'; message: string };

export function ImportForm() {
  const router = useRouter();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>({ status: 'idle' });

  async function handleUpload(): Promise<void> {
    if (!selectedFile) return;
    setState({ status: 'uploading' });

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const response = await fetch('/api/import', { method: 'POST', body: formData });
      const body = await response.json();

      if (!response.ok) {
        setState({ status: 'error', message: body.error ?? `upload failed (HTTP ${response.status})` });
        return;
      }

      setState({ status: 'success', result: body as ImportResult });
      router.refresh();
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  const uploading = state.status === 'uploading';

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="file"
          accept=".csv"
          disabled={uploading}
          onChange={(e) => {
            setSelectedFile(e.target.files?.[0] ?? null);
            setState({ status: 'idle' });
          }}
          className="max-w-xs"
        />
        <Button type="button" disabled={!selectedFile || uploading} onClick={() => void handleUpload()}>
          {uploading ? 'Uploading…' : 'Upload CSV'}
        </Button>
      </div>

      {state.status === 'error' && (
        <p className="mt-3 text-sm text-red-400">{state.message}</p>
      )}

      {state.status === 'success' && (
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge className="border-transparent bg-emerald-500/15 text-emerald-300">{state.result.okRows} ok</Badge>
            <Badge className="border-transparent bg-red-500/15 text-red-400">{state.result.errorRows} errors</Badge>
            <span className="text-muted-foreground">of {state.result.totalRows} rows</span>
          </div>
          {state.result.errors.length > 0 && (
            <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md bg-muted/30 p-3 text-xs">
              {state.result.errors.map((err, idx) => (
                <li key={`${err.row}-${idx}`} className="text-muted-foreground">
                  <span className="font-medium text-foreground">row {err.row}:</span> {err.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
