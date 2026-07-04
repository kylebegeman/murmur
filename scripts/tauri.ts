import { existsSync } from "node:fs";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const rootDir = process.cwd();
const cargoBin = join(process.env.HOME ?? "", ".cargo", "bin");
const path = process.env.PATH ?? "";
const env = {
  ...process.env,
  PATH: existsSync(cargoBin) ? `${cargoBin}:${path}` : path,
};

const devServerUrl = "http://localhost:1420/";

const canReachDevServer = async () => {
  try {
    const response = await fetch(devServerUrl);
    return response.ok;
  } catch {
    return false;
  }
};

const waitForDevServer = async () => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    if (await canReachDevServer()) return;
    await Bun.sleep(250);
  }

  throw new Error(`Timed out waiting for ${devServerUrl}`);
};

const splitDevArgs = (devArgs: string[]) => {
  const separatorIndex = devArgs.indexOf("--");
  const runnerArgs =
    separatorIndex === -1 ? devArgs : devArgs.slice(0, separatorIndex);
  const appArgs =
    separatorIndex === -1 ? [] : devArgs.slice(separatorIndex + 1);
  const cargoArgs = ["--no-default-features", "--color", "always"];

  for (let index = 0; index < runnerArgs.length; index += 1) {
    const arg = runnerArgs[index];

    if (
      arg === "--release" ||
      arg === "--target" ||
      arg === "-t" ||
      arg === "--features" ||
      arg === "-f"
    ) {
      cargoArgs.push(arg);
      const nextArg = runnerArgs[index + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        cargoArgs.push(nextArg);
        index += 1;
      }
      continue;
    }

    if (
      arg.startsWith("--target=") ||
      arg.startsWith("--features=") ||
      arg === "--all-features"
    ) {
      cargoArgs.push(arg);
    }
  }

  return { cargoArgs, appArgs };
};

const runMacDev = async () => {
  const hadDevServer = await canReachDevServer();
  const vite = hadDevServer
    ? null
    : Bun.spawn(["bun", "run", "dev"], {
        cwd: rootDir,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
      });

  let runner: ReturnType<typeof Bun.spawn> | null = null;

  const stopChildren = () => {
    runner?.kill();
    vite?.kill();
  };

  process.on("SIGINT", () => {
    stopChildren();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopChildren();
    process.exit(143);
  });

  await waitForDevServer();

  const { cargoArgs, appArgs } = splitDevArgs(args.slice(1));
  runner = Bun.spawn(
    [
      "../scripts/macos-dev-app-runner.sh",
      "run",
      ...cargoArgs,
      "--",
      ...appArgs,
    ],
    {
      cwd: join(rootDir, "src-tauri"),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
    },
  );

  const code = await runner.exited;
  vite?.kill();
  process.exit(code);
};

if (process.platform === "darwin" && args[0] === "dev") {
  await runMacDev();
}

const child = Bun.spawn(["tauri", ...args], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env,
});

process.exit(await child.exited);
