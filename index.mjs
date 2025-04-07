#!/usr/bin/env node

import { tailStackEvents } from "./lib/events.mjs";

function showUsageAndExit() {
  console.log(`cfn-event-tailer <stack-name>
Usage:
  <stack-name> the name of the stack to tail
`);
  process.exit(1);
}

function main() {
  const stackName = process.argv[2];
  if (!stackName) showUsageAndExit();
  tailStackEvents(process.argv[2]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

main();
