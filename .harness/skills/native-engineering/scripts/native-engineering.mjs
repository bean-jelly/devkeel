#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const SKIP_DIRS = new Set([
  ".git",
  ".harness",
  "node_modules",
  "build",
  "dist",
]);
const ACTIONS = new Set([
  "discover",
  "doctor",
  "prepare",
  "build",
  "verify",
  "deps-update",
]);
const ERROR_LIMIT = 400;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { positional: [], execute: false, options: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--execute") {
      args.execute = true;
      continue;
    }
    if (["--root", "--config", "--profile", "--workdir"].includes(value)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        fail(`Missing value for ${value}`);
      args.options[value.slice(2)] = argv[++i];
      continue;
    }
    if (value.startsWith("--")) fail(`Unsupported option: ${value}`);
    args.positional.push(value);
  }
  if (args.positional.length !== 1 || !ACTIONS.has(args.positional[0])) {
    fail(
      "Usage: native-engineering.mjs <discover|doctor|prepare|build|verify|deps-update> [options]",
    );
  }
  return { action: args.positional[0], ...args };
}

async function emit(result, exitCode = 0) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  process.exit(exitCode);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function nearestRealPath(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return fs.realpathSync(current);
}

function resolveRoot(value) {
  const requested = path.resolve(value);
  const real = fs.realpathSync(requested);
  if (!fs.statSync(real).isDirectory())
    fail("Project root must be a directory");
  return real;
}

function discover(root) {
  const candidates = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const { directory, depth } = queue.shift();
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (
      entries.some(
        (entry) =>
          entry.isFile() &&
          ["CMakeLists.txt", "conanfile.py", "conanfile.txt"].includes(
            entry.name,
          ),
      )
    ) {
      candidates.push(path.relative(root, directory) || ".");
    }
    if (depth >= 4) continue;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        SKIP_DIRS.has(entry.name)
      )
        continue;
      queue.push({
        directory: path.join(directory, entry.name),
        depth: depth + 1,
      });
    }
  }
  return candidates.sort((a, b) => a.localeCompare(b));
}

function readConfig(root, configArg) {
  const configPath = path.resolve(root, configArg);
  if (!inside(root, configPath))
    fail("Config path must remain within project root");
  if (!fs.existsSync(configPath))
    fail(
      "Native config is missing; adapt the skill example for this project first",
    );
  if (!inside(root, fs.realpathSync(configPath)))
    fail("Config path resolves outside project root");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`Cannot read native config: ${error.message.slice(0, ERROR_LIMIT)}`);
  }
  if (
    !config ||
    config.schemaVersion !== 1 ||
    !Array.isArray(config.tools) ||
    !config.profiles ||
    typeof config.profiles !== "object" ||
    Array.isArray(config.profiles)
  ) {
    fail(
      "Invalid native config: expected schemaVersion 1, tools array, and profiles map",
    );
  }
  for (const tool of config.tools) {
    if (!tool || typeof tool.name !== "string" || !validCommand(tool.command))
      fail("Invalid tool entry");
    if (
      tool.acceptedExitCodes !== undefined &&
      (!Array.isArray(tool.acceptedExitCodes) ||
        !tool.acceptedExitCodes.every(Number.isInteger))
    )
      fail(`Invalid acceptedExitCodes for ${tool.name}`);
    for (const version of [tool.minVersion, tool.maxVersionExclusive].filter(
      Boolean,
    ))
      if (!parseVersion(version))
        fail(`Invalid version constraint for ${tool.name}`);
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile))
      fail(`Invalid profile: ${name}`);
    if (
      profile.workingDirectory !== undefined &&
      (typeof profile.workingDirectory !== "string" ||
        !profile.workingDirectory.trim())
    )
      fail(`Invalid workingDirectory for ${name}`);
    if (
      profile.environment !== undefined &&
      (!profile.environment ||
        typeof profile.environment !== "object" ||
        Array.isArray(profile.environment) ||
        Object.values(profile.environment).some((v) => typeof v !== "string"))
    )
      fail(`Invalid environment for ${name}`);
    if (
      profile.protectedFiles !== undefined &&
      (!Array.isArray(profile.protectedFiles) ||
        !profile.protectedFiles.every((v) => typeof v === "string"))
    )
      fail(`Invalid protectedFiles for ${name}`);
    if (profile.commands !== undefined) {
      if (
        !profile.commands ||
        typeof profile.commands !== "object" ||
        Array.isArray(profile.commands)
      )
        fail(`Invalid commands for ${name}`);
      for (const [action, steps] of Object.entries(profile.commands)) {
        if (
          !["prepare", "build", "verify", "deps-update"].includes(action) ||
          !Array.isArray(steps)
        )
          fail(`Invalid commands for ${name}`);
        for (const step of steps) {
          if (
            !step ||
            typeof step.name !== "string" ||
            !validCommand(step.command)
          )
            fail(`Invalid command step for ${name}`);
          if (
            step.timeoutMs !== undefined &&
            (!Number.isInteger(step.timeoutMs) ||
              step.timeoutMs <= 0 ||
              step.timeoutMs > 2147483647)
          )
            fail(`Invalid timeoutMs for ${step.name}`);
        }
      }
    }
  }
  return config;
}

