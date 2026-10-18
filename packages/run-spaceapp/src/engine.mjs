import { UNIVERSAL_COMMAND } from "./package-info.mjs";

// Container engines the launcher can drive. "docker" is the default and the
// stored configuration only records a non-default choice, so an installation
// without an "engine" field keeps running on Docker unchanged.
export const INSTALL_ENGINES = Object.freeze(["docker", "podman"]);

const ENGINE_DISPLAY_NAMES = Object.freeze({ docker: "Docker", podman: "Podman" });

// Memory the container engine itself must be allowed to use per profile (GiB).
// On Docker Desktop/rootless Docker this is engine-allocated memory; on macOS
// with Podman it maps to the Podman machine's memory, which is what
// `podman machine set --memory <MiB>` resizes.
export const ENGINE_MEMORY_BYTES = Object.freeze({
  small: 3,
  medium: 5,
  large: 7,
  light: 3,
  standard: 3
});

export function engineDisplayName(engine) {
  return ENGINE_DISPLAY_NAMES[engine] ?? "Docker";
}

export function assertInstallEngine(engine) {
  if (!INSTALL_ENGINES.includes(engine)) {
    throw new Error("Container engine must be docker or podman.");
  }
  return engine;
}

// The stored engine, when present, is the engine the installation runs on.
// Docker is represented by the absence of the field so Docker-only launchers
// keep reading the same config.
export function resolveInstallEngine(requested, existing) {
  if (requested !== undefined) {
    assertInstallEngine(requested);
  }
  if (existing !== undefined && existing !== null) {
    assertInstallEngine(existing);
  }
  return requested ?? existing ?? "docker";
}

export function storedEngine(config) {
  return config?.engine ?? "docker";
}

// Probe used when the launcher needs engine facts (architecture, CPU, memory,
// data root, cgroup). Kept per engine because the two CLIs report different
// JSON shapes.
export function engineInfoProbe(engine) {
  assertInstallEngine(engine);
  return engine === "podman"
    ? { command: "podman", args: ["info", "--format", "json"] }
    : { command: "docker", args: ["info", "--format", "{{json .}}"] };
}

