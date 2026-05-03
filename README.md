# EVM Rescue Tool — Maximum Speed Edition v4.0

A local rescue tool that monitors a compromised EVM wallet 
and automatically sweeps assets the moment they arrive — 
faster than drainer bots using high gas priority.

WebSocket real-time detection · Parallel RPCs · Pre-signed 
transactions · Auto-retry · EIP-1559 support

Keys never leave your machine. No server. No backend.

---

## Requirements

- Windows, Mac or Linux computer
- Node.js 18+ — https://nodejs.org
- Git — https://git-scm.com
- A compromised wallet private key
- A clean sponsor wallet with small native token for gas
- A safe destination wallet address

---

## Installation

## Installation

Option 1 — With Git:
Hold windws button and R and click enter
git clone https://github.com/YOURUSERNAME/evm-rescue-tool.git
cd evm-rescue-tool
npm install

Option 2 — Without Git:
1. Click the green Code button on this page
2. Click Download ZIP
3. Extract the ZIP folder
4. Open terminal inside the folder
5. Run: npm install
---

## Configuration

cp .env.example .env

Open .env and fill in:

COMPROMISED_PRIVATE_KEY=0xYourCompromisedWalletPrivateKey
SPONSOR_PRIVATE_KEY=0xYourSponsorWalletPrivateKey
SAFE_WALLET_ADDRESS=0xYourSafeWalletAddress
RPC_URL=https://api.infra.mainnet.somnia.network
RPC_BACKUP_1=https://dream-rpc.somnia.network
RPC_BACKUP_2=https://vsomnia-rpc.somnia.network
TOKEN_CONTRACT_ADDRESS=
POLL_INTERVAL_MS=500
GAS_MULTIPLIER=7
MAX_GAS_MULTIPLIER=15
MIN_BALANCE_SOMI=1
SWEEP_DELAY_MS=500
MAX_RETRIES=5
MAX_BLOCKS=20

---

## Supported chains

Change RPC_URL and backup RPCs for your chain:

Somnia:   https://api.infra.mainnet.somnia.network
Ethereum: https://eth.llamarpc.com
Base:     https://mainnet.base.org
Arbitrum: https://arb1.arbitrum.io/rpc
Polygon:  https://polygon-rpc.com
Optimism: https://mainnet.optimism.io
BNB:      https://bsc-dataseed.binance.org

---

## Run

node rescue.js

The script will:
1. Check wallet gas status
2. Pre-sign gas funding transaction
3. Enter standby — watching 24/7
4. Fire automatically the instant balance detected
5. Sweep assets to your safe wallet

---

## How to export private key from MetaMask

1. Open MetaMask
2. Click three dots next to account
3. Account Details
4. Export Private Key
5. Enter password
6. Copy key starting with 0x

---

## Security rules

- Never share your .env file
- Never enter your seed phrase anywhere
- Delete .env after rescue completes
- Retire compromised wallet after rescue
- Verify source code before running
-NEVER SHARE .ENV FILE

---

## Sponsor wallet gas requirements

Somnia:   0.05 SOMI
Ethereum: 0.01 ETH
Base:     0.01 ETH
Polygon:  0.5 MATIC
BNB:      0.01 BNB

---

## Common errors

Balance 0 on startup    — airdrop not landed yet, wait
Sponsor balance 0       — wrong private key or wrong RPC
All RPCs failed         — check RPC_BACKUP_1 and RPC_BACKUP_2
WebSocket 502           — auto switches to polling, normal
Gas funding failed      — top up sponsor wallet
