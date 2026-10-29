// Central LLM client — Azure OpenAI.
// Required env vars:
//   OPENAI_API_KEY      — Azure OpenAI API key
//   OPENAI_BASE_URL     — https://<resource>.openai.azure.com/openai/deployments/<deployment>
//   OPENAI_API_VERSION  — e.g. 2024-08-01-preview
import OpenAI from "openai";

export function createLLMClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const baseURL = process.env.OPENAI_BASE_URL;
  const apiVersion = process.env.OPENAI_API_VERSION;

  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(apiVersion
      ? {
          defaultQuery: { "api-version": apiVersion },
          defaultHeaders: { "api-key": apiKey },
        }
      : {}),
  });
}

export const LLM_MODEL_EXTRACT = process.env.OPENAI_MODEL_EXTRACT ?? "gpt-4o-mini";
export const LLM_MODEL_ORCHESTRATOR = process.env.OPENAI_MODEL_ORCHESTRATOR ?? "gpt-4o-mini";
