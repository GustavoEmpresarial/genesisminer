import React from 'react';
import { TriangleAlert } from 'lucide-react';
import { LegalPageLayout, type LegalSection } from './LegalPageLayout';

const sections: LegalSection[] = [
  {
    id: 'natureza',
    title: '1. Natureza do risco',
    body: [
      'O Genesis Miner é um jogo ou simulador com componentes Web3. O uso de carteiras, redes blockchain, tokens e transações on-chain envolve riscos técnicos, económicos, operacionais, jurídicos e regulatórios.',
      'A presença de funcionalidades Web3 não transforma a plataforma em consultoria financeira, corretora, custodiante tradicional, promessa de retorno ou garantia de liquidez futura.'
    ]
  },
  {
    id: 'volatilidade',
    title: '2. Volatilidade e mercado',
    body: [
      'Ativos digitais podem sofrer forte oscilação de preço, perda de liquidez, variações abruptas, falhas de mercado, restrições regulatórias e mudanças inesperadas de infraestrutura.',
      'Nada na plataforma constitui promessa de retorno financeiro, valorização futura, rentabilidade mínima, estabilidade de preço ou capacidade permanente de conversão.'
    ]
  },
  {
    id: 'transacoes',
    title: '3. Transações on-chain',
    body: [
      'Transações blockchain podem ser irreversíveis. Endereço errado, rede errada, token errado, assinatura indevida, erro de operação ou interação com contrato incorreto podem causar perda permanente de ativos.',
      'Você é responsável por validar cada operação antes de assinar, aprovar ou enviar, incluindo rede, endereço, ativo, valor, taxa, carteira e contexto do contrato.'
    ]
  },
  {
    id: 'custodia',
    title: '4. Custódia e segurança da carteira',
    body: [
      'Você é o único responsável por proteger a sua carteira, seed phrase, chaves privadas, extensões, dispositivos, permissões, assinaturas e ambiente de navegação.',
      'O Genesis Miner não guarda seed phrase nem chave privada e não consegue recuperar ativos perdidos por erro do utilizador, comprometimento externo da carteira, phishing, malware, assinatura indevida ou acesso não autorizado ao dispositivo.'
    ]
  },
  {
    id: 'infraestrutura',
    title: '5. Infraestrutura de terceiros',
    body: [
      'Carteiras, RPCs, bridges, exploradores, blockchains, validadores, indexadores e serviços de terceiros podem ficar indisponíveis, falhar, atrasar, divergir, sofrer congestionamento ou apresentar comportamentos fora do nosso controlo.',
      'Falhas desses fornecedores podem afetar disponibilidade, tempos de confirmação, leitura de estado, compatibilidade de carteira e execução prática de certas funcionalidades.'
    ]
  },
  {
    id: 'responsabilidade',
    title: '6. Responsabilidade do utilizador',
    body: [
      'Você deve usar a plataforma apenas se compreender estes riscos e aceitar responsabilidade pelas suas decisões relacionadas com integrações Web3.',
      'Se não compreender plenamente os riscos de blockchain, carteiras e transações irreversíveis, a recomendação é não utilizar funcionalidades on-chain até obter conhecimento suficiente para operar de forma consciente.'
    ]
  }
];

export const Web3RiskPage: React.FC = () => {
  return (
    <LegalPageLayout
      title="Aviso de Risco Web3 / Cripto"
      intro="Este aviso resume os principais riscos relacionados com carteiras, ativos digitais, blockchain e funcionalidades Web3 do Genesis Miner."
      updatedAt="21 de maio de 2026"
      accentClass="text-yellow-700 dark:text-yellow-400"
      accentHoverClass="hover:text-yellow-600 dark:hover:text-yellow-300"
      iconClass="text-yellow-600 dark:text-yellow-500"
      icon={TriangleAlert}
      sections={sections}
    />
  );
};
