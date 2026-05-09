import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const resolverPath = fileURLToPath(new URL("../secret-ref-resolver.js", import.meta.url));

function runResolver(params: {
  request: unknown;
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(params.env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(`${JSON.stringify(params.request)}\n`);
  });
}

describe("onecli SecretRef resolver", () => {
  it("resolves requested ids from the inline values fallback", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onecli",
        ids: ["providers/openai/apiKey"],
      },
      env: {
        ONECLI_SECRET_VALUES_JSON: JSON.stringify({
          "providers/openai/apiKey": "not-a-real-value",
        }),
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {
        "providers/openai/apiKey": "not-a-real-value",
      },
      errors: {},
    });
  });

  it("returns per-id errors when no OneCLI raw secret resolver is configured", async () => {
    const result = await runResolver({
      request: {
        protocolVersion: 1,
        provider: "onecli",
        ids: ["providers/anthropic/apiKey"],
      },
      env: {
        ONECLI_SECRET_VALUES_JSON: "",
        ONECLI_SECRET_RESOLVER_COMMAND: "",
      },
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      protocolVersion: 1,
      values: {},
      errors: {
        "providers/anthropic/apiKey": {
          message:
            "OneCLI raw secret resolver is not configured. Set ONECLI_SECRET_RESOLVER_COMMAND or ONECLI_SECRET_VALUES_JSON.",
        },
      },
    });
  });
});
