# mothpost

**Secure remote MCP access without VPNs, public endpoints, or complex networking setups.**

`mothpost` is an experimental bridge that lets AI agents discover and invoke tools exposed by MCP servers on other networks, without exposing those servers to the internet.

It provides:

- **Cross-network connectivity** — Reach MCP servers on private networks without a VPN or inbound ports.
- **Per-agent, per-tool permissions** — Grant or revoke individual tools without changing the MCP server's configuration or its own authorization rules.
- **End-to-end encryption** — Tool calls and responses travel encrypted between endpoints, including when routed through a third-party relay.
- **Resilient delivery** — Calls are queued while a remote endpoint is briefly disconnected and executed when it reconnects, as long as the agent is still waiting for the result.

Calls that reach the server after the agent has stopped waiting are dropped instead of executed late, so a tool never runs after the agent gave up on it, or twice when the agent retries (see [Request Expiry](#request-expiry)). Executing calls after the agent's timeout, with the result retrieved later, is planned; see [Future Work](#future-work).

Under the hood, `mothpost` uses [SEPT](https://github.com/fcavallarin/sept), an open-source encrypted event protocol that handles transport, device identities, access control, and offline delivery.

## Current Scope

The prototype currently supports:

- MCP initialization
- Tool discovery
- Tool calls
- Per-tool grant/revoke
- One or more agents connected to the same MCP server, each through its own connection (see [Multiple Agents](#multiple-agents))

MCP prompts, resources, and notifications are intentionally out of scope for the first demo.

## Example

A newly connected client has no tools available by default. An administrator can grant access to one tool:

```bash
npx mothpost admin grant-tool my-connection get_door_state
```

The client can then discover and invoke `get_door_state`. Revoking the permission prevents subsequent invocations, even if the agent still has the tool in a cached tool list.

## Quick Start

Connect an AI agent to an MCP server on another network and manage exactly which tools it can use.

There are three components:

- **Server** — Runs alongside an existing MCP server and makes its tools reachable remotely.
- **Client** — Presents authorized remote tools to an AI agent through a local MCP endpoint.
- **Admin** — Pairs the endpoints and manages tool permissions.

These components can run on separate networks. No VPN or publicly exposed MCP endpoint is required.

### 1. Installation

`mothpost` requires Node.js 20 or later. No installation is needed: the commands below run it with `npx`, which downloads it on first use.

If you run it often (for example the Admin commands), you can install it globally and use `mothpost` instead of `npx mothpost`:

```bash
npm install -g mothpost
```

Each component reads `config.json` from its working directory, so give each one its own directory. [`config.example.json`](config.example.json) lists every option; copy the section for the component you run (`server`, `client`, or none for the Admin).

To run from source instead, clone the repository, run `npm install`, and replace `npx mothpost` with `node src/cli.js` (`config.json` is git-ignored).

### 2. Configure the server

On the machine hosting your MCP server, create `config.json`:

```json
{
  "server": {
    "id": "my-server",
    "transport": "streamable-http",
    "url": "http://localhost:8931/mcp"
  }
}
```

Replace the URL with your MCP server's local endpoint and ensure that it is running.

Start the bridge:

```bash
npx mothpost server
```

On its first run, it displays Base64-encoded pairing data and prompts for a pairing PIN. Leave the terminal running; pairing will be completed in step 4.

### 3. Configure the client

On the machine running your AI agent, create `config.json`:

```json
{
  "client": {
    "id": "my-agent",
    "listenHost": "127.0.0.1",
    "port": 8001
  }
}
```

Start the local MCP bridge:

```bash
npx mothpost client
```

On first run, it also displays pairing data and asks for a PIN. Leave this terminal running.

**Note:** The server, client, and Admin each need their own working directory and `config.json`, also when they run on the same machine: their identities and state are stored in that directory.

### 4. Connect the client and server

In a third terminal, connect them using the pairing data displayed by each endpoint:

```bash
npx mothpost admin connect my-connection \
  "<CLIENT_PAIRING_DATA>" \
  --new-server "<SERVER_PAIRING_DATA>"
```

The Admin initializes the underlying private network if necessary and generates pairing PINs for both endpoints. Enter each PIN in the corresponding terminal.

Once pairing completes, the endpoints have the permissions needed to exchange MCP requests and responses. **No MCP tools are granted by default.**

### 5. Grant access to a tool

Inspect the connection and its available tools:

```bash
npx mothpost admin connection my-connection
```

Grant one tool:

```bash
npx mothpost admin grant-tool my-connection get_door_state
```

Replace `get_door_state` with a tool exposed by your MCP server. To grant all available tools:

```bash
npx mothpost admin grant-all my-connection
```

Tool permissions are enforced by the bridge's underlying access-control layer, independently of the MCP server's own authorization mechanisms.

### 6. Connect your AI agent

Configure your MCP-compatible agent to use this local Streamable HTTP endpoint:

```text
http://127.0.0.1:8001/mcp
```

The agent can discover and invoke only the tools permitted for its connection. Requests are encrypted and forwarded to the remote bridge, which invokes the local MCP server and returns its response.

### 7. Revoke access

Revoke access to one tool:

```bash
npx mothpost admin revoke-tool my-connection get_door_state
```

Or revoke all tools:

```bash
npx mothpost admin revoke-all my-connection
```

Inspect the connection again:

```bash
npx mothpost admin connection my-connection
```

Revocation blocks subsequent calls even if the agent cached the old tool list.

The server bridge also follows the MCP server: when it adds or removes tools (`notifications/tools/list_changed`), the new list is reported to the Admin without restarting the bridge, and if the MCP server restarts, the bridge reconnects on the next call.

Agents don't need to be restarted after a grant or revoke: the client bridge sends a `notifications/tools/list_changed` notification, and agents that listen for it refresh their tool list automatically. This requires an agent using the 2026-07-28 MCP protocol revision; agents on older revisions see the updated list the next time they reconnect or run tool discovery.

## Multiple Agents

Each agent gets its own connection, with its own tool permissions. There are two ways to connect a second agent to the same MCP server.

**Shared server bridge.** Start a new client for the agent (with its own `id` and `port`), find the server's device ID, and connect the client to the existing bridge:

```bash
npx mothpost admin connection my-connection    # prints "Server: <SERVER_DEVICE_ID>"

npx mothpost admin connect my-second-agent \
  "<CLIENT_PAIRING_DATA>" \
  --existing-server <SERVER_DEVICE_ID>
```

Permissions stay separate: granting or revoking a tool on `my-second-agent` does not affect `my-connection`. However, the bridge talks to the MCP server through **a single MCP session shared by all its connections**. If the MCP server keeps per-session state (for example a browser in a Playwright MCP server, open files, or a logged-in account), the agents share that state.

**Dedicated server bridge.** For isolation, start another server bridge for the new agent (with its own `id`, pointing to the same MCP server URL) and connect it with `--new-server`, as in [step 4](#4-connect-the-client-and-server). Each bridge opens its own MCP session. This is the recommended setup when agents must not see each other's state.

## Request Expiry

A tool call is executed only while the agent is still waiting for its result. Each request carries the client's timeout, and the server bridge checks the request's age, based on the sender's signed timestamp, before invoking the tool. Requests that are too old are logged and dropped, without executing the tool:

```text
[my-server] Dropping mcp.tools.call.get_door_state <requestId> from <device>: expired (age 42s, window 30s)
```

This prevents a call queued while the server was offline from running long after the agent has moved on, and a retried call from running twice.

The window can be tuned in `config.json`:

```json
{
  "client": {
    "requestTimeoutMs": 30000
  },
  "server": {
    "maxRequestAgeMs": 60000,
    "clockSkewMs": 5000
  }
}
```

- `client.requestTimeoutMs` — How long the client waits for a response (default: 30000). It is also sent with each request as its validity window.
- `server.maxRequestAgeMs` — Upper bound on the window a client may request (default: 60000).
- `server.clockSkewMs` — Tolerated clock difference between endpoints (default: 5000). It is also used as a safety margin: a call is executed only if it is younger than the window minus this value, so that the response can still reach the agent in time. Requests with a timestamp further in the future than this value are rejected as well.

Keep the endpoints' clocks synchronized (for example with NTP). A clock difference larger than `clockSkewMs` causes valid requests to be dropped.

## How It Works

```text
AI Agent
   |
   | MCP (localhost)
   v
Remote MCP Client Bridge
   |
   | Encrypted relay transport
   | Per-agent, per-tool permissions
   v
Remote MCP Server Bridge
   |
   | MCP (local)
   v
MCP Server
```

The relay forwards encrypted messages without access to tool-call contents. Each endpoint has its own cryptographic identity, and an administrator controls which tools each client can invoke. No inbound ports, VPN connections, or public MCP endpoints are required between client and server.

## Remote Agent Interaction

The same encrypted communication infrastructure can also connect users directly to AI agents, including from mobile apps. This makes it possible to chat with an agent running on a private network while the agent accesses MCP tools hosted elsewhere.

```text
Mobile App / User
        |
        | Encrypted chat / commands
        v
     AI Agent
        |
        | MCP (localhost)
        v
  MCP Client Bridge
        |
        | Encrypted remote access
        | Per-tool permissions
        v
  MCP Server Bridge
        |
        | MCP (local)
        v
     MCP Server
```

The underlying protocol already supports secure user-to-agent messaging. **Chat integration is not currently a feature of `mothpost` itself.**

## Security Notes

- Permissions are enforced per **connection** (one client bridge ↔ one server bridge), both by the server bridge, which lists and executes only granted tools, and by SEPT's access control, which rejects calls to non-granted tools before they reach the server bridge.
- The client bridge's local MCP endpoint has no authentication of its own: any process that can reach `listenHost:port` can use the tools granted to that connection. Keep it bound to `127.0.0.1` (the default), and give agents that must not share permissions separate client bridges.
- The relay sees only encrypted payloads and routing metadata (which devices exchange events, and when).

## Relay Configuration

By default, `mothpost` uses a free public relay. You can also [self-host a relay](https://github.com/fcavallarin/sept/blob/main/docs/self-hosting.md).

To use a different relay, add this field to the top-level object in each component's `config.json`:

```json
{
  "sept": {
    "restEndpoint": "https://YOUR-SEPT-RELAY"
  }
}
```

Merge this `sept` field into your existing server, client, or Admin configuration; don't replace the other fields.

## Future Work

### Asynchronous MCP Tool Execution

The transport already supports persistent offline delivery: a call can reach a disconnected endpoint when it comes back online. But standard MCP tool calls use a request/response model, so the originating agent may time out before the call is executed and would never receive its eventual result. For this reason, the server bridge currently drops calls that arrive after the agent's timeout (see [Request Expiry](#request-expiry)).

A future version could use the [MCP Tasks Extension](https://tasks.extensions.modelcontextprotocol.io/) to provide native asynchronous execution and result retrieval:

1. An agent invokes a remote tool.
2. The client bridge persists a task and immediately returns a task identifier.
3. The request is queued for delivery even if the remote endpoint is offline.
4. On reconnection, the server bridge invokes the existing MCP server.
5. The result is delivered back and associated with the task.
6. The agent retrieves the result with `tasks/get` or receives an optional `notifications/tasks` update.

This requires persistent task state, request/result correlation, execution deduplication, expiration policies, and cancellation handling. **Existing MCP servers would not need to implement asynchronous execution**: the bridge could manage the task lifecycle while continuing to invoke ordinary MCP tools.

This is planned work, **not a feature of the current prototype**.

## Status

`mothpost` is an experimental prototype/demo. It is published on [npm](https://www.npmjs.com/package/mothpost), but its CLI and configuration may change between versions.

## Related

- [SEPT](https://github.com/fcavallarin/sept) — underlying encrypted event transport and access-control protocol
