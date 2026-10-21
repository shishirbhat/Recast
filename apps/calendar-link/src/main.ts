// Starts the Google Calendar sign-in on http://localhost:8787. Reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from
// apps/calendar-link/.env (or from the environment). Prints where to go; never prints the secret.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLinkServer } from "./server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const clientId = process.env["GOOGLE_CLIENT_ID"]?.trim() ?? "";
const clientSecret = process.env["GOOGLE_CLIENT_SECRET"]?.trim() ?? "";
const port = Number(process.env["PORT"] ?? 8787);
const problems: string[] = [];
if (!existsSync(envFile) && !clientId) problems.push(`No .env file found at ${envFile}. Copy .env.example to .env in that folder.`);
if (!clientId || clientId.startsWith("paste-")) problems.push("GOOGLE_CLIENT_ID is missing in .env (it ends with .apps.googleusercontent.com).");
else if (!clientId.endsWith(".apps.googleusercontent.com")) problems.push("GOOGLE_CLIENT_ID does not look right: it should end with .apps.googleusercontent.com.");
if (!clientSecret || clientSecret.startsWith("paste-")) problems.push("GOOGLE_CLIENT_SECRET is missing in .env.");
if (!Number.isInteger(port) || port < 1024 || port > 65535) problems.push("PORT must be a number between 1024 and 65535.");
if (problems.length) { console.error(`Cannot start:\n- ${problems.join("\n- ")}`); process.exit(1); }

const tokenFile = path.join(root, ".secrets", "google-token.json");
createLinkServer({ clientId, clientSecret, port, tokenFile }).listen(port, "127.0.0.1", () => {
  console.log(`Recast Google Calendar sign-in is running.\nOpen http://localhost:${port}/ in your browser.\nPress Ctrl+C here to stop it.`);
});