// Normalizes `docker info --format '{{json .}}'` and `podman info --format json`
// into one shape. Returns null when the output is not usable so probes stay
// conservative instead of failing late.
export function parseEngineInfo(engine, output) {
  if (engine !== "docker" && engine !== "podman") {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(String(output ?? ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  if (engine === "podman") {
    const host = parsed.host && typeof parsed.host === "object" ? parsed.host : {};
    const security = host.security && typeof host.security === "object" ? host.security : {};
    const store = parsed.store && typeof parsed.store === "object" ? parsed.store : {};
    const version = parsed.version && typeof parsed.version === "object" ? parsed.version : {};
    return {
      engine,
      version: typeof version.Version === "string" ? version.Version : null,
      architecture: typeof host.arch === "string" ? host.arch : null,
      cpuCount: Number.isFinite(host.cpus) ? host.cpus : null,
      memoryBytes: Number.isFinite(host.memTotal) ? host.memTotal : null,
      dataRoot: typeof store.graphRoot === "string" ? store.graphRoot : null,
      rootless: typeof security.rootless === "boolean" ? security.rootless : null,
      cgroupVersion: normalizeCgroupVersion(host.cgroupVersion),
      cgroupControllers: Array.isArray(host.cgroupControllers) ? host.cgroupControllers : null
    };
  }
  return {
    engine,
    version: typeof parsed.ServerVersion === "string" ? parsed.ServerVersion : null,
    architecture: typeof parsed.Architecture === "string" ? parsed.Architecture : null,
    cpuCount: Number.isFinite(parsed.NCPU) ? parsed.NCPU : null,
    memoryBytes: Number.isFinite(parsed.MemTotal) ? parsed.MemTotal : null,
    dataRoot: typeof parsed.DockerRootDir === "string" ? parsed.DockerRootDir : null,
    rootless: Array.isArray(parsed.SecurityOptions)
      ? parsed.SecurityOptions.some((option) => String(option).includes("rootless"))
      : null,
    cgroupVersion: normalizeCgroupVersion(parsed.CgroupVersion),
    cgroupControllers: null
  };
}

function normalizeCgroupVersion(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const normalized = String(value).replace(/^v/i, "").trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

// "Delegated" means the rootless manager actually exposes cpu and memory
// controllers to containers; without them mem_limit/cpus are ignored and the
// launcher must say so instead of failing late.
export function limitsDelegation(engineInfo) {
  if (!engineInfo || engineInfo.cgroupVersion === null) {
    return null;
  }
  if (engineInfo.cgroupVersion !== "2") {
    return { delegated: false, reason: `cgroup v${engineInfo.cgroupVersion}` };
  }
  const controllers = engineInfo.cgroupControllers;
  if (!Array.isArray(controllers)) {
    return null;
  }
  const missing = ["cpu", "memory"].filter((controller) => !controllers.includes(controller));
  return missing.length === 0
    ? { delegated: true, reason: null }
    : { delegated: false, reason: `cgroup v2 without the ${missing.join("/")} controller${missing.length > 1 ? "s" : ""}` };
}

// `podman machine inspect --format json` for the active machine.
export function parsePodmanMachineInspect(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output ?? ""));
  } catch {
    return null;
  }
  const machines = Array.isArray(parsed) ? parsed : [parsed];
  const machine = machines.find((entry) => entry?.State === "running") ?? machines.find((entry) => entry && typeof entry === "object");
  if (!machine || typeof machine !== "object") {
    return null;
  }
  if (typeof machine.Name !== "string" && typeof machine.State !== "string") {
    // Not a machine record: callers treat this as "no machine information".
    return null;
  }
  const resources = machine.Resources && typeof machine.Resources === "object" ? machine.Resources : {};
  const connection = machine.ConnectionInfo && typeof machine.ConnectionInfo === "object" ? machine.ConnectionInfo : {};
  const socket = connection.PodmanSocket && typeof connection.PodmanSocket === "object" ? connection.PodmanSocket : {};
  const memoryMiB = Number.isFinite(resources.Memory) ? resources.Memory : null;
  const diskGiB = Number.isFinite(resources.DiskSize) ? resources.DiskSize : null;
  return {
    name: typeof machine.Name === "string" ? machine.Name : null,
    state: typeof machine.State === "string" ? machine.State : null,
    cpuCount: Number.isFinite(resources.CPUs) ? resources.CPUs : null,
    memoryBytes: memoryMiB === null ? null : memoryMiB * 1024 ** 2,
    diskBytes: diskGiB === null ? null : diskGiB * 1024 ** 3,
    socketPath: typeof socket.Path === "string" && socket.Path ? socket.Path : null
  };
}

// Profile checks for a Podman machine on macOS: the machine owns its own CPU,
// memory and disk budget, so SpaceApp stops early with resize instructions
// instead of failing during image pulls or container start. `requirements`
// carries the profile minima: cpuCount, memoryBytes (engine memory, as
// `podman machine set --memory` takes MiB) and diskBytes.
export function podmanMachineResourceChecks(machine, profile, requirements) {
  if (!machine || !requirements) {
    return [];
  }
  const checks = [];
  if (machine.cpuCount !== null) {
    checks.push({
      name: "Podman machine CPU",
      ok: machine.cpuCount >= requirements.cpuCount,
      detail: `${machine.cpuCount} allocated; ${requirements.cpuCount} required for ${profile}`
    });
  }
  if (machine.memoryBytes !== null) {
    checks.push({
      name: "Podman machine memory",
      ok: machine.memoryBytes >= requirements.memoryBytes,
      detail: `${formatGibibytes(machine.memoryBytes)} GiB allocated; ${formatGibibytes(requirements.memoryBytes)} GiB required for ${profile}`
    });
  }
  if (machine.diskBytes !== null) {
    checks.push({
      name: "Podman machine disk",
      ok: machine.diskBytes >= requirements.diskBytes,
      detail: `${formatGibibytes(machine.diskBytes)} GiB allocated; ${formatGibibytes(requirements.diskBytes)} GiB required for ${profile}`
    });
  }
  return checks;
}

// The minima a Podman machine must satisfy for a profile: CPU and disk come
// from the profile requirements; memory is the engine allocation map, because
// the machine's memory is the engine memory on macOS.
export function podmanMachineRequirements(profile, profileRequirements) {
  if (!profileRequirements) {
    return null;
  }
  return {
    cpuCount: profileRequirements.cpuCount,
    memoryBytes: (ENGINE_MEMORY_BYTES[profile] ?? 3) * 1024 ** 3,
    diskBytes: profileRequirements.freshDiskBytes
  };
}

export function podmanMachineResizeHint(checks) {
  const failing = checks.some((check) => !check.ok);
  if (!failing) {
    return null;
  }
  return (
    "Resize the Podman machine with: podman machine stop && " +
    "podman machine set --cpus <cpus> --memory <MiB> && podman machine start " +
    "(disk: --disk-size <GiB>, growing the disk is supported; shrinking is not)."
  );
}

export function podmanInstallInstructions(platform) {
  if (platform === "darwin") {
    return (
      "Podman was not found. Install it with Homebrew (brew install podman) or Podman Desktop, " +
      "then create the Linux machine: podman machine init && podman machine start, " +
      "and install the Compose provider: brew install docker-compose."
    );
  }
  return (
    "Podman was not found. Install Podman with your distribution packages " +
    "(for example sudo apt install podman, sudo dnf install podman, or sudo pacman -S podman) " +
    "and make sure the docker-compose v2 provider is on PATH."
  );
}

export function podmanPreparationHelp(platform) {
  if (platform === "darwin") {
    return (
      `Start a Podman machine ("podman machine init" once, then "podman machine start") ` +
      `and rerun "${UNIVERSAL_COMMAND} install --engine podman".`
    );
  }
  return (
    "Rootless Podman is daemonless, but the docker-compose v2 provider talks to the Podman socket. " +
    'Start it for this user with "systemctl --user enable --now podman.socket" ' +
    "and retry. Rootless Podman also needs the newuidmap/newgidmap helpers and a /etc/subuid entry for your user."
  );
}

// `docker info` output is plain text and Docker refuses `--format` for a few
// of these facts on old releases, so the doctor parses the text it already
// captured. Returns null when the output is empty.
export function parseDockerInfoText(output) {
  const text = String(output ?? "");
  if (!text.trim()) {
    return null;
  }
  return {
    version: /Server Version:\s*([^\s,]+)/.exec(text)?.[1] ?? null,
    cgroupVersion: normalizeCgroupVersion(/Cgroup Version:\s*v?([0-9]+)/i.exec(text)?.[1]),
    rootless: text.includes("Security Options:") ? /name=rootless/.test(text) : null
  };
}

function formatGibibytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)}`;
}
