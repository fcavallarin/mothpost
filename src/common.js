import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import Database from "better-sqlite3"
import qrcode from "qrcode-terminal"
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"


export function now() {
  return Math.floor(Date.now() / 1000);
}


export function isExpired(ts, w) {
  return now() >= ts + w;
}


export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}


export function betterSqliteDataStore(filename) {
  return {
    type: "better-sqlite",

    open: () => {
      const db = new Database(filename)
      db.pragma("journal_mode = WAL")
      return db
    },

    close: db => db.close(),
  }
}


export function loadOrCreateSecret(filename) {
  if (!existsSync(filename)) {
    writeFileSync(filename, randomBytes(32), { mode: 0o600 })
  }

  const secret = readFileSync(filename)

  if (secret.length !== 32) {
    throw new Error(`${filename} must contain exactly 32 bytes`)
  }

  return new Uint8Array(secret)
}


export async function pairIfNeeded(sept, name, role) {
  if (await sept.getNetworkId()) {
    return
  }
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
  })
  try {
    const deviceData = await sept.initDevice()

    deviceData.metadata = {
      name,
      role
    }

    const pairingData = Buffer.from(JSON.stringify(deviceData)).toString("base64")
    // qrcode.generate(JSON.stringify(deviceData), {
    //   small: true,
    // })

    console.log("Your pairing data:\n")
    console.log(pairingData)
    const pin = await rl.question("Pairing PIN: ")


    await sept.pairDevice(pin.trim())
  } finally {
    rl.close()
  }
}