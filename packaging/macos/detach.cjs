// Starts a command in its own session (setsid), detached from the launcher,
// with output appended to a log file. Prints the child's PID.
//
// usage: node detach.cjs <log-file> <command> [args...]
'use strict';
const { spawn } = require('node:child_process');
const { openSync } = require('node:fs');

const [logFile, command, ...args] = process.argv.slice(2);
if (!logFile || !command) {
  console.error('usage: node detach.cjs <log-file> <command> [args...]');
  process.exit(2);
}
const out = openSync(logFile, 'a');
const child = spawn(command, args, { detached: true, stdio: ['ignore', out, out], env: process.env });
child.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});
child.unref();
process.stdout.write(`${child.pid}\n`);
