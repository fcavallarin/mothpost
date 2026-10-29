import {
  Client,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { pairIfNeeded, sleep } from "./common.js";
import { BaseCommand } from "./base-command.js";

export class SeptMcpServer extends BaseCommand {

  constructor(program) {
    super("server", "Run the server bridge in front of an existing MCP server", program)
    this.command
      .action(this.daemonAction("start"))
  }


  async init() {
    this.service = this.config.server
    this.mcpClient = null;
    this.mcpTransport = null;
    this.mcpConnecting = null;
    this.tools = [];
    this.registeredTools = new Set();
    this.ready = false;

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

    await this.ensureMcp();
    this.registerToolsList()

    await this.sept.connect()
  }


  async start() {
    await this.waitInit()
    this.ready = true

    console.log(
      `[${this.service.id}] Discovered MCP tools:`,
      this.tools.map(tool => tool.name),
    );

    const deviceId = await this.sept.getDeviceId();

    console.log(
      `[${this.service.id}] SEPT gateway connected as ${deviceId}`,
    );

    await this.sendToolsToAdmins()
  }

  async waitInit() {
    const ownDeviceId = await this.sept.getDeviceId()
    while (true) {
      const acl = await this.sept.getACL()
      const granted = acl.some(edge =>
        edge.srcDeviceId === ownDeviceId &&
        (edge.policy?.allowedEventTypes ?? []).includes("tools.list")
      )
      if (granted) {
        break
      }
      await sleep(500)
    }
  }

  async sendToolsToAdmins() {
    const admins = await this.sept.getAdmins()
    await this.sept.send("tools.list", { tools: this.tools }, admins.map(a => a.deviceId))
  }

  async connectMcp() {

    if (this.service.transport !== "streamable-http") {
      throw new Error(
        `Unsupported MCP transport '${this.service.transport}' for service '${this.service.id}'`,
      );
    }

    const client = new Client(
      {
        name: `mothpost-${this.service.id}`,
        version: "0.1.0",
      },
      {
        versionNegotiation: {
          mode: "auto",
        },
        // Follow notifications/tools/list_changed from the MCP server, so
        // added or removed tools don't require restarting the bridge.
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error) {
                console.error(`[${this.service.id}] Failed to refresh MCP tools:`, error)
                return
              }
              void this.setTools(tools ?? [])
            },
          },
        },
      },
    );

    const transport = new StreamableHTTPClientTransport(
      new URL(this.service.url),
    );

    await client.connect(transport);

    this.mcpClient = client
    this.mcpTransport = transport

    console.log(
      `[${this.service.id}] Connected to MCP server at ${this.service.url}`,
    );

    console.log(
      `[${this.service.id}] MCP protocol era:`,
      client.getProtocolEra(),
    );

    console.log(
      `[${this.service.id}] MCP server:`,
      client.getServerVersion(),
    );

    const { tools } = await client.listTools();
    await this.setTools(tools)
  }

  async ensureMcp() {
    if (this.mcpClient) {
      return this.mcpClient
    }
    if (!this.mcpConnecting) {
      this.mcpConnecting = this.connectMcp()
        .finally(() => { this.mcpConnecting = null })
    }
    await this.mcpConnecting
    return this.mcpClient
  }

  async dropMcp() {
    const client = this.mcpClient
    const transport = this.mcpTransport
    this.mcpClient = null
    this.mcpTransport = null
    try { await transport?.terminateSession() } catch {}
    try { await client?.close() } catch {}
  }

  async withMcp(fn, { idempotent = false } = {}) {
    const client = await this.ensureMcp()
    try {
      return await fn(client)
    } catch (error) {
      if (error instanceof ProtocolError) {
        // The MCP server answered with a JSON-RPC error: the session is fine.
        throw error
      }
      console.warn(
        `[${this.service.id}] MCP request failed (${error.message}), reconnecting`,
      )
      if (this.mcpClient === client) {
        await this.dropMcp()
      }
      const sessionExpired = error instanceof SdkHttpError && error.status === 404
      if (!idempotent && !sessionExpired) {
        throw error
      }
      return await fn(await this.ensureMcp())
    }
  }

  async setTools(tools) {
    const names = list => list.map(t => t.name).sort().join("\n")
    const changed = names(tools) !== names(this.tools)
      || JSON.stringify(tools) !== JSON.stringify(this.tools)

    this.tools = tools
    this.registerMcpTools()

    if (changed && this.ready) {
      console.log(
        `[${this.service.id}] MCP tools changed:`,
        tools.map(tool => tool.name),
      )
      try {
        await this.sendToolsToAdmins()
      } catch (error) {
        console.error(`[${this.service.id}] Failed to send tools to admins:`, error)
      }
    }
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
      if (this.registeredTools.has(tool.name)) {
        continue
      }
      this.registeredTools.add(tool.name)

      const toolName = tool.name
      const eventType = `mcp.tools.call.${toolName}`;

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

          if (!this.tools.some(t => t.name === toolName)) {
            await this.sendError(
              event,
              requestId,
              new Error(`Tool ${toolName} is no longer exposed by the MCP server`),
            );
            return;
          }

          console.log(
            `[${this.service.id}] Calling ${toolName}`,
            {
              requestId,
              mcpRequestId,
              senderDeviceId: event.senderDeviceId,
              arguments: arguments_,
            },
          );

          try {
            const result = await this.withMcp(client => client.callTool({
              name: toolName,
              arguments: arguments_,
            }));

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
  //  client has already given up on it
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
    if (this.stopping) {
      return;
    }

    this.stopping = true;

    console.log(
      `[${this.service?.id}] Stopping...`,
    );

    try {
      await this.sept?.disconnect();
    } catch (error) {
      console.error(
        `[${this.service?.id}] SEPT disconnect failed:`,
        error,
      );
    }

    await this.dropMcp()
  }
}
