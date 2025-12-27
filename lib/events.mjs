import { CloudFormation, DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";

const cfn = new CloudFormation();

const TERMINAL_EVENT_STATUS_SUFFIXES = ["_COMPLETE", "_FAILED", "_SKIPPED"];
const SUCCESSFUL_EVENT_STATUSES = ["CREATE_COMPLETE", "DELETE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"];

/**
 * @typedef {import('@aws-sdk/client-cloudformation').StackEvent} StackEvent
 */

/**
 * @param {string | undefined} str
 * @param {number} length
 */
function chunkString(str, length) {
  const numChunks = Math.ceil((str ?? "").length / length);
  const chunks = new Array(numChunks);

  for (let i = 0, o = 0; i < numChunks; ++i, o += length) {
    chunks[i] = (str ?? "").substr(o, length);
  }

  return chunks;
}

/**
 * @param {StackEvent} stackEvent
 */
function logStackEvent(stackEvent) {
  let numberOfTerminalColumns = Math.floor(process.stdout.columns - 10);
  if (Number.isNaN(numberOfTerminalColumns)) numberOfTerminalColumns = 80;

  const timeWidth = 8;
  const columnWidths = [
    Math.floor((numberOfTerminalColumns - timeWidth) / 5),
    timeWidth,
    Math.floor((numberOfTerminalColumns - timeWidth) / 5),
    Math.floor((numberOfTerminalColumns - timeWidth) / 5),
    Math.floor((numberOfTerminalColumns - timeWidth) / 5),
  ];
  const remainingWidth = numberOfTerminalColumns - columnWidths.reduce((a, b) => a + b, 0);
  columnWidths.push(remainingWidth);
  const timeDate = new Date(stackEvent.Timestamp ?? 0);
  const timestamp = `${timeDate.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    second: "2-digit",
    minute: "2-digit",
  })}`;
  const reason = chunkString(stackEvent.ResourceStatusReason || "", columnWidths[5]);
  const logLines = [
    chunkString(stackEvent.StackName, columnWidths[0]),
    chunkString(timestamp, columnWidths[1]),
    chunkString(stackEvent.LogicalResourceId, columnWidths[2]),
    chunkString(stackEvent.ResourceType, columnWidths[3]),
    chunkString(stackEvent.ResourceStatus, columnWidths[4]),
    reason,
  ];
  const numberOfLines = logLines
    .map((arr) => arr.length)
    .sort((a, b) => a - b)
    .pop();
  for (let i = 0; i < (numberOfLines ?? 0); i++) {
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
 * @param {StackEvent} event
 */
function isTerminalStackEvent(stackName, event) {
  return (
    event.ResourceType === "AWS::CloudFormation::Stack" &&
    event.LogicalResourceId === stackName &&
    !!TERMINAL_EVENT_STATUS_SUFFIXES.find((suffix) => event.ResourceStatus?.endsWith(suffix))
  );
}

/**
 * @param {string} stackName
 * @param {number} tries
 */
async function safeDescribeStackEvents(stackName, tries = 0) {
  try {
    const response = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    return response.StackEvents;
  } catch (err) {
    if (tries < 5 && /** @type {*} */ (err)?.Code === "Throttling") {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      return safeDescribeStackEvents(stackName, tries + 1);
    }
    throw err;
  }
}

/**
 * @param {string} stackName
 */
export async function tailStackEvents(stackName) {
  /** @type {StackEvent[]} */
  let stackEventsToLog;
  /** @type {StackEvent | undefined} */
  let lastLoggedStackEvent;
  /** @type {StackEvent | undefined} */
  let currentExecutionTerminalEvent;
  let lastTerminalEventIndex;

  let stackId = stackName;
  if (stackName.startsWith("arn:")) {
    stackName = stackName.split("/")[1];
  }
  const describeStacksResponse = await cfn.describeStacks({ StackName: stackName });
  if (!describeStacksResponse.Stacks || describeStacksResponse.Stacks.length === 0) {
    throw new Error(`Stack ${stackName} not found`);
  }
  stackId = describeStacksResponse.Stacks[0].StackId ?? stackName;

  // kep track of stacks we're tailing
  const tailingStacks = {
    [stackName]: Promise.resolve(),
  };

  const currentStackEvents = await safeDescribeStackEvents(stackId);
  if (!currentStackEvents || currentStackEvents.length === 0) {
    console.log(`${stackName}: No stack events found`);
    return;
  }
  /** @type {StackEvent[] | undefined} */
  let stackEvents = currentStackEvents;
  let lastExecutionTerminalEvent = stackEvents.find((event) => isTerminalStackEvent(stackName, event));
  if (!lastExecutionTerminalEvent) {
    for (const event of stackEvents) {
      if (
        event.ResourceType === "AWS::CloudFormation::Stack" &&
        event.LogicalResourceId === stackName &&
        ["REVIEW_IN_PROGRESS", "CREATE_IN_PROGRESS"].includes(/** @type {string} */ (event.ResourceStatus))
      ) {
        lastExecutionTerminalEvent = event;
      }
    }
  }
  if (!lastExecutionTerminalEvent || stackEvents.indexOf(lastExecutionTerminalEvent) === 0) {
    console.log(`${stackName}: No currently running stack update`);
    return;
  }

  do {
    // get stack events
    try {
      stackEvents = (await cfn.send(new DescribeStackEventsCommand({ StackName: stackId }))).StackEvents;
    } catch (err) {
      if (/** @type {*} */ (err)?.Code === "Throttling") {
        continue;
      }
      // if (/** @type {*} */ (err)?.Code === "ValidationError") {
      //   if (/** @type {*} */ (err)?.message?.includes("does not exist")) {
      //     return;
      //   }
      // }
      throw err;
    }
    if (!stackEvents || stackEvents.length === 0) {
      console.log(`${stackName}: No stack events found`);
      return;
    }

    // filter out previous executions
    lastTerminalEventIndex = stackEvents.map((x) => x.EventId).indexOf(lastExecutionTerminalEvent?.EventId);
    if (lastTerminalEventIndex !== -1) {
      stackEventsToLog = stackEvents.slice(
        0,
        stackEvents.map((x) => x.EventId).indexOf(lastExecutionTerminalEvent?.EventId),
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
    stackEventsToLog.sort((a, b) => new Date(a?.Timestamp ?? 0).getTime() - new Date(b?.Timestamp ?? 0).getTime());
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
        tailingStacks[event.PhysicalResourceId] = tailStackEvents(event.PhysicalResourceId);
      }
    }

    // sleep for 1 second
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });

    // while we can't find a terminal stack event
    currentExecutionTerminalEvent = stackEventsToLog.find((event) => isTerminalStackEvent(stackName, event));
  } while (!currentExecutionTerminalEvent);
  await Promise.all(Object.values(tailingStacks));

  // check final stack event
  if (!SUCCESSFUL_EVENT_STATUSES.includes(currentExecutionTerminalEvent?.ResourceStatus ?? "")) {
    console.error(`${stackName} ${currentExecutionTerminalEvent.ResourceStatus}`);
    process.exit(1);
  }
}
