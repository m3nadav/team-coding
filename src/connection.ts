import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import localtunnel from "localtunnel";

export function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

export interface ConnectionInfo {
  url: string;
  displayUrl: string;
  mode: "lan" | "tunnel" | "relay" | "custom";
  cleanup?: () => void;
}

export function formatConnectionInfo(opts: {
  mode: "lan" | "tunnel" | "relay" | "custom";
  host: string;
  port: number;
}): ConnectionInfo {
  if (opts.mode === "tunnel") {
    const url = `wss://${opts.host}`;
    return { url, displayUrl: url, mode: opts.mode };
  }
  const url = `ws://${opts.host}:${opts.port}`;
  return { url, displayUrl: url, mode: opts.mode };
}

// Cloudflare Quick Tunnel — uses the `cloudflared` npm package which auto-downloads the binary
export async function startCloudflareTunnel(localPort: number): Promise<ConnectionInfo> {
  const { Tunnel, bin, install } = await import("cloudflared");

  // Auto-install the cloudflared binary if not present
  if (!existsSync(bin)) {
    try {
      await install(bin);
    } catch (err) {
      throw new Error(
        `Failed to auto-install cloudflared binary: ${err instanceof Error ? err.message : err}\n` +
        "You can also install it manually: brew install cloudflared",
      );
    }
  }

  return new Promise((resolve, reject) => {
    const t = Tunnel.quick(`http://localhost:${localPort}`);

    const timeout = setTimeout(() => {
      t.stop();
      reject(new Error("cloudflared timed out after 30s"));
    }, 30000);

    t.once("url", (httpsUrl: string) => {
      clearTimeout(timeout);
      const wssUrl = httpsUrl.replace("https://", "wss://");
      resolve({
        url: wssUrl,
        displayUrl: wssUrl,
        mode: "tunnel",
        cleanup: () => t.stop(),
      });
    });

    t.once("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function startLocaltunnel(localPort: number): Promise<ConnectionInfo | null> {
  try {
    const tunnel = await Promise.race([
      localtunnel({ port: localPort }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("localtunnel timed out after 30s")), 30000),
      ),
    ]);

    const httpsUrl = tunnel.url;
    const wssUrl = httpsUrl.replace("https://", "wss://");

    return {
      url: wssUrl,
      displayUrl: wssUrl,
      mode: "tunnel",
      cleanup: () => tunnel.close(),
    };
  } catch {
    return null;
  }
}
