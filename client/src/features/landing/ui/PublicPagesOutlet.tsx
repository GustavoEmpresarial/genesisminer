import type { PublicView } from '../../shell';
import { GuidePage } from '../../guide';
import { RoadmapPage } from '../../roadmap';
import {
  AmlPolicyPage,
  CommunityPolicyPage,
  CookiesPolicyPage,
  PrivacyPage,
  RefundPolicyPage,
  TermsPage,
  Web3RiskPage
} from '../../legal';

type PublicPagesOutletProps = {
  view: PublicView;
};

export function PublicPagesOutlet({ view }: PublicPagesOutletProps) {
  if (view === 'docs') return <GuidePage />;
  if (view === 'roadmap') return <RoadmapPage />;
  if (view === 'terms') return <TermsPage />;
  if (view === 'privacy') return <PrivacyPage />;
  if (view === 'cookies') return <CookiesPolicyPage />;
  if (view === 'aml') return <AmlPolicyPage />;
  if (view === 'web3_risk') return <Web3RiskPage />;
  if (view === 'refunds') return <RefundPolicyPage />;
  if (view === 'community') return <CommunityPolicyPage />;
  return null;
}
