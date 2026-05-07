# Build `create-metaplex-agent` (npm scaffolder)

  You're building a standalone npm package that gets invoked via:

  ```
  npx create-metaplex-agent my-agent                                                                       
  # or
  npm create metaplex-agent@latest my-agent                                                                
  ```

  It scaffolds a fresh checkout of the Metaplex Agent Template into `<my-agent>/`, runs an interactive
  configuration prompt against that new directory, and prints next steps. Pattern to follow: `create-vite`,
   `create-next-app`, `create-t3-app` — tiny package, single binary, no build step.

## Source of truth for the scaffolder logic
  
  The template repo is `metaplex-foundation/metaplex-mastra-agent-template`. The v0 of this scaffolder
  already exists there as `scripts/setup.ts` — it runs **in-place against an existing checkout**. Your job
  is to wrap that same flow with a "clone the template first, then run it in the new dir" front-end.

  **Read `scripts/setup.ts` in the template repo before writing anything.** Almost all the prompt logic
  ports verbatim:

- mode pick (`public` | `autonomous`)
- generate Ed25519 keypair via `tweetnacl` + `bs58` (do NOT shell out to `solana-keygen`)
- canonical-pubkey verification (don't trust trailing 32 bytes blindly)
- LLM provider pick (1=Anthropic, 2=OpenAI, 3=Google) → maps to env-var name + model id
- if public mode: optional wallet pubkey → seeds `WALLET_ALLOWLIST` and `wallets.allowlist.json`
- if autonomous mode: required `BOOTSTRAP_WALLET` pubkey
- writes `.env` with `chmod 0600` (the explicit `chmodSync` after `writeFileSync` is intentional — `mode`
   only applies on creation, not overwrite)
- `replaceOrAppend` pattern against `.env.example` so that template drift doesn't silently drop keys

## What's new vs. the in-place version

  1. **Target dir resolution.** Accept the dir name as the first positional arg (`process.argv[2]`). If
  absent, prompt for it. Refuse to scaffold into an existing non-empty dir unless `--force`.
  2. **Clone the template.** Use `tiged` (maintained `degit` fork) to copy the template at a pinned ref:

     ```
     tiged metaplex-foundation/metaplex-mastra-agent-template#main <targetDir>
     ```

     Pin to a tag (e.g. `#v0.1.0`) once the template starts cutting releases — for now `#main` is fine.
  3. **Then run the existing setup flow** with `cwd = targetDir` instead of the script's own location.
  4. **Final "next steps" output** should mention `cd <dir> && pnpm install && pnpm doctor && pnpm
  dev:full`.

## Package shape

  ```
  create-metaplex-agent/
  ├── package.json
  ├── index.js          # the binary; pure ESM, no build step
  ├── README.md         # short — what it does + one usage example                                         
  └── LICENSE           # Apache-2.0 to match the template                                                 
  ```

  `package.json`:

  ```json
  {                                                                                                        
    "name": "create-metaplex-agent",                     
    "version": "0.1.0",
    "description": "Scaffold a new Metaplex Solana AI agent.",
    "type": "module",                                                                                      
    "bin": { "create-metaplex-agent": "./index.js" },
    "files": ["index.js", "README.md", "LICENSE"],                                                         
    "engines": { "node": ">=20" },                       
    "dependencies": {                                                                                      
      "tiged": "^3.0.0",                                 
      "tweetnacl": "^1.0.3",                                                                               
      "bs58": "^6.0.0"                                                                                     
    },
    "repository": "github:metaplex-foundation/create-metaplex-agent",                                      
    "license": "Apache-2.0"                                                                                
  }
  ```

  Keep `dependencies` to those three. No `inquirer`, no `chalk`, no `commander` — Node's built-in
  `readline/promises` and plain `console.log` are enough and keep the install fast (this matters because
  every `npx` invocation re-fetches if uncached).

## Behavior requirements

- `index.js` must start with `#!/usr/bin/env node` and be `chmod +x` in the published tarball (npm
  preserves mode 0755 on `bin` entries automatically when `bin` is set, but verify with `npm pack` + `tar
  -tvf`).
- Exit code 0 on success, 1 on any error. Print errors to stderr.
- If the user Ctrl-C's mid-prompt, exit cleanly (don't leave a half-written `.env` behind — write to a
  temp file then `rename`).
- Refuse to overwrite an existing target dir unless empty or `--force` passed.
- Don't run `pnpm install` for the user — let them do it. (Reason: their package manager preference,
  network, lockfile choices.)

## Test before publishing

  ```bash
  # in this repo                                         
  npm pack
  # in a sibling dir
  npx /absolute/path/to/create-metaplex-agent-0.1.0.tgz test-agent                                         
  cd test-agent && pnpm install && pnpm doctor                                                             
  ```

  Run that full loop and confirm `pnpm doctor` passes against the scaffolded dir before declaring done.

## Out of scope

- Publishing to npm (the maintainer will run `npm publish --access public`).
- TypeScript / a build step. Plain `.js` only.
- Hand-rolling a wallet picker, chain RPC checks, or anything beyond what `scripts/setup.ts` already does
   in-place.

## Definition of done

  1. `npm pack` produces a tarball.
  2. `npx <tarball> test-agent` clones the template, runs the same prompts as the template's `pnpm setup`,
  writes a valid `.env` (mode 0600) and `wallets.allowlist.json` if applicable into `test-agent/`.
  3. `cd test-agent && pnpm install && pnpm doctor` exits 0.
  4. README in this repo has one usage example and a link back to the template repo.
