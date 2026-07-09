// Action handlers register themselves into the ToolRegistry on import.
// They must be imported here before classifyIntent runs so the registry
// is populated. Order doesn't matter — each import is a side-effect registration.
import "@/features/ai-assistant/actions/create-invoice.action";
import "@/features/ai-assistant/actions/summarize-invoices.action";
import "@/features/ai-assistant/actions/run-reconciliation.action";
import "@/features/ai-assistant/actions/explain-reconciliation.action";
import "@/features/ai-assistant/actions/find-gst-mismatches.action";

import { prisma } from "@/shared/prisma/client";
import { eventBus } from "@/shared/events/event-bus";
import { EventTypes } from "@/shared/events/domain-event";
import { conversationStore } from "@/features/ai-assistant/conversation-store";
import { classifyIntent } from "@/features/ai-assistant/intent-classifier";
import { toolRegistry } from "@/features/ai-assistant/tool-registry";

export interface ChatInput {
  message: string;
  conversationId?: string;
}

export interface ChatResponse {
  conversationId: string;
  response: string;
  actionTaken: string | null;
  actionData: Record<string, unknown> | null;
  /** Present only when the assistant call was rate-limited, so the client
   *  can disable the input / show a countdown instead of treating this like
   *  a normal reply. */
  retryAfterSeconds?: number;
}

class AiAssistantService {
  async chat(
    organizationId: string,
    userId: string,
    input: ChatInput
  ): Promise<ChatResponse> {
    const conversationId =
      input.conversationId ?? (await conversationStore.createConversation(organizationId, userId));

    await conversationStore.appendMessage(conversationId, "user", input.message);

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true, state: true },
    });
    const context = `Organization: ${org.name} (State: ${org.state})`;

    const intent = await classifyIntent(input.message, context);

    let responseText: string;
    let actionTaken: string | null = null;
    let actionData: Record<string, unknown> | null = null;

    if (intent.rateLimited) {
      // Don't treat this as a normal assistant turn: no tool was attempted,
      // nothing happened on the user's behalf. Still log it to history so
      // the conversation reads naturally, but skip the AI_ACTION_PERFORMED
      // event since no action occurred.
      responseText = intent.directResponse ?? "The AI assistant is rate-limited. Please try again shortly.";
    } else if (intent.toolName) {
      const tool = toolRegistry.get(intent.toolName);
      if (tool) {
        const result = await tool.handler(intent.toolArgs, { organizationId, userId });
        responseText = result.message;
        actionTaken = intent.toolName;
        actionData = result.data ? (result.data as Record<string, unknown>) : null;

        await eventBus.emit(
          EventTypes.AI_ACTION_PERFORMED,
          organizationId,
          {
            entityType: "AIAction",
            entityId: conversationId,
            toolName: intent.toolName,
            success: result.success,
          },
          userId
        );
      } else {
        responseText = `I understood you want to ${intent.toolName.replace(/_/g, " ")}, but that action isn't available yet.`;
      }
    } else {
      responseText = intent.directResponse ?? "I couldn't process that request.";
    }

    await conversationStore.appendMessage(
      conversationId,
      "assistant",
      responseText,
      actionTaken ?? undefined,
      actionData ?? undefined
    );

    return {
      conversationId,
      response: responseText,
      actionTaken,
      actionData,
      ...(intent.rateLimited ? { retryAfterSeconds: intent.rateLimited.retryAfterSeconds } : {}),
    };
  }

  async getConversation(organizationId: string, conversationId: string) {
    const conversation = await prisma.aIConversation.findFirst({
      where: { id: conversationId, organizationId },
    });
    if (!conversation) return null;
    const messages = await conversationStore.getHistory(conversationId);
    return { ...conversation, messages };
  }
}

export const aiAssistantService = new AiAssistantService();