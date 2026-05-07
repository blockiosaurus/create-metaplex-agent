# create-metaplex-agent

Scaffold a new [Metaplex Solana AI agent](https://github.com/metaplex-foundation/metaplex-mastra-agent-template).

## Usage

```bash
npx create-metaplex-agent my-agent
# or
npm create metaplex-agent@latest my-agent
```

This clones the [metaplex-mastra-agent-template](https://github.com/metaplex-foundation/metaplex-mastra-agent-template) into `my-agent/`, runs an interactive setup (mode pick, Ed25519 keypair generation, LLM provider, wallet allowlist or bootstrap wallet), and writes a locked-down `.env` (chmod 0600). It does **not** install dependencies — pick your own package manager:

```bash
cd my-agent
pnpm install
pnpm doctor
pnpm dev:full
```

## Flags

- `--force` — scaffold into a non-empty target directory.

## License

Apache-2.0
