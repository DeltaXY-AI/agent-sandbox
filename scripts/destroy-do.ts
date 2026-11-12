// Deletes every droplet tagged agent-sandbox and the reserved IP pointing at them.
// Run:  npm run destroy:do            (lists what would be deleted)
//       npm run destroy:do -- --yes   (deletes)
import { spawnSync } from "node:child_process";

const TAG = "agent-sandbox";

function doctl(...args: string[]): any {
  const r = spawnSync("doctl", [...args, "--output", "json"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`doctl ${args.slice(0, 3).join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const droplets: { id: number; name: string }[] = doctl(
  "compute",
  "droplet",
  "list",
  "--tag-name",
  TAG,
);
const ids = new Set(droplets.map((d) => d.id));
const reserved: { ip: string; droplet?: { id: number } }[] = doctl(
  "compute",
  "reserved-ip",
  "list",
);
const ips = reserved.filter((r) => r.droplet && ids.has(r.droplet.id)).map((r) => r.ip);

console.log(
  `droplets tagged ${TAG}: ${droplets.map((d) => `${d.name} (${d.id})`).join(", ") || "none"}`,
);
console.log(`reserved IPs on them: ${ips.join(", ") || "none"}`);
if (!process.argv.includes("--yes")) {
  console.log("\nNothing deleted. Re-run with --yes to delete these.");
  process.exit(0);
}
for (const ip of ips) {
  doctl("compute", "reserved-ip-action", "unassign", ip, "--wait");
  spawnSync("doctl", ["compute", "reserved-ip", "delete", ip, "--force"], { windowsHide: true });
  console.log(`deleted reserved IP ${ip}`);
}
for (const d of droplets) {
  spawnSync("doctl", ["compute", "droplet", "delete", String(d.id), "--force"], {
    windowsHide: true,
  });
  console.log(`deleted droplet ${d.name}`);
}
