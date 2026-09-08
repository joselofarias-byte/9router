import { CLI_TOOLS as BASE_CLI_TOOLS, MITM_TOOLS } from "./cliTools";

export { MITM_TOOLS };

// Keep the upstream CLI tool catalog intact while extending the effective registry
// with Pi. Consumers should import CLI_TOOLS from this module.
export const CLI_TOOLS = {
  ...BASE_CLI_TOOLS,
  pi: {
    id: "pi",
    name: "Pi",
    image: "/providers/pi.svg",
    color: "#111827",
    description: "Pi coding agent — lightweight terminal agent with custom model providers",
    configType: "custom",
    docsUrl: "https://github.com/earendil-works/pi",
    defaultCommand: "pi",
    notes: [
      { type: "info", text: "9Router writes a custom provider to ~/.pi/agent/models.json using Pi's OpenAI Chat Completions adapter." },
      { type: "info", text: "All currently enabled 9Router models are discovered automatically and keep their real routed model IDs." },
      { type: "warning", text: "PI_CODING_AGENT_DIR is honored when Pi uses a custom configuration directory." },
    ],
  },
};
