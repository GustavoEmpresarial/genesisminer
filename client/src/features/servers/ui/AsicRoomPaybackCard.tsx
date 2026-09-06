import React from 'react';
import { NftRoomPaybackCard } from './NftRoomPaybackCard';
import type { AsicLeaseDetail, MiningCoin, PlacedRack, Upgrade } from '../types';

type Props = {
  racks: PlacedRack[];
  roomId: string | null | undefined;
  upgrades: Upgrade[];
  miningCoins: MiningCoin[];
  minedUsdTotal?: number;
  asicLeaseDetails?: AsicLeaseDetail[];
};

/** Painel de payback da Sala ASICs — mesma conta que o cartão NFT, outro sítio. */
export const AsicRoomPaybackCard: React.FC<Props> = (props) => <NftRoomPaybackCard {...props} />;
