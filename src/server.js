import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { pairIfNeeded } from "./common.js";
import { BaseCommand } from "./base-command.js";

export class SeptMcpServer extends BaseCommand {

  constructor(program) {
    super("server", "Run the server bridge in front of an existing MCP server", program)
    this.command
      .action(this.action("start"))
  }


  async init() {
    this.service = this.config.server
    this.mcpClient = null;
    this.mcpTransport = null;

    this.tools = [];
    this.stopping = false;
    let networkId = await this.sept.getNetworkId()
    if (!networkId) {

      await pairIfNeeded(
        this.sept,
        this.service.id,
        "server"
      );
      networkId = await this.sept.getNetworkId()
      console.log("Pairing done")
    }
    console.log(`NetworkID: ${networkId}`)

    await this.connectMcp();

    const { tools } = await this.mcpClient.listTools();

    this.tools = tools;
    this.registerMcpTools();
    this.registerToolsList()

    await this.sept.connect()
  }

  async stop() {
    await this.sept.disconnect()
  }


  async start() {
    await this.waitInit()

    console.log(
      `[${this.service.id}] Discovered MCP tools:`,
      this.tools.map(tool => tool.name),
    );

    const deviceId = await this.sept.getDeviceId();

    console.log(
      `[${this.service.id}] SEPT gateway connected as ${deviceId}`,
    );

    await this.sentToolsToAdmins()
  }

  async waitInit() {

    while (true) {
      const acl = await this.sept.getACL()
      if (acl.find(a => a.policy.allowedEventTypes.includes("tools.list"))) {
        break
      }
      await new Promise(r => setTimeout(r, 500))
    }
  }

  async sentToolsToAdmins() {
    const admins = await this.sept.getAdmins()
    await this.sept.send("tools.list", { tools: this.tools }, admins.map(a => a.deviceId))
  }

  async connectMcp() {

    if (this.service.transport !== "streamable-http") {
      throw new Error(
        `Unsupported MCP transport '${this.service.transport}' for service '${this.service.id}'`,
      );
    }


    this.mcpClient = new Client(
      {
        name: `mothpost-${this.service.id}`,
        version: "0.1.0",
      },
      {
        versionNegotiation: {
          mode: "auto",
        },
      },
    );


    this.mcpTransport = new StreamableHTTPClientTransport(
      new URL(this.service.url),
    );


    await this.mcpClient.connect(
      this.mcpTransport,
    );


    console.log(
      `[${this.service.id}] Connected to MCP server at ${this.service.url}`,
    );

    console.log(
      `[${this.service.id}] MCP protocol era:`,
      this.mcpClient.getProtocolEra(),
    );

    console.log(
      `[${this.service.id}] MCP server:`,
      this.mcpClient.getServerVersion(),
    );
  }


  registerToolsList() {

    this.sept.register(
      "mcp.tools.list",

      async event => {

        const requestId = event.payload?.requestId;

        if (!requestId) {
          console.error(
            `[${this.service.id}] mcp.tools.list: missing requestId`,
          );

          return;
        }

        if (this.isStale(event, "mcp.tools.list")) {
          return;
        }

        try {
          const gatewayDeviceId = await this.sept.getDeviceId();
          const graph = await this.sept.getACL();

          const relation = graph.find(edge =>
            edge.srcDeviceId === event.senderDeviceId &&
            edge.dstDeviceId === gatewayDeviceId
          );

          const allowedEventTypes = relation?.policy?.allowedEventTypes ?? [];
          const allowedTools = this.tools.filter(tool =>
            allowedEventTypes.includes(
              `mcp.tools.call.${tool.name}`,
            )
          );

          console.log(
            `[${this.service.id}] tools/list for ${event.senderDeviceId}:`,
            allowedTools.map(tool => tool.name),
          );

          await this.sendResult(
            event,
            requestId,
            {
              tools: allowedTools,
            },
          );

        } catch (error) {
          console.error(
            `[${this.service.id}] mcp.tools.list failed:`,
            error,
          );

          await this.sendError(
            event,
            requestId,
            error,
          );
        }
      },
    );

    console.log(`[${this.service.id}] Registered mcp.tools.list`);
  }


  registerMcpTools() {
    for (const tool of this.tools) {

      const eventType = `mcp.tools.call.${tool.name}`;

      this.sept.register(
        eventType,
        async event => {
          const {
            requestId,
            arguments: arguments_ = {},
            mcpRequestId,
          } = event.payload;

          if (!requestId) {
            console.error(`[${this.service.id}] ${eventType}: missing requestId`);
            return;
          }

          if (this.isStale(event, eventType)) {
            return;
          }

          console.log(
            `[${this.service.id}] Calling ${tool.name}`,
            {
              requestId,
              mcpRequestId,
              senderDeviceId: event.senderDeviceId,
              arguments: arguments_,
            },
          );

          try {
            const result = await this.mcpClient.callTool({
              name: tool.name,
              arguments: arguments_,
            });

            await this.sendResult(
              event,
              requestId,
              result,
            );

          } catch (error) {
            console.error(
              `[${this.service.id}] ${eventType} failed:`,
              error,
            );

            await this.sendError(
              event,
              requestId,
              error,
            );
          }
        }
      );

      console.log(`[${this.service.id}] Registered ${eventType}`);
    }
  }

  //  Returns true when a request must not be executed because the
  //  client has already given up on it, or its timestamp is implausible.
  isStale(event, eventType) {
    const { maxRequestAgeMs, clockSkewMs } = this.service
    const nowMs = Date.now()
    const sentMs = event.timestamp * 1000
    const ageMs = nowMs - sentMs

    const requested = Number(event.payload?.timeoutMs)
    const windowMs = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, maxRequestAgeMs)
      : maxRequestAgeMs

    let reason = null
    if (-ageMs > clockSkewMs) {
      reason = `timestamp ${Math.round(-ageMs / 1000)}s in the future`
    } else if (ageMs > windowMs - clockSkewMs) {
      reason = `expired (age ${Math.round(ageMs / 1000)}s, window ${Math.round(windowMs / 1000)}s)`
    }

    if (reason) {
      console.warn(
        `[${this.service.id}] Dropping ${eventType} ${event.payload?.requestId}`
        + ` from ${event.senderDeviceId}: ${reason}`,
      )
      return true
    }

    return false
  }


  async sendResult(event, requestId, result) {
    await this.sept.send(
      "mcp.response",
      {
        requestId,
        result,
      },
      [event.senderDeviceId],
    );
  }


  async sendError(event, requestId, error) {
    const message = error instanceof Error
      ? error.message
      : String(error);


    await this.sept.send(
      "mcp.response",
      {
        requestId,
        error: {
          message,
        },
      },
      [event.senderDeviceId],
    );
  }


  async stop() {
    return
    if (this.stopping) {
      return;
    }

    this.stopping = true;

    console.log(
      `[${this.service.id}] Stopping...`,
    );

    if (this.sept) {
      try {
        await this.sept.disconnect();
      } catch (error) {
        console.error(
          `[${this.service.id}] SEPT disconnect failed:`,
          error,
        );
      }
    }

    if (this.mcpTransport) {
      try {
        await this.mcpTransport.terminateSession();
      } catch {
      }
    }


    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (error) {
        console.error(
          `[${this.service.id}] MCP close failed:`,
          error,
        );
      }
    }
  }
}