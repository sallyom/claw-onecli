import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "onecli",
  name: "OneCLI",
  description: "OneCLI SecretRef provider integration",
  register(api: OpenClawPluginApi) {
    api.registerCli(
      async ({ program, config }) => {
        const { registerOneCliCommands } = await import("./cli.js");
        registerOneCliCommands({ program, config });
      },
      {
        descriptors: [
          {
            name: "onecli",
            description: "Manage the OneCLI SecretRef provider integration",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
