import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["apps/mobile-web/app.mjs"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/app.js",
  minify: true,
});
await copyFile("apps/mobile-web/index.html", "dist/index.html");
await copyFile("apps/mobile-web/style.css", "dist/style.css");
console.log("Built mobile Web → dist/");
