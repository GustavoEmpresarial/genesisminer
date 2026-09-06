import { describe, expect, it } from 'vitest';
import {
  ASIC_ROOM_ID,
  isChassisAllowedInRoom,
  isExclusiveChassisRoom,
  resolveRoomKind,
  roomRules,
  ROOM_KIND_RULES
} from '../../../../server/modules/mining-engine/services/room-kind.js';
import {
  NFT_AUTO_ALLOWED_CHASSIS_ID,
  NFT_AUTO_ROOM_ID
} from '../../../../server/modules/mining-engine/services/nft-room-mining.js';

/** Segunda sala NFT — existe por nome de política, com id próprio. */
const SALA_NFT_POR_NOME = 'room_sala_das_asics';
const NFT_IDS = new Set<string>([NFT_AUTO_ROOM_ID, SALA_NFT_POR_NOME]);
const CHASSI_COMUM = 'rack04_cores';

describe('mining-engine services/room-kind', () => {
  describe('resolveRoomKind', () => {
    it('sala comum é standard', () => {
      expect(resolveRoomKind('room_initial', NFT_IDS)).toBe('standard');
      expect(resolveRoomKind('room_qualquer', NFT_IDS)).toBe('standard');
    });

    it('sala NFT canónica é nft', () => {
      expect(resolveRoomKind(NFT_AUTO_ROOM_ID, NFT_IDS)).toBe('nft');
    });

    it('sem conjunto fornecido, só a sala NFT canónica conta (comportamento histórico)', () => {
      expect(resolveRoomKind(NFT_AUTO_ROOM_ID)).toBe('nft');
      expect(resolveRoomKind(SALA_NFT_POR_NOME)).toBe('standard');
    });

    it('normaliza o room_id antes de decidir', () => {
      expect(resolveRoomKind('  room_initial  ', NFT_IDS)).toBe('standard');
      expect(resolveRoomKind(null, NFT_IDS)).toBe('standard');
      expect(resolveRoomKind('main', NFT_IDS)).toBe('standard');
    });

    /**
     * Regressão: a colocação de rig usava o conjunto resolvido e o equipar usava
     * o id fixo. Numa segunda sala NFT as duas discordavam, e a regra "só ASICs"
     * deixava de ser aplicada. Uma pergunta só ⇒ não podem divergir.
     */
    it('segunda sala NFT (por nome) também é nft — não só a canónica', () => {
      expect(resolveRoomKind(SALA_NFT_POR_NOME, NFT_IDS)).toBe('nft');
    });
  });

  describe('ROOM_KIND_RULES', () => {
    it('enumera as diferenças reais entre os dois tipos', () => {
      expect(ROOM_KIND_RULES.standard).toEqual({
        allowedChassisId: null,
        asicMachinesOnly: false,
        coinComesFromMachine: false
      });
      expect(ROOM_KIND_RULES.nft).toEqual({
        allowedChassisId: NFT_AUTO_ALLOWED_CHASSIS_ID,
        asicMachinesOnly: true,
        coinComesFromMachine: true
      });
    });

    it('os dois tipos diferem em todas as regras declaradas', () => {
      for (const chave of Object.keys(ROOM_KIND_RULES.standard) as Array<keyof typeof ROOM_KIND_RULES.standard>) {
        expect(ROOM_KIND_RULES.standard[chave], `regra "${chave}" não diferencia os tipos`).not.toBe(
          ROOM_KIND_RULES.nft[chave]
        );
      }
    });
  });

  describe('roomRules', () => {
    it('sala NFT exige ASICs e tira a moeda da máquina', () => {
      const r = roomRules(SALA_NFT_POR_NOME, NFT_IDS);
      expect(r.asicMachinesOnly).toBe(true);
      expect(r.coinComesFromMachine).toBe(true);
    });

    it('sala comum não impõe nenhuma das duas', () => {
      const r = roomRules('room_initial', NFT_IDS);
      expect(r.asicMachinesOnly).toBe(false);
      expect(r.coinComesFromMachine).toBe(false);
    });
  });

  describe('isChassisAllowedInRoom (exclusividade mútua)', () => {
    it('chassi H1 só entra em sala NFT', () => {
      expect(isChassisAllowedInRoom(NFT_AUTO_ALLOWED_CHASSIS_ID, NFT_AUTO_ROOM_ID, NFT_IDS)).toBe(true);
      expect(isChassisAllowedInRoom(NFT_AUTO_ALLOWED_CHASSIS_ID, SALA_NFT_POR_NOME, NFT_IDS)).toBe(true);
      expect(isChassisAllowedInRoom(NFT_AUTO_ALLOWED_CHASSIS_ID, 'room_initial', NFT_IDS)).toBe(false);
    });

    it('sala NFT só aceita o chassi H1', () => {
      expect(isChassisAllowedInRoom(CHASSI_COMUM, NFT_AUTO_ROOM_ID, NFT_IDS)).toBe(false);
      expect(isChassisAllowedInRoom(CHASSI_COMUM, SALA_NFT_POR_NOME, NFT_IDS)).toBe(false);
    });

    it('chassi comum entra em sala comum', () => {
      expect(isChassisAllowedInRoom(CHASSI_COMUM, 'room_initial', NFT_IDS)).toBe(true);
    });

    it('a relação é simétrica: nenhum dos dois lados aceita o par errado', () => {
      const casos = [
        [NFT_AUTO_ALLOWED_CHASSIS_ID, 'room_initial'],
        [CHASSI_COMUM, SALA_NFT_POR_NOME]
      ] as const;
      for (const [chassi, sala] of casos) {
        expect(isChassisAllowedInRoom(chassi, sala, NFT_IDS), `${chassi} em ${sala}`).toBe(false);
      }
    });
  });

  /**
   * Regressão: `listSlotMiningCredits` credita o chassi H1 na Sala ASICs, mas
   * montar/sanitizar/validar tratavam-no como sala comum — o sanitize desmontava
   * as rigs do jogador e remontar era rejeitado.
   */
  describe('chassi H1 na Sala ASICs', () => {
    const ASIC_IDS = new Set<string>([ASIC_ROOM_ID]);

    it('entra na Sala ASICs canónica', () => {
      expect(isChassisAllowedInRoom(NFT_AUTO_ALLOWED_CHASSIS_ID, ASIC_ROOM_ID, NFT_IDS, ASIC_IDS)).toBe(true);
    });

    it('entra em Sala ASICs resolvida por id de BD', () => {
      const porBd = new Set<string>(['room_outra_asics']);
      expect(isChassisAllowedInRoom(NFT_AUTO_ALLOWED_CHASSIS_ID, 'room_outra_asics', NFT_IDS, porBd)).toBe(true);
    });

    it('entra em Sala ASICs reconhecida pelo nome', () => {
      expect(
        isChassisAllowedInRoom(NFT_AUTO_ALLOWED_CHASSIS_ID, 'room_x', NFT_IDS, new Set(), 'SALA DAS ASICS')
      ).toBe(true);
    });

    it('continua fora das salas comuns', () => {
      expect(isChassisAllowedInRoom(NFT_AUTO_ALLOWED_CHASSIS_ID, 'room_initial', NFT_IDS, ASIC_IDS)).toBe(false);
    });

    it('Sala ASICs continua a aceitar chassis comuns', () => {
      expect(isChassisAllowedInRoom(CHASSI_COMUM, ASIC_ROOM_ID, NFT_IDS, ASIC_IDS)).toBe(true);
    });

    it('Sala NFT continua exclusiva do H1 mesmo com asicRoomIds', () => {
      expect(isChassisAllowedInRoom(CHASSI_COMUM, NFT_AUTO_ROOM_ID, NFT_IDS, ASIC_IDS)).toBe(false);
    });
  });

  describe('isExclusiveChassisRoom', () => {
    const ASIC_IDS = new Set<string>([ASIC_ROOM_ID]);

    it('Sala NFT e Sala ASICs hospedam o chassi exclusivo', () => {
      expect(isExclusiveChassisRoom(NFT_AUTO_ROOM_ID, NFT_IDS, ASIC_IDS)).toBe(true);
      expect(isExclusiveChassisRoom(ASIC_ROOM_ID, NFT_IDS, ASIC_IDS)).toBe(true);
    });

    it('sala comum não hospeda', () => {
      expect(isExclusiveChassisRoom('room_initial', NFT_IDS, ASIC_IDS)).toBe(false);
    });
  });
});
