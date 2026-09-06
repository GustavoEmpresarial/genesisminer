import React from 'react';
import { PartnerGamesPage } from './PartnerGamesPage';

type Props = {
  slug?: string;
  onBackToHub?: () => void;
};

export const PartnerGamePlayerPage: React.FC<Props> = ({ onBackToHub }) => (
  <PartnerGamesPage onExit={onBackToHub} />
);
