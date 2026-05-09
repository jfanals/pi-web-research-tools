import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const DEEPWIKI_MCP_URL = process.env.DEEPWIKI_MCP_URL ?? "https://mcp.deepwiki.com/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";

type TextResultDetails = {
  query?: string;
  model?: string;
  repo?: string;
  action?: string;
  error?: boolean;
  message?: string;
  status?: number;
  cancelled?: boolean;
  sources?: Array<{ title: string; uri: string }>;
  usage?: unknown;
};

interface GeminiGroundingChunk {
  web?: { uri: string; title: string };
}

interface GeminiCandidate {
  content: { parts: Array<{ text?: string }>; role: string };
  groundingMetadata?: {
    groundingChunks?: GeminiGroundingChunk[];
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message: string };
  usageMetadata?: unknown;
}

interface PerplexityResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  citations?: string[];
  search_results?: Array<{
    title?: string;
    url?: string;
  }>;
  usage?: unknown;
  error?: { message?: string };
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

function formatSources(sources: Array<{ title: string; uri: string }>): string {
  if (sources.length === 0) return "";
  const lines = ["", "**Sources:**"];
  for (const source of sources) lines.push(`- [${source.title}](${source.uri})`);
  return lines.join("\n");
}

function renderPreview(result: string, expanded: boolean, theme: Theme): Text {
  const lines = result.split("\n");
  const previewLines = 3;
  if (expanded || lines.length <= previewLines) return new Text(result, 0, 0);
  return new Text(
    lines.slice(0, previewLines).join("\n") +
      "\n" +
      theme.fg("dim", `... ${lines.length - previewLines} more lines (${keyHint("expandTools", "to expand")})`),
    0,
    0,
  );
}

function renderQuery(theme: Theme, toolName: string, query: string, suffix?: string): string {
  let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
  if (suffix) text += theme.fg("dim", suffix);
  text += "\n" + theme.fg("dim", query);
  return text;
}

function errorResult(details: TextResultDetails, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError: true,
  };
}

