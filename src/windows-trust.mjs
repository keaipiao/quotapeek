import { win32 } from "node:path";

/**
 * Return the inbox Windows PowerShell executable without consulting PATH.
 * SystemRoot is supplied by Windows; a malformed/missing value fails back to
 * the standard absolute Windows root instead of producing a relative command.
 */
export function systemWindowsPowerShellPath(env = process.env) {
  const configuredRoot = typeof env?.SystemRoot === "string" ? env.SystemRoot.trim() : "";
  // SystemRoot is expected to be a fully-qualified local drive path. Node's
  // win32.isAbsolute also accepts drive-less root-relative values (for example
  // `\\Windows`), so require the drive explicitly before trusting the value.
  const windowsRoot = /^[A-Za-z]:[\\/]/.test(configuredRoot) ? configuredRoot : "C:\\Windows";
  return win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
