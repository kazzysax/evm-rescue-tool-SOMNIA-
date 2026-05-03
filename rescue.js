import { ethers } from "ethers";
import { FlashbotsBundleProvider, FlashbotsBundleResolution } from "@flashbots/ethers-provider-bundle";
import dotenv from "dotenv";
import chalk from "chalk";
import ora from "ora";

dotenv.config();

// ─── Constants ────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const FLASHBOTS_RELAY = {
  1: "https://relay.flashbots.net",
  5: "https://relay-goerli.flashbots.net",
};

const RPC_POOL = [
  process.env.RPC_URL,
  "https://dream-rpc.somnia.network",
  "https://vsomnia-rpc.somnia.network",
].filter(Boolean);

const GAS_REFRESH_INTERVAL_MS   = 5  * 60 * 1000;
const NONCE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

// ─── Validate env ─────────────────────────────────────────────────────────────
function validateEnv() {
  const required = ["COMPROMISED_PRIVATE_KEY", "SPONSOR_PRIVATE_KEY", "SAFE_WALLET_ADDRESS", "RPC_URL"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(chalk.red(`\n✗ Missing required .env values: ${missing.join(", ")}`));
    process.exit(1);
  }
}

function banner() {
  console.log(chalk.cyan("\n╔══════════════════════════════════════════════════════════════════╗"));
  console.log(chalk.cyan("║    EVM RESCUE TOOL — Maximum Speed Edition v4.0                 ║"));
  console.log(chalk.cyan("║    WebSocket · Parallel Detection · Multi-RPC · Pre-Sign        ║"));
  console.log(chalk.cyan("║    Auto-Retry · Gas Refresh · Nonce Refresh · EIP-1559          ║"));
  console.log(chalk.cyan("║    Sound Alert · Pre-Fund Detection · Escalating Gas            ║"));
  console.log(chalk.cyan("║    Local-only — keys never leave your machine                   ║"));
  console.log(chalk.cyan("╚══════════════════════════════════════════════════════════════════╝\n"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Sound alert ──────────────────────────────────────────────────────────────
function playAlert() {
  process.stdout.write("\x07\x07\x07");
}

// ─── Raw JSON-RPC ─────────────────────────────────────────────────────────────
async function rawRpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ─── Multi-RPC broadcast ──────────────────────────────────────────────────────
async function broadcastToAll(signedTx) {
  const promises = RPC_POOL.map((rpc) =>
    rawRpc(rpc, "eth_sendRawTransaction", [signedTx]).catch(() => null)
  );
  const results = await Promise.allSettled(promises);
  const success = results.find((r) => r.status === "fulfilled" && r.value);
  if (success) return success.value;
  throw new Error("All RPC endpoints failed to broadcast");
}

// ─── Parallel balance check ───────────────────────────────────────────────────
async function parallelBalanceCheck({ address, tokenAddress, minBalance, provider }) {
  const minBal = ethers.utils.parseEther(minBalance || "1");
  const checks = RPC_POOL.map(async (rpc) => {
    try {
      let balance;
      if (tokenAddress) {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        balance = await token.balanceOf(address);
      } else {
        const hex = await rawRpc(rpc, "eth_getBalance", [address, "latest"]);
        balance = ethers.BigNumber.from(hex);
      }
      return balance.gte(minBal) ? balance : null;
    } catch (_) { return null; }
  });
  const results = await Promise.all(checks);
  return results.find((b) => b !== null) || null;
}

// ─── EIP-1559 optimal gas ─────────────────────────────────────────────────────
async function getOptimalGas(provider, multiplier) {
  try {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas) {
      return {
        maxFeePerGas: feeData.maxFeePerGas.mul(multiplier),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(multiplier),
        type: 2,
        isEIP1559: true,
      };
    }
  } catch (_) {}
  const base = await provider.getGasPrice();
  return { gasPrice: base.mul(multiplier), type: 0, isEIP1559: false };
}

// ─── Background gas refresher ─────────────────────────────────────────────────
async function startGasRefresher({ provider, gasMultiplier, state }) {
  const refresh = async () => {
    try {
      const gas = await getOptimalGas(provider, gasMultiplier);
      state.gasFees = gas;
      state.gasPrice = gas.gasPrice || gas.maxFeePerGas;
      state.gasForCompromised = state.gasPrice.mul(state.GAS_SWEEP + 10000);
      process.stdout.write(
        chalk.gray(`\r  ⛽ Gas refreshed: ${ethers.utils.formatUnits(state.gasPrice, "gwei")} gwei (${gasMultiplier}x) ${gas.isEIP1559 ? "EIP-1559" : "legacy"}                    \n`)
      );
    } catch (_) {}
  };
  const interval = setInterval(refresh, GAS_REFRESH_INTERVAL_MS);
  return () => clearInterval(interval);
}

// ─── Background nonce refresher ───────────────────────────────────────────────
async function startNonceRefresher({ sponsorWallet, compromisedAddress, state, chainId }) {
  const refresh = async () => {
    try {
      const nonce = await sponsorWallet.getTransactionCount("latest");
      const tx = {
        to: compromisedAddress,
        value: state.gasForCompromised,
        gasLimit: 21000,
        nonce,
        chainId,
        ...( state.gasFees.isEIP1559
          ? { maxFeePerGas: state.gasFees.maxFeePerGas, maxPriorityFeePerGas: state.gasFees.maxPriorityFeePerGas, type: 2 }
          : { gasPrice: state.gasPrice, type: 0 }
        ),
      };
      state.preSignedFundTx = await sponsorWallet.signTransaction(tx);
      process.stdout.write(
        chalk.gray(`\r  🔑 Pre-signed tx refreshed — nonce: ${nonce}                         \n`)
      );
    } catch (_) {}
  };
  const interval = setInterval(refresh, NONCE_REFRESH_INTERVAL_MS);
  return () => clearInterval(interval);
}

// ─── Polling fallback ─────────────────────────────────────────────────────────
async function pollFallback({ address, tokenAddress, pollMs, provider, minBalance, resolve }) {
  let attempt = 0;
  const startTime = Date.now();
  while (true) {
    attempt++;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    try {
      const balance = await parallelBalanceCheck({ address, tokenAddress, minBalance, provider });
      if (balance) { resolve(balance); return; }
      process.stdout.write(
        chalk.gray(`\r  ⏳ Standby ${mins}m ${secs}s — attempt ${attempt} — balance: 0 — next check in ${pollMs/1000}s   `)
      );
    } catch (_) {}
    await sleep(pollMs);
  }
}

// ─── WebSocket watcher with polling fallback ──────────────────────────────────
async function watchForBalance({ address, tokenAddress, pollMs, provider, minBalance }) {
  return new Promise((resolve) => {
    const wsUrl = process.env.RPC_URL
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    let wsProvider;
    try {
      wsProvider = new ethers.providers.WebSocketProvider(wsUrl);
      console.log(chalk.green("  ⚡ WebSocket connected — real-time block detection active"));
    } catch (_) {
      console.log(chalk.yellow("  WebSocket unavailable — falling back to polling"));
      return pollFallback({ address, tokenAddress, pollMs, provider, minBalance, resolve });
    }

    let attempt = 0;
    const startTime = Date.now();

    wsProvider.on("block", async (blockNumber) => {
      attempt++;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      try {
        const balance = await parallelBalanceCheck({ address, tokenAddress, minBalance, provider });
        if (balance) {
          wsProvider.removeAllListeners();
          wsProvider.destroy();
          resolve(balance);
          return;
        }
        process.stdout.write(
          chalk.gray(`\r  ⚡ Block ${blockNumber} — ${mins}m ${secs}s — attempt ${attempt} — balance: 0   `)
        );
      } catch (_) {}
    });

    wsProvider.on("error", () => {
      try { wsProvider.removeAllListeners(); } catch (_) {}
      console.log(chalk.yellow("\n  WebSocket error — switching to polling fallback"));
      pollFallback({ address, tokenAddress, pollMs, provider, minBalance, resolve });
    });

    wsProvider._websocket?.on("close", () => {
      try { wsProvider.removeAllListeners(); } catch (_) {}
      console.log(chalk.yellow("\n  WebSocket closed — switching to polling fallback"));
      pollFallback({ address, tokenAddress, pollMs, provider, minBalance, resolve });
    });

    wsProvider._websocket?.on("error", () => {
      try { wsProvider.removeAllListeners(); } catch (_) {}
      console.log(chalk.yellow("\n  WebSocket connection error — switching to polling fallback"));
      pollFallback({ address, tokenAddress, pollMs, provider, minBalance, resolve });
    });

    // Catch unhandled WebSocket errors like 502
    process.on("uncaughtException", (err) => {
      if (err.message.includes("502") || err.message.includes("WebSocket") || err.message.includes("Unexpected server response")) {
        console.log(chalk.yellow("\n  WebSocket 502/error — switching to polling fallback"));
        try { wsProvider.removeAllListeners(); wsProvider.destroy(); } catch (_) {}
        pollFallback({ address, tokenAddress, pollMs, provider, minBalance, resolve });
      }
    });
  });
}

// ─── Auto-retry sweep with escalating gas ─────────────────────────────────────
async function sweepWithRetry({
  compromisedWallet, sweepTx,
  baseGasMultiplier, maxGasMultiplier,
  maxRetries, provider,
}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const escalated  = Math.min(baseGasMultiplier + (attempt - 1) * 2, maxGasMultiplier);
    const gas        = await getOptimalGas(provider, escalated);
    const gasPrice   = gas.gasPrice || gas.maxFeePerGas;
    const label      = ["1st","2nd","3rd","4th","5th"][attempt-1] || `${attempt}th`;

    const sweepSpinner = ora(
      `Sweep attempt ${label}/${maxRetries} — ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei (${escalated}x) — ${RPC_POOL.length} RPCs`
    ).start();

    try {
      const nonce = await compromisedWallet.getTransactionCount("latest");
      const signedSweep = await compromisedWallet.signTransaction({
        ...sweepTx,
        ...(gas.isEIP1559
          ? { maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas, type: 2 }
          : { gasPrice, type: 0 }
        ),
        nonce,
      });

      const txHash = await broadcastToAll(signedSweep);
      sweepSpinner.text = `Confirming: ${txHash}`;

      let confirmed = false;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        try {
          const receipt = await rawRpc(process.env.RPC_URL, "eth_getTransactionReceipt", [txHash]);
          if (receipt && receipt.status === "0x1") { confirmed = true; break; }
        } catch (_) {}
      }

      if (confirmed) {
        sweepSpinner.succeed(chalk.green(`✓ Sweep confirmed on attempt ${label} — ${txHash}`));
        return true;
      } else {
        sweepSpinner.warn(`Attempt ${label} unconfirmed — escalating gas`);
      }
    } catch (err) {
      sweepSpinner.fail(`Attempt ${label} failed: ${err.message.slice(0, 80)}`);
      if (attempt < maxRetries) { await sleep(1500); }
    }
  }
  return false;
}

