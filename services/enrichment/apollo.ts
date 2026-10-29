// Apollo — firmographic + people enrichment. Company data (industry, size, revenue,
// description) by domain; person data (title, seniority, company) by email. Plain
// fetch (no SDK). Returns a compact text block to fold into the memory episode, or
// throws on a hard failure (the orchestrator records the provider as failed and
// keeps the others).
const APOLLO_BASE = "https://api.apollo.io/api/v1";

async function apollo<T>(path: string, query: Record<string, string>): Promise<T> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new Error("APOLLO_API_KEY is not set");
  const url = new URL(`${APOLLO_BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "x-api-key": key },
  });
  if (!res.ok) throw new Error(`Apollo ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

interface ApolloOrg {
  name?: string;
  website_url?: string;
  industry?: string;
  estimated_num_employees?: number;
  annual_revenue_printed?: string;
  short_description?: string;
  keywords?: string[];
}

interface ApolloPerson {
  name?: string;
  title?: string;
  seniority?: string;
  headline?: string;
  organization?: { name?: string; industry?: string };
}

const line = (label: string, v: unknown) => (v === undefined || v === null || v === "" ? null : `- ${label}: ${v}`);

/** Company firmographics by domain. Returns a labeled text block. */
export async function enrichOrganization(domain: string): Promise<string> {
  const { organization: o } = await apollo<{ organization?: ApolloOrg }>("/organizations/enrich", { domain });
  if (!o) throw new Error(`Apollo found no organization for ${domain}`);
  const facts = [
    line("Name", o.name),
    line("Website", o.website_url),
    line("Industry", o.industry),
    line("Employees", o.estimated_num_employees),
    line("Annual revenue", o.annual_revenue_printed),
    line("Keywords", o.keywords?.slice(0, 8).join(", ")),
    line("Description", o.short_description),
  ].filter(Boolean);
  if (facts.length === 0) throw new Error(`Apollo returned an empty organization for ${domain}`);
  return `Company firmographics (Apollo):\n${facts.join("\n")}`;
}

/** Person enrichment by email. Returns a labeled text block. */
export async function enrichPerson(email: string): Promise<string> {
  const { person: p } = await apollo<{ person?: ApolloPerson }>("/people/match", { email });
  if (!p) throw new Error(`Apollo found no person for ${email}`);
  const facts = [
    line("Name", p.name),
    line("Title", p.title),
    line("Seniority", p.seniority),
    line("Headline", p.headline),
    line("Company", p.organization?.name),
    line("Company industry", p.organization?.industry),
  ].filter(Boolean);
  if (facts.length === 0) throw new Error(`Apollo returned an empty person for ${email}`);
  return `Person profile (Apollo):\n${facts.join("\n")}`;
}
