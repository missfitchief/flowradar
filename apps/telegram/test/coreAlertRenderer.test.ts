import { describe, expect, it } from 'vitest';
import { parseCoreAlertCallback, renderCoreMonitoringAlert } from '../src/coreAlertRenderer';

const ALERT = {
  id: 'cluster-alert-1', alertType: 'core_multi_wallet_buy', payloadJson: {
    signalTier: 'STRONG_WATCH', chain: 'SOLANA', protocol: 'Raydium', token: 'Example Token', symbol: 'TOKEN',
    ca: 'TokenContractAddress', rawWalletCount: 3, qualifyingWalletCount: 3, coreWalletCount: 2, relatedWalletCount: 1,
    entityCount: 2, independentEntityCount: 2, sameEntityWalletCount: 2, effectiveConfirmationCount: 2,
    combinedBuyUsd: 2_940, combinedTokenAmount: 18.42, windowMs: 7 * 60_000,
    marketCapUsd: 184_000, liquidityUsd: 71_400, liquidityAvailable: true, holderCount: 428, holdersAvailable: true, entryDelaySec: 261,
    historicalAlphaScore: 91, dormantWakeUpCount: 1, maxDormantDays: 214, confidence: 0.82, alertScore: 88,
    whyThisMatters: '2 independent high-alpha entities entered within 7 minutes. One dormant Core wallet activated after 214 days.',
    entityLabels: ['Alpha Entity', 'Dormant Entity'],
    participants: [
      { wallet: 'WalletOneFullAddress', role: 'core', amountUsd: 1_500, entityLabel: 'Alpha Entity' },
      { wallet: 'WalletTwoFullAddress', role: 'core', amountUsd: 1_440, entityLabel: 'Dormant Entity' }
    ],
    fundingPaths: [{ source: 'FundingWallet', destination: 'WalletTwoFullAddress', route: 'direct_transfer', confidence: 0.91 }]
  }
} as const;

describe('Core confluence Telegram alert', () => {
  it('renders a compact cluster-centric summary without debug or full wallet dumps', () => {
    const rendered = renderCoreMonitoringAlert(ALERT);

    expect(rendered.text).toContain('CLUSTER BUY');
    expect(rendered.text).toContain('Raydium');
    expect(rendered.text).toContain('3</b> qualified wallets · <b>2</b> independent entities');
    expect(rendered.text).toContain('Cluster bought <b>18.42 TOKEN ($2.94K)</b> at MC <b>$184K</b>');
    expect(rendered.text).toContain('Signal: <b>STRONG WATCH</b>');
    expect(rendered.text).toContain('<code>TokenContractAddress</code>');
    expect(rendered.text).not.toContain('CORE WALLET TOKEN BUY');
    expect(rendered.text).not.toContain('observation_only');
    expect(rendered.text).not.toContain('WalletOneFullAddress');

    const labels = rendered.keyboard.inline_keyboard.map((row) => row.map((button) => button.text));
    expect(labels).toEqual([
      ['🐴 Trojan', '🟪 Padre', '🦎 GMGN'],
      ['AXIOM', 'Bonk', '📊 Info'],
      ['👥 Wallets', '🔗 Capital Path', '🧠 Entity']
    ]);
    expect(rendered.keyboard.inline_keyboard[0]?.[0]?.url).toContain('TokenContractAddress');
    expect(rendered.keyboard.inline_keyboard[1]?.[2]?.url).toBe('https://dexscreener.com/solana/TokenContractAddress');
  });

  it('keeps full addresses and evidence counts behind explicit detail callbacks', () => {
    const wallets = renderCoreMonitoringAlert(ALERT, 'wallets');
    const entity = renderCoreMonitoringAlert(ALERT, 'entity');

    expect(wallets.text).toContain('<code>WalletOneFullAddress</code>');
    expect(entity.text).toContain('Independent entities: <b>2</b>');
    expect(parseCoreAlertCallback('c2|w|cluster-alert-1')).toEqual({ alertId: 'cluster-alert-1', view: 'wallets' });
    expect(parseCoreAlertCallback('c2|bad|cluster-alert-1')).toBeNull();
  });

  it('labels standalone dormant wake-up as activity rather than a buy opportunity', () => {
    const rendered = renderCoreMonitoringAlert({
      id: 'wake-1', alertType: 'dormant_wallet_reactivated',
      payloadJson: { chain: 'BASE', wallet: '0xabc', evidence: { dormantDays: 214 } }
    });
    expect(rendered.text).toContain('DORMANT WALLET AWAKENED');
    expect(rendered.text).toContain('not a token buy opportunity');
  });

  it('never renders unavailable liquidity or holder coverage as zero', () => {
    const rendered = renderCoreMonitoringAlert({
      ...ALERT,
      payloadJson: { ...ALERT.payloadJson, liquidityUsd: 0, liquidityAvailable: false, holderCount: 0, holdersAvailable: false }
    });
    expect(rendered.text).not.toContain('Liquidity: <b>$0');
    expect(rendered.text).not.toContain('Holders: <b>0');
  });
});
