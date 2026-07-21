#!/usr/bin/env node

import { errorResult, main } from "../src/cli.mjs";

const argv = process.argv.slice(2);

main(argv).then((result) => {
  if (result?.ok === false) process.exitCode = 1;
}).catch((error) => {
  const result = errorResult(error);
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stderr.write(`quotapeek: [${result.error.code}] ${result.error.message}\n`);
  process.exitCode = 1;
});
