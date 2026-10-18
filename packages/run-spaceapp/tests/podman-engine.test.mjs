import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  composeCommand,
  createDefaultConfig,
  PROFILE_REQUIREMENTS,
  renderEngineCompose,
  renderWorkspaceCompose,
  saveConfig,
  writeRuntimeFiles
} from "../src/index.mjs";
import {
  ENGINE_MEMORY_BYTES,
  INSTALL_ENGINES,
  engineInfoProbe,
  limitsDelegation,
  parseDockerInfoText,
  parseEngineInfo,
  parsePodmanMachineInspect,
  podmanMachineRequirements,
  podmanMachineResizeHint,
  podmanMachineResourceChecks,
  resolveInstallEngine
} from "../src/engine.mjs";
import {
  ensureDockerAvailable,
  ensurePodmanAvailable,
  parsePodmanVersion,
  PODMAN_MINIMUM_VERSION,
  podmanReadyForInstall,
  podmanSocketAvailable
} from "../src/prerequisites.mjs";

const launcherManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const RUNTIME_VERSION = launcherManifest.spaceappRuntimeVersion;

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) {
            return { done: true };
          }
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function readyUnclaimedRequest(url) {
  return Promise.resolve(url.endsWith("/readyz")
    ? jsonResponse({ ok: true })
    : jsonResponse({ setupRequired: true, expiresAt: "2099-07-23T12:15:00.000Z" }));
}

// Trimmed from a real `podman info --format json` on podman 6.1.4.
const podmanInfoJson = JSON.stringify({
  host: {
    arch: "arm64",
    cpus: 4,
    memTotal: 4_294_967_296,
    cgroupVersion: "v2",
    cgroupControllers: ["cpu", "io", "memory", "pids"],
    security: { rootless: true }
  },
  store: { graphRoot: "/home/dev/.local/share/containers/storage" },
  version: { Version: "6.1.4" }
});

// Trimmed from a real `podman machine inspect` (a JSON array, no --format).
const podmanMachineInspectJson = JSON.stringify([{
  Name: "podman-machine-default",
  State: "running",
  Resources: { CPUs: 4, DiskSize: 60, Memory: 4096 },
  ConnectionInfo: { PodmanSocket: { Path: "/private/var/folders/podman-machine-default-api.sock" } }
}]);

const linuxResources = Object.freeze({
  cpuCount: 4,
  totalMemoryBytes: 8 * 1024 ** 3,
  freeDiskBytes: 20 * 1024 ** 3
});

const installAnswers = (extra = {}) => JSON.stringify({
  confirm: true,
  profile: "light",
  access: "isolated",
  companions: false,
  telemetry: false,
  open: false,
  ...extra
});

test("the engine field is optional and only records the non-default engine", () => {
  assert.deepEqual(INSTALL_ENGINES, ["docker", "podman"]);
  const dockerConfig = createDefaultConfig({ version: RUNTIME_VERSION });
  assert.equal(Object.hasOwn(dockerConfig, "engine"), false);
  const podmanConfig = createDefaultConfig({ version: RUNTIME_VERSION, engine: "podman" });
  assert.equal(podmanConfig.engine, "podman");
  assert.throws(
    () => createDefaultConfig({ version: RUNTIME_VERSION, engine: "containerd" }),
    /docker or podman/i
  );
});

test("engine resolution prefers the explicit choice, keeps the stored engine, and defaults to docker", () => {
  assert.equal(resolveInstallEngine(), "docker");
  assert.equal(resolveInstallEngine("podman"), "podman");
  assert.equal(resolveInstallEngine(undefined, "podman"), "podman");
  assert.equal(resolveInstallEngine(undefined, undefined), "docker");
  assert.throws(() => resolveInstallEngine("containerd"), /docker or podman/i);
  assert.throws(() => resolveInstallEngine(undefined, "containerd"), /docker or podman/i);
});

test("engine info probes use each CLI's native JSON output", () => {
  assert.deepEqual(engineInfoProbe("docker"), {
    command: "docker",
    args: ["info", "--format", "{{json .}}"]
  });
  assert.deepEqual(engineInfoProbe("podman"), {
    command: "podman",
    args: ["info", "--format", "json"]
  });
  assert.throws(() => engineInfoProbe("containerd"), /docker or podman/i);
});

