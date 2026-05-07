#!/usr/bin/env node
/**
 * create-metaplex-agent — scaffolds a fresh checkout of the Metaplex Agent
 * Template into <targetDir>/, then runs the same interactive setup as the
 * template's `pnpm setup`.
 *
 * Source of truth for the prompt logic is `scripts/setup.ts` in the template
 * repo (metaplex-foundation/metaplex-mastra-agent-template). Anything that
 * also lives in setup.ts should be kept in sync there.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import tiged from 'tiged';

const TEMPLATE = 'metaplex-foundation/metaplex-mastra-agent-template#main';
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));

// Track in-flight state so SIGINT can clean up rather than leaving half-written
// secrets on disk. `rl` is created lazily because tiged spawns subprocesses
// that inherit stdin and would close a top-level readline interface.
let tmpEnvPath = null;
let rl = null;
// When stdin is a pipe / file redirect (CI, scripted tests, `printf | npx ...`),
// we slurp it upfront and serve lines from a queue. Going through readline in
// that case is unreliable: once the input stream emits 'end', readline closes
// and pending question() promises hang indefinitely instead of rejecting.
let pipedLines = null;

process.on('SIGINT', () => {
  if (tmpEnvPath) {
    try { unlinkSync(tmpEnvPath); } catch {}
  }
  console.error('\nAborted.');
  if (rl) { try { rl.close(); } catch {} }
  process.exit(1);
});

async function ensureInputReady() {
  if (input.isTTY) return;
  if (pipedLines !== null) return;
  pipedLines = await new Promise((resolve, reject) => {
    const chunks = [];
    input.on('data', (c) => chunks.push(c));
    input.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const lines = text.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      resolve(lines);
    });
    input.on('error', reject);
  });
}

function nextPipedLine() {
  if (pipedLines === null || pipedLines.length === 0) return '';
  return pipedLines.shift();
}

function getRl() {
  if (rl === null) rl = createInterface({ input, output });
  return rl;
}

async function readLine(prompt) {
  if (input.isTTY) {
    return await getRl().question(prompt);
  }
  // Non-TTY: print prompt for log visibility, then dequeue from buffer.
  output.write(prompt);
  const line = nextPipedLine();
  output.write(`${line}\n`);
  return line;
}

async function ask(q, fallback = '') {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await readLine(`${q}${suffix}: `)).trim();
  return answer || fallback;
}

async function askYesNo(q, defaultYes = true) {
  const fallback = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await readLine(`${q} [${fallback}]: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function generateKeypairBase58() {
  const kp = nacl.sign.keyPair();
  return bs58.encode(kp.secretKey);
}

/**
 * Recover the canonical Ed25519 public key from a base58-encoded 64-byte
 * secret key (Solana / NaCl / libsodium expanded format: seed (32) || pubkey (32)).
 *
 * We don't trust the trailing 32 bytes blindly — we re-derive from the seed
 * and fail fast on mismatch so a tampered or wrong-format blob never
 * silently emits a wrong wallet address.
 */
function pubkeyFromKeypair(secretKeyBase58) {
  const decoded = bs58.decode(secretKeyBase58);
  if (decoded.length !== 64) {
    throw new Error(`expected 64-byte secret key, got ${decoded.length} bytes`);
  }
  const derived = nacl.sign.keyPair.fromSecretKey(decoded);
  const trailing = decoded.slice(32, 64);
  for (let i = 0; i < 32; i++) {
    if (derived.publicKey[i] !== trailing[i]) {
      throw new Error(
        'AGENT_KEYPAIR is not in canonical Ed25519 layout — the trailing 32 bytes ' +
          'do not match the public key derived from the leading 32-byte seed. ' +
          'Re-export from your wallet or regenerate.',
      );
    }
  }
  return bs58.encode(derived.publicKey);
}

