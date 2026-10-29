import { redirect } from "next/navigation";

// /memory is split into /memory/ask and /memory/explore; Ask is the default.
// A ?scope= link keeps working: it is carried over untouched, and the Ask page
// validates it like any other request.
export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ scope?: string | string[] }> }) {
  const { scope } = await searchParams;
  redirect(typeof scope === "string" ? `/memory/ask?scope=${encodeURIComponent(scope)}` : "/memory/ask");
}