test("parseEngineInfo normalizes podman and docker facts into one shape", () => {
  const podman = parseEngineInfo("podman", podmanInfoJson);
  assert.equal(podman.engine, "podman");
  assert.equal(podman.version, "6.1.4");
  assert.equal(podman.architecture, "arm64");
  assert.equal(podman.cpuCount, 4);
  assert.equal(podman.memoryBytes, 4_294_967_296);
  assert.equal(podman.dataRoot, "/home/dev/.local/share/containers/storage");
  assert.equal(podman.rootless, true);
  assert.equal(podman.cgroupVersion, "2");
  assert.deepEqual(podman.cgroupControllers, ["cpu", "io", "memory", "pids"]);

  const docker = parseEngineInfo("docker", JSON.stringify({
    ServerVersion: "27.3.1",
    Architecture: "x86_64",
    NCPU: 8,
    MemTotal: 16 * 1024 ** 3,
    DockerRootDir: "/var/lib/docker",
    SecurityOptions: ["name=rootless"],
    CgroupVersion: "2"
  }));
  assert.equal(docker.version, "27.3.1");
  assert.equal(docker.architecture, "x86_64");
  assert.equal(docker.cpuCount, 8);
  assert.equal(docker.memoryBytes, 16 * 1024 ** 3);
  assert.equal(docker.dataRoot, "/var/lib/docker");
  assert.equal(docker.rootless, true);
  assert.equal(docker.cgroupVersion, "2");

  assert.equal(parseEngineInfo("podman", "not json"), null);
  assert.equal(parseEngineInfo("docker", ""), null);
  assert.equal(parseEngineInfo("containerd", podmanInfoJson), null);
});

test("limits delegation is reported for cgroup v1 and for v2 without cpu/memory controllers", () => {
  assert.deepEqual(ENGINE_MEMORY_BYTES, { small: 3, medium: 5, large: 7, light: 3, standard: 3 });
  assert.deepEqual(
    limitsDelegation({ cgroupVersion: "2", cgroupControllers: ["cpu", "io", "memory", "pids"] }),
    { delegated: true, reason: null }
  );
  const missing = limitsDelegation({ cgroupVersion: "2", cgroupControllers: ["cpu", "io", "pids"] });
  assert.equal(missing.delegated, false);
  assert.match(missing.reason, /memory/);
  assert.deepEqual(
    limitsDelegation({ cgroupVersion: "1", cgroupControllers: null }),
    { delegated: false, reason: "cgroup v1" }
  );
  assert.equal(limitsDelegation({ cgroupVersion: null }), null);
  assert.equal(limitsDelegation({ cgroupVersion: "2", cgroupControllers: null }), null);
});

test("podman machine inspect facts drive profile resource checks and resize guidance", () => {
  const machine = parsePodmanMachineInspect(podmanMachineInspectJson);
  assert.equal(machine.name, "podman-machine-default");
  assert.equal(machine.state, "running");
  assert.equal(machine.cpuCount, 4);
  assert.equal(machine.memoryBytes, 4096 * 1024 ** 2);
  assert.equal(machine.diskBytes, 60 * 1024 ** 3);
  assert.equal(machine.socketPath, "/private/var/folders/podman-machine-default-api.sock");
  assert.equal(parsePodmanMachineInspect(""), null);
  assert.equal(parsePodmanMachineInspect("{}"), null);

  const smallRequirements = podmanMachineRequirements("small", PROFILE_REQUIREMENTS.small);
  assert.deepEqual(smallRequirements, {
    cpuCount: 4,
    memoryBytes: 3 * 1024 ** 3,
    diskBytes: PROFILE_REQUIREMENTS.small.freshDiskBytes
  });
  const passing = podmanMachineResourceChecks(machine, "small", smallRequirements);
  assert.equal(passing.length, 3);
  assert.ok(passing.every((check) => check.ok));
  assert.equal(podmanMachineResizeHint(passing), null);

  const tiny = parsePodmanMachineInspect(JSON.stringify([{
    Name: "podman-machine-default",
    State: "running",
    Resources: { CPUs: 2, DiskSize: 4, Memory: 2048 },
    ConnectionInfo: {}
  }]));
  const failing = podmanMachineResourceChecks(
    tiny,
    "medium",
    podmanMachineRequirements("medium", PROFILE_REQUIREMENTS.medium)
  );
  assert.ok(failing.some((check) => !check.ok));
  assert.match(podmanMachineResizeHint(failing), /podman machine set --cpus <cpus> --memory <MiB>/);
});

