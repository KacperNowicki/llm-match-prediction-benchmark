import fs from "node:fs/promises";

const affectedPackages = new Set([
  "size-sensor",
  "echarts-for-react",
  "timeago.js",
  "canvas-nest.js",
  "jest-canvas-mock",
  "jest-date-mock",
  "lint-md",
  "@antv/scale",
  "@antv/g",
  "@antv/path-util",
  "@antv/g-svg",
  "@antv/g-lite",
  "@antv/vendor",
  "@antv/l7-layers",
  "@antv/g-canvas",
  "@antv/g2-extension-plot",
  "@antv/g2",
  "@antv/g6",
  "@antv/x6",
  "@antv/l7",
  "@antv/s2",
  "@antv/f2",
  "@antv/g2plot",
  "@antv/graphin",
  "@antv/data-set"
]);

const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
const hits = [];

for (const [packagePath, info] of Object.entries(lock.packages ?? {})) {
  if (!packagePath.startsWith("node_modules/") || !info.version) continue;
  let name = packagePath.slice("node_modules/".length);
  const nestedParts = name.split("/node_modules/");
  name = nestedParts[nestedParts.length - 1];
  if (affectedPackages.has(name) || name.startsWith("@antv/")) {
    hits.push({ name, version: info.version, packagePath });
  }
}

if (hits.length > 0) {
  console.error(JSON.stringify({ compromisedPackageHits: hits }, null, 2));
  process.exit(1);
}

console.log("Compromised package gate passed: no known Mini Shai-Hulud AntV wave packages found.");
