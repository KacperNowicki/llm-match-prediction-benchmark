import fs from "node:fs/promises";

const cutoffIso = process.env.LOLPH_DEPENDENCY_CUTOFF ?? "2026-04-21T00:00:00.000Z";
const cutoff = new Date(cutoffIso);
const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));

function encodePackageName(name) {
  return name.startsWith("@") ? `@${name.slice(1).replace("/", "%2f")}` : name;
}

const uniquePackages = new Map();
for (const [packagePath, info] of Object.entries(lock.packages ?? {})) {
  if (!packagePath.startsWith("node_modules/") || !info.version) continue;
  let name = packagePath.slice("node_modules/".length);
  const nestedParts = name.split("/node_modules/");
  name = nestedParts[nestedParts.length - 1];
  uniquePackages.set(`${name}@${info.version}`, { name, version: info.version });
}

const metadataCache = new Map();
const youngPackages = [];
const missingPublishDates = [];

for (const item of uniquePackages.values()) {
  if (!metadataCache.has(item.name)) {
    const response = await fetch(`https://registry.npmjs.org/${encodePackageName(item.name)}`);
    if (!response.ok) {
      throw new Error(`Could not inspect ${item.name}: ${response.status}`);
    }
    metadataCache.set(item.name, await response.json());
  }

  const published = metadataCache.get(item.name).time?.[item.version];
  if (!published) {
    missingPublishDates.push(`${item.name}@${item.version}`);
    continue;
  }
  if (new Date(published) >= cutoff) {
    youngPackages.push({ ...item, published });
  }
}

if (missingPublishDates.length || youngPackages.length) {
  console.error(JSON.stringify({ cutoff: cutoff.toISOString(), youngPackages, missingPublishDates }, null, 2));
  process.exit(1);
}

console.log(`Dependency age gate passed: ${uniquePackages.size} packages older than ${cutoff.toISOString()}.`);
