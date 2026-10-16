// Reads a password on stdin and prints the scrypt hash for RECAST_LOCAL_USERS ("email|hash|uuid").
import { hashPassword } from "../lib/passwords";
const c: Buffer[] = []; for await (const x of process.stdin) c.push(x as Buffer);
const pw = Buffer.concat(c).toString("utf8").replace(/\r?\n$/, "");
if (pw.length < 12) { console.error("use at least 12 characters"); process.exit(2); }
console.log(await hashPassword(pw));
