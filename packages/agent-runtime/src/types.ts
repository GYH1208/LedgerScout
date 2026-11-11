export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  callId?: string; name?: string; toolCalls?: ToolCall[];
};
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type RuntimeTool = ToolDefinition & {
  execute(args: Record<string, unknown>, callId: string, signal?: AbortSignal): Promise<unknown>;
};
export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ModelRequest = { messages: ChatMessage[]; tools: ToolDefinition[]; signal?: AbortSignal; finalOnly?: boolean };
export type ModelReply = { content: string; toolCalls?: ToolCall[]; usage?: ModelUsage; truncated?: boolean };
export type RequestModel = (request: ModelRequest) => Promise<ModelReply>;
export type EngineEvent = { type: string; [key: string]: unknown };
export type RunStatus = 'completed' | 'partial' | 'awaiting_user' | 'failed' | 'cancelled' | 'exhausted';
