import { Card } from "@/components/ui";

/** Stands in for a panel this person may not load, naming who can help. */
export function AdminOnly({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4 sm:p-6">
      <h2 className="text-base font-semibold text-fg sm:text-lg">{title}</h2>
      <p className="mt-1 text-sm leading-relaxed text-fg-muted">{children}</p>
    </Card>
  );
}
