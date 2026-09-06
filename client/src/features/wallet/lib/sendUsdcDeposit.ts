/**
 * Envio ERC-20 USDC via MetaMask — só o início de depósito da WalletPage.
 * Sem endpoint HTTP: a carteira assina; o servidor credita em /api/deposit/verify.
 */

type DepositWeb3Settings = {
  depositWallet?: string;
  depositTokenContract?: string;
  depositTokenContractBnb?: string;
  depositTokenContractBase?: string;
  depositPolygonDisabled?: boolean;
  depositBnbDisabled?: boolean;
  depositBaseDisabled?: boolean;
};

function depositFlagDisabled(v: unknown): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    return t === '1' || t === 'true' || t === 'yes' || t === 'on';
  }
  return false;
}

export type SendUsdcDepositResult = {
  ok: boolean;
  tx?: string;
  cancelled?: boolean;
  error?: string;
};

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function networkMeta(network: string, s: DepositWeb3Settings): {
  contract: string;
  dest: string;
  targetChainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
} | { error: string } {
  const netKey = (network || 'polygon').toLowerCase();
  if (netKey === 'polygon' || netKey === 'matic') {
    if (depositFlagDisabled(s.depositPolygonDisabled)) {
      return { error: 'Depósitos na Polygon estão desativados pelo administrador.' };
    }
  } else if (netKey === 'bnb' || netKey === 'bsc') {
    if (depositFlagDisabled(s.depositBnbDisabled)) {
      return { error: 'Depósitos na BNB Chain estão desativados pelo administrador.' };
    }
  } else if (netKey === 'base') {
    if (depositFlagDisabled(s.depositBaseDisabled)) {
      return { error: 'Depósitos na Base estão desativados pelo administrador.' };
    }
  } else {
    return { error: 'Rede não suportada.' };
  }

  let contract = '';
  let targetChainId = '0x89';
  let chainName = 'Polygon Mainnet';
  let nativeCurrency = { name: 'MATIC', symbol: 'MATIC', decimals: 18 };
  let rpcUrls = ['https://polygon-rpc.com'];
  let blockExplorerUrls = ['https://polygonscan.com'];

  if (netKey === 'bnb' || netKey === 'bsc') {
    contract = s.depositTokenContractBnb || '';
    targetChainId = '0x38';
    chainName = 'Binance Smart Chain';
    nativeCurrency = { name: 'BNB', symbol: 'BNB', decimals: 18 };
    rpcUrls = ['https://bsc-dataseed.binance.org/'];
    blockExplorerUrls = ['https://bscscan.com'];
  } else if (netKey === 'base') {
    contract = s.depositTokenContractBase || '';
    targetChainId = '0x2105';
    chainName = 'Base Mainnet';
    nativeCurrency = { name: 'ETH', symbol: 'ETH', decimals: 18 };
    rpcUrls = ['https://mainnet.base.org'];
    blockExplorerUrls = ['https://basescan.org'];
  } else {
    contract = s.depositTokenContract || '';
  }

  const dest = s.depositWallet || '';
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract) || !/^0x[a-fA-F0-9]{40}$/.test(dest)) {
    return { error: `Configuração de contrato/carteira incompleta para a rede ${network}.` };
  }
  return { contract, dest, targetChainId, chainName, nativeCurrency, rpcUrls, blockExplorerUrls };
}

export async function sendUsdcDeposit(args: {
  amount: number;
  network: string;
  polygonWallet: string;
  settings: DepositWeb3Settings;
  ethereum?: EthereumProvider | null;
  confirm?: (msg: string) => boolean;
}): Promise<SendUsdcDepositResult> {
  const amt = Number(args.amount);
  if (!amt || amt < 0.001) return { ok: false, error: 'Valor inválido.' };
  const wallet = String(args.polygonWallet || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return { ok: false, error: 'Conecte uma carteira para depositar.' };
  }
  const meta = networkMeta(args.network, args.settings);
  if ('error' in meta) return { ok: false, error: meta.error };

  const eth = args.ethereum ?? (typeof window !== 'undefined' ? (window as unknown as { ethereum?: EthereumProvider }).ethereum : undefined);
  if (!eth) return { ok: false, error: 'Carteira (MetaMask) não encontrada.' };

  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[] | undefined;
  const from = accounts && accounts[0];
  if (!from || !/^0x[a-fA-F0-9]{40}$/.test(from)) return { ok: false, error: 'Conta MetaMask inválida.' };
  if (from.toLowerCase() !== wallet.toLowerCase()) {
    return { ok: false, error: 'Depósito deve ser realizado exclusivamente pela carteira conectada no Perfil.' };
  }

  try {
    const chainId = String(await eth.request({ method: 'eth_chainId' }));
    if (chainId.toLowerCase() !== meta.targetChainId.toLowerCase()) {
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: meta.targetChainId }] });
      } catch {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: meta.targetChainId,
                chainName: meta.chainName,
                nativeCurrency: meta.nativeCurrency,
                rpcUrls: meta.rpcUrls,
                blockExplorerUrls: meta.blockExplorerUrls
              }
            ]
          });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }

  let decimals = 6;
  try {
    const decRes = await eth.request({
      method: 'eth_call',
      params: [{ to: meta.contract, data: '0x313ce567' }, 'latest']
    });
    if (typeof decRes === 'string' && decRes.startsWith('0x')) {
      const d = parseInt(decRes, 16);
      if (!Number.isNaN(d) && d > 0 && d < 36) decimals = d;
    }
  } catch {
    /* fallback */
  }

  const raw = BigInt(Math.round(amt * Math.pow(10, decimals)));
  const amountHex = raw.toString(16);
  const toPadded = meta.dest.replace(/^0x/, '').padStart(64, '0');
  const amtPadded = amountHex.padStart(64, '0');
  const data = '0xa9059cbb' + toPadded + amtPadded;

  const confirm = args.confirm ?? ((msg: string) => (typeof window !== 'undefined' ? window.confirm(msg) : false));
  try {
    const proceed = confirm(`Atenção: você pagará o gas na rede ${String(args.network).toUpperCase()}. Deseja continuar?`);
    if (!proceed) return { ok: false, cancelled: true };
    const tx = await eth.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: meta.contract, value: '0x0', data }]
    });
    if (typeof tx === 'string' && tx) {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [tx] });
          if (receipt && typeof receipt === 'object' && 'status' in (receipt as object)) {
            const status = (receipt as { status?: string | number }).status;
            const ok = status === '0x1' || status === 1;
            return { ok, tx };
          }
        } catch {
          /* keep polling */
        }
      }
      return { ok: false, tx };
    }
    return { ok: false };
  } catch {
    return { ok: false, cancelled: true };
  }
}
