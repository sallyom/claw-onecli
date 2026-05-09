#!/usr/bin/env node

import { spawn } from "node:child_process";

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(input));
  });
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function parseRequest(input) {
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ids)) {
    throw new Error("invalid exec SecretRef request");
  }
  return {
    protocolVersion: 1,
    ids: parsed.ids.filter((id) => typeof id === "string" && id.length > 0),
  };
}

function resolveFromInlineValues(ids) {
  const raw = process.env.ONECLI_SECRET_VALUES_JSON;
  if (!raw) {
    return undefined;
  }
  const values = JSON.parse(raw);
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("ONECLI_SECRET_VALUES_JSON must be a JSON object");
  }
  const response = { protocolVersion: 1, values: {}, errors: {} };
  for (const id of ids) {
    if (typeof values[id] === "string") {
      response.values[id] = values[id];
    } else {
      response.errors[id] = {
        message: "OneCLI credential id was not present in ONECLI_SECRET_VALUES_JSON.",
      };
    }
  }
  return response;
}

function parseResolverArgs() {
  const raw = process.env.ONECLI_SECRET_RESOLVER_ARGS_JSON;
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("ONECLI_SECRET_RESOLVER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

async function callExternalResolver(input) {
  const command = process.env.ONECLI_SECRET_RESOLVER_COMMAND;
  if (!command) {
    return undefined;
  }
  const args = parseResolverArgs();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: false,
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
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`OneCLI resolver failed (${signal ?? code ?? "unknown"}): ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

function unavailableResponse(ids) {
  const errors = {};
  for (const id of ids) {
    errors[id] = {
      message:
        "OneCLI raw secret resolver is not configured. Set ONECLI_SECRET_RESOLVER_COMMAND or ONECLI_SECRET_VALUES_JSON.",
    };
  }
  return { protocolVersion: 1, values: {}, errors };
}

async function main() {
  const input = await readStdin();
  const request = parseRequest(input);
  const inline = resolveFromInlineValues(request.ids);
  if (inline) {
    writeResponse(inline);
    return;
  }
  const external = await callExternalResolver(input);
  if (external !== undefined) {
    process.stdout.write(external);
    if (!external.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }
  writeResponse(unavailableResponse(request.ids));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeResponse({
    protocolVersion: 1,
    values: {},
    errors: {
      request: { message },
    },
  });
});