test("docker info text yields mode and cgroup facts without extra probes", () => {
  const text = [
    "Server Version: 27.3.1",
    " Cgroup Version: 2",
    " Security Options:",
    "  name=rootless",
    "  name=seccomp,profile=builtin"
  ].join("\n");
  assert.deepEqual(parseDockerInfoText(text), {
    version: "27.3.1",
    cgroupVersion: "2",
    rootless: true
  });
  const rootful = text.replace(/^\s*name=rootless\n/m, "");
  assert.equal(parseDockerInfoText(rootful).rootless, false);
  assert.equal(parseDockerInfoText(""), null);
});

test("podman versions parse and older major versions are refused", () => {
  assert.deepEqual(parsePodmanVersion("podman version 6.1.4"), [6, 1, 4]);
  assert.deepEqual(parsePodmanVersion("podman version 5.0.0-dev"), [5, 0, 0]);
  assert.equal(parsePodmanVersion("not a version"), null);
  assert.deepEqual(PODMAN_MINIMUM_VERSION, [5, 0]);
});

test("composeCommand drives podman with the engine override and keeps docker unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-compose-"));

  const docker = composeCommand("up", root, { profile: "small" });
  assert.equal(docker.command, "docker");
  assert.equal(docker.args[0], "compose");
  assert.ok(!docker.args.includes(join(root, "compose.engine.yml")));
  assert.deepEqual(docker.args.slice(-3), ["up", "-d", "--remove-orphans"]);

  const podman = composeCommand("up", root, { profile: "small", engine: "podman" });
  assert.equal(podman.command, "podman");
  assert.equal(podman.args[0], "compose");
  const engineIndex = podman.args.indexOf(join(root, "compose.engine.yml"));
  assert.notEqual(engineIndex, -1);
  assert.equal(podman.args[engineIndex - 1], "-f");
  assert.equal(podman.args[engineIndex - 2], join(root, "compose.host-access.yml"));
  assert.deepEqual(podman.args.slice(-3), ["up", "-d", "--remove-orphans"]);

  // Later commands honor the stored config: spreading the config into options
  // keeps the engine selection.
  const stored = composeCommand("pull", root, {
    ...createDefaultConfig({ version: RUNTIME_VERSION, profile: "small", engine: "podman" })
  });
  assert.equal(stored.command, "podman");
  assert.ok(stored.args.includes(join(root, "compose.engine.yml")));
});

test("renderEngineCompose writes keep-id only for rootless Podman on Linux", () => {
  const podmanConfig = createDefaultConfig({ version: RUNTIME_VERSION, engine: "podman" });
  const linuxEngine = renderEngineCompose(podmanConfig, "linux");
  for (const service of ["spaceapp-core", "spaceapp-cli", "spaceapp-browser"]) {
    assert.match(
      linuxEngine,
      new RegExp(`${service}:\\n    userns_mode: "keep-id:uid=10001,gid=10001"`)
    );
  }
  assert.equal(renderEngineCompose(podmanConfig, "darwin"), "services: {}\n");
  assert.equal(
    renderEngineCompose(createDefaultConfig({ version: RUNTIME_VERSION }), "linux"),
    "services: {}\n"
  );
});

