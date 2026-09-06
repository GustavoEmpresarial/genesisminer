export type DeviceFingerprintPayload = {
  visitorId: string;
  components: Record<string, string | number | boolean>;
};

export interface AccessLevel {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  isActive: boolean;
  priceUsdc?: number;
  contractAddress?: string;
  inactiveMessage?: string;
  newsPostingEnabled?: boolean;
  allowedPages?: string[];
}

export interface User {
  username: string;
  email: string;
  password?: string;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  polygonWallet?: string;
  isBlocked?: boolean;
  accessLevelId?: string;
  accessLevelIds?: string[];
  referralCode?: string;
  referredBy?: string;
  referrals?: string[];
  totalUsdcDeposited?: number;
  totalCryptoWithdrawn?: number;
  lastActiveAt?: number;
  isNewRegistration?: boolean;
  isImpersonating?: boolean;
  isManagingAccount?: boolean;
  managerMode?: boolean;
  managerUserId?: number | null;
  actingAsOwnerId?: number | null;
  /** Kill-switch servidor (`ACCOUNT_MANAGER_ENABLED`). Ausente = tratar como off. */
  accountManagerEnabled?: boolean;
  /** Merge Station ligado no admin. Ausente = tratar como on (legado). */
  mergeEnabled?: boolean;
  emailVerified?: boolean;
  emailVerificationRequired?: boolean;
  id?: string;
  adminPermissions?: string[];
  deviceFingerprint?: DeviceFingerprintPayload;
  siteMaintenance?: boolean;
  error?: string;
  code?: string;
}
