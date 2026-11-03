import { describe, expect, it } from 'vitest';
import {
  CHAT_POPUP_DOCK_BLOG_COLLAPSED_CLASS,
  CHAT_POPUP_DOCK_BLOG_EXPANDED_CLASS,
  CHAT_POPUP_DOCK_DEFAULT_CLASS,
  CHAT_POPUP_Z_CLASS,
  floatingChatDockClass,
  floatingChatDockRightRem,
  MINI_BLOG_COLLAPSED_MARGIN_REM,
  MINI_BLOG_COLLAPSED_WIDTH_REM,
  MINI_BLOG_EXPANDED_MARGIN_REM,
  MINI_BLOG_EXPANDED_MAX_REM,
  CHAT_POPUP_EDGE_REM,
  CHAT_POPUP_RAIL_GAP_REM,
  amPeerPickerHeading,
  amPeerThreadLabel,
  CHAT_CHANNEL_GLOBAL,
  chatChannelUsesMessageTtl,
  pickInitialAmPeerChannel,
  shouldShowFloatingGerenciaChat,
  shouldUsePageGerenciaChat
} from '../../../../../client/src/features/chat/lib/chatPlacement.js';

describe('shouldShowFloatingGerenciaChat', () => {
  it('aparece no jogo normal', () => {
    expect(shouldShowFloatingGerenciaChat({})).toBe(true);
  });

  it('aparece no modo gerência (dentro da conta do utilizador)', () => {
    expect(
      shouldShowFloatingGerenciaChat({ isManagingAccount: true, managerMode: true })
    ).toBe(true);
  });

  it('aparece ao visualizar conta de utilizador (impersonate)', () => {
    expect(shouldShowFloatingGerenciaChat({ isImpersonating: true })).toBe(true);
  });
});

describe('chatChannelUsesMessageTtl', () => {
  it('só o global usa TTL de 1h', () => {
    expect(chatChannelUsesMessageTtl(CHAT_CHANNEL_GLOBAL)).toBe(true);
    expect(chatChannelUsesMessageTtl('')).toBe(true);
    expect(chatChannelUsesMessageTtl('am:10:20')).toBe(false);
  });
});

describe('amPeerThreadLabel', () => {
  it('dono vê o nome do gerente', () => {
    expect(amPeerThreadLabel({ role: 'owner', peerUsername: 'JMOURA' })).toBe('Gerente · JMOURA');
  });

  it('gerente vê o nome da conta', () => {
    expect(amPeerThreadLabel({ role: 'manager', peerUsername: 'ElonMuskBR' })).toBe(
      'Conta · ElonMuskBR'
    );
  });
});

describe('amPeerPickerHeading', () => {
  it('um só contrato mostra o papel', () => {
    expect(amPeerPickerHeading([{ role: 'owner' }])).toBe('Gerente');
    expect(amPeerPickerHeading([{ role: 'manager' }])).toBe('Conta');
  });

  it('quando o dono tem vários gerentes pede para escolher o gerente', () => {
    expect(amPeerPickerHeading([{ role: 'owner' }, { role: 'owner' }])).toBe('Escolhe o gerente');
  });

  it('quando o gerente tem várias contas pede para escolher a conta', () => {
    expect(amPeerPickerHeading([{ role: 'manager' }, { role: 'manager' }])).toBe('Escolhe a conta');
  });
});

describe('pickInitialAmPeerChannel', () => {
  const peers = [
    { channel: 'am:10:20', peerUserId: 20 },
    { channel: 'am:11:20', peerUserId: 11 }
  ];

  it('escolhe a conta que estás a ver', () => {
    expect(pickInitialAmPeerChannel(peers, 11)).toBe('am:11:20');
  });

  it('sem preferência fica no primeiro contrato', () => {
    expect(pickInitialAmPeerChannel(peers, null)).toBe('am:10:20');
  });
});

describe('shouldUsePageGerenciaChat', () => {
  it('na Gestão o chat também vai embutido na página', () => {
    expect(shouldUsePageGerenciaChat('management')).toBe(true);
  });

  it('nas outras views não embute na página', () => {
    expect(shouldUsePageGerenciaChat('servers')).toBe(false);
    expect(shouldUsePageGerenciaChat('checkin')).toBe(false);
  });
});

describe('floatingChatDockRightRem', () => {
  it('sem Mini Blog usa a margem da borda', () => {
    expect(floatingChatDockRightRem({ miniBlogVisible: false, miniBlogExpanded: false })).toBe(
      CHAT_POPUP_EDGE_REM
    );
  });

  it('com Mini Blog expandido soma largura + margem + gap', () => {
    expect(floatingChatDockRightRem({ miniBlogVisible: true, miniBlogExpanded: true })).toBe(
      MINI_BLOG_EXPANDED_MAX_REM + MINI_BLOG_EXPANDED_MARGIN_REM + CHAT_POPUP_RAIL_GAP_REM
    );
  });

  it('com Mini Blog recolhido soma w-12 + mx-3 + gap', () => {
    expect(floatingChatDockRightRem({ miniBlogVisible: true, miniBlogExpanded: false })).toBe(
      MINI_BLOG_COLLAPSED_WIDTH_REM + MINI_BLOG_COLLAPSED_MARGIN_REM + CHAT_POPUP_RAIL_GAP_REM
    );
  });
});

describe('CHAT_POPUP_Z_CLASS', () => {
  it('fica acima do anúncio in-app z-[200]', () => {
    expect(CHAT_POPUP_Z_CLASS).toBe('z-[220]');
  });
});

describe('floatingChatDockClass', () => {
  it('escolhe classes Tailwind completas (xl só desloca)', () => {
    expect(floatingChatDockClass({ miniBlogVisible: false, miniBlogExpanded: true })).toBe(
      CHAT_POPUP_DOCK_DEFAULT_CLASS
    );
    expect(floatingChatDockClass({ miniBlogVisible: true, miniBlogExpanded: true })).toBe(
      CHAT_POPUP_DOCK_BLOG_EXPANDED_CLASS
    );
    expect(floatingChatDockClass({ miniBlogVisible: true, miniBlogExpanded: false })).toBe(
      CHAT_POPUP_DOCK_BLOG_COLLAPSED_CLASS
    );
  });

  it('classes usam os mesmos rem da função de docking', () => {
    const expanded = floatingChatDockRightRem({ miniBlogVisible: true, miniBlogExpanded: true });
    const collapsed = floatingChatDockRightRem({ miniBlogVisible: true, miniBlogExpanded: false });
    expect(CHAT_POPUP_DOCK_BLOG_EXPANDED_CLASS).toContain(`xl:right-[${expanded}rem]`);
    expect(CHAT_POPUP_DOCK_BLOG_COLLAPSED_CLASS).toContain(`xl:right-[${collapsed}rem]`);
  });
});
