import path from 'node:path';
import { rm, mkdir, cp } from 'node:fs/promises';
import { execFileSync } from "node:child_process";

import {
  __dirname,
  SERVER_PORT,
  NUM_DEVICES,
  SEPT_VERSION,
  run,
  runCLI,
  sleep,
  runMCPServer,
  runMCPClient,
  assert,
  waitFor,
  writeConfig,
  toolCalls,
  callTool
} from './common.js'

let septServer, appClient, appClient2, appServer, mcpServer, mcpClient, dataDir, mcpClient2
const serverOutput = []


class MothpostTest {
  async init() {
    dataDir = path.resolve(__dirname, "data")
    const serverDir = path.resolve(dataDir, "test-server")
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true });

    mcpServer = await runMCPServer()

    writeConfig(path.resolve(dataDir, "config.json"))

    execFileSync("git", [
      "clone", "--branch", `v${SEPT_VERSION}`, '--depth', '1', 'https://github.com/fcavallarin/sept.git'
    ], { cwd: dataDir })

    execFileSync(
      "npm",
      ["run", "scaffold:server", "--", "test", serverDir],
      { stdio: "inherit", cwd: path.resolve(dataDir, "sept") }
    )

    execFileSync(
      "npm", ["install"],
      { stdio: "inherit", cwd: serverDir }
    )
    const wranglerConf = path.resolve(serverDir, "wrangler.jsonc")
    await cp(path.resolve(__dirname, "wrangler.jsonc"), wranglerConf)

    execFileSync(
      "npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"],
      { stdio: ["ignore", "pipe", "pipe"], cwd: serverDir }
    )

    const serverUrl = `http://127.0.0.1:${SERVER_PORT}`
    septServer = await runCLI("npx",
      ["wrangler", "dev", "--config", wranglerConf, "--port", SERVER_PORT],
      {
        cwd: serverDir,
      }
    )

    await septServer.wait(/\[wrangler:info\] Ready on/)
    appClient = run("client")
    appServer = run("server")
  }

  async _sync_client_devices(exclude = []) {
    for (let i = 1; i <= NUM_DEVICES; i++) {
      await this[`appDevice${i}`].sync()
    }
  }

  async test_admin(testId) {

    let clData = await appClient.wait(/^eyJk/)
    let srData = await appServer.wait(/^eyJk/)

    const admin = run("admin", "connect", "my-connection", clData, "--new-server", srData)
    const pinServer = (await admin.wait(/PIN Server/)).split(": ")[1]
    const pinClient = (await admin.wait(/PIN Client/)).split(": ")[1]

    await appClient.wait(/PIN/)
    await appClient.send(pinClient)

    await appServer.wait(/PIN/)
    await appServer.send(pinServer)

    await appServer.wait(/Pairing done/)
    await appClient.wait(/Pairing done/)
    console.log("Pairing done")
    await appClient.wait(/MCP proxy listening on/)
    // Don't let the next admin command run concurrently with this one: they
    // are the same device sharing admin.db.
    await admin.done

    // await appServer.wait(/Discovered MCP tools: \[ 'tool 1' \]/)
    console.log("Starting MCP client")
    mcpClient = await runMCPClient()
  }

  async test_grantall(testId) {
    let res
    res = await mcpClient.listTools()
    assert(res.tools.length === 0, "Tools list must be empty")
    const admin = run("admin", "grant-all", "my-connection")
    await admin.done

    res = await waitFor(async () => {
      const r = await mcpClient.listTools()
      return r.tools.length > 0 && r
    }, 10000, "granted tools to appear")
    assert(res.tools.length === 1, `Tools list must NOT be empty: ${res.tools.length}`)
    assert(res.tools[0].name === "tool-1", `Wrong tool name ${res.tools[0].name}`)
  }

  async test_existing_server(testId) {
    let res
    writeConfig(path.resolve(dataDir, "config2.json"), 1)
    appClient2 = run("client", "--config", "./data/config2.json")

    let clData = await appClient2.wait(/^eyJk/)
    let admin = run("admin", "connection", "my-connection")
    const serverId = (await admin.wait(/Server\: /)).split(": ")[1]
    await admin.done
    console.log(`Server ID: ${serverId}`)
    admin = run("admin", "connect", "my-connection2", clData, "--existing-server", serverId)

    const pinClient = (await admin.wait(/PIN Client/)).split(": ")[1]

    await appClient2.wait(/PIN/)
    await appClient2.send(pinClient)

    await appClient2.wait(/Pairing done/)
    console.log("Pairing done")
    await appClient2.wait(/MCP proxy listening on/)

    mcpClient2 = await runMCPClient(1)

    res = await mcpClient2.listTools()
    assert(res.tools.length === 0, "Tools list must be empty")

    admin = run("admin", "grant-tool", "my-connection2", "tool-1")
    await admin.done

    admin = run("admin", "connection", "my-connection2")
    await admin.wait(/tool\-1/)
    await admin.done

    res = await waitFor(async () => {
      const r = await mcpClient2.listTools()
      return r.tools.length > 0 && r
    }, 10000, "granted tools to appear")
    assert(res.tools.length === 1, `Tools list must NOT be empty: ${res.tools.length}`)
    assert(res.tools[0].name === "tool-1", `Wrong tool name ${res.tools[0].name}`)
  }

  async test_tool_call(testId) {
    const before = toolCalls.length
    const res = await callTool(mcpClient, "tool-1")
    assert(res.ok, `Tool call failed: ${res.text}`)
    assert(res.text === "tool-1 executed", `Unexpected result: ${res.text}`)
    assert(toolCalls.length === before + 1, "Tool not executed on the MCP server")
  }

  // After a revoke the call must be blocked even though the agent still has
  // tool-1 in its cached list (we never call listTools here).
  async test_revoked_call(testId) {
    const changed = () => appClient.output()
      .filter(l => /Tool permissions changed/.test(l)).length
    const changesBefore = changed()

    const admin = run("admin", "revoke-tool", "my-connection", "tool-1")
    await admin.done
    await waitFor(() => changed() > changesBefore, 10000, "client to apply the revoke")

    const before = toolCalls.length
    const res = await callTool(mcpClient, "tool-1")
    assert(!res.ok, `Revoked tool call succeeded: ${res.text}`)

    // Give a (wrongly) delivered call time to show up before asserting.
    await sleep(1000)
    assert(toolCalls.length === before, "Revoked tool executed on the MCP server")
  }

  // revoke-all must also revoke grants for tools the server doesn't expose
  // (e.g. removed temporarily), or they'd become effective again when the
  // tool reappears. Uses cl0 (my-connection), where tool-1 is already revoked.
  async test_revoke_all_unexposed(testId) {
    let admin = run("admin", "grant-tool", "my-connection", "ghost-tool")
    await admin.done

    admin = run("admin", "connection", "my-connection")
    await admin.wait(/ghost-tool .*not exposed/)
    await admin.done

    admin = run("admin", "revoke-all", "my-connection")
    await admin.wait(/Revoked: ghost-tool/)
    await admin.done

    admin = run("admin", "connection", "my-connection")
    await admin.done
    const out = admin.output().join("\n")
    assert(!/ghost-tool/.test(out), `ghost-tool still granted:\n${out}`)
    assert(!/✓/.test(out), `Some tool still granted:\n${out}`)
  }

  // A call made while the server bridge is offline must not be executed when
  // the bridge comes back after the client's timeout (8s in writeConfig).
  // Uses cl1 (my-connection2), which still has tool-1.
  async test_stale_request(testId) {
    appServer.close()
    await appServer.done

    const before = toolCalls.length
    const res = await callTool(mcpClient2, "tool-1")
    assert(!res.ok && /Timeout/.test(res.text), `Expected a timeout, got: ${res.text}`)

    appServer = run("server")
    await appServer.wait(/SEPT gateway connected/)
    await waitFor(
      () => appServer.errors().some(l => /Dropping mcp\.tools\.call\.tool-1 .*expired/.test(l)),
      10000,
      "server to drop the expired call"
    )
    assert(toolCalls.length === before, "Expired tool call executed on the MCP server")

    // A fresh call goes through normally once the bridge is back.
    const fresh = await callTool(mcpClient2, "tool-1")
    assert(fresh.ok, `Fresh call after reconnect failed: ${fresh.text}`)
    assert(toolCalls.length === before + 1, "Fresh call not executed")
  }

  // The client bridge (and its agent) restarts while the server bridge keeps
  // running: tools must still be listed and callable. Uses cl1 (my-connection2),
  // which still has tool-1.
  async test_client_restart(testId) {
    mcpClient2.close()
    appClient2.close()
    await appClient2.done

    appClient2 = run("client", "--config", "./data/config2.json")
    await appClient2.wait(/MCP proxy listening on/)
    mcpClient2 = await runMCPClient(1)

    const res = await waitFor(async () => {
      const r = await mcpClient2.listTools()
      return r.tools.length > 0 && r
    }, 10000, "tools to be listed after client restart")
    assert(res.tools[0].name === "tool-1", `Wrong tool name ${res.tools[0].name}`)

    const before = toolCalls.length
    const call = await callTool(mcpClient2, "tool-1")
    assert(call.ok, `Tool call after client restart failed: ${call.text}`)
    assert(toolCalls.length === before + 1, "Tool not executed after client restart")
  }

  // The MCP server restarts while the server bridge keeps running: calls
  // fail while it is down, and the bridge reconnects once it is back.
  // Uses cl1 (my-connection2), which still has tool-1.
  async test_mcp_server_restart(testId) {
    mcpServer.closeAllConnections()
    await new Promise(resolve => mcpServer.close(resolve))

    const before = toolCalls.length
    const down = await callTool(mcpClient2, "tool-1")
    assert(!down.ok, `Call succeeded with the MCP server down: ${down.text}`)
    assert(!/Timeout/.test(down.text), `Expected an error response, got a timeout`)

    mcpServer = await runMCPServer()
    const res = await waitFor(async () => {
      const r = await callTool(mcpClient2, "tool-1")
      return r.ok && r
    }, 10000, "tool call to succeed after MCP server restart")
    assert(res.text === "tool-1 executed", `Unexpected result: ${res.text}`)
    assert(toolCalls.length === before + 1, "Tool not executed after MCP server restart")
  }

}

async function main() {
  const septTest = new MothpostTest()
  await septTest.init()

  const tests = Object.getOwnPropertyNames(MothpostTest.prototype)
    .filter(t => t.startsWith("test_"))

  const errors = []
  const exit = () => {
    septServer.close()
    appClient.close()
    appServer.close()
    if (mcpClient) {
      mcpClient.close()
    }
    mcpServer.close()
    if (mcpClient2) {
      mcpClient2.close()
    }
    if (appClient2) {
      appClient2.close()
    }
    if (errors.length > 0) {
      for (const e of errors) {
        console.log(e)
      }
      process.exit(1)
    }
    console.log("ALL TESTS PASSED")
    process.exit(0)
  }

  process.on('SIGINT', () => {
    console.log('Ctrl+C pressed')
    exit()
  })

  for (const t of tests) {
    console.log(`Running ${t}`)
    try {
      await septTest[t](t)
      console.log(`${t} ... OK`)
    } catch (e) {
      errors.push(`${t}: ${e}`)
      console.log(`${t} ... ERROR`)
    }
    console.log("---------------")
  }
  exit()
}

main()

