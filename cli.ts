import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

type SecretRef = {
  source: "exec";
  provider: string;
  id: string;
};

type SecretsPlanTarget = {
  type: "models.providers.apiKey";
  path: string;
  pathSegments: string[];
  providerId: string;
  ref: SecretRef;
};

type SecretsApplyPlan = {
  version: 1;
  protocolVersion: 1;
  generatedAt: string;
  generatedBy: "manual";
  providerUpserts: Record<string, OneCliExecProviderConfig>;
  targets: SecretsPlanTarget[];
};

type OneCliExecProviderConfig = {
  source: "exec";
  command: string;
  args: string[];
  timeoutMs: number;
  noOutputTimeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
  passEnv: string[];
};

type RegisterOneCliCommandsParams = {
  program: Command;
  config: OpenClawConfig;
};

type StatusOptions = {
  json?: boolean;
  dashboardUrl?: string;
  gatewayUrl?: string;
};

type SetupOptions = {
  planOut?: string;
  providerAlias?: string;
  resolverCommand?: string;
  resolverArgsJson?: string;
  openaiId?: string;
  anthropicId?: string;
  yes?: boolean;
  skipApply?: boolean;
  skipAudit?: boolean;
  skipReload?: boolean;
  startOnecli?: boolean;
  openDashboard?: boolean;
  containerEngine?: string;
  containerName?: string;
  dashboardPort?: string;
  gatewayPort?: string;
  dataVolume?: string;
  image?: string;
  dashboardUrl?: string;
};

type ProviderStatus = {
  configured: boolean;
  source?: string;
  command?: string;
};

type OneCliServiceOptions = {
  containerEngine?: string;
  containerName?: string;
  dashboardPort?: string;
  gatewayPort?: string;
  dataVolume?: string;
  image?: string;
  dashboardUrl?: string;
};

type StartOptions = OneCliServiceOptions & {
  open?: boolean;
};

type DashboardOptions = {
  dashboardUrl?: string;
};

