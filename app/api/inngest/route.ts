import { serve } from "inngest/next";
import { functions, inngest } from "@/lib/inngest";

// Inngest endpoint — serves the background functions. The Inngest dev server (local)
// and Inngest cloud (prod) call this to discover and run functions.
export const { GET, POST, PUT } = serve({ client: inngest, functions });
