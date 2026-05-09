import { describe, expect, it } from "vitest";
import { __testing } from "../cli.js";

describe("onecli CLI helpers", () => {
  it("builds the documented separate OneCLI container command", () => {
    expect(__testing.buildOneCliContainerRunArgs({})).toEqual([
      "run",
      "-d",
      "--pull",
      "always",
      "--name",
      "onecli",
      "-p",
      "10254:10254",
      "-p",
      "10255:10255",
      "-v",
      "onecli-data:/app/data",
      "ghcr.io/onecli/onecli",
    ]);
  });

  it("honors custom OneCLI host ports and storage volume", () => {
    expect(
      __testing.buildOneCliContainerRunArgs({
        containerName: "onecli-shared",
        dashboardPort: "12054",
        gatewayPort: "12055",
        dataVolume: "onecli-shared-data",
        image: "example.com/onecli:test",
      }),
    ).toEqual([
      "run",
      "-d",
      "--pull",
      "always",
      "--name",
      "onecli-shared",
      "-p",
      "12054:10254",
      "-p",
      "12055:10255",
      "-v",
      "onecli-shared-data:/app/data",
      "example.com/onecli:test",
    ]);
  });

  it("defaults the dashboard URL to the chosen host port", () => {
    expect(__testing.resolveDashboardUrl({ dashboardPort: "12054" })).toBe(
      "http://localhost:12054",
    );
    expect(__testing.resolveDashboardUrl({ dashboardUrl: "http://onecli.local" })).toBe(
      "http://onecli.local",
    );
  });
});
