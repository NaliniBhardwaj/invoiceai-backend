import type { AiToolContext } from "@/features/ai-assistant/tool-registry";

export interface ConversationContext {
  organizationName: string;
  recentCustomerNames: string[];
  openInvoiceCount: number;
}

export async function buildContext(_ctx: AiToolContext): Promise<ConversationContext> {
  throw new Error("buildContext not yet implemented — pending Phase 5 (depends on Invoice/Customer services)");
}
