import { mkdir, cp, access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
const dest = resolve(homedir(), ".agents/skills/mya-approval");
try {
  await access(dest);
  throw new Error("Skill already exists; review it before replacing: " + dest);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await mkdir(resolve(homedir(), ".agents/skills"), { recursive: true });
await cp(".agents/skills/mya-approval", dest, {
  recursive: true,
  errorOnExist: true,
  force: false,
});
console.log(
  "Installed " +
    dest +
    "; run npm link from this repository to expose the mya command. No approval settings were changed.",
);
