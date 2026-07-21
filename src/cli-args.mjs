export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    if (equal !== -1) {
      flags[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const name = token.slice(2);
    if (name.startsWith("no-")) {
      flags[name.slice(3)] = false;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { command: positionals[0] ?? "help", positionals: positionals.slice(1), flags };
}

export function numberFlag(flags, name, options = {}) {
  if (flags[name] === undefined) return options.defaultValue;
  const value = Number(flags[name]);
  if (!Number.isInteger(value) ||
      (options.min !== undefined && value < options.min) ||
      (options.max !== undefined && value > options.max)) {
    throw new Error(`--${name} must be an integer${options.min !== undefined ? ` >= ${options.min}` : ""}${options.max !== undefined ? ` and <= ${options.max}` : ""}`);
  }
  return value;
}
