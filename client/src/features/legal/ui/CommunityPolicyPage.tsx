import React from 'react';
import { MessagesSquare } from 'lucide-react';
import { LegalPageLayout, type LegalSection } from './LegalPageLayout';

const sections: LegalSection[] = [
  {
    id: 'objetivo',
    title: '1. Objetivo',
    body: [
      'Esta política define padrões mínimos de convivência, conduta, conteúdo e uso aceitável em áreas sociais, suporte, comunicação e interações dentro do ecossistema Genesis Miner.',
      'O objetivo é proteger a comunidade, reduzir abuso, manter um ambiente funcional para suporte e colaboração e permitir moderação consistente quando ocorrer comportamento indevido.'
    ]
  },
  {
    id: 'conteudo-proibido',
    title: '2. Conteúdo proibido',
    body: [
      'É proibido publicar ou transmitir conteúdo ilegal, ameaçador, difamatório, violento, discriminatório, obsceno, enganoso, fraudulento, malicioso ou que coloque terceiros em risco.',
      'Também é proibido conteúdo sexual envolvendo menores, incentivo à violência, discurso de ódio, perseguição, assédio, extorsão, phishing, engenharia social ou divulgação indevida de dados pessoais.',
      'Conteúdo que tente confundir utilizadores sobre identidade, suporte oficial, garantias financeiras, supostas parcerias ou legitimidade de operações também pode ser removido.'
    ]
  },
  {
    id: 'conduta',
    title: '3. Regras de conduta',
    body: [
      'Você deve manter comportamento respeitoso com equipa, comunidade, parceiros e outros utilizadores.',
      'Spam, flood, abuso de suporte, tentativas de manipulação social, impersonação, anúncios não autorizados, phishing, provocação persistente, ofensas repetidas e perturbação intencional da comunidade são proibidos.',
      'O uso abusivo de canais de suporte, inclusive reenvio massivo de mensagens, anexos maliciosos, falsas urgências ou tentativas de pressionar a equipa com informação enganosa, pode levar a restrições imediatas.'
    ]
  },
  {
    id: 'propriedade',
    title: '4. Direitos sobre conteúdo submetido',
    body: [
      'Você só deve partilhar conteúdo sobre o qual possua direitos suficientes. Continua responsável por tudo o que publicar ou enviar através dos serviços.',
      'Ao submeter conteúdo dentro das áreas funcionais da plataforma, você declara que esse material não viola direitos de terceiros e que pode ser tratado, exibido, moderado, armazenado e removido pelo Genesis Miner para fins operacionais do serviço.'
    ]
  },
  {
    id: 'moderacao',
    title: '5. Moderação e aplicação',
    body: [
      'Podemos moderar, ocultar, remover conteúdo, limitar contas, restringir canais, suspender utilizadores ou encerrar contas quando necessário para segurança, legalidade e integridade da comunidade.',
      'As medidas podem ser preventivas ou reativas e não dependem necessariamente de aviso prévio quando houver risco relevante, reincidência, abuso grave ou necessidade de resposta urgente.'
    ]
  },
  {
    id: 'denuncias',
    title: '6. Denúncias',
    body: [
      'Se encontrar conteúdo abusivo, suspeito ou contrário a esta política, utilize os canais oficiais de suporte ou denúncia disponibilizados pela equipa.',
      'Denúncias falsas, maliciosas ou usadas como instrumento de perseguição também podem constituir violação desta política.'
    ]
  }
];

export const CommunityPolicyPage: React.FC = () => {
  return (
    <LegalPageLayout
      title="Política de Conteúdo e Comunidade"
      intro="Esta política resume regras de convivência, moderação e uso aceitável de conteúdo no Genesis Miner."
      updatedAt="21 de maio de 2026"
      accentClass="text-violet-700 dark:text-violet-400"
      accentHoverClass="hover:text-violet-600 dark:hover:text-violet-300"
      iconClass="text-violet-600 dark:text-violet-500"
      icon={MessagesSquare}
      sections={sections}
    />
  );
};