const ONECLI_PROVIDER_ALIAS = "onecli";
const DEFAULT_ONECLI_CONTAINER_ENGINE = "podman";
const DEFAULT_ONECLI_CONTAINER_NAME = "onecli";
const DEFAULT_ONECLI_DASHBOARD_PORT = 10254;
const DEFAULT_ONECLI_GATEWAY_PORT = 10255;
const DEFAULT_ONECLI_DATA_VOLUME = "onecli-data";
const DEFAULT_ONECLI_IMAGE = "ghcr.io/onecli/onecli";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function writeLine(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertValidProviderAlias(value: string): void {
  if (!SECRET_PROVIDER_ALIAS_PATTERN.test(value)) {
    throw new Error(
      `Invalid provider alias "${value}". Use lowercase letters, numbers, underscores, or hyphens.`,
    );
  }
}

function assertValidExecSecretId(label: string, value: string): void {
  if (
    !EXEC_SECRET_REF_ID_PATTERN.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Invalid ${label} OneCLI credential id: ${value}`);
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return fallback;
  }
  if (!/^\d{1,5}$/.test(trimmed)) {
    throw new Error(`Invalid port: ${trimmed}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port: ${trimmed}`);
  }
  return parsed;
}

function resolveDashboardUrl(options: { dashboardUrl?: string; dashboardPort?: string }): string {
  return (
    normalizeOptionalString(options.dashboardUrl) ??
    `http://localhost:${parsePort(options.dashboardPort, DEFAULT_ONECLI_DASHBOARD_PORT)}`
  );
}

function buildOneCliContainerRunArgs(options: OneCliServiceOptions): string[] {
  const containerName =
    normalizeOptionalString(options.containerName) ?? DEFAULT_ONECLI_CONTAINER_NAME;
  const dashboardPort = parsePort(options.dashboardPort, DEFAULT_ONECLI_DASHBOARD_PORT);
  const gatewayPort = parsePort(options.gatewayPort, DEFAULT_ONECLI_GATEWAY_PORT);
  const dataVolume = normalizeOptionalString(options.dataVolume) ?? DEFAULT_ONECLI_DATA_VOLUME;
  const image = normalizeOptionalString(options.image) ?? DEFAULT_ONECLI_IMAGE;
  return [
    "run",
    "-d",
    "--pull",
    "always",
    "--name",
    containerName,
    "-p",
    `${dashboardPort}:10254`,
    "-p",
    `${gatewayPort}:10255`,
    "-v",
    `${dataVolume}:/app/data`,
    image,
  ];
}

function openBrowserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

async function runProcess(params: {
  command: string;
  args: string[];
  label: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      stdio: "inherit",
      env: params.env ?? process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${params.label} failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

function readProviderStatus(config: OpenClawConfig, providerAlias: string): ProviderStatus {
  const provider = config.secrets?.providers?.[providerAlias];
  if (!isRecord(provider)) {
    return { configured: false };
  }
  return {
    configured: true,
    source: normalizeOptionalString(provider.source),
    ...(provider.source === "exec" ? { command: normalizeOptionalString(provider.command) } : {}),
  };
}

function resolveResolverScriptPath(): string {
  return fileURLToPath(new URL("./secret-ref-resolver.js", import.meta.url));
}

function buildProviderConfig(options: SetupOptions): OneCliExecProviderConfig {
  const env: Record<string, string> = {};
  const resolverCommand = normalizeOptionalString(options.resolverCommand);
  const resolverArgsJson = normalizeOptionalString(options.resolverArgsJson);
  if (resolverCommand) {
    env.ONECLI_SECRET_RESOLVER_COMMAND = resolverCommand;
  }
  if (resolverArgsJson) {
    env.ONECLI_SECRET_RESOLVER_ARGS_JSON = resolverArgsJson;
  }

  return {
    source: "exec",
    command: process.execPath,
    args: [resolveResolverScriptPath()],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    noOutputTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    passEnv: [
      "HOME",
      "PATH",
      "ONECLI_SECRET_RESOLVER_COMMAND",
      "ONECLI_SECRET_RESOLVER_ARGS_JSON",
      "ONECLI_SECRET_VALUES_JSON",
    ],
  };
}

function createModelApiKeyTarget(params: {
  providerAlias: string;
  providerId: "openai" | "anthropic";
  secretId: string;
}): SecretsPlanTarget {
  return {
    type: "models.providers.apiKey",
    path: `models.providers.${params.providerId}.apiKey`,
    pathSegments: ["models", "providers", params.providerId, "apiKey"],
    providerId: params.providerId,
    ref: {
      source: "exec",
      provider: params.providerAlias,
      id: params.secretId,
    },
  };
}

function buildPlan(params: {
  providerAlias: string;
  providerConfig: OneCliExecProviderConfig;
  openaiId?: string;
  anthropicId?: string;
}): SecretsApplyPlan {
  const targets: SecretsPlanTarget[] = [];
  if (params.openaiId) {
    targets.push(
      createModelApiKeyTarget({
        providerAlias: params.providerAlias,
        providerId: "openai",
        secretId: params.openaiId,
      }),
    );
  }
  if (params.anthropicId) {
    targets.push(
      createModelApiKeyTarget({
        providerAlias: params.providerAlias,
        providerId: "anthropic",
        secretId: params.anthropicId,
      }),
    );
  }
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "manual",
    providerUpserts: {
      [params.providerAlias]: params.providerConfig,
    },
    targets,
  };
}

async function promptOptionalSecretId(label: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return normalizeOptionalString(
      await rl.question(`${label} OneCLI credential id (blank to skip): `),
    );
  } finally {
    rl.close();
  }
}

async function confirmApply(options: SetupOptions): Promise<boolean> {
  if (options.yes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Apply this OneCLI secrets plan now? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

function resolveOpenClawCliArgs(args: string[]): { command: string; args: string[] } {
  const cliScript = process.argv[1];
  if (!cliScript) {
    throw new Error("Unable to locate the running openclaw CLI entrypoint.");
  }
  return {
    command: process.execPath,
    args: [cliScript, ...args],
  };
}

async function runOpenClaw(args: string[]): Promise<void> {
  const command = resolveOpenClawCliArgs(args);
  await runProcess({
    command: command.command,
    args: command.args,
    label: `openclaw ${args.join(" ")}`,
  });
}

async function openDashboard(options: DashboardOptions): Promise<void> {
  const url = resolveDashboardUrl(options);
  const command = openBrowserCommand(url);
  await runProcess({
    command: command.command,
    args: command.args,
    label: `open dashboard ${url}`,
  });
}

async function startOneCli(options: StartOptions): Promise<void> {
  const engine =
    normalizeOptionalString(options.containerEngine) ?? DEFAULT_ONECLI_CONTAINER_ENGINE;
  const args = buildOneCliContainerRunArgs(options);
  await runProcess({
    command: engine,
    args,
    label: `${engine} ${args.join(" ")}`,
  });
  const dashboardUrl = resolveDashboardUrl(options);
  writeLine(`OneCLI dashboard: ${dashboardUrl}`);
  writeLine(
    `OneCLI gateway: http://localhost:${parsePort(options.gatewayPort, DEFAULT_ONECLI_GATEWAY_PORT)}`,
  );
  if (options.open) {
    await openDashboard({ dashboardUrl });
  }
}

async function runStatus(config: OpenClawConfig, options: StatusOptions): Promise<void> {
  const provider = readProviderStatus(config, ONECLI_PROVIDER_ALIAS);
  const result = {
    providerAlias: ONECLI_PROVIDER_ALIAS,
    provider,
    resolverScript: resolveResolverScriptPath(),
    dashboardUrl: resolveDashboardUrl(options),
    gatewayUrl:
      normalizeOptionalString(options.gatewayUrl) ??
      `http://localhost:${DEFAULT_ONECLI_GATEWAY_PORT}`,
  };
  if (options.json) {
    writeJson(result);
    return;
  }
  writeLine(`OneCLI provider: ${provider.configured ? "configured" : "not configured"}`);
  if (provider.source) {
    writeLine(`Source: ${provider.source}`);
  }
  if (provider.command) {
    writeLine(`Command: ${provider.command}`);
  }
  writeLine(`Dashboard: ${result.dashboardUrl}`);
  writeLine(`Gateway: ${result.gatewayUrl}`);
  writeLine(`Resolver: ${result.resolverScript}`);
}

async function runSetup(options: SetupOptions): Promise<void> {
  if (options.startOnecli) {
    await startOneCli({
      containerEngine: options.containerEngine,
      containerName: options.containerName,
      dashboardPort: options.dashboardPort,
      gatewayPort: options.gatewayPort,
      dataVolume: options.dataVolume,
      image: options.image,
      dashboardUrl: options.dashboardUrl,
      open: options.openDashboard,
    });
  } else if (options.openDashboard) {
    await openDashboard({ dashboardUrl: options.dashboardUrl });
  }

  const providerAlias = normalizeOptionalString(options.providerAlias) ?? ONECLI_PROVIDER_ALIAS;
  assertValidProviderAlias(providerAlias);
  const openaiId =
    normalizeOptionalString(options.openaiId) ?? (await promptOptionalSecretId("OpenAI"));
  const anthropicId =
    normalizeOptionalString(options.anthropicId) ?? (await promptOptionalSecretId("Anthropic"));
  if (openaiId) {
    assertValidExecSecretId("OpenAI", openaiId);
  }
  if (anthropicId) {
    assertValidExecSecretId("Anthropic", anthropicId);
  }
  const plan = buildPlan({
    providerAlias,
    providerConfig: buildProviderConfig(options),
    ...(openaiId ? { openaiId } : {}),
    ...(anthropicId ? { anthropicId } : {}),
  });
  const planPath =
    normalizeOptionalString(options.planOut) ??
    path.join(os.tmpdir(), `openclaw-onecli-secrets-${process.pid}.json`);
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  writeLine(`Plan written to ${planPath}`);
  writeLine(`Targets: ${plan.targets.length}`);

  writeLine("Preflighting plan...");
  await runOpenClaw(["secrets", "apply", "--from", planPath, "--dry-run", "--allow-exec"]);

  if (options.skipApply) {
    writeLine("Apply skipped.");
    return;
  }
  if (!(await confirmApply(options))) {
    writeLine("Apply cancelled.");
    return;
  }

  await runOpenClaw(["secrets", "apply", "--from", planPath, "--allow-exec"]);
  if (!options.skipAudit) {
    await runOpenClaw(["secrets", "audit", "--check"]);
  }
  if (!options.skipReload) {
    await runOpenClaw(["secrets", "reload"]);
  }
}

export function registerOneCliCommands(params: RegisterOneCliCommandsParams): void {
  const onecli = params.program.command("onecli").description("Manage OneCLI SecretRefs");
  onecli
    .command("status")
    .description("Show OneCLI SecretRef provider status")
    .option("--dashboard-url <url>", "OneCLI dashboard URL", "http://localhost:10254")
    .option("--gateway-url <url>", "OneCLI gateway URL", "http://localhost:10255")
    .option("--json", "Print JSON status")
    .action((options: StatusOptions) => runStatus(params.config, options));
  onecli
    .command("start")
    .description("Start OneCLI as a separate local container")
    .option(
      "--container-engine <engine>",
      "Container engine to use",
      DEFAULT_ONECLI_CONTAINER_ENGINE,
    )
    .option("--container-name <name>", "Container name", DEFAULT_ONECLI_CONTAINER_NAME)
    .option("--dashboard-port <port>", "Host dashboard port", String(DEFAULT_ONECLI_DASHBOARD_PORT))
    .option("--gateway-port <port>", "Host gateway port", String(DEFAULT_ONECLI_GATEWAY_PORT))
    .option(
      "--data-volume <volume>",
      "Container volume for OneCLI data",
      DEFAULT_ONECLI_DATA_VOLUME,
    )
    .option("--image <image>", "OneCLI container image", DEFAULT_ONECLI_IMAGE)
    .option("--dashboard-url <url>", "Dashboard URL to print/open after start")
    .option("--open", "Open the dashboard after starting OneCLI")
    .action((options: StartOptions) => startOneCli(options));
  onecli
    .command("dashboard")
    .description("Open the OneCLI dashboard in the local browser")
    .option("--dashboard-url <url>", "OneCLI dashboard URL", "http://localhost:10254")
    .action((options: DashboardOptions) => openDashboard(options));
  onecli
    .command("setup")
    .description("Create and optionally apply a OneCLI SecretRef setup plan")
    .option("--plan-out <path>", "Write the generated secrets apply plan to a path")
    .option("--provider-alias <alias>", "Secret provider alias to configure", ONECLI_PROVIDER_ALIAS)
    .option("--resolver-command <path>", "OneCLI-compatible raw secret resolver command")
    .option("--resolver-args-json <json>", "JSON array of arguments for the resolver command")
    .option("--openai-id <id>", "OneCLI credential id for models.providers.openai.apiKey")
    .option("--anthropic-id <id>", "OneCLI credential id for models.providers.anthropic.apiKey")
    .option("--yes", "Apply after preflight without an interactive confirmation")
    .option("--skip-apply", "Only generate and preflight the plan")
    .option("--skip-audit", "Do not run secrets audit after apply")
    .option("--skip-reload", "Do not run secrets reload after apply")
    .option("--start-onecli", "Start OneCLI as a separate local container before setup")
    .option("--open-dashboard", "Open the OneCLI dashboard before setup")
    .option(
      "--container-engine <engine>",
      "Container engine for --start-onecli",
      DEFAULT_ONECLI_CONTAINER_ENGINE,
    )
    .option(
      "--container-name <name>",
      "Container name for --start-onecli",
      DEFAULT_ONECLI_CONTAINER_NAME,
    )
    .option(
      "--dashboard-port <port>",
      "Host dashboard port for --start-onecli",
      String(DEFAULT_ONECLI_DASHBOARD_PORT),
    )
    .option(
      "--gateway-port <port>",
      "Host gateway port for --start-onecli",
      String(DEFAULT_ONECLI_GATEWAY_PORT),
    )
    .option(
      "--data-volume <volume>",
      "Container volume for OneCLI data",
      DEFAULT_ONECLI_DATA_VOLUME,
    )
    .option("--image <image>", "OneCLI container image", DEFAULT_ONECLI_IMAGE)
    .option("--dashboard-url <url>", "Dashboard URL to open with --open-dashboard")
    .action((options: SetupOptions) => runSetup(options));
}

export const __testing = {
  buildOneCliContainerRunArgs,
  openBrowserCommand,
  resolveDashboardUrl,
};