test("workspace mounts are SELinux-relabeled for podman only", () => {
  const workspace = {
    id: "project-1234abcd",
    hostPath: "/tmp/project",
    containerPath: "/workspaces/project",
    readOnly: false
  };
  const podmanConfig = createDefaultConfig({ version: RUNTIME_VERSION, engine: "podman" });
  const podmanRendered = renderWorkspaceCompose({ ...podmanConfig, workspaces: [workspace] });
  assert.match(podmanRendered, /bind:\n          selinux: Z/);
  const dockerConfig = createDefaultConfig({ version: RUNTIME_VERSION });
  const dockerRendered = renderWorkspaceCompose({ ...dockerConfig, workspaces: [workspace] });
  assert.doesNotMatch(dockerRendered, /selinux/);
});

test("runtime files always include the engine override", async () => {
  const podmanRoot = await mkdtemp(join(tmpdir(), "spaceapp-podman-runtime-"));
  const podmanConfig = createDefaultConfig({ version: RUNTIME_VERSION, engine: "podman" });
  await writeRuntimeFiles(podmanRoot, podmanConfig);
  assert.equal(
    await readFile(join(podmanRoot, "compose.engine.yml"), "utf8"),
    renderEngineCompose(podmanConfig)
  );

  const dockerRoot = await mkdtemp(join(tmpdir(), "spaceapp-docker-runtime-"));
  await writeRuntimeFiles(dockerRoot, createDefaultConfig({ version: RUNTIME_VERSION }));
  assert.equal(
    await readFile(join(dockerRoot, "compose.engine.yml"), "utf8"),
    "services: {}\n"
  );
});

test("a ready rootless Podman replaces missing Docker when the caller allows it", async () => {
  const calls = [];
  let chooserCalls = 0;
  const result = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async (spec) => {
      calls.push(spec);
      return spec.command === "docker" ? 127 : 0;
    },
    pathExists: async (path) => path === "/run/user/1000/podman/podman.sock",
    allowPodmanFallback: true,
    chooseEngine: async () => {
      chooserCalls += 1;
      return "podman";
    },
    download: async () => {
      throw new Error("docker installation must not start");
    },
    launch: async () => {
      throw new Error("docker installation must not start");
    },
    sleep: async () => {}
  });

  assert.deepEqual(result, { code: 0, reexecuted: false, engine: "podman" });
  assert.equal(chooserCalls, 1);
  assert.deepEqual(calls.map((spec) => [spec.command, ...spec.args]), [
    ["docker", "--version"],
    ["podman", "--version"],
    ["podman", "compose", "version"],
    ["podman", "info"]
  ]);
});

test("a Podman that cannot run the stack yet is not offered", async () => {
  const chooserCalls = [];
  const execute = async (spec) => (spec.command === "docker" ? 127 : 0);
  assert.equal(
    await podmanReadyForInstall(execute, {
      platform: "linux",
      env: {},
      pathExists: async () => false
    }),
    false
  );
  assert.equal(
    await podmanReadyForInstall(execute, {
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      pathExists: async (path) => path === "/run/user/1000/podman/podman.sock"
    }),
    true
  );
  // macOS: the CLI is present but the machine has no inspectable running state.
  assert.equal(
    await podmanReadyForInstall(execute, {
      platform: "darwin",
      env: {},
      pathExists: async () => true
    }),
    false
  );

  const stderr = capture();
  const result = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: {},
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: stderr.stream,
    execute,
    pathExists: async () => false,
    allowPodmanFallback: true,
    chooseEngine: async () => {
      chooserCalls.push("called");
      return "podman";
    },
    download: async () => {},
    osRelease: { ID: "kali" },
    sleep: async () => {}
  });
  assert.equal(chooserCalls.length, 0);
  assert.equal(result.code, 1);
  assert.equal(result.engine, undefined);
  assert.match(stderr.value(), /not yet supported for Linux distribution/);
});

test("declining the Podman offer continues to the Docker installation path", async () => {
  const stderr = capture();
  const result = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    stdin: Readable.from([]),
    stdout: capture().stream,
    stderr: stderr.stream,
    execute: async (spec) => (spec.command === "docker" ? 127 : 0),
    pathExists: async (path) => path === "/run/user/1000/podman/podman.sock",
    allowPodmanFallback: true,
    chooseEngine: async () => "docker",
    download: async () => {},
    osRelease: { ID: "kali" },
    sleep: async () => {}
  });
  assert.equal(result.code, 1);
  assert.equal(result.engine, undefined);
  assert.match(stderr.value(), /not yet supported for Linux distribution/);
});

