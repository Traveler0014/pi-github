/**
 * Example Plugin — Tool Extension
 *
 * Demonstrates registering custom tools and commands in pi.
 * This is a template showing the structure for utility/tool extensions.
 *
 * ## What this extension provides
 *
 * - A custom tool: `example_tool` — callable by the AI during conversations
 * - A slash command: `/example` — user-invokable command in pi
 *
 * ## Testing
 *
 *   pi -e ./tools/example-plugin/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ── Register a custom tool ───────────────────────────────────────────────
  //
  // Tools are callable by the AI model during conversations.
  // The handler receives the tool arguments and returns a result string.

  pi.registerTool({
    name: "example_tool",
    description: "An example tool — replace with your actual implementation",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The input query to process",
        },
      },
      required: ["query"],
    },
    async execute({ query }) {
      // Replace with your actual tool logic
      return `Processed: ${query}`;
    },
  });

  // ── Register a slash command ─────────────────────────────────────────────
  //
  // Commands are user-invokable via /command-name in the pi TUI.

  pi.registerCommand("example", {
    description: "An example command — replace with your actual implementation",
    async execute(_args, context) {
      // context provides access to pi's runtime (conversation, config, etc.)
      return "Hello from example command! Replace this with your logic.";
    },
  });
}
