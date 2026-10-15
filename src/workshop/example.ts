/** Standalone CLI example; does not read or write companion configuration. */
import { pathToFileURL } from 'node:url';
import { SteamWorkshopProvider, WorkshopError } from './index.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const key = process.env.STEAM_WEB_API_KEY;
  const provider = new SteamWorkshopProvider(key ? { apiKey: key } : {});
  const signal = AbortSignal.timeout(60_000);
  if (command === 'search') console.log(JSON.stringify(await provider.search({ text: args.join(' ') }, signal), null, 2));
  else if (command === 'details') console.log(JSON.stringify(await provider.details(args, signal), null, 2));
  else throw new WorkshopError('invalid_input');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const safe = error instanceof WorkshopError ? error : new WorkshopError('network');
    console.error(JSON.stringify({ code: safe.code, message: safe.message })); process.exitCode = 1;
  });
}