function selectProfile(config, requested) {
  const names = Object.keys(config.profiles);
  if (requested) {
    if (!Object.hasOwn(config.profiles, requested))
      fail(`Unknown profile: ${requested}`);
    return requested;
  }
  if (names.length === 1) return names[0];
  return null;
}

function resolveWorkdir(root, requested, profile) {
  const relative = requested ?? profile?.workingDirectory;
  let selected = relative;
  if (selected === undefined) {
    const candidates = discover(root);
    if (candidates.length !== 1)
      return {
        blocked:
          "Select --workdir or profile workingDirectory; discovery did not find exactly one candidate",
        candidates,
      };
    selected = candidates[0];
  }
  if (path.isAbsolute(selected))
    return { error: "Working directory must be relative to project root" };
  const lexical = path.resolve(root, selected);
  if (!inside(root, lexical))
    return { error: "Working directory escapes project root" };
  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    return { error: "Working directory does not exist" };
  }
  if (!inside(root, real))
    return { error: "Working directory resolves outside project root" };
  if (!fs.statSync(real).isDirectory())
    return { error: "Working directory must be a directory" };
  return { directory: real };
}

function validCommand(command) {
  return (
    Array.isArray(command) &&
    command.length > 0 &&
    typeof command[0] === "string" &&
    command[0].trim() &&
    command.every((value) => typeof value === "string" && !value.includes("\0"))
  );
}

function environmentValue(env, name) {
  const key = Object.keys(env).find((key) =>
    process.platform === "win32"
      ? key.toLowerCase() === name.toLowerCase()
      : key === name,
  );
  return key === undefined ? undefined : env[key];
}

function effectiveEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === "win32") {
      for (const existing of Object.keys(env))
        if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

function findExecutable(executable, cwd, env) {
  const extensions =
    process.platform === "win32"
      ? (environmentValue(env, "PATHEXT") || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  const names =
    process.platform === "win32" && !path.extname(executable)
      ? [executable, ...extensions.map((extension) => executable + extension)]
      : [executable];
  const candidates =
    path.isAbsolute(executable) || /[\\/]/.test(executable)
      ? names.map((name) => path.resolve(cwd, name))
      : (environmentValue(env, "PATH") || "")
          .split(path.delimiter)
          .filter(Boolean)
          .flatMap((dir) => names.map((name) => path.resolve(cwd, dir, name)));
  return candidates.find((candidate) => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      if (process.platform !== "win32")
        fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function safeSummary(value) {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(
      /\b(token|password|passwd|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
    .slice(-ERROR_LIMIT);
}

function run(command, options = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    let child;
    let timer;
    let drainTimer;
    let terminationError;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      let summary = output;
      for (const value of options.privateValues || [])
        if (value) summary = summary.split(value).join("[redacted]");
      const failure = error || terminationError;
      resolve({
        exitCode: code,
        durationMs: Date.now() - started,
        version: parseVersion(output),
        output: safeSummary(summary),
        error: failure
          ? safeSummary(String(failure.message || failure))
          : undefined,
        timedOut,
      });
    };
    try {
      child = spawn(command[0], command.slice(1), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, error);
      return;
    }
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-8192);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") {
          const taskkill = path.join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "taskkill.exe",
          );
          const killed = spawnSync(
            taskkill,
            ["/pid", String(child.pid), "/t", "/f"],
            { windowsHide: true, timeout: 5000, stdio: "ignore" },
          );
          if (killed.status !== 0) {
            terminationError =
              "Process tree termination could not be confirmed";
            child.kill("SIGKILL");
          }
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        terminationError = "Process tree termination could not be confirmed";
        child.kill("SIGKILL");
      }
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(
          null,
          terminationError || "Process tree termination could not be confirmed",
        );
      }, 500);
    }, options.timeoutMs ?? 30000);
  });
}

function parseVersion(output) {
  const match = output.match(
    /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/,
  );
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

async function inspectTools(config, cwd, env) {
  const steps = [];
  let blocked = false;
  for (const tool of config.tools) {
    const executable = findExecutable(tool.command[0], cwd, env);
    const base = {
      name: tool.name,
      path: executable || tool.command[0],
      status: "PASS",
      exitCode: null,
    };
    if (!executable) {
      steps.push({
        ...base,
        status: "BLOCKED",
        error: `Not available on current PATH: ${tool.command[0]}`,
      });
      blocked = true;
      continue;
    }
    const result = await run([executable, ...tool.command.slice(1)], {
      cwd,
      env,
    });
    const accepted = tool.acceptedExitCodes ?? [0];
    const version = result.version;
    const inRange =
      version &&
      (!tool.minVersion ||
        compareVersions(version, parseVersion(tool.minVersion) || []) >= 0) &&
      (!tool.maxVersionExclusive ||
        compareVersions(version, parseVersion(tool.maxVersionExclusive) || []) <
          0);
    const ok =
      !result.timedOut &&
      accepted.includes(result.exitCode) &&
      version &&
      inRange;
    steps.push({
      ...base,
      status: ok ? "PASS" : "BLOCKED",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      version: version?.join("."),
      error: ok
        ? undefined
        : result.error ||
          (version
            ? "Version is outside configured range"
            : "Version could not be parsed"),
    });
    if (!ok) blocked = true;
  }
  return { steps, blocked };
}

function snapshotProtected(workdir, files) {
  const result = new Map();
  for (const relative of files) {
    if (path.isAbsolute(relative))
      fail(`Protected file must be relative: ${relative}`);
    const candidate = path.resolve(workdir, relative);
    if (!inside(workdir, candidate))
      fail(`Protected file escapes working directory: ${relative}`);
    const nearest = nearestRealPath(candidate);
    if (nearest && !inside(workdir, nearest))
      fail(`Protected file resolves outside working directory: ${relative}`);
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      result.set(relative, null);
      continue;
    }
    if (!inside(workdir, real))
      fail(`Protected file resolves outside working directory: ${relative}`);
    const stat = fs.statSync(real);
    result.set(
      relative,
      stat.isFile()
        ? createHash("sha256").update(fs.readFileSync(real)).digest("hex")
        : `non-file:${stat.mode}`,
    );
  }
  return result;
}