test("ensurePodmanAvailable reports version, provider, machine, and socket problems", async () => {
  const withVersion = (version) => async (spec, io) => {
    if (spec.args[0] === "--version") {
      io.stdout?.write(`podman version ${version}\n`);
    }
    return 0;
  };

  const oldVersion = capture();
  assert.deepEqual(
    await ensurePodmanAvailable({
      platform: "linux",
      env: {},
      stdout: capture().stream,
      stderr: oldVersion.stream,
      execute: withVersion("4.9.3")
    }),
    { code: 1, reexecuted: false }
  );
  assert.match(oldVersion.value(), /Podman 4\.9\.3 is not supported/);

  const noProvider = capture();
  const providerMissing = async (spec, io) => {
    if (spec.args[0] === "--version") {
      io.stdout?.write("podman version 6.1.4\n");
      return 0;
    }
    return spec.args[0] === "compose" ? 1 : 0;
  };
  assert.equal(
    (await ensurePodmanAvailable({
      platform: "linux",
      env: {},
      stdout: capture().stream,
      stderr: noProvider.stream,
      execute: providerMissing
    })).code,
    1
  );
  assert.match(noProvider.value(), /no Compose provider was found/);

  const noMachine = capture();
  assert.equal(
    (await ensurePodmanAvailable({
      platform: "darwin",
      env: {},
      stdout: capture().stream,
      stderr: noMachine.stream,
      execute: withVersion("6.1.4")
    })).code,
    1
  );
  assert.match(noMachine.value(), /No Podman machine was found/);

  const runningMachine = capture();
  const okMachines = async (spec, io) => {
    if (spec.args[0] === "--version") {
      io.stdout?.write("podman version 6.1.4\n");
    }
    if (spec.args.join(" ") === "machine inspect") {
      io.stdout?.write(podmanMachineInspectJson);
    }
    return 0;
  };
  assert.deepEqual(
    await ensurePodmanAvailable({
      platform: "darwin",
      env: {},
      stdout: runningMachine.stream,
      stderr: capture().stream,
      execute: okMachines
    }),
    { code: 0, reexecuted: false }
  );
  assert.match(runningMachine.value(), /Using Podman 6\.1\.4 on machine "podman-machine-default" \(4 CPUs, 4\.0 GiB memory, 60\.0 GiB disk\)/);

  const noSocket = capture();
  assert.equal(
    (await ensurePodmanAvailable({
      platform: "linux",
      env: {},
      stdout: capture().stream,
      stderr: noSocket.stream,
      execute: withVersion("6.1.4"),
      pathExists: async () => false
    })).code,
    1
  );
  assert.match(noSocket.value(), /API socket is not running/);
});

test("podmanSocketAvailable resolves the rootless socket from the environment", async () => {
  assert.equal(
    await podmanSocketAvailable({ XDG_RUNTIME_DIR: "/run/user/1000" }, async (path) => path === "/run/user/1000/podman/podman.sock"),
    "/run/user/1000/podman/podman.sock"
  );
  assert.equal(await podmanSocketAvailable({}, async () => false), null);
});

test("install --engine podman runs the whole lifecycle through podman compose", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  let ensurePodmanOptions = null;
  let ensureDockerCalls = 0;

  assert.equal(await run([
    "install",
    "--engine", "podman",
    "--non-interactive",
    "--answers", installAnswers()
  ], {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    platform: "linux",
    arch: "x64",
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    prepareDockerPath: async () => null,
    inspectResources: async () => linuxResources,
    ensureDocker: async () => {
      ensureDockerCalls += 1;
      return { code: 0, reexecuted: false };
    },
    ensurePodman: async (options) => {
      ensurePodmanOptions = options;
      return { code: 0, reexecuted: false };
    },
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.args?.includes("pg_dump")) {
        io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      }
      return 0;
    }
  }), 0);

  assert.equal(ensureDockerCalls, 0);
  assert.equal(ensurePodmanOptions.platform, "linux");
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  assert.match(await readFile(join(root, "compose.engine.yml"), "utf8"), /^services:/);
  assert.equal(await readFile(join(root, "runtime.env"), "utf8").then((value) => value.includes("SPACEAPP_ENGINE=podman")), false);

  const composeCalls = calls.filter((spec) => spec.args?.includes("compose"));
  assert.ok(composeCalls.length >= 2);
  assert.ok(composeCalls.every((spec) => spec.command === "podman"));
  assert.ok(composeCalls.every((spec) =>
    spec.args.some((argument, index) => argument === "-f" && spec.args[index + 1]?.endsWith("compose.engine.yml"))
  ));
  assert.ok(composeCalls.some((spec) => spec.args.includes("up")));
  assert.equal(calls.filter((spec) => spec.command === "docker").length, 0);
  assert.match(stdout.value(), /PASS Podman CLI: available/);
  assert.equal(stderr.value(), "");
});

test("install adopts Podman when the Docker step hands back a ready Podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-flip-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];

  assert.equal(await run([
    "install",
    "--non-interactive",
    "--answers", installAnswers()
  ], {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    platform: "linux",
    arch: "x64",
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    prepareDockerPath: async () => null,
    inspectResources: async () => linuxResources,
    ensureDocker: async () => ({ code: 0, reexecuted: false, engine: "podman" }),
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.args?.includes("pg_dump")) {
        io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      }
      return 0;
    }
  }), 0);

  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  assert.match(stdout.value(), /Continuing with rootless Podman/);
  const composeCalls = calls.filter((spec) => spec.args?.includes("compose"));
  assert.ok(composeCalls.length >= 2);
  assert.ok(composeCalls.every((spec) => spec.command === "podman"));
  assert.ok(composeCalls.every((spec) =>
    spec.args.some((argument, index) => argument === "-f" && spec.args[index + 1]?.endsWith("compose.engine.yml"))
  ));
  assert.equal(stderr.value(), "");
});

test("--non-interactive picks a ready Podman when Docker is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-autopick-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];

  assert.equal(await run([
    "install",
    "--non-interactive",
    "--answers", installAnswers()
  ], {
    env: { SPACEAPP_HOME: root, XDG_RUNTIME_DIR: "/run/user/1000", SPACEAPP_TELEMETRY: "0" },
    platform: "linux",
    arch: "x64",
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    prepareDockerPath: async () => null,
    inspectResources: async () => linuxResources,
    // The real Docker step runs: only the socket check is stubbed, so a ready
    // Podman is detected exactly like on a host with the socket running.
    ensureDocker: (options) => ensureDockerAvailable({
      ...options,
      pathExists: async (path) => path === "/run/user/1000/podman/podman.sock"
    }),
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.command === "docker") {
        return 127;
      }
      if (spec.args?.includes("pg_dump")) {
        io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      }
      return 0;
    }
  }), 0);

  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  assert.match(stdout.value(), /Continuing with rootless Podman/);
  assert.deepEqual(
    calls.filter((spec) => spec.command === "docker").map((spec) => spec.args),
    [["--version"]]
  );
  const composeCalls = calls.filter((spec) => spec.args?.includes("compose"));
  assert.ok(composeCalls.length >= 2);
  assert.ok(composeCalls.every((spec) => spec.command === "podman"));
  assert.equal(stderr.value(), "");
});

test("install refuses to switch engines on an existing installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-switch-"));
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    platform: "linux",
    stdin: ttyStdin("y"),
    stdout: capture().stream,
    stderr: capture().stream,
    prepareDockerPath: async () => null,
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  };
  await run(["init"], options);

  await assert.rejects(
    run([
      "install",
      "--engine", "podman",
      "--non-interactive",
      "--answers", installAnswers()
    ], options),
    /switching container engines is refused/i
  );
  const message = await run([
    "install",
    "--engine", "podman",
    "--non-interactive",
    "--answers", installAnswers()
  ], options).catch((error) => error.message);
  assert.match(message, /backup/);
  assert.match(message, /restore/);
  assert.equal(calls.filter((spec) => spec.args?.includes("compose")).length, 0);
});

test("host-root access is refused with Podman before any command runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  const calls = [];
  await assert.rejects(
    run([
      "install",
      "--engine", "podman",
      "--access", "host-root",
      "--non-interactive",
      "--answers", installAnswers({ access: "host-root" })
    ], {
      env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
      platform: "linux",
      hostRootRuntimeCompatible: true,
      stdin: Readable.from([]),
      stdout: capture().stream,
      stderr: capture().stream,
      prepareDockerPath: async () => null,
      inspectResources: async () => linuxResources,
      execute: async (spec) => {
        calls.push(spec);
        return 0;
      }
    }),
    /host-root is not supported with Podman/i
  );
  assert.equal(calls.length, 0);
});

test("doctor reports Podman engine facts and machine resources on macOS", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  const options = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    platform: "darwin",
    stdin: ttyStdin("y"),
    stdout: capture().stream,
    stderr: capture().stream,
    prepareDockerPath: async () => null,
    inspectResources: async () => linuxResources,
    execute: async (spec, io) => {
      if (spec.args?.includes("pg_dump")) {
        io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      }
      return 0;
    }
  };
  await run(["init"], options);
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  await saveConfig(root, { ...config, engine: "podman" });

  const stdout = capture();
  const stderr = capture();
  const probes = [];
  assert.equal(await run(["doctor"], {
    ...options,
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec, io) => {
      probes.push(spec);
      const args = spec.args.join(" ");
      if (args === "--version") {
        io.stdout.write("podman version 6.1.4\n");
      } else if (args === "info --format json") {
        io.stdout.write(podmanInfoJson);
      } else if (args === "machine inspect") {
        io.stdout.write(podmanMachineInspectJson);
      }
      return 0;
    }
  }), 0);

  assert.deepEqual(probes.map((spec) => spec.args), [
    ["--version"],
    ["compose", "version"],
    ["info", "--format", "json"],
    ["machine", "inspect"]
  ]);
  assert.match(stdout.value(), /PASS Podman CLI: available \(6\.1\.4\)/);
  assert.match(stdout.value(), /PASS Podman Compose: available/);
  assert.match(stdout.value(), /PASS Podman Engine: available/);
  assert.match(stdout.value(), /PASS Podman mode: rootless/);
  assert.match(stdout.value(), /PASS Podman cgroup: cgroup v2; CPU and memory limits delegated/);
  assert.match(stdout.value(), /PASS Podman machine CPU: 4 allocated; 4 required for light/);
  assert.match(stdout.value(), /PASS Podman machine memory: 4\.0 GiB allocated; 3\.0 GiB required for light/);
  assert.match(stdout.value(), /PASS Podman machine disk: 60\.0 GiB allocated; 8\.0 GiB required for light/);
  assert.equal(stderr.value(), "");
});

test("doctor fails old Podman versions with upgrade guidance", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-old-"));
  const options = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    platform: "linux",
    stdin: ttyStdin("y"),
    stdout: capture().stream,
    stderr: capture().stream,
    prepareDockerPath: async () => null,
    inspectResources: async () => linuxResources,
    execute: async (spec, io) => {
      if (spec.args?.includes("pg_dump")) {
        io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      }
      return 0;
    }
  };
  await run(["init"], options);
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  await saveConfig(root, { ...config, engine: "podman" });

  const stdout = capture();
  const stderr = capture();
  assert.equal(await run(["doctor"], {
    ...options,
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec, io) => {
      const args = spec.args.join(" ");
      if (args === "--version") {
        io.stdout.write("podman version 4.9.3\n");
      } else if (args === "info --format json") {
        io.stdout.write(JSON.stringify({
          host: {
            arch: "x86_64",
            cpus: 4,
            memTotal: 8 * 1024 ** 3,
            cgroupVersion: "v1",
            security: { rootless: true }
          },
          store: {},
          version: { Version: "4.9.3" }
        }));
      }
      return 0;
    }
  }), 1);
  assert.match(stdout.value(), /PASS Podman CLI: available \(4\.9\.3\)/);
  assert.match(stderr.value(), /FAIL Podman cgroup: cgroup v1/);
});
