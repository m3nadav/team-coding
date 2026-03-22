#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";

const program = new Command();

program
  .name("team-coding")
  .description("Multi-participant collaborative coding sessions — share a Claude Code session with your team")
  .version("0.1.0");

program
  .command("host")
  .description("Start a team-coding session as host")
  .option("--max-participants <n>", "maximum number of participants (default: 10, ⚠ performance may degrade above 10)", "10")
  .option("-n, --name <name>", "your display name", process.env.USER || "host")
  .option("--no-approval", "disable approval mode (trust your partner)")
  .option("--tunnel [provider]", "use a tunnel for remote access (localtunnel, cloudflare)")
  .option("--relay <url>", "use a relay server for remote access")
  .option("-p, --port <port>", "WebSocket server port (tunnel/LAN modes)", "0")
  .option("-c, --continue", "resume most recent Claude Code session")
  .option("--resume <id>", "resume a specific Claude Code session by ID")
  .option("--permission-mode <mode>", "permission mode: auto (default) or interactive")
  .option("--with-claude", "spawn a private local Claude for agent mode and agentic discussions")
  .option("--max-agent-hops <n>", "maximum agent-to-agent exchange hops in a discussion (default: 10)", "10")
  .option("--debug", "print debug logs to stderr (ws events, message types, errors)")
  .action(async (options, cmd) => {
    console.log("  Starting session...");
    const { hostCommand } = await import("./commands/host.js");
    const config = loadConfig();
    const tunnelFlag = options.tunnel === true ? "localtunnel" : options.tunnel;
    const tunnel = tunnelFlag || config.tunnel;
    const nameExplicit = cmd.getOptionValueSource("name") === "cli";
    hostCommand({
      name: nameExplicit ? options.name : (config.name || options.name),
      noApproval: !options.approval || config.approvalMode === false,
      tunnel,
      relay: options.relay || config.relay,
      port: parseInt(options.port, 10) || config.port || 0,
      continueSession: options.continue || false,
      resumeSession: options.resume,
      permissionMode: options.permissionMode || config.permissionMode || "auto",
      withClaude: options.withClaude ?? false,
      maxAgentHops: parseInt(options.maxAgentHops, 10) || 10,
      debug: options.debug ?? false,
    });
  });

program
  .command("join <session-code-or-offer>")
  .description("Join an existing team-coding session (session code or P2P offer code)")
  .option("-n, --name <name>", "your display name")
  .option("--password <password>", "session password")
  .option("--url <url>", "WebSocket URL (direct, SSH tunnel, VPN, etc.)")
  .option("--with-claude", "spawn a private local Claude for /think and /private commands")
  .option("--debug", "print debug logs to stderr (ws events, message types, errors)")
  .action(async (sessionCodeOrOffer, options) => {
    if (!options.password) {
      console.error("Error: --password is required");
      process.exit(1);
    }
    console.log("  Connecting...");
    const { joinCommand } = await import("./commands/join.js");
    const config = loadConfig();
    joinCommand(sessionCodeOrOffer, {
      name: options.name ?? config.name ?? process.env.USER ?? "guest",
      password: options.password,
      url: options.url,
      withClaude: options.withClaude ?? false,
      debug: options.debug ?? false,
    });
  });

program
  .command("relay")
  .description("Run a self-hosted relay server for remote team-coding sessions")
  .option("-p, --port <port>", "relay server port", "9877")
  .action(async (options) => {
    const { startRelayServer } = await import("./relay-server.js");
    startRelayServer(parseInt(options.port, 10));
  });

const configCmd = program
  .command("config")
  .description("View and manage team-coding configuration")
  .action(async () => {
    const { configShowCommand } = await import("./commands/config.js");
    configShowCommand();
  });

configCmd
  .command("set <key> <value>")
  .description("Set a config value")
  .option("--project", "save to project config (.team-coding.json)")
  .action(async (key, value, options) => {
    const { configSetCommand } = await import("./commands/config.js");
    configSetCommand(key, value, options);
  });

configCmd
  .command("get <key>")
  .description("Get a config value")
  .action(async (key) => {
    const { configGetCommand } = await import("./commands/config.js");
    configGetCommand(key);
  });

configCmd
  .command("path")
  .description("Show config file paths")
  .action(async () => {
    const { configPathCommand } = await import("./commands/config.js");
    configPathCommand();
  });

// Default action: if no subcommand is given, launch the interactive wizard
program.action(async () => {
  const { runWizard } = await import("./wizard.js");
  const result = await runWizard();
  if (!result) process.exit(0);

  const config = loadConfig();

  if (result.mode === "host") {
    const { hostCommand } = await import("./commands/host.js");
    hostCommand({
      name: result.name || config.name || process.env.USER || "host",
      noApproval: result.trustMode === "trusted",
      tunnel: result.connectionType === "cloudflare" ? "cloudflare"
            : result.connectionType === "lan" || result.connectionType === "ssh" ? "lan"
            : undefined,
      relay: result.connectionType === "relay" ? result.relayUrl : undefined,
      port: result.port ?? config.port ?? 0,
      continueSession: result.resumeSession === "continue",
      permissionMode: result.permissionMode ?? "auto",
      withClaude: result.withClaude ?? false,
      debug: false,
    });
  } else if (result.mode === "join") {
    const { joinCommand } = await import("./commands/join.js");
    joinCommand(result.sessionCode!, {
      name: result.name,
      password: result.password,
      url: result.url,
      withClaude: false,
      debug: false,
    });
  } else if (result.mode === "relay") {
    const { startRelayServer } = await import("./relay-server.js");
    startRelayServer(result.relayPort ?? 9877);
  }
});

program.parseAsync();