function changedProtected(workdir, before) {
  const after = snapshotProtected(workdir, [...before.keys()]);
  return [...before.keys()].filter(
    (name) => before.get(name) !== after.get(name),
  );
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const root = resolveRoot(parsed.options.root || process.cwd());
  if (parsed.action === "discover") {
    const candidates = discover(root);
    return emit(
      {
        schemaVersion: 1,
        action: "discover",
        profile: null,
        workingDirectory: null,
        status: candidates.length ? "PASS" : "BLOCKED",
        candidates,
      },
      candidates.length ? 0 : 1,
    );
  }
  const config = readConfig(
    root,
    parsed.options.config || ".harness/native.json",
  );
  const profileName = selectProfile(config, parsed.options.profile);
  if (!profileName)
    return emit(
      {
        schemaVersion: 1,
        action: parsed.action,
        profile: null,
        workingDirectory: null,
        status: "BLOCKED",
        steps: [],
        error:
          "Select a profile with --profile when multiple profiles are configured",
      },
      1,
    );
  const profile = profileName ? config.profiles[profileName] : null;
  const work = resolveWorkdir(root, parsed.options.workdir, profile);
  if (work.error) fail(work.error);
  if (work.blocked)
    return emit(
      {
        schemaVersion: 1,
        action: parsed.action,
        profile: profileName,
        workingDirectory: null,
        status: "BLOCKED",
        steps: [],
        candidates: work.candidates,
        error: work.blocked,
      },
      1,
    );
  const workdir = work.directory || root;
  const env = effectiveEnvironment(profile.environment);
  const protectedFiles = [
    ...new Set([...(profile.protectedFiles || []), "conan.lock"]),
  ];
  const protecting = ["build", "verify"].includes(parsed.action);
  const before =
    protecting || parsed.action === "doctor"
      ? snapshotProtected(workdir, protectedFiles)
      : null;
  const missingFiles = (profile.protectedFiles || []).filter(
    (file) => before?.get(file) === null,
  );
  if ((protecting || parsed.action === "doctor") && missingFiles.length) {
    return emit(
      {
        schemaVersion: 1,
        action: parsed.action,
        profile: profileName,
        workingDirectory: workdir,
        status: "BLOCKED",
        steps: [],
        error: `Missing protected files: ${missingFiles.join(", ")}`,
      },
      1,
    );
  }
  if (parsed.action === "doctor") {
    const tools = await inspectTools(config, workdir, env);
    return emit(
      {
        schemaVersion: 1,
        action: "doctor",
        profile: profileName,
        workingDirectory: workdir,
        status: tools.blocked ? "BLOCKED" : "PASS",
        steps: tools.steps,
      },
      tools.blocked ? 1 : 0,
    );
  }
  const steps = profile?.commands?.[parsed.action];
  if (!steps?.length)
    return emit(
      {
        schemaVersion: 1,
        action: parsed.action,
        profile: profileName,
        workingDirectory: workdir,
        status: "BLOCKED",
        steps: [],
        error: `No ${parsed.action} commands configured`,
      },
      1,
    );
  if (
    parsed.action !== "deps-update" &&
    steps.some((step) =>
      step.command.some(
        (argument) =>
          argument === "--lockfile-out" ||
          argument.startsWith("--lockfile-out="),
      ),
    )
  ) {
    fail("--lockfile-out is allowed only in the deps-update action");
  }
  if (!parsed.execute)
    return emit({
      schemaVersion: 1,
      action: parsed.action,
      profile: profileName,
      workingDirectory: workdir,
      status: "PLAN",
      steps: steps.map((step) => ({
        name: step.name,
        status: "PLAN",
        command: step.command,
      })),
    });

  const tools = await inspectTools(config, workdir, env);
  if (tools.blocked)
    return emit(
      {
        schemaVersion: 1,
        action: parsed.action,
        profile: profileName,
        workingDirectory: workdir,
        status: "BLOCKED",
        steps: tools.steps,
      },
      1,
    );
  const results = [];
  for (const step of steps) {
    const result = await run(step.command, {
      cwd: workdir,
      env,
      timeoutMs: step.timeoutMs ?? 600000,
      privateValues: Object.values(profile.environment || {}),
    });
    const item = {
      name: step.name,
      status: result.exitCode === 0 && !result.timedOut ? "PASS" : "FAIL",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
    if (item.status === "FAIL")
      item.error = safeSummary(
        (result.timedOut ? "Process timed out. " : "") +
          (result.error ? `${result.error}. ` : "") +
          result.output,
      );
    results.push(item);
    if (before) {
      const changed = changedProtected(workdir, before);
      if (changed.length) {
        results.push({
          name: "Protected file check",
          status: "FAIL",
          exitCode: null,
          durationMs: 0,
          error: `Changed protected files: ${changed.join(", ")}`,
        });
        break;
      }
    }
    if (item.status === "FAIL") break;
  }
  const status = results.some((step) => step.status === "FAIL")
    ? "FAIL"
    : "PASS";
  return emit(
    {
      schemaVersion: 1,
      action: parsed.action,
      profile: profileName,
      workingDirectory: workdir,
      status,
      tools: tools.steps,
      steps: results,
    },
    status === "PASS" ? 0 : 1,
  );
}

main().catch((error) =>
  fail(String(error?.message || error).slice(0, ERROR_LIMIT)),
);
