import { env } from "@/config/env";
import { logger } from "@/config/logger";
import { toolRegistry } from "@/features/ai-assistant/tool-registry";

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

interface ClassifiedIntent {
  toolName: string | null;
  toolArgs: Record<string, unknown>;
  directResponse: string | null;
  /** Set when the failure was a rate limit, so callers can decide whether to
   *  surface a "try again in N seconds" message or queue a retry. */
  rateLimited?: { retryAfterSeconds: number };
}

/**
 * Parse the retry delay (in seconds) from a Gemini 429 error response.
 * Falls back to a default if parsing fails.
 */
function parseRetryDelay(errorText: string, fallbackSeconds = 30): number {
  try {
    const errorBody = JSON.parse(errorText);
    const retryDetail = errorBody?.error?.details?.find(
      (d: { "@type": string }) => d["@type"]?.includes("RetryInfo")
    );
    if (retryDetail?.retryDelay) {
      const seconds = parseInt(retryDetail.retryDelay, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds;
    }
  } catch {
    // Parsing failed — use fallback
  }
  return fallbackSeconds;
}

export async function classifyIntent(
  userMessage: string,
  conversationContext: string
): Promise<ClassifiedIntent> {
  if (!env.GEMINI_API_KEY) {
    return {
      toolName: null,
      toolArgs: {},
      directResponse:
        "The AI assistant is not configured yet — set GEMINI_API_KEY in your environment to enable it.",
    };
  }

  const tools = toolRegistry.list().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const systemInstruction = `You are InvoiceAI's financial operations assistant for Indian SMEs.
You help with invoicing, GST reconciliation, and financial reporting.
When a user request maps to a specific business action, call the appropriate tool.
When explaining or answering questions, respond conversationally.
Always refer to amounts in Indian Rupees (Rs.).
${conversationContext}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    tools: [{ function_declarations: tools }],
    tool_config: { function_calling_config: { mode: "AUTO" } },
  };

  // Single attempt — no synchronous retry/sleep here. Holding an HTTP
  // request open for a minute-plus while we wait out a rate limit ties up
  // a connection for no benefit: most frontends time out well before that,
  // and a client-side retry on top of a server-side retry just doubles the
  // load on the same quota. On 429, we fail fast and tell the caller how
  // long to actually wait, so *they* can decide whether to surface that to
  // the user, queue a background retry, or just let the user re-send.
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY, // auth keys go in a header, not ?key=
      },
      body: JSON.stringify(body),
    }
  );

  if (response.ok) {
    const data = (await response.json()) as {
      candidates: Array<{
        content: {
          parts: Array<{ functionCall?: GeminiFunctionCall; text?: string }>;
        };
      }>;
    };

    const parts = data.candidates[0]?.content?.parts ?? [];
    const functionCallPart = parts.find((p) => p.functionCall);
    const textPart = parts.find((p) => p.text);

    if (functionCallPart?.functionCall) {
      return {
        toolName: functionCallPart.functionCall.name,
        toolArgs: functionCallPart.functionCall.args,
        directResponse: null,
      };
    }

    return {
      toolName: null,
      toolArgs: {},
      directResponse: textPart?.text ?? "I couldn't understand that request. Could you rephrase it?",
    };
  }

  const errorText = await response.text();

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryDelay(errorText);
    logger.warn(
      { status: 429, retryAfterSeconds },
      "Gemini API rate-limited — failing fast, no synchronous retry"
    );
    return {
      toolName: null,
      toolArgs: {},
      directResponse: `The AI assistant is handling a lot of requests right now. Please try again in about ${retryAfterSeconds} seconds.`,
      rateLimited: { retryAfterSeconds },
    };
  }

  // Non-429 error — don't retry
  logger.error({ status: response.status, error: errorText }, "Gemini API error");
  return {
    toolName: null,
    toolArgs: {},
    directResponse: "The AI assistant encountered an unexpected error. Please try again later.",
  };
}