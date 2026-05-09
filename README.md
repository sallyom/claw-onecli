# claw-onecli

OneCLI SecretRef provider integration for OpenClaw.

This plugin keeps OneCLI separate from OpenClaw while making it easy to wire
OpenClaw SecretRefs to a OneCLI-compatible credential resolver.

## Install

```bash
openclaw plugins install clawhub:claw-onecli
```

## Commands

```bash
openclaw onecli status
openclaw onecli start --open
openclaw onecli dashboard
openclaw onecli setup --openai-id providers/openai/apiKey
openclaw onecli setup --start-onecli --open-dashboard --openai-id providers/openai/apiKey
openclaw onecli setup --anthropic-id providers/anthropic/apiKey
```

`openclaw onecli setup` writes an OpenClaw secrets apply plan, dry-runs it, and
then optionally applies it. The resulting OpenClaw config stores SecretRefs, not
raw API keys:

```json
{ "source": "exec", "provider": "onecli", "id": "providers/openai/apiKey" }
```

By default, the resolver expects either:

- `ONECLI_SECRET_RESOLVER_COMMAND`, plus optional
  `ONECLI_SECRET_RESOLVER_ARGS_JSON`, for a command that accepts the OpenClaw
  exec SecretRef request on stdin and returns the exec SecretRef response on
  stdout.
- `ONECLI_SECRET_VALUES_JSON` for local smoke testing.

Example local smoke setup:

```bash
openclaw onecli setup \
  --openai-id providers/openai/apiKey \
  --resolver-command /absolute/path/to/onecli-compatible-resolver \
  --yes
```

## OneCLI Container Helper

`openclaw onecli start` is a convenience helper for launching a separate local
OneCLI container using dashboard port `10254`, gateway port `10255`, and
persistent `onecli-data` volume. Pass `--container-engine docker` if you prefer
Docker over Podman.

The current `ghcr.io/onecli/onecli:latest` image may require additional OneCLI
runtime configuration such as Postgres and OAuth settings. The OpenClaw
SecretRef bridge does not require the OneCLI dashboard or OAuth flow if you
provide a compatible resolver command directly.

## SecretRef Contract

The plugin declares a `secretProviderIntegrations.onecli` preset that materializes
an OpenClaw exec secret provider. OpenClaw calls the packaged resolver with the
standard exec SecretRef request, and the resolver delegates to the configured
OneCLI-compatible command.

```json
{"protocolVersion":1,"ids":["providers/openai/apiKey"]}
```

For smoke tests, use the inline fallback:

```bash
printf '%s\n' '{"protocolVersion":1,"ids":["providers/openai/apiKey"]}' \
  | ONECLI_SECRET_VALUES_JSON='{"providers/openai/apiKey":"not-a-real-value"}' \
    ./secret-ref-resolver.js
```

Expected:

```json
{"protocolVersion":1,"values":{"providers/openai/apiKey":"not-a-real-value"},"errors":{}}
```

## Local Test

From this repo:

```bash
npm install
npm test
```
