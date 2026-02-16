// Simple test to verify tee streaming works
const { spawn } = require('child_process');

console.log("Testing tee streaming...");

const child = spawn('bash', ['-c', 'for i in 1 2 3 4 5; do echo "Line $i"; sleep 1; done']);

child.stdout.on('data', (data) => {
    process.stdout.write(`STDOUT: ${data}`);
});

child.stderr.on('data', (data) => {
    process.stderr.write(`STDERR: ${data}`);
});

child.on('close', (code) => {
    console.log(`Process exited with code ${code}`);
});

child.on('error', (err) => {
    console.error(`Spawn error: ${err.message}`);
});