// ─── High-gas rescue ──────────────────────────────────────────────────────────
async function rescueViaHighGas({
  rpcUrl, sponsorWallet, compromisedWallet,
  gasPrice, gasFees, sweepTx, state,
  baseGasMultiplier, maxGasMultiplier,
  maxRetries, sweepDelayMs, provider,
  skipGasFunding,
}) {
  console.log(chalk.yellow("\nMode: Parallel Multi-RPC High-Gas Hybrid Rescue v4.0"));
  console.log(chalk.gray(`Gas: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei — ${RPC_POOL.length} RPCs — ${maxRetries} retries\n`));

  if (!skipGasFunding) {
    const fundSpinner = ora(`Broadcasting pre-signed gas tx to ${RPC_POOL.length} RPCs...`).start();
    try {
      const fundHash = await broadcastToAll(state.preSignedFundTx);
      fundSpinner.text = `Waiting for confirmation: ${fundHash}`;

      let confirmed = false;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        try {
          const receipt = await rawRpc(rpcUrl, "eth_getTransactionReceipt", [fundHash]);
          if (receipt && receipt.status === "0x1") { confirmed = true; break; }
        } catch (_) {}
      }

      confirmed
        ? fundSpinner.succeed(`Gas funded — ${fundHash}`)
        : fundSpinner.warn("Gas tx unconfirmed — attempting sweep anyway");

    } catch (err) {
      fundSpinner.warn(`Pre-signed tx failed — using live fallback`);
      try {
        const fundTx = await sponsorWallet.sendTransaction({
          to: compromisedWallet.address,
          value: state.gasForCompromised,
          ...(gasFees.isEIP1559
            ? { maxFeePerGas: gasFees.maxFeePerGas, maxPriorityFeePerGas: gasFees.maxPriorityFeePerGas, type: 2 }
            : { gasPrice, type: 0 }
          ),
          gasLimit: 21000,
        });
        await fundTx.wait(1);
        fundSpinner.succeed(`Gas funded (fallback) — ${fundTx.hash}`);
      } catch (err2) {
        console.error(chalk.red(`\n✗ Gas funding failed: ${err2.message}`));
        process.exit(1);
      }
    }
    await sleep(sweepDelayMs);
  } else {
    console.log(chalk.green("✓ Compromised wallet pre-funded — skipping gas funding step\n"));
  }

  return await sweepWithRetry({
    compromisedWallet, sweepTx,
    baseGasMultiplier, maxGasMultiplier,
    maxRetries, provider,
  });
}

