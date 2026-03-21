#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";

const program = new Command();

program
  .name("team-claude")
  .description("Multi-participant collaborative coding sessions — share a Claude Code session with your team")
  .version("0.1.0");

program
  .command("host")
  .description("Start a team-claude session as host")
  .option("--max-participants <n>", "maximum number of participants (default: 10, ⚠ performance may degrade above 10)", "10")
  .option("-n, --name <name>", "your display name", process.env.USER || "host")
  .option("--no-approval", "disable approval mode (trust your partner)")
  .option("--tunnel [provider]", "use a tunnel for remote access (localtunnel, cloudflare)")
  .option("--relay <url>", "use a relay server for remote access")
  .option("-p, --port <port>", "WebSocket server port (tunnel/LAN modes)", "0")
  .option("-c, --continue", "resume most recent Claude Code session")
  .option("--resume <id>", "resume a specific Claude Code session by ID")
  .option("--permission-mode <mode>", "permission mode: auto (default) or interactive")
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
    });
  });

program
  .command("join <session-code-or-offer>")
  .description("Join an existing team-claude session (session code or P2P offer code)")
  .option("-n, --name <name>", "your display name")
  .option("--password <password>", "session password")
  .option("--url <url>", "WebSocket URL (direct, SSH tunnel, VPN, etc.)")
  .option("--with-claude", "spawn a private local Claude for /think and /private commands")
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
    });
  });

program
  .command("relay")
  .description("Run a self-hosted relay server for remote team-claude sessions")
  .option("-p, --port <port>", "relay server port", "9877")
  .action(async (options) => {
    const { startRelayServer } = await import("./relay-server.js");
    startRelayServer(parseInt(options.port, 10));
  });

const configCmd = program
  .command("config")
  .description("View and manage team-claude configuration")
  .action(async () => {
    const { configShowCommand } = await import("./commands/config.js");
    configShowCommand();
  });

configCmd
  .command("set <key> <value>")
  .description("Set a config value")
  .option("--project", "save to project config (.team-claude.json)")
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

program.parse();
