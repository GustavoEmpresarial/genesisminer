import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { LegalPageLayout, type LegalSection } from './LegalPageLayout';

const sections: LegalSection[] = [
  {
    id: 'objetivo',
    title: '1. Objetivo',
    body: [
      'Esta política define medidas de AML, antifraude, verificação, controlo de abuso e conformidade adotadas pelo Genesis Miner para proteger a plataforma, os utilizadores e as operações ligadas a conta, saldo, recompensas, carteira, saques e integrações externas.',
      'O objetivo principal é reduzir risco operacional, prevenir uso ilícito da infraestrutura, mitigar manipulações económicas e permitir resposta rápida a comportamentos incompatíveis com segurança, integridade do jogo e requisitos legais aplicáveis.'
    ]
  },
  {
    id: 'condutas-proibidas',
    title: '2. Condutas proibidas',
    body: [
      'É proibido utilizar a plataforma para lavagem de dinheiro, fraude, financiamento ilícito, evasão de sanções, falsidade ideológica, uso de identidade enganosa, manipulação de saques, exploração de recompensas, criação massiva de contas, autoindicação fraudulenta ou qualquer atividade ilícita.',
      'Também é proibido usar automação, scripts, bots, técnicas de ocultação de origem, adulteração de dispositivo, engenharia de comportamento, proxies abusivos, contas encadeadas ou qualquer método destinado a contornar controlos internos.',
      'Tentativas de manipular a economia interna, gerar saldos artificiais, explorar falhas para vantagem indevida ou forjar legitimidade de operações poderão ser tratadas como fraude grave, mesmo que o comportamento explore imperfeições técnicas do sistema.'
    ]
  },
  {
    id: 'monitorizacao',
    title: '3. Monitorização e análise de risco',
    body: [
      'Podemos monitorizar atividade de conta, padrões de login, IP, dispositivo, sessões, comportamento económico, depósitos, saques, uso de carteira, tentativas falhadas, sinais de abuso e indicadores internos de risco.',
      'Esses controlos podem envolver análise manual, pontuação automatizada, detecção de anomalias, comparação de padrões, correlação entre contas e limitação temporária de funcionalidades quando necessário.',
      'A monitorização é orientada por critérios operacionais e de segurança e pode continuar mesmo após determinada ação ser concluída, inclusive para investigação retroativa, auditoria e resposta a incidentes.'
    ]
  },
  {
    id: 'verificacao',
    title: '4. Verificação e pedidos adicionais',
    body: [
      'Podemos solicitar informações adicionais para validar identidade, titularidade de conta, origem de atividade, legitimidade de pedidos, coerência de dados e segurança operacional.',
      'Dependendo do risco identificado, a revisão pode incluir confirmação de e-mail, validação de conta, análise de comportamento, prova adicional de legitimidade da operação ou outros mecanismos compatíveis com a natureza do serviço.',
      'A ausência de cooperação, inconsistências graves, documentação insuficiente ou indícios razoáveis de abuso podem resultar em suspensão, bloqueio, atraso de saque, limitação de funcionalidades ou encerramento de conta.'
    ]
  },
  {
    id: 'medidas',
    title: '5. Medidas que podemos adotar',
    body: [
      'Podemos limitar funcionalidades, congelar saldos, impedir saques, cancelar recompensas abusivas, reverter vantagens indevidas, bloquear acesso, encerrar conta e comunicar atividade às autoridades competentes quando a lei exigir ou quando houver suspeita razoável de fraude ou ilicitude.',
      'Sempre que operacionalmente adequado, as medidas adotadas serão proporcionais ao risco identificado, mas o Genesis Miner poderá aplicar ações preventivas imediatas quando existir ameaça relevante para a plataforma ou para terceiros.'
    ]
  },
  {
    id: 'cooperacao',
    title: '6. Cooperação e cumprimento legal',
    body: [
      'O Genesis Miner pode cooperar com autoridades, ordens legais, investigações, pedidos formalmente válidos e requisitos regulatórios na medida exigida pela legislação aplicável.',
      'A cooperação pode incluir preservação de registos, resposta a solicitações legítimas, fornecimento de informação permitida por lei e adoção de medidas internas para impedir continuação de atividade suspeita.'
    ]
  }
];

export const AmlPolicyPage: React.FC = () => {
  return (
    <LegalPageLayout
      title="Política de AML / Antifraude / KYC"
      intro="Esta política resume práticas de prevenção a fraude, lavagem de dinheiro, abuso de conta e verificações operacionais do Genesis Miner."
      updatedAt="21 de maio de 2026"
      accentClass="text-red-700 dark:text-red-400"
      accentHoverClass="hover:text-red-600 dark:hover:text-red-300"
      iconClass="text-red-600 dark:text-red-500"
      icon={ShieldAlert}
      sections={sections}
    />
  );
};
