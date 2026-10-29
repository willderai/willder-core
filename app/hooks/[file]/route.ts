// GET /hooks/<file>: the Claude Code hook that `willder init` installs, served by the site
// so a project can install it without a copy of this repository (/docs/claude-code).
//
// The one rule this file enforces: it serves the files in PUBLISHED_HOOK_FILES exactly as
// cli/hooks holds them in this build, and nothing else. Each is rendered once at build time
// (force-static, no other params), so a request never reaches the filesystem.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PUBLISHED_HOOK_FILES } from "@/lib/docs";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return PUBLISHED_HOOK_FILES.map((file) => ({ file }));
}

const isPublished = (file: string): boolean => (PUBLISHED_HOOK_FILES as readonly string[]).includes(file);

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await params;
  if (!isPublished(file)) return new Response("Not found", { status: 404 });
  const source = await readFile(join(process.cwd(), "cli/hooks", file), "utf8");
  return new Response(source, { headers: { "content-type": "text/javascript; charset=utf-8" } });
}
