import fs from "node:fs";

export function loadConfig(options = {}) {
  const configFile = options.config ?? "./config.json";
  const fileConfig = fs.existsSync(configFile)
    ? JSON.parse(fs.readFileSync(configFile, "utf8"))
    : {};

  const config = {
    sept: {
      restEndpoint: fileConfig.sept?.restEndpoint,
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
      maxRequestAgeMs: 60000,
      // Tolerated clock difference between endpoints
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