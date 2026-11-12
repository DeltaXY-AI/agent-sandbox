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
function deleteOk(...args: string[]) {
  const r = spawnSync("doctl", [...args, "--force"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`doctl ${args.join(" ")} failed: ${r.stderr}`);
}

// Deleting a droplet releases its reserved IP; doctl has no --wait for that, so poll.
for (const d of droplets) {
  deleteOk("compute", "droplet", "delete", String(d.id));
  console.log(`deleted droplet ${d.name}`);
}
for (const ip of ips) {
  for (let i = 0; doctl("compute", "reserved-ip", "get", ip)[0]?.droplet; i++) {
    if (i >= 60) throw new Error(`reserved IP ${ip} still assigned after 2 minutes`);
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 2000)"]);
  }
  // After its droplet is deleted, DigitalOcean answers 422 "unprocessable" or accepts the
  // delete and keeps listing the IP for about 3 minutes (seen twice, Nov 12, 2026). Retry.
  const listed = () =>
    (doctl("compute", "reserved-ip", "list") as { ip: string }[]).some((r) => r.ip === ip);
  for (let i = 0; i < 30 && listed(); i++) {
    spawnSync("doctl", ["compute", "reserved-ip", "delete", ip, "--force"], { windowsHide: true });
    if (listed()) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
  }
  if (listed()) {
    console.log(`WARNING: reserved IP ${ip} is still listed. Retry later:`);
    console.log(`  doctl compute reserved-ip delete ${ip} --force`);
  } else {
    console.log(`deleted reserved IP ${ip}`);
  }
}
