import { getAccessToken } from "./auth.js";

try {
  // Deliberate CLI-only export for pasting into Postman; no HTTP token route.
  process.stdout.write(`${await getAccessToken()}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
