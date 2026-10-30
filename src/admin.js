import pc from "picocolors"
import { Option } from "commander";

import { sleep } from "./common.js"
import { BaseCommand } from "./base-command.js";

const TOOL_CALL_PREFIX = "mcp.tools.call."

export class MothpostAdmin extends BaseCommand {
  constructor(program) {
    super("admin", "Manage connections and tool permissions", program)
    this.command
      .command("connect")
      .description("Add a new connection")
      .argument("name", "Connection's name")
      .argument("device-data", "Base64 encoded device data")
      .addOption(
        new Option("--new-server <device-data>", "Create a new server")
          .conflicts("existingServer")
      )
      .addOption(
        new Option("--existing-server <device-id>", "Use an existing server")
          .conflicts("newServer")
      )
      .action(this.action("connect"))

    this.command
      .command("grant-tool")
      .description("Grant permission")
      .argument("connection-name", "Connection name")
      .argument("tool", "Tools name")
      .action(this.action("grantTool"))

    this.command
      .command("grant-all")
      .description("Grant permissions to all tools")
      .argument("connection-name", "Connection name")
      .action(this.action("grantAll"))

    this.command
      .command("revoke-all")
      .description("Revoke permissions to all tools")
      .argument("connection-name", "Connection name")
      .action(this.action("revokeAll"))

    this.command
      .command("revoke-tool")
      .description("Revoke permission")
      .argument("connection-name", "Connection name")
      .argument("tool", "Tools name")
      .action(this.action("revokeTool"))

    this.command
      .command("connection")
      .description("Get connection details")
      .argument("connection-name", "Connection name")
      .action(this.action("connection"))
  }

  async init() {
    let networkId = await this.sept.getNetworkId()
    if (!networkId) {
      await this.sept.bootstrap()
      networkId = await this.sept.getNetworkId()
      console.log("Bootstrap done")
    }
    console.log(`NetworkID: ${networkId}`)
    this.connectionsStorage = this.sept.appStorage("connections")
    // The tool list belongs to the server bridge, not to a connection: several
    // connections may share a server, and they must all see the same list.
    this.serversStorage = this.sept.appStorage("servers")
    // Only server bridges we connected are granted tools.list towards admins,
    // and SEPT enforces that on receipt, so any sender here is one of ours.
    this.sept.register("tools.list", async event => {
      await this.serversStorage.set(event.senderDeviceId, {
        tools: event.payload.tools ?? [],
      })
    })
    await this.sept.connect()
  }

  parseDeviceData(b64Data) {
    return JSON.parse(Buffer.from(b64Data, "base64").toString("utf8"))
  }

  async connect(name, clientDeviceData, options) {
    const { existingServer, newServer } = options

    if (!existingServer && !newServer) {
      throw new Error("One of --new-server or --existing-server is required")
    }

    if (await this.connectionsStorage.get(name)) {
      throw new Error(`Connection with name ${name} already exists`)
    }

    const client = this.parseDeviceData(clientDeviceData)

    if (client.metadata.role !== "client") {
      throw new Error(`Wrong client role: ${client.metadata.role}`)
    }

    const { pin: pinClient, pairing: pairingClient } = await this.sept.addDevice(client)
    let serverDeviceId, pairingServer
    if (newServer) {
      const server = this.parseDeviceData(newServer)
      if (server.metadata.role !== "server") {
        throw new Error(`Wrong server role`)
      }
      const { pin: pinServer, pairing } = await this.sept.addDevice(server)
      console.log(`PIN Server: ${pinServer}`)
      serverDeviceId = server.deviceId
      pairingServer = pairing
    } else {
      if (!(await this.sept.getDevices()).find(d => d.id === existingServer)) {
        throw new Error(`Device ${existingServer} not found`)
      }
      serverDeviceId = existingServer
    }

    console.log(`PIN Client: ${pinClient}`)

    if (newServer) {
      await pairingServer
    }
    await pairingClient

    await this.sept.grant(client.deviceId, serverDeviceId, ["mcp.tools.list"])
    await this.sept.grant(serverDeviceId, client.deviceId, ["mcp.response"])
    await this.connectionsStorage.set(name, {
      name,
      server: serverDeviceId,
      client: client.deviceId
    });
    for (const admins of await this.sept.getAdmins()) {
      await this.sept.grant(serverDeviceId, admins.deviceId, ["tools.list"])
    }
  }

  async getConnection(connectionName) {
    const connection = await this.connectionsStorage.get(connectionName)
    if (!connection) {
      throw new Error(`Connection ${connectionName} not found`)
    }
    return connection
  }

  async getServerTools(serverDeviceId) {
    const server = await this.serversStorage.get(serverDeviceId)
    return server?.tools ?? []
  }

  async getEnabledTools(connection) {
    const acl = await this.sept.getACL()
    const edge = acl.find(a =>
      a.srcDeviceId === connection.client &&
      a.dstDeviceId === connection.server
    )
    return (edge?.policy?.allowedEventTypes ?? [])
      .filter(type => type.startsWith(TOOL_CALL_PREFIX))
      .map(type => type.slice(TOOL_CALL_PREFIX.length))
  }

  async grantTool(connectionName, tool) {
    const connection = await this.getConnection(connectionName)
    await this.sept.grant(connection.client, connection.server, [`mcp.tools.call.${tool}`])
  }

  async getConnectionWithTools(connectionName, timeoutMs = 10000) {
    const connection = await this.getConnection(connectionName)
    const start = Date.now()
    while (true) {
      const tools = await this.getServerTools(connection.server)
      if (tools.length > 0) {
        return { connection, tools }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `No tool list received yet for ${connectionName}: make sure the `
          + `server bridge is running (it reports its tools to admins on start)`
        )
      }
      await sleep(250)
    }
  }

  async grantAll(connectionName) {
    const { connection, tools } = await this.getConnectionWithTools(connectionName)
    const eventTypes = tools.map(t => `mcp.tools.call.${t.name}`)
    await this.sept.grant(connection.client, connection.server, eventTypes)
  }

  async revokeAll(connectionName) {
    const connection = await this.getConnection(connectionName)
    const enabled = await this.getEnabledTools(connection)
    if (enabled.length === 0) {
      console.log(`No tools granted on ${connectionName}`)
      return
    }
    const eventTypes = enabled.map(name => `${TOOL_CALL_PREFIX}${name}`)
    await this.sept.revoke(connection.client, connection.server, eventTypes)
    console.log(`Revoked: ${enabled.join(", ")}`)
  }


  async revokeTool(connectionName, tool) {
    const connection = await this.getConnection(connectionName)
    await this.sept.revoke(connection.client, connection.server, [`mcp.tools.call.${tool}`])
  }

  async connection(connectionName) {
    const c = await this.getConnection(connectionName)
    const tools = await this.getServerTools(c.server)
    const enabled = new Set(await this.getEnabledTools(c))
    console.log(`Client: ${c.client}`)
    console.log(`Server: ${c.server}`)
    console.log(`Tools:`)
    for (const t of tools) {
      console.log(`  ${enabled.has(t.name) ? pc.green('✓') : pc.red('✗')} ${t.name}`)
    }

    const exposed = new Set(tools.map(t => t.name))
    for (const name of enabled) {
      if (!exposed.has(name)) {
        console.log(`  ${pc.yellow('!')} ${name} ${pc.dim('(granted, not exposed by the server)')}`)
      }
    }
  }
}