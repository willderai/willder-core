"use client";

// The question asked before a knowledge source is disconnected. A disconnect
// deletes what the source brought into memory and cannot be undone short of
// connecting it again and re-syncing, so the person reads exactly what goes and
// what stays (connector-data.ts) before anything is sent. Nothing is deleted
// until they confirm.

import { Button, Modal } from "@/components/ui";
import type { SourceType } from "@/lib/source-lists";
import { disconnectEffects } from "./connector-data";

export function DisconnectConfirm({
  kind,
  name,
  busy,
  unavailable = false,
  onConfirm,
  onCancel,
}: {
  kind: SourceType;
  /** The source as its card names it. */
  name: string;
  busy: boolean;
  /** The caller refuses confirmation while the source list is being refreshed. */
  unavailable?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { removed, kept } = disconnectEffects(kind);
  return (
    <Modal
      title={`Disconnect ${name}?`}
      glow="brick"
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy} aria-disabled={busy || unavailable}>
            {busy ? "Disconnecting…" : "Disconnect and remove"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm leading-relaxed">
        <section aria-labelledby="disconnect-removed">
          <h3 id="disconnect-removed" className="font-medium text-fg">
            Removed from Willder
          </h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-fg-muted">
            {removed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="disconnect-kept">
          <h3 id="disconnect-kept" className="font-medium text-fg">
            Kept
          </h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-fg-muted">
            {kept.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <p className="text-fg-subtle">To bring the content back, connect the source again and sync it.</p>
      </div>
    </Modal>
  );
}
