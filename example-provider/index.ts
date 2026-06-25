/**
 * Example Provider Extension
 *
 * A minimal provider extension demonstrating the basic structure.
 * Replace this with your actual API provider implementation.
 *
 * ## Quick Start
 *
 * 1. Define your models in the MODELS array below
 * 2. Configure baseUrl, apiKey, and api format in registerProvider()
 * 3. Set compat options to match your API's behavior
 *
 * ## Testing
 *
 *   pi -e ./example-provider/index.ts
 *   /login → "Use an API key" → example → paste your key
 *   /model example/your-model-id
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Model Definitions
// =============================================================================

interface ExampleModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

const MODELS: ExampleModel[] = [
  {
    id: "example-model",
    name: "Example Model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  // Add more models here...
];

// =============================================================================
// Compat Settings
// =============================================================================

/**
 * Adjust these based on your API's behavior:
 *
 * - supportsDeveloperRole:  Does the API accept "developer" role? (OpenAI uses it, others may not)
 * - requiresToolResultName: Does the API require "name" in tool results?
 * - maxTokensField:         "max_tokens" | "max_completion_tokens" | "max_output_tokens"
 * - thinkingFormat:         "qwen" | "anthropic" | "gemini" | undefined (for reasoning models)
 */
const BASE_COMPAT = {
  supportsDeveloperRole: false,
  requiresToolResultName: false,
  maxTokensField: "max_tokens" as const,
} as const;

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerProvider("example", {
    name: "Example Provider",
    baseUrl: "https://api.example.com/v1",
    apiKey: "$EXAMPLE_API_KEY",
    api: "openai-completions",
    authHeader: true,

    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: BASE_COMPAT,
    })),
  });
}
