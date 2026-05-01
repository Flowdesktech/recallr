import { Command } from "commander";
import pc from "picocolors";
import { startServer } from "../../server/server.js";

export function serveCommand(): Command {
  return new Command("serve")
    .description(
      "Start the local web UI + HTTP API at http://127.0.0.1:7474.\n\n" +
        "Bound to localhost only — never exposed to your network.",
    )
    .option("--port <port>", "Port to listen on", (v) => Number.parseInt(v, 10), 7474)
    .option("--host <host>", "Host to bind to (default 127.0.0.1)", "127.0.0.1")
    .option("--no-embed", "Skip embedder load (lexical-only search)")
    .option("--no-open", "Don't auto-open the browser")
    .action(
      async (opts: {
        port: number;
        host: string;
        embed: boolean;
        open: boolean;
      }) => {
        const { url, close } = await startServer({
          port: opts.port,
          host: opts.host,
          noEmbed: !opts.embed,
        });

        process.stdout.write(
          `\n  ${pc.bold("recallr")} ${pc.dim("·")} ${pc.cyan(url)}\n` +
            `  ${pc.dim("Press Ctrl+C to stop.")}\n\n`,
        );

        if (opts.open) {
          openInBrowser(url).catch(() => {
            // Browser launch is best-effort; the URL is already printed.
          });
        }

        const shutdown = async (signal: string): Promise<void> => {
          process.stdout.write(`\n${pc.dim(`Received ${signal}, shutting down...`)}\n`);
          await close();
          process.exit(0);
        };
        process.on("SIGINT", () => void shutdown("SIGINT"));
        process.on("SIGTERM", () => void shutdown("SIGTERM"));
      },
    );
}

/**
 * Open a URL in the user's default browser, cross-platform, without
 * pulling in a dependency. Each branch swallows its own error — failing
 * to open the browser is never fatal because the URL is in the terminal.
 */
async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "win32") {
    cmd = "cmd";
    // The empty "" is the title placeholder for `start`.
    args = ["/c", "start", '""', url];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
