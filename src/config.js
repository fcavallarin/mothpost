import fs from "node:fs";

export const DEFAULT_REST_ENDPOINT = "https://sept.filippo-572.workers.dev"

export function loadConfig(options = {}) {
  const configFile = options.config ?? "./config.json";
  if (options.config !== undefined && !fs.existsSync(configFile)) {
    throw new Error(`Configuration file not found: ${configFile}`)
  }
  const fileConfig = fs.existsSync(configFile)
    ? JSON.parse(fs.readFileSync(configFile, "utf8"))
    : {};

  const config = {
    sept: {
      restEndpoint: fileConfig.sept?.restEndpoint || DEFAULT_REST_ENDPOINT,
      logLevel: fileConfig.sept?.logLevel ?? "info",
      dataDir: fileConfig.sept?.dataDir ?? ".",
    },
    client: {
      id: fileConfig.client?.id ?? "client1",
      listenHost: fileConfig.client?.listenHost ?? "127.0.0.1",
      port: fileConfig.client?.port ?? 8001,
      requestTimeoutMs: fileConfig.client?.requestTimeoutMs || 30000
    },
    server: {
      id: fileConfig.server?.id ?? "server1",
      transport: "streamable-http",
      maxRequestAgeMs: 60000,
      clockSkewMs: 5000,
      ...fileConfig.server,
    },
  };

  const override = (section, key) => {
    if (options[key] !== undefined) config[section][key] = options[key];
  };

  override("sept", "restEndpoint")
  override("sept", "logLevel")
  override("sept", "dataDir")
  override("client", "id")
  override("client", "listenHost")
  override("client", "port")
  override("client", "requestTimeoutMs")
  override("server", "id")
  override("server", "transport")
  override("server", "url")
  override("server", "command")
  override("server", "args")

  return config
}
