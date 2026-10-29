import { Option } from "commander";
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "./config.js";
import { SeptClient } from "@sept-protocol/client"

import {
  betterSqliteDataStore,
  loadOrCreateSecret,
} from "./common.js"


export class BaseCommand {
  constructor(command, descr, program) {
    this.role = command
    this.command = program
      .command(command)
      .description(descr)
      .option("-c, --config <file>", "JSON configuration file")
      .option("--rest-endpoint <url>", "SEPT REST endpoint")
      .option("--data-dir <directory>", "SEPT state and secret directory")
      .addOption(
        new Option("--log-level <level>", "logging verbosity")
          .choices(["debug", "info", "warn", "error"]),
      )
  }

  async run(method, p) {
    const [command, options, ...args] = p.reverse()
    this.config = loadConfig(command.optsWithGlobals())
    const id = this.config[this.role]?.id ?? ""
    mkdirSync(this.config.sept.dataDir, { recursive: true })
    const fname = `${this.role}${id ? '-' + id : ''}`
    this.sept = await SeptClient.create({
      restEndpoint: this.config.sept.restEndpoint,
      dataStore: betterSqliteDataStore(
        join(this.config.sept.dataDir, `${fname}.db`)
      ),
      secretKeyProvider: () =>
        loadOrCreateSecret(
          join(this.config.sept.dataDir, `${fname}.secret`)
        ),
    })
    await this.init()
    await this[method](...args.reverse(), options)
  }


  action(method) {
    return (...p) => this.run(method, p).then(() => this.stop())
  }

  async init(){}

  async stop(){}

}
