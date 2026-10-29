import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/mermaid-diagram";

/**
 * Compact GFM markdown renderer for agent brief/report section content — tables, lists,
 * headings, code, links — on the text roles (fg, fg-muted, fg-subtle) and the accent. Tuned lighter
 * than the legal-doc renderer (components/legal/markdown.tsx) because this prose is embedded
 * inside already-titled report sections, not a standalone document. Safe by default:
 * react-markdown does not evaluate raw HTML, so model output is not injected as markup.
 */
const components: Components = {
  h1: ({ children }) => <h3 className="mt-5 text-base font-semibold text-fg first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 text-base font-semibold text-fg first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 text-sm font-semibold text-fg first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="mt-3 text-base leading-relaxed text-fg-muted first:mt-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mt-3 space-y-2 text-base leading-relaxed text-fg-muted first:mt-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-3 list-decimal space-y-2 pl-5 text-base leading-relaxed text-fg-muted first:mt-0">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="flex items-start gap-2.5 [ol_&]:list-item [ol_&]:pl-1">
      <span aria-hidden="true" className="mt-2.5 hidden h-1 w-1 shrink-0 rounded-full bg-accent [ul_&]:block" />
      <span className="flex-1">{children}</span>
    </li>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
      className="break-words text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    // ```mermaid fences arrive as a <code class="language-mermaid"> — render the
    // diagram inline instead of a plain code element. Everything else is untouched.
    if (typeof className === "string" && /\blanguage-mermaid\b/.test(className)) {
      return <MermaidDiagram chart={String(children).replace(/\n$/, "")} />;
    }
    return (
      <code className="break-words rounded bg-fg/[0.06] px-1.5 py-0.5 font-mono text-[0.875em] text-fg">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mt-3 overflow-x-auto rounded-xl border border-divider bg-fg/[0.04] p-3 text-xs leading-relaxed text-fg-muted first:mt-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-3 border-l-2 border-accent/50 pl-4 text-fg-muted first:mt-0">{children}</blockquote>
  ),
  hr: () => <div aria-hidden className="my-6 h-px w-full bg-divider" />,
  table: ({ children }) => (
    <div className="mt-3 overflow-x-auto rounded-xl border border-divider first:mt-0">
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-fg/[0.04] text-sm text-fg-subtle">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-t border-divider align-top">{children}</tr>,
  th: ({ children }) => <th className="px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 text-sm leading-relaxed text-fg-muted">{children}</td>,
};

export function Markdown({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