function successResult(text: string, details: TextResultDetails = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function formatGeminiResponse(data: GeminiResponse) {
  const candidate = data.candidates?.[0];
  if (!candidate) return { text: "No response received from Gemini.", sources: [] as Array<{ title: string; uri: string }> };
  const text = candidate.content.parts.map((p) => p.text ?? "").join("\n").trim() || "No response received from Gemini.";
  const seen = new Set<string>();
  const sources = (candidate.groundingMetadata?.groundingChunks ?? [])
    .flatMap((chunk) => {
      if (!chunk.web?.uri || !chunk.web?.title) return [];
      const key = `${chunk.web.title} ${chunk.web.uri}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ title: chunk.web.title, uri: chunk.web.uri }];
    });
  return { text: text + formatSources(sources), sources };
}

function formatPerplexityResponse(data: PerplexityResponse) {
  const text = data.choices?.[0]?.message?.content?.trim() || "No response received from Perplexity.";
  const fromSearchResults = (data.search_results ?? [])
    .filter((item) => item.title && item.url)
    .map((item) => ({ title: item.title!, uri: item.url! }));
  const fallbackCitations = (data.citations ?? []).map((uri, index) => ({ title: `Citation ${index + 1}`, uri }));
  const sources = fromSearchResults.length > 0 ? fromSearchResults : fallbackCitations;
  return { text: text + formatSources(sources), sources };
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function callDeepWikiTool(name: string, args: Record<string, unknown>) {
  const response = await fetch(DEEPWIKI_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${Date.now()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    return { ok: false, status: response.status, message: typeof data?.raw === "string" ? data.raw : JSON.stringify(data) };
  }

  if (data?.error?.message) return { ok: false, status: 500, message: String(data.error.message) };
  const result = data?.result as McpToolResult | undefined;
  if (result?.isError) {
    const text = result.content?.map((item) => item.text ?? "").join("\n").trim() || "DeepWiki returned an error.";
    return { ok: false, status: 500, message: text };
  }

  const text = result?.content?.map((item) => item.text ?? "").join("\n").trim() || "No response received from DeepWiki.";
  return { ok: true, text };
}

export default function webResearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "google_search",
    label: "Google Search",
    description:
      "Search the web using Google Search grounded through Gemini. Returns accurate, cited answers synthesized from live Google Search results.",
    promptGuidelines: [
      "Use google_search for current events, fast factual web research, and questions that benefit from live Google-grounded sources.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query or question to research on the web" }),
      model: Type.Optional(StringEnum(["flash", "pro"] as const, { description: 'Model to use: "flash" or "pro". Default: flash.' })),
    }),
    renderCall(args, theme) {
      const modelName = args.model === "pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
      return new Text(renderQuery(theme, "google", args.query, `search (${modelName})`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as TextResultDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", `Error: ${details.message ?? `API returned ${details.status}`}`), 0, 0);
      if (details?.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const content = result.content[0];
      const answer = content?.type === "text" ? content.text : "";
      return renderPreview(answer, expanded, theme);
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const modelName = params.model === "pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
      if (!GOOGLE_API_KEY) {
        return errorResult({ query: params.query, model: modelName, error: true }, "Error: GOOGLE_API_KEY environment variable is not set.");
      }
      onUpdate?.({ content: [{ type: "text", text: "Searching..." }], details: { query: params.query, model: modelName } });
      try {
        const response = await fetch(`${GEMINI_API_URL}/${modelName}:generateContent?key=${GOOGLE_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: params.query }] }],
            tools: [{ google_search: {} }],
          }),
          signal,
        });
        const data = (await parseJsonResponse(response)) as GeminiResponse & { raw?: string };
        if (!response.ok) {
          return errorResult(
            { query: params.query, model: modelName, error: true, status: response.status },
            `Error: Gemini API returned ${response.status}: ${typeof data.raw === "string" ? data.raw : JSON.stringify(data)}`,
          );
        }
        if (data.error?.message) return errorResult({ query: params.query, model: modelName, error: true, message: data.error.message }, `Gemini API error: ${data.error.message}`);
        const formatted = formatGeminiResponse(data);
        return successResult(formatted.text, { query: params.query, model: modelName, sources: formatted.sources, usage: data.usageMetadata });
      } catch (error) {
        if (signal.aborted) return successResult("Search cancelled", { query: params.query, model: modelName, cancelled: true });
        const message = error instanceof Error ? error.message : String(error);
        return errorResult({ query: params.query, model: modelName, error: true, message }, `Google Search error: ${message}`);
      }
    },
  });

  pi.registerTool({
    name: "perplexity_search",
    label: "Perplexity Search",
    description: "Search the web using Perplexity AI. Returns a synthesized answer with citations.",
    promptGuidelines: [
      "Use perplexity_search for broader synthesis, source-backed web research, and questions where Perplexity's grounded answers may be helpful.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query or question to research on the web" }),
      model: Type.Optional(
        StringEnum(["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"] as const, {
          description: 'Model to use. Default: "sonar".',
        }),
      ),
    }),
    renderCall(args, theme) {
      return new Text(renderQuery(theme, "perplexity", args.query, `search (${args.model ?? "sonar"})`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as TextResultDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", `Error: ${details.message ?? `API returned ${details.status}`}`), 0, 0);
      if (details?.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const content = result.content[0];
      const answer = content?.type === "text" ? content.text : "";
      return renderPreview(answer, expanded, theme);
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const modelName = params.model ?? "sonar";
      if (!PERPLEXITY_API_KEY) {
        return errorResult({ query: params.query, model: modelName, error: true }, "Error: PERPLEXITY_API_KEY environment variable is not set.");
      }
      onUpdate?.({ content: [{ type: "text", text: "Searching..." }], details: { query: params.query, model: modelName } });
      try {
        const response = await fetch(PERPLEXITY_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: "user", content: params.query }],
          }),
          signal,
        });
        const data = (await parseJsonResponse(response)) as PerplexityResponse & { raw?: string };
        if (!response.ok) {
          const message = data.error?.message ?? (typeof data.raw === "string" ? data.raw : JSON.stringify(data));
          return errorResult({ query: params.query, model: modelName, error: true, status: response.status, message }, `Perplexity API returned ${response.status}: ${message}`);
        }
        const formatted = formatPerplexityResponse(data);
        return successResult(formatted.text, { query: params.query, model: modelName, sources: formatted.sources, usage: data.usage });
      } catch (error) {
        if (signal.aborted) return successResult("Search cancelled", { query: params.query, model: modelName, cancelled: true });
        const message = error instanceof Error ? error.message : String(error);
        return errorResult({ query: params.query, model: modelName, error: true, message }, `Perplexity Search error: ${message}`);
      }
    },
  });

  pi.registerTool({
    name: "deepwiki",
    label: "DeepWiki",
    description:
      "Query any public GitHub repository's codebase and documentation via DeepWiki. Use it as a knowledge source or architectural consultant.",
    promptGuidelines: [
      "Use deepwiki for questions about public GitHub repositories, how a library works internally, or how a project would structure a solution.",
      "Use deepwiki action structure before deepwiki read when you need an overview of the wiki first.",
    ],
    parameters: Type.Object({
      action: StringEnum(["ask", "structure", "read"] as const, { description: 'Action to perform: "ask", "structure", or "read".' }),
      repo: Type.String({ description: 'GitHub repo in "owner/repo" format. For ask, you may also pass a comma-separated list for multi-repo questions if DeepWiki supports it.' }),
      question: Type.Optional(Type.String({ description: "Question to ask about the repo. Required for ask action." })),
    }),
    prepareArguments(args) {
      if (args && typeof args === "object" && "repository" in (args as Record<string, unknown>) && !("repo" in (args as Record<string, unknown>))) {
        return { ...args, repo: (args as Record<string, unknown>).repository };
      }
      return args;
    },
    renderCall(args, theme) {
      const suffix = `${args.action} ${args.repo}`;
      const detail = args.question ? `${suffix}\n${args.question}` : suffix;
      return new Text(renderQuery(theme, "deepwiki", detail), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as TextResultDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", `Error: ${details.message ?? `API returned ${details.status}`}`), 0, 0);
      if (details?.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const content = result.content[0];
      const answer = content?.type === "text" ? content.text : "";
      return renderPreview(answer, expanded, theme);
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      if (params.action === "ask" && !params.question?.trim()) {
        return errorResult({ action: params.action, repo: params.repo, error: true, message: "question is required for ask" }, "DeepWiki error: question is required when action is \"ask\".");
      }
      onUpdate?.({ content: [{ type: "text", text: "Querying DeepWiki..." }], details: { action: params.action, repo: params.repo } });
      try {
        if (signal.aborted) return successResult("Query cancelled", { action: params.action, repo: params.repo, cancelled: true });
        const response =
          params.action === "ask"
            ? await callDeepWikiTool("ask_question", { repoName: params.repo, question: params.question })
            : params.action === "structure"
              ? await callDeepWikiTool("read_wiki_structure", { repoName: params.repo })
              : await callDeepWikiTool("read_wiki_contents", { repoName: params.repo });
        if (!response.ok) {
          return errorResult({ action: params.action, repo: params.repo, error: true, status: response.status, message: response.message }, `DeepWiki error: ${response.message}`);
        }
        return successResult(response.text, { action: params.action, repo: params.repo, query: params.question });
      } catch (error) {
        if (signal.aborted) return successResult("Query cancelled", { action: params.action, repo: params.repo, cancelled: true });
        const message = error instanceof Error ? error.message : String(error);
        return errorResult({ action: params.action, repo: params.repo, error: true, message }, `DeepWiki error: ${message}`);
      }
    },
  });
}
