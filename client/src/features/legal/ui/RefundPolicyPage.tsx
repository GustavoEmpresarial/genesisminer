import React from 'react';
import { ReceiptText } from 'lucide-react';
import { LegalPageLayout, type LegalSection } from './LegalPageLayout';

const sections: LegalSection[] = [
  {
    id: 'escopo',
    title: '1. Escopo',
    body: [
      'Esta política descreve como o Genesis Miner trata pedidos de reembolso relacionados com compras, créditos, itens digitais, depósitos, ativações e serviços internos, sempre sujeitos à legislação obrigatória aplicável.',
      'A existência desta política não significa que todo pagamento, crédito ou operação é automaticamente reembolsável. Cada caso depende da natureza do bem digital, do estado de consumo, do método utilizado, do histórico da conta e das exigências legais aplicáveis.'
    ]
  },
  {
    id: 'itens-digitais',
    title: '2. Itens digitais e entregas consumadas',
    body: [
      'Compras de itens digitais, benefícios internos, entregas instantâneas, moedas, upgrades, vantagens operacionais e conteúdos consumíveis podem ser consideradas consumadas assim que creditadas, ativadas, disponibilizadas ou usadas na conta.',
      'Quando a entrega digital já tiver sido disponibilizada, consumida, resgatada, utilizada para progresso ou convertida em benefício interno, pedidos de reembolso podem ser recusados quando permitido por lei.',
      'O simples facto de o utilizador mudar de opinião, deixar de querer usar o item ou discordar do resultado económico da sua decisão não gera, por si só, obrigação automática de reembolso.'
    ]
  },
  {
    id: 'depositos',
    title: '3. Depósitos e operações blockchain',
    body: [
      'Depósitos on-chain, transferências blockchain e operações externas geralmente não podem ser revertidos pelo Genesis Miner, porque dependem de redes e infraestruturas que operam fora do controlo direto da plataforma.',
      'Taxas de rede, erros de envio, rede errada, token errado, carteira incorreta, falha do utilizador ao validar a operação ou envio para destino inadequado não geram obrigação automática de reembolso pela plataforma.',
      'Quando houver necessidade de análise, o Genesis Miner poderá solicitar elementos mínimos para identificar a operação, mas isso não implica aceitação prévia do pedido.'
    ]
  },
  {
    id: 'fraude-abuso',
    title: '4. Fraude, chargeback e abuso',
    body: [
      'Pedidos ligados a fraude, chargeback abusivo, uso indevido, exploração de falhas, múltiplas contas, manipulação de saldo, ocultação de informação relevante ou violação dos Termos podem ser recusados e podem levar a restrições adicionais na conta.',
      'Quando um pedido de reembolso estiver ligado a comportamento suspeito, o Genesis Miner poderá suspender funcionalidades, rever saldos, congelar operações ou exigir verificação adicional antes de decidir.'
    ]
  },
  {
    id: 'analise',
    title: '5. Análise de pedidos',
    body: [
      'Cada pedido poderá ser analisado segundo histórico da conta, estado do bem ou serviço digital, uso já ocorrido, risco operacional, conformidade, meio de pagamento, data da operação e direitos legais obrigatórios do consumidor.',
      'O Genesis Miner poderá deferir, indeferir, pedir informação complementar ou propor solução alternativa compatível com a natureza da operação e com a lei aplicável.'
    ]
  },
  {
    id: 'contacto',
    title: '6. Como pedir análise',
    body: [
      'Para solicitar análise de reembolso, use os canais oficiais de suporte com o máximo de detalhe possível sobre a operação, a conta, a data, o motivo do pedido e qualquer referência útil para localizar a transação.',
      'Pedidos incompletos, contraditórios, abusivos ou formulados fora dos canais oficiais podem ser recusados ou exigir nova submissão em formato adequado.'
    ]
  }
];

export const RefundPolicyPage: React.FC = () => {
  return (
    <LegalPageLayout
      title="Política de Reembolsos"
      intro="Esta política resume como o Genesis Miner trata pedidos de reembolso, estorno e revisão de compras ou operações."
      updatedAt="21 de maio de 2026"
      accentClass="text-cyan-700 dark:text-cyan-400"
      accentHoverClass="hover:text-cyan-600 dark:hover:text-cyan-300"
      iconClass="text-cyan-600 dark:text-cyan-500"
      icon={ReceiptText}
      sections={sections}
    />
  );
};