// ─── Flashbots rescue ─────────────────────────────────────────────────────────
async function rescueViaFlashbots({
  provider, sponsorWallet, compromisedWallet,
  gasPrice, network, sweepTx, gasForCompromised,
  maxBlocks, currentBlock,
}) {
  const spinner = ora("Connecting to Flashbots relay...").start();
  let flashbotsProvider;
  try {
    flashbotsProvider = await FlashbotsBundleProvider.create(
      provider, sponsorWallet,
      FLASHBOTS_RELAY[network.chainId],
      network.chainId === 1 ? "mainnet" : "goerli"
    );
    spinner.succeed("Flashbots relay connected — fully private");
  } catch (err) {
    spinner.warn("Flashbots unavailable — switching to high-gas mode");
    return rescueViaHighGas({ sponsorWallet, compromisedWallet, gasPrice, sweepTx });
  }

  const bundle = [
    { signer: sponsorWallet, transaction: { to: compromisedWallet.address, value: gasForCompromised, gasPrice, gasLimit: 21000, chainId: network.chainId } },
    { signer: compromisedWallet, transaction: { ...sweepTx, gasPrice, chainId: network.chainId } },
  ];

  const simSpinner = ora("Simulating bundle...").start();
  try {
    const sim = await flashbotsProvider.simulate(bundle, currentBlock + 1);
    if ("error" in sim) { simSpinner.fail(`Simulation failed: ${sim.error.message}`); process.exit(1); }
    simSpinner.succeed(`Simulation passed — gas: ${sim.totalGasUsed}`);
  } catch (err) {
    simSpinner.fail(`Simulation error: ${err.message}`); process.exit(1);
  }

  for (let i = 1; i <= maxBlocks; i++) {
    const targetBlock = currentBlock + i;
    const s = ora(`Block ${targetBlock} — attempt ${i}/${maxBlocks}`).start();
    const response = await flashbotsProvider.sendBundle(bundle, targetBlock);
    if ("error" in response) { s.fail(`Bundle error: ${response.error.message}`); continue; }
    const resolution = await response.wait();
    if (resolution === FlashbotsBundleResolution.BundleIncluded) {
      s.succeed(chalk.green(`Included in block ${targetBlock}!`)); return true;
    } else if (resolution === FlashbotsBundleResolution.AccountNonceTooHigh) {
      s.fail("Nonce too high"); process.exit(1);
    } else { s.warn(`Block ${targetBlock} passed — retrying`); }
  }
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  banner();
  validateEnv();

  const {
    COMPROMISED_PRIVATE_KEY, SPONSOR_PRIVATE_KEY,
    SAFE_WALLET_ADDRESS, RPC_URL,
    TOKEN_CONTRACT_ADDRESS, MAX_BLOCKS,
    POLL_INTERVAL_MS, GAS_MULTIPLIER,
    MIN_BALANCE_SOMI, SWEEP_DELAY_MS,
    MAX_GAS_MULTIPLIER, MAX_RETRIES,
  } = process.env;

  const maxBlocks        = parseInt(MAX_BLOCKS         || "20");
  const pollMs           = parseInt(POLL_INTERVAL_MS   || "500");
  const gasMultiplier    = parseInt(GAS_MULTIPLIER     || "7");
  const minBalance       = MIN_BALANCE_SOMI            || "1";
  const sweepDelayMs     = parseInt(SWEEP_DELAY_MS     || "500");
  const maxGasMultiplier = parseInt(MAX_GAS_MULTIPLIER || "15");
  const maxRetries       = parseInt(MAX_RETRIES        || "5");
  const GAS_SWEEP        = TOKEN_CONTRACT_ADDRESS ? 65000 : 21000;

  const provider          = new ethers.providers.StaticJsonRpcProvider(RPC_URL);
  const compromisedWallet = new ethers.Wallet(COMPROMISED_PRIVATE_KEY, provider);
  const sponsorWallet     = new ethers.Wallet(SPONSOR_PRIVATE_KEY, provider);

  console.log(chalk.white("Wallets loaded:"));
  console.log(chalk.gray(`  Compromised : ${compromisedWallet.address}`));
  console.log(chalk.gray(`  Sponsor     : ${sponsorWallet.address}`));
  console.log(chalk.gray(`  Safe target : ${SAFE_WALLET_ADDRESS}`));
  console.log(chalk.gray(`  RPC pool    : ${RPC_POOL.length} endpoints\n`));

  // Network
  const netSpinner   = ora("Detecting network...").start();
  const network      = await provider.getNetwork();
  const hasFlashbots = !!FLASHBOTS_RELAY[network.chainId];
  netSpinner.succeed(`Chain ID: ${network.chainId} — Mode: ${hasFlashbots ? "Flashbots ✓" : "Multi-RPC High-Gas"}`);

  // Sponsor balance
  const balanceHex     = await rawRpc(RPC_URL, "eth_getBalance", [sponsorWallet.address, "latest"]);
  const sponsorBalance = ethers.BigNumber.from(balanceHex);
  console.log(chalk.white(`Sponsor balance: ${ethers.utils.formatEther(sponsorBalance)} SOMI`));
  if (sponsorBalance.isZero()) {
    console.error(chalk.red("\n✗ Sponsor wallet has 0 SOMI. Top it up and retry.\n"));
    process.exit(1);
  }

  // Optimal gas
  const gasFees  = await getOptimalGas(provider, gasMultiplier);
  const gasPrice = gasFees.gasPrice || gasFees.maxFeePerGas;
  console.log(chalk.white(`Gas: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei (${gasMultiplier}x) ${gasFees.isEIP1559 ? "— EIP-1559 ✓" : "— legacy"}`));
  console.log(chalk.white(`Max retry gas: up to ${maxGasMultiplier}x over ${maxRetries} attempts\n`));

  const gasForCompromised = gasPrice.mul(GAS_SWEEP + 10000);
  const requiredGas       = gasPrice.mul(GAS_SWEEP);
  const requiredGasEther  = ethers.utils.formatEther(requiredGas);

  // ── Wallet gas status report ─────────────────────────────────────────────────
  const compExistingHex = await rawRpc(RPC_URL, "eth_getBalance", [compromisedWallet.address, "latest"]);
  const compExistingBal = ethers.BigNumber.from(compExistingHex);
  const skipGasFunding  = compExistingBal.gte(requiredGas);

  console.log(chalk.white("\n┌─────────────────────────────────────────────────────┐"));
  console.log(chalk.white("│           WALLET GAS STATUS REPORT                  │"));
  console.log(chalk.white("├─────────────────────────────────────────────────────┤"));
  console.log(chalk.white(`│  Compromised wallet balance : ${ethers.utils.formatEther(compExistingBal).padEnd(20)} │`));
  console.log(chalk.white(`│  Required gas to sweep      : ${requiredGasEther.padEnd(20)} │`));
  console.log(chalk.white(`│  Sponsor wallet balance     : ${ethers.utils.formatEther(sponsorBalance).padEnd(20)} │`));
  console.log(chalk.white("├─────────────────────────────────────────────────────┤"));

  if (skipGasFunding) {
    console.log(chalk.green("│  ✓ STATUS: SELF-FUNDED                               │"));
    console.log(chalk.green("│  Compromised wallet has sufficient gas               │"));
    console.log(chalk.green("│  No external gas transaction needed                  │"));
    console.log(chalk.green("│  Rescue will sweep directly on detection             │"));
  } else {
    const deficit = requiredGas.sub(compExistingBal);
    console.log(chalk.yellow("│  ⚠ STATUS: NEEDS GAS FUNDING                         │"));
    console.log(chalk.yellow(`│  Deficit: ${ethers.utils.formatEther(deficit).padEnd(41)}│`));
    console.log(chalk.yellow("│  Sponsor wallet will fund gas on detection           │"));
    console.log(chalk.yellow("│  Tip: send gas to compromised wallet to skip step    │"));
  }

  console.log(chalk.white("└─────────────────────────────────────────────────────┘\n"));

  // ── Shared mutable state ─────────────────────────────────────────────────────
  const state = { gasPrice, gasFees, gasForCompromised, preSignedFundTx: null, GAS_SWEEP };

  // Pre-sign gas funding tx
  const preSignSpinner = ora("Pre-signing gas funding transaction...").start();
  try {
    const nonce = await sponsorWallet.getTransactionCount("latest");
    state.preSignedFundTx = await sponsorWallet.signTransaction({
      to: compromisedWallet.address,
      value: gasForCompromised,
      gasLimit: 21000,
      nonce,
      chainId: network.chainId,
      ...(gasFees.isEIP1559
        ? { maxFeePerGas: gasFees.maxFeePerGas, maxPriorityFeePerGas: gasFees.maxPriorityFeePerGas, type: 2 }
        : { gasPrice, type: 0 }
      ),
    });
    preSignSpinner.succeed(`Gas tx pre-signed — nonce: ${nonce} — ready to fire instantly`);
  } catch (err) {
    preSignSpinner.warn(`Pre-sign failed — will sign on detection`);
  }

  // Start background refreshers
  const stopGasRefresher   = await startGasRefresher({ provider, gasMultiplier, state });
  const stopNonceRefresher = await startNonceRefresher({
    sponsorWallet,
    compromisedAddress: compromisedWallet.address,
    state,
    chainId: network.chainId,
  });

  // ── Standby display ──────────────────────────────────────────────────────────
  console.log(chalk.cyan("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.cyan("  STANDBY ACTIVE — MAXIMUM SPEED v4.0"));
  console.log(chalk.cyan(`  Monitoring        : ${compromisedWallet.address}`));
  console.log(chalk.cyan(`  Detection         : WebSocket real-time + ${RPC_POOL.length} RPCs parallel fallback`));
  console.log(chalk.cyan(`  Poll fallback     : every ${pollMs}ms`));
  console.log(chalk.cyan(`  Gas boost         : ${gasMultiplier}x — auto-refreshes every 5 mins`));
  console.log(chalk.cyan(`  EIP-1559          : ${gasFees.isEIP1559 ? "active ✓" : "not supported — using legacy gas"}`));
  console.log(chalk.cyan(`  Max retry gas     : up to ${maxGasMultiplier}x over ${maxRetries} attempts`));
  console.log(chalk.cyan(`  Nonce refresh     : every 10 mins`));
  console.log(chalk.cyan(`  Broadcast         : ${RPC_POOL.length} RPCs simultaneously`));
  console.log(chalk.cyan(`  Gas funding       : ${skipGasFunding ? "skipped — wallet pre-funded ✓" : `${sweepDelayMs}ms delay after funding`}`));
  console.log(chalk.cyan(`  Min trigger       : ${minBalance} SOMI`));
  console.log(chalk.cyan("  Sound alert       : active — will beep on detection"));
  console.log(chalk.cyan("  Press Ctrl+C to stop"));
  console.log(chalk.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"));

  // ── Watch ────────────────────────────────────────────────────────────────────
  const detectedBalance = await watchForBalance({
    address: compromisedWallet.address,
    tokenAddress: TOKEN_CONTRACT_ADDRESS || null,
    pollMs,
    provider,
    minBalance,
  });

  // Stop refreshers
  stopGasRefresher();
  stopNonceRefresher();

  // Sound alert
  playAlert();

  // ── Fire ─────────────────────────────────────────────────────────────────────
  console.log(chalk.green(`\n\n🚨 BALANCE DETECTED: ${ethers.utils.formatEther(detectedBalance)} SOMI`));
  console.log(chalk.green(`   FIRING — ${RPC_POOL.length} RPCs — ${gasMultiplier}x GAS — ${maxRetries} RETRIES — EIP-1559: ${gasFees.isEIP1559 ? "YES" : "NO"}\n`));

  // Live gas at moment of detection
  const liveGasFees       = await getOptimalGas(provider, gasMultiplier);
  const liveGasPrice      = liveGasFees.gasPrice || liveGasFees.maxFeePerGas;
  const liveGasForComp    = liveGasPrice.mul(GAS_SWEEP + 10000);

  // Build sweep tx
  let sweepTx;
  if (TOKEN_CONTRACT_ADDRESS) {
    const iface = new ethers.utils.Interface(ERC20_ABI);
    sweepTx = {
      to: TOKEN_CONTRACT_ADDRESS,
      data: iface.encodeFunctionData("transfer", [SAFE_WALLET_ADDRESS, detectedBalance]),
      gasLimit: GAS_SWEEP,
      chainId: network.chainId,
    };
  } else {
    const compBalHex  = await rawRpc(RPC_URL, "eth_getBalance", [compromisedWallet.address, "latest"]);
    const compBalance = ethers.BigNumber.from(compBalHex);
    const sweepable   = skipGasFunding
      ? compBalance.sub(liveGasPrice.mul(GAS_SWEEP))
      : compBalance.add(liveGasForComp).sub(liveGasPrice.mul(GAS_SWEEP));
    sweepTx = {
      to: SAFE_WALLET_ADDRESS,
      value: sweepable.gt(0) ? sweepable : compBalance,
      gasLimit: GAS_SWEEP,
      chainId: network.chainId,
    };
  }

  const currentBlock = await provider.getBlockNumber();
  let success = false;

  if (hasFlashbots) {
    success = await rescueViaFlashbots({
      provider, sponsorWallet, compromisedWallet,
      gasPrice: liveGasPrice, network, sweepTx,
      gasForCompromised: liveGasForComp,
      maxBlocks, currentBlock,
    });
  } else {
    success = await rescueViaHighGas({
      rpcUrl: RPC_URL,
      sponsorWallet, compromisedWallet,
      gasPrice: liveGasPrice,
      gasFees: liveGasFees,
      sweepTx,
      state: { ...state, gasForCompromised: liveGasForComp, preSignedFundTx: state.preSignedFundTx },
      baseGasMultiplier: gasMultiplier,
      maxGasMultiplier,
      maxRetries,
      sweepDelayMs,
      provider,
      skipGasFunding,
    });
  }

  if (success) {
    playAlert();
    console.log(chalk.green("\n══════════════════════════════════════════════════════════════════"));
    console.log(chalk.green("  ✓ RESCUE SUCCESSFUL"));
    console.log(chalk.green(`  SOMI is now safe in: ${SAFE_WALLET_ADDRESS}`));
    console.log(chalk.green("  Retire the compromised wallet — never use it again."));
    console.log(chalk.green("══════════════════════════════════════════════════════════════════\n"));
  } else {
    console.log(chalk.yellow(`\n⚠ All ${maxRetries} rescue attempts exhausted.`));
    console.log(chalk.yellow("  Increase GAS_MULTIPLIER, MAX_GAS_MULTIPLIER and MAX_RETRIES in .env and retry.\n"));
  }
}

main().catch((err) => { console.error(chalk.red("\n✗ Fatal error:"), err.message); process.exit(1); });
