import http from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./auth.js";
import { ApiError } from "./errors.js";
import { topicRequest } from "./topics.js";

const routes = new Map([
  ["/api/topics/list", "list"],
  ["/api/topics/subscribe", "subscribe"],
  ["/api/topics/unsubscribe", "unsubscribe"],
]);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function json(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readJson(request) {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !==
      "application/json" ||
    request.headers["transfer-encoding"]
  )
    throw new ApiError(415, "Send application/json with Content-Length.");
  const length = Number(request.headers["content-length"]);
  if (!Number.isInteger(length) || length < 1 || length > 16384)
    throw new ApiError(413, "Request must contain 1–16384 bytes.");
  request.setTimeout(10_000, () => request.destroy());
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) throw new ApiError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Invalid JSON request.");
  }
}

export function createHandler({
  port,
  topicService = topicRequest,
  middleware,
  dist = resolve(ROOT, "dist"),
}) {
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const host = request.headers.host;
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host))
        throw new ApiError(403, "Use this server on localhost.");
      let path;
      try {
        path = decodeURIComponent(
          new URL(request.url, `http://${host}`).pathname,
        );
      } catch {
        throw new ApiError(400, "Invalid URL.");
      }
      if (path.startsWith("/api/")) {
        const action = routes.get(path);
        if (!action) throw new ApiError(404, "Unknown API endpoint.");
        if (request.method !== "POST")
          throw new ApiError(405, "Use POST for topic operations.");
        if (
          port < 8081 ||
          port > 8084 ||
          host !== `localhost:${port}` ||
          request.headers.origin !== `http://localhost:${port}`
        )
          throw new ApiError(
            403,
            "Topic requests must come from this exact localhost receiver origin.",
          );
        json(
          response,
          200,
          await topicService(action, await readJson(request)),
        );
        return;
      }
      if (!["GET", "HEAD"].includes(request.method))
        throw new ApiError(405, "Method not allowed.");
      if (
        /(?:service-account|firebase-adminsdk|\.env|\.git)|\.(?:py|pem|key|crt)$/i.test(
          path,
        ) ||
        /^\/(?:server|tests|postman|node_modules|\.venv)\//.test(path)
      )
        throw new ApiError(404, "Not found.");
      if (middleware) {
        middleware(request, response, () =>
          json(response, 404, { error: "Not found." }),
        );
        return;
      }
      // Production serves only built files, never the repository root.
      const file = await realpath(
        resolve(dist, `.${path === "/" ? "/index.html" : path}`),
      ).catch(() => null);
      const inside = file && relative(dist, file);
      if (
        !file ||
        inside.startsWith("..") ||
        isAbsolute(inside) ||
        !mime[extname(file)]
      )
        throw new ApiError(404, "Not found. Run pnpm build before pnpm start.");
      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type": mime[extname(file)],
        "Content-Length": body.length,
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        json(response, error instanceof ApiError ? error.status : 500, {
          error:
            error instanceof ApiError
              ? error.message
              : "Local server failed. Check server setup and retry.",
        });
    }
  };
}

export async function startServers({
  production = false,
  ports = [8080, 8081, 8082, 8083, 8084],
  topicService,
} = {}) {
  const servers = [];
  let vite;
  const close = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((done) => {
            server.close(done);
            server.closeAllConnections();
          }),
      ),
    );
    await vite?.close();
  };
  try {
    if (!production) {
      const { createServer } = await import("vite");
      vite = await createServer({
        configFile: resolve(ROOT, "vite.config.js"),
        server: { middlewareMode: true, ws: { host: "localhost", port: 8090 } },
      });
    }
    for (const port of ports) {
      const server = http.createServer(
        createHandler({ port, topicService, middleware: vite?.middlewares }),
      );
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      servers.push(server);
      await new Promise((done, fail) => {
        server.once("error", fail);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, done);
      });
    }
    return { servers, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const runtime = await startServers({
      production: process.argv.includes("--production"),
    });
    console.log("Dashboard: http://localhost:8080");
    console.log("Receivers: http://localhost:8081 through :8084");
    console.log(
      "Topic auth: service account (automatic refresh), or manual FCM_ACCESS_TOKEN override",
    );
    const stop = async () => {
      await runtime.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(
      error.code === "EADDRINUSE"
        ? "A required port is occupied. Stop the old server and retry."
        : "Cannot start the server. Check dependencies, ports and pnpm build output.",
    );
    process.exitCode = 1;
  }
}
