import { parseArgs } from "./cli-args.mjs";
import { CodexQuotaError } from "./errors.mjs";
import { PACKAGE_ROOT } from "./paths.mjs";
import { readPackageMetadata } from "./commands/install.mjs";

const HELP = `Codex Quota

Usage:
  codex-q install [--no-desktop] [--no-shortcuts] [--json]
  codex-q start [--port PORT] [--foreground] [--json]
  codex-q doctor [--live] [--json]
  codex-q uninstall [--json]
  codex-q version

The first cold start must go through "Codex + Quota" (or the start command)
so the official Store process receives loopback CDP flags.
`;

export async function main(argv, io = defaultIo()) {
  const parsed = parseArgs(argv);
  try {
    const globalAction = classifyGlobalAction(argv, parsed);
    if (globalAction === "help") {
      io.stdout(HELP);
      return { ok: true };
    }
    if (globalAction === "version") {
      const metadata = await readPackageMetadata(PACKAGE_ROOT);
      const result = { ok: true, version: metadata.version };
      if (jsonRequested(parsed.flags)) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      else io.stdout(`${metadata.version}\n`);
      return result;
    }
    validateInvocation(parsed);
    return await dispatch(parsed, io);
  } catch (error) {
    const result = errorResult(error);
    emitResult(result, jsonRequested(parsed.flags), io, () => emitHumanFailure(result, io));
    return result;
  }
}

async function dispatch(parsed, io) {
  switch (parsed.command) {
    case "help":
    case "--help":
    case "-h":
      io.stdout(HELP);
      return { ok: true };
    case "version":
    case "--version": {
      const metadata = await readPackageMetadata(PACKAGE_ROOT);
      const result = { ok: true, version: metadata.version };
      emitResult(result, jsonRequested(parsed.flags), io, () => io.stdout(`${metadata.version}\n`));
      return result;
    }
    case "install": {
      const { installCommand } = await import("./commands/install.mjs");
      const result = await installCommand({
        desktop: parsed.flags.desktop === undefined ? true : booleanValue(parsed.flags.desktop),
        noShortcuts: parsed.flags.shortcuts === undefined ? false : !booleanValue(parsed.flags.shortcuts)
      });
      emitResult(result, jsonRequested(parsed.flags), io, () => emitInstallHuman(result, io));
      return result;
    }
    case "start": {
      const { startCommand } = await import("./commands/start.mjs");
      const result = await startCommand(parsed.flags);
      emitResult(result, jsonRequested(parsed.flags), io, () => {
        if (!result.ok) return emitHumanFailure(result, io);
        io.stdout(`Codex Quota started (daemon PID ${result.daemonPid}, CDP port ${result.port}).\n`);
      });
      return result;
    }
    case "doctor": {
      const { doctorCommand, formatDoctor } = await import("./commands/doctor.mjs");
      const result = await doctorCommand({ live: booleanValue(parsed.flags.live) });
      emitResult(result, jsonRequested(parsed.flags), io, () => emitDoctorHuman(result, formatDoctor, io));
      return result;
    }
    case "uninstall": {
      const { uninstallCommand } = await import("./commands/uninstall.mjs");
      const result = await uninstallCommand({});
      emitResult(result, jsonRequested(parsed.flags), io, () => emitUninstallHuman(result, io));
      return result;
    }
    case "daemon": {
      const { daemonCommand } = await import("./host/daemon.mjs");
      return daemonCommand(parsed.flags);
    }
    default:
      throw new CodexQuotaError("E_UNKNOWN_COMMAND", `Unknown command: ${parsed.command}\n\n${HELP}`);
  }
}

const COMMAND_FLAGS = Object.freeze({
  help: new Set([]),
  install: new Set(["desktop", "shortcuts", "json"]),
  start: new Set(["port", "foreground", "installed", "json"]),
  doctor: new Set(["live", "json"]),
  uninstall: new Set(["json"]),
  version: new Set(["json"]),
  daemon: new Set(["session", "nonce", "engine-root"])
});

const BOOLEAN_FLAGS = new Set(["desktop", "shortcuts", "foreground", "installed", "live", "json"]);

export function classifyGlobalAction(argv, parsed = parseArgs(argv)) {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (argv.includes("--version")) return "version";
  if (parsed.command === "--help" || parsed.command === "-h") return "help";
  if (parsed.command === "--version") return "version";
  return null;
}

export function validateInvocation(parsed) {
  const allowed = COMMAND_FLAGS[parsed.command];
  if (!allowed) return;
  if (parsed.positionals.length) {
    throw new CodexQuotaError("E_USAGE", `Unexpected argument for ${parsed.command}: ${parsed.positionals[0]}`);
  }
  for (const [name, value] of Object.entries(parsed.flags)) {
    if (!allowed.has(name)) throw new CodexQuotaError("E_USAGE", `Unknown option for ${parsed.command}: --${name}`);
    if (BOOLEAN_FLAGS.has(name) && !isBooleanValue(value)) {
      throw new CodexQuotaError("E_USAGE", `--${name} must be a boolean flag`);
    }
  }
}

function isBooleanValue(value) {
  return value === true || value === false || value === "true" || value === "false";
}

function booleanValue(value) {
  if (value === undefined) return false;
  if (!isBooleanValue(value)) throw new CodexQuotaError("E_USAGE", "Expected a boolean option");
  return value === true || value === "true";
}

function jsonRequested(flags) {
  return flags?.json === true || flags?.json === "true";
}

export function emitResult(result, json, io, human) {
  if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else human();
  if (result?.ok === false) markFailed(io);
}

export function errorResult(error) {
  const rawCode = typeof error?.code === "string" ? error.code : "E_CLI";
  const code = /^[A-Z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : "E_CLI";
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      code,
      message,
      ...(error?.details === undefined ? {} : { details: error.details })
    }
  };
}

export function emitInstallHuman(result, io) {
  if (!result.ok) return emitHumanFailure(result, io);
  io.stdout(`Installed Codex Quota ${result.install.version} in ${result.install.engineRoot}\n`);
  if (result.shortcuts?.skipped) {
    io.stdout("Installation does not start Codex. Shortcuts were not created (--no-shortcuts); start it with 'codex-q start'.\n");
  } else {
    io.stdout("Installation does not start Codex. Next, open the 'Codex + Quota' shortcut directly; you do not need to run 'codex-q start'. CDP remains a same-user security boundary.\n");
  }
}

export function emitDoctorHuman(result, formatDoctor, io) {
  io.stdout(formatDoctor(result));
  if (!result.ok) io.stderr("[E_DOCTOR_FAILED] Doctor found blocking failures.\n");
}

export function emitUninstallHuman(result, io) {
  if (!result.ok) return emitHumanFailure(result, io);
  io.stdout("Codex Quota was uninstalled.\n");
  if (result.shortcuts?.skipped?.length) {
    io.stdout(`Warning: ${result.shortcuts.skipped.length} same-name shortcut(s) were not owned by Codex Quota and were left untouched.\n`);
  }
  if (result.cdpMayStillBeOpen) {
    io.stdout("Codex is still running with CDP; fully exit and reopen the official app to close it.\n");
  }
}

function emitHumanFailure(result, io) {
  const code = result?.error?.code ?? result?.code ?? "E_COMMAND_FAILED";
  const message = result?.error?.message ?? result?.message ?? "Command failed";
  io.stderr(`[${code}] ${message}\n`);
}

function markFailed(io) {
  if (typeof io.setExitCode === "function") io.setExitCode(1);
}

function defaultIo() {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    setExitCode: (value) => { process.exitCode = value; }
  };
}

export { HELP };