function isValidPubkey(s) {
  if (!BASE58_ADDRESS_RE.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

function isEmptyDir(p) {
  if (!existsSync(p)) return true;
  try {
    return readdirSync(p).length === 0;
  } catch {
    return true;
  }
}

async function main() {
  // 0. Resolve target dir
  let dirName = positional[0];
  if (!dirName) {
    dirName = await ask('Project directory name', 'my-metaplex-agent');
  }
  if (!dirName) {
    throw new Error('No project directory name provided.');
  }
  const targetDir = resolve(process.cwd(), dirName);

  if (existsSync(targetDir) && !isEmptyDir(targetDir) && !FORCE) {
    throw new Error(
      `Target directory "${targetDir}" exists and is not empty. ` +
        `Re-run with --force to scaffold into it anyway.`,
    );
  }

  // 1. Clone the template
  console.log(`\nCloning ${TEMPLATE} → ${targetDir}`);
  const emitter = tiged(TEMPLATE, {
    force: true,
    cache: false,
    verbose: false,
    disableCache: true,
  });
  await emitter.clone(targetDir);

  // Slurp piped stdin (if any) NOW — tiged's child processes can disturb the
  // stdin stream, so we wait until they're done before reading.
  await ensureInputReady();

  console.log('\nMetaplex Agent Template — interactive setup');

  // 2. Mode
  console.log('\n1. Agent mode\n');
  console.log('  public     — end users sign their own transactions (chatbot, mint helper, etc.)');
  console.log('  autonomous — agent signs everything itself (treasury bot, scheduled job, etc.)\n');
  let mode = null;
  while (mode === null) {
    const raw = (await ask('AGENT_MODE', 'public')).toLowerCase();
    if (raw === 'public' || raw === 'autonomous') {
      mode = raw;
    } else {
      console.log(`  "${raw}" is not a valid mode. Pick "public" or "autonomous".`);
    }
  }

  // 3. Keypair
  console.log('\n2. Agent keypair\n');
  console.log("  This is the agent's on-chain identity. The setup script will generate a fresh");
  console.log("  Ed25519 keypair so you don't need solana-keygen installed. Treat the generated");
  console.log('  secret key like a password — anyone with it can sign as the agent.\n');
  const generate = await askYesNo('Generate a new keypair?', true);
  let agentKeypair;
  let agentPubkey;
  if (generate) {
    agentKeypair = generateKeypairBase58();
    agentPubkey = pubkeyFromKeypair(agentKeypair);
    console.log(`  → generated; pubkey: ${agentPubkey}`);
  } else {
    while (true) {
      agentKeypair = (await ask('Paste base58 64-byte secret key')).trim();
      let decoded;
      try {
        decoded = bs58.decode(agentKeypair);
      } catch {
        console.log('  Not valid base58. Try again.');
        continue;
      }
      if (decoded.length !== 64) {
        console.log(`  Expected 64 bytes, got ${decoded.length}. Try again.`);
        continue;
      }
      try {
        agentPubkey = pubkeyFromKeypair(agentKeypair);
        break;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.log(`  ${detail}`);
      }
    }
  }

  // 4. LLM provider + key
  console.log('\n3. LLM provider\n');
  console.log('  1) Anthropic (default)');
  console.log('  2) OpenAI');
  console.log('  3) Google\n');
  const PROVIDERS = {
    '1': { key: 'ANTHROPIC_API_KEY', model: 'anthropic/claude-sonnet-4-5-20250929' },
    '2': { key: 'OPENAI_API_KEY', model: 'openai/gpt-4o' },
    '3': { key: 'GOOGLE_GENERATIVE_AI_API_KEY', model: 'google/gemini-2.5-pro' },
  };
  let provider = null;
  while (provider === null) {
    const raw = (await ask('Pick provider [1-3]', '1')).trim();
    if (raw in PROVIDERS) {
      provider = PROVIDERS[raw];
    } else {
      console.log(`  "${raw}" is not a valid choice. Enter 1, 2, or 3.`);
    }
  }
  const providerKey = provider.key;
  const llmModel = provider.model;
  const llmKey = (await ask(`Paste ${providerKey} (leave blank to fill later)`)).trim();

  // 5. Wallet allowlist (public mode) or bootstrap wallet (autonomous mode)
  let walletAllowlist = '';
  let bootstrapWallet = '';
  if (mode === 'public') {
    console.log('\n4. Wallet allowlist (optional)\n');
    console.log('  In public mode the agent accepts SIWS-signed connections from any wallet by');
    console.log('  default. To restrict it to a specific list (e.g. just your own wallet for the');
    console.log('  initial test), paste your wallet pubkey below. The on-chain owner is always');
    console.log('  allowed regardless of this list.\n');
    while (true) {
      const pk = (await ask('Your wallet pubkey (or blank to skip)')).trim();
      if (pk === '') break;
      if (!isValidPubkey(pk)) {
        console.log('  Not a valid base58 32-byte pubkey. Try again or leave blank.');
        continue;
      }
      walletAllowlist = pk;
      break;
    }
  } else {
    console.log('\n4. Bootstrap wallet (autonomous mode)\n');
    console.log('  Autonomous mode requires a BOOTSTRAP_WALLET pubkey before the agent is');
    console.log('  registered on-chain. After registration, the on-chain asset owner takes over.\n');
    while (true) {
      const pk = (await ask('BOOTSTRAP_WALLET pubkey (your wallet)')).trim();
      if (!isValidPubkey(pk)) {
        console.log('  Not a valid base58 32-byte pubkey. Try again.');
        continue;
      }
      bootstrapWallet = pk;
      break;
    }
  }

  if (rl) rl.close();

  // 6. Render .env
  const envPath = resolve(targetDir, '.env');
  const examplePath = resolve(targetDir, '.env.example');
  let envContent = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';

  // replaceOrAppend: if the canonical key exists in .env.example, swap the
  // line in place; otherwise append at the bottom so a customised
  // .env.example doesn't silently drop a key we care about.
  const appended = [];
  function replaceOrAppend(re, line) {
    if (re.test(envContent)) {
      envContent = envContent.replace(re, line);
    } else {
      appended.push(line);
    }
  }

  replaceOrAppend(/^AGENT_MODE=.*$/m, `AGENT_MODE=${mode}`);
  replaceOrAppend(/^AGENT_KEYPAIR=.*$/m, `AGENT_KEYPAIR=${agentKeypair}`);
  replaceOrAppend(
    /^# ?ANTHROPIC_API_KEY=.*$/m,
    `${providerKey === 'ANTHROPIC_API_KEY' ? '' : '# '}ANTHROPIC_API_KEY=${providerKey === 'ANTHROPIC_API_KEY' ? llmKey : ''}`,
  );
  replaceOrAppend(
    /^# ?OPENAI_API_KEY=.*$/m,
    `${providerKey === 'OPENAI_API_KEY' ? '' : '# '}OPENAI_API_KEY=${providerKey === 'OPENAI_API_KEY' ? llmKey : ''}`,
  );
  replaceOrAppend(
    /^# ?GOOGLE_GENERATIVE_AI_API_KEY=.*$/m,
    `${providerKey === 'GOOGLE_GENERATIVE_AI_API_KEY' ? '' : '# '}GOOGLE_GENERATIVE_AI_API_KEY=${providerKey === 'GOOGLE_GENERATIVE_AI_API_KEY' ? llmKey : ''}`,
  );
  replaceOrAppend(/^WALLET_ALLOWLIST=.*$/m, `WALLET_ALLOWLIST=${walletAllowlist}`);
  replaceOrAppend(
    /^# ?BOOTSTRAP_WALLET=.*$/m,
    bootstrapWallet ? `BOOTSTRAP_WALLET=${bootstrapWallet}` : '# BOOTSTRAP_WALLET=',
  );

  // LLM_MODEL is optional in the slim example (defaults to Anthropic Claude).
  // Only write a line when the operator picked a non-default provider.
  if (llmModel !== 'anthropic/claude-sonnet-4-5-20250929') {
    if (/^LLM_MODEL=/m.test(envContent)) {
      envContent = envContent.replace(/^LLM_MODEL=.*$/m, `LLM_MODEL=${llmModel}`);
    } else {
      appended.push(`LLM_MODEL=${llmModel}`);
    }
  }

  if (appended.length > 0) {
    if (!envContent.endsWith('\n')) envContent += '\n';
    envContent += '\n# --- appended by `create-metaplex-agent` (key not found in .env.example) ---\n';
    envContent += appended.join('\n') + '\n';
  }

  // Atomic write: temp file in the same directory, then rename. If we get
  // SIGINT'd between the write and the rename we leave at most a tmp file
  // (which the SIGINT handler unlinks) — never a half-written .env.
  const tmpPath = `${envPath}.tmp`;
  tmpEnvPath = tmpPath;
  writeFileSync(tmpPath, envContent, { mode: 0o600 });
  // writeFileSync's `mode` only applies on creation, not overwrite, so force
  // 0600 explicitly. Same on the final path after rename.
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, envPath);
  chmodSync(envPath, 0o600);
  tmpEnvPath = null;
  console.log(`\n  wrote ${envPath} (chmod 0600)`);
  if (appended.length > 0) {
    console.log(
      `  (${appended.length} key${appended.length === 1 ? '' : 's'} appended because .env.example was missing the placeholder line)`,
    );
  }

  // 7. wallets.allowlist.json
  if (mode === 'public' && walletAllowlist) {
    const allowlistPath = resolve(targetDir, 'wallets.allowlist.json');
    let seedAllowlist = !existsSync(allowlistPath);
    if (!seedAllowlist) {
      // We've already closed the main readline interface above. Open a fresh
      // one for this final confirmation in TTY mode; in piped mode, fall back
      // to the queue.
      let answer;
      if (input.isTTY) {
        const confirmRl = createInterface({ input, output });
        answer = (
          await confirmRl.question(
            `  ${allowlistPath} already exists — overwrite with [{ "wallets": ["${walletAllowlist}"] }]? [y/N]: `,
          )
        )
          .trim()
          .toLowerCase();
        confirmRl.close();
      } else {
        output.write(
          `  ${allowlistPath} already exists — overwrite with [{ "wallets": ["${walletAllowlist}"] }]? [y/N]: `,
        );
        answer = nextPipedLine().trim().toLowerCase();
        output.write(`${answer}\n`);
      }
      seedAllowlist = answer === 'y' || answer === 'yes';
    }
    if (seedAllowlist) {
      writeFileSync(
        allowlistPath,
        JSON.stringify({ wallets: [walletAllowlist] }, null, 2) + '\n',
      );
      console.log(`  wrote ${allowlistPath}`);
    } else {
      console.log(`  kept existing ${allowlistPath} unchanged`);
    }
  }

  // Build a chat-template share link that pre-fills the agent profile, so
  // operators (and anyone they hand the link to) can skip the chat UI's
  // profile-setup step. Format mirrors `encodeProfileToHash` in
  // metaplex-agent-chat-template/src/lib/share-link.ts — keep them in sync.
  // Defaults assume the standard `pnpm dev:full` ports (UI 3001, WS 3002)
  // and the .env.example default of devnet RPC.
  const shareParams = new URLSearchParams();
  shareParams.set('ws', 'ws://localhost:3002');
  shareParams.set('preset', 'devnet');
  shareParams.set('name', dirName);
  const shareLink = `http://localhost:3001/#${shareParams.toString()}`;

  console.log('\nDone! Next steps:\n');
  console.log(`  cd ${dirName}`);
  console.log('  pnpm install');
  console.log('  pnpm doctor');
  console.log('  pnpm dev:full');
  console.log(
    `\n  Then connect a wallet at http://localhost:3001 (${mode === 'public' ? 'must be on the allowlist' : 'must be the bootstrap wallet pre-registration'}).`,
  );
  console.log('\n  Share this link to skip profile setup in the chat UI:');
  console.log(`    ${shareLink}`);
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (rl) { try { rl.close(); } catch {} }
    if (tmpEnvPath) {
      try { unlinkSync(tmpEnvPath); } catch {}
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[create-metaplex-agent] error: ${detail}`);
    process.exit(1);
  });
