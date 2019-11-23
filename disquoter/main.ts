import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import * as sudo from 'sudo-prompt';

async function execDisquoter() {
  const {runDisquoter} = require('./disquoter');
  await runDisquoter();
}

async function main() {
  let runAsAdmin = true;

  let configDir = path.resolve(os.homedir(), '.config/disquoter');

  for(const arg of process.argv.slice(1)) {

    if(arg === '--no-admin') {
      runAsAdmin = false;
    }

    if(arg.startsWith('--config-dir=')) {
      configDir = arg.slice('--config-dir='.length);
    }
  }

  if(runAsAdmin) {
    await fs.ensureDir(configDir);

    const argv0 = process.argv0;
    const args = [
      ...process.argv.slice(1),
      '--no-admin',
    ];
    const fullCmd = `${argv0} ${__filename} ${args.join(' ')}`;

    const execOptions = {
      name: 'Disquoter',
    };

    const {stdout, stderr} = await new Promise((resolve, reject) => {
      const handler = (err, stdout, stderr) => {
        if(err) {
          reject(err);
        } else {
          resolve({stdout, stderr});
        }
      };

      sudo.exec(fullCmd, execOptions, handler);
    });

    process.stdout.write(stdout);
    process.stderr.write(stderr);

    process.exit(0);
  }

  process.env.NODE_CONFIG_DIR = configDir;

  await execDisquoter();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
