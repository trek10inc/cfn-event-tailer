#!/usr/bin/env node

import {
  CloudFormation,
  DescribeStackEventsCommand,
} from "@aws-sdk/client-cloudformation";

const cfn = new CloudFormation();

const TERMINAL_EVENT_STATUS_SUFFIXES = ["_COMPLETE", "_FAILED", "_SKIPPED"];
const SUCCESSFUL_EVENT_STATUSES = [
  "CREATE_COMPLETE",
  "DELETE_COMPLETE",
  "UPDATE_COMPLETE",
  "IMPORT_COMPLETE",
];

function chunkString(str, length) {
  const numChunks = Math.ceil(str.length / length);
  const chunks = new Array(numChunks);

  for (let i = 0, o = 0; i < numChunks; ++i, o += length) {
    chunks[i] = str.substr(o, length);
  }

  return chunks;
}

/**
 * @param {import('aws-sdk').CloudFormation.StackEvent} stackEvent
 */
function logStackEvent(stackEvent) {
  const numberOfTerminalColumns =
    Math.floor(process.stdout.columns * 0.8) || 132;
  const columnWidths = [
    numberOfTerminalColumns / 5,
    24,
    numberOfTerminalColumns / 5,
    numberOfTerminalColumns / 5,
    numberOfTerminalColumns / 5,
    numberOfTerminalColumns / 5,
  ];
  const logLines = [
    chunkString(stackEvent.StackName, columnWidths[0]),
    chunkString(stackEvent.Timestamp.toISOString(), columnWidths[1]),
    chunkString(stackEvent.LogicalResourceId, columnWidths[2]),
    chunkString(stackEvent.ResourceType, columnWidths[3]),
    chunkString(stackEvent.ResourceStatus, columnWidths[4]),
    chunkString(stackEvent.ResourceStatusReason || "", columnWidths[5]),
  ];
  const numberOfLines = logLines
    .map((arr) => arr.length)
    .sort((a, b) => a - b)
    .pop();
  for (let i = 0; i < numberOfLines; i++) {
    console.log(
      [
        (logLines?.[0]?.[i] || "").padEnd(columnWidths[0]),
        (logLines?.[1]?.[i] || "").padEnd(columnWidths[1]),
        (logLines?.[2]?.[i] || "").padEnd(columnWidths[2]),
        (logLines?.[3]?.[i] || "").padEnd(columnWidths[3]),
        (logLines?.[4]?.[i] || "").padEnd(columnWidths[4]),
        (logLines?.[5]?.[i] || "").padEnd(columnWidths[5]),
      ].join("  "),
    );
  }
}

/**
 * @param {String} stackName
 * @param {import('aws-sdk').CloudFormation.StackEvent} event
 */
function isTerminalStackEvent(stackName, event) {
  return (
    event.ResourceType === "AWS::CloudFormation::Stack" &&
    event.LogicalResourceId === stackName &&
    !!TERMINAL_EVENT_STATUS_SUFFIXES.find((suffix) =>
      event.ResourceStatus.endsWith(suffix),
    )
  );
}

async function safeDescribeStackEvents(stackName, tries = 0) {
  try {
    const response = await cfn.send(
      new DescribeStackEventsCommand({ StackName: stackName }),
    );
    return response.StackEvents;
  } catch (err) {
    if (tries < 5 && err.code === "Throttling") {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      return safeDescribeStackEvents(stackName, tries + 1);
    }
    throw err;
  }
}

async function tailStackEvents(stackName) {
  /** @type {import('aws-sdk').CloudFormation.StackEvents} */
  let stackEventsToLog;
  /** @type {import('aws-sdk').CloudFormation.StackEvent} */
  let lastLoggedStackEvent;
  /** @type {import('aws-sdk').CloudFormation.StackEvent} */
  let currentExecutionTerminalEvent;
  let lastTerminalEventIndex;

  const stackId = stackName;
  if (stackName.startsWith("arn:")) {
    stackName = stackName.split("/")[1];
  }
  // kep track of stacks we're tailing
  const tailingStacks = {
    [stackName]: Promise.resolve(),
  };

  /** @type {import('aws-sdk').CloudFormation.StackEvents} */
  let stackEvents = await safeDescribeStackEvents(stackId);
  const lastExecutionTerminalEvent = stackEvents.find((event) =>
    isTerminalStackEvent(stackName, event),
  );
  if (stackEvents.indexOf(lastExecutionTerminalEvent) === 0) {
    console.log(`${stackName}: No currently running stack update`);
    return;
  }

  do {
    // get stack events
    try {
      stackEvents = (
        await cfn.send(new DescribeStackEventsCommand({ StackName: stackId }))
      ).StackEvents;
    } catch (err) {
      if (err?.code === "Throttling") {
        continue;
      }
      throw err;
    }

    // filter out previous executions
    lastTerminalEventIndex = stackEvents
      .map((x) => x.EventId)
      .indexOf(lastExecutionTerminalEvent?.EventId);
    if (lastTerminalEventIndex !== -1) {
      stackEventsToLog = stackEvents.slice(
        0,
        stackEvents
          .map((x) => x.EventId)
          .indexOf(lastExecutionTerminalEvent?.EventId),
      );
    } else {
      // if this is the first execution of the stack
      stackEventsToLog = stackEvents;
    }

    // trim out old events
    if (lastLoggedStackEvent) {
      stackEventsToLog = stackEventsToLog.slice(
        0,
        stackEvents.map((x) => x.EventId).indexOf(lastLoggedStackEvent.EventId),
      );
    }

    // sort events before logging
    stackEventsToLog.sort((a, b) => a.Timestamp - b.Timestamp);
    // log events
    for (const event of stackEventsToLog) {
      logStackEvent(event);
      lastLoggedStackEvent = event;
      // kick off new tail for nested stacks
      if (
        // is nested stack
        event.ResourceType === "AWS::CloudFormation::Stack" &&
        event.LogicalResourceId !== stackName &&
        event.PhysicalResourceId &&
        // not already being tailed
        !Object.keys(tailingStacks).includes(event.PhysicalResourceId)
      ) {
        tailingStacks[event.PhysicalResourceId] = tailStackEvents(
          event.PhysicalResourceId,
        );
      }
    }

    // sleep for 1 second
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });

    // while we can't find a terminal stack event
    currentExecutionTerminalEvent = stackEventsToLog.find((event) =>
      isTerminalStackEvent(stackName, event),
    );
  } while (!currentExecutionTerminalEvent);
  await Promise.all(Object.values(tailingStacks));

  // check final stack event
  if (
    !SUCCESSFUL_EVENT_STATUSES.includes(
      currentExecutionTerminalEvent.ResourceStatus,
    )
  ) {
    console.error(
      `${stackName} ${currentExecutionTerminalEvent.ResourceStatus}`,
    );
    process.exit(1);
  }
}

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
