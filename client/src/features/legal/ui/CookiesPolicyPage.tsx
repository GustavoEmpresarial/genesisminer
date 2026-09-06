import React from 'react';
import { Cookie } from 'lucide-react';
import { LegalPageLayout, type LegalSection } from './LegalPageLayout';

const sections: LegalSection[] = [
  {
    id: 'o-que-sao',
    title: '1. O que são cookies e tecnologias semelhantes',
    body: [
      'Cookies são pequenos ficheiros armazenados no navegador, dispositivo ou sessão para reconhecer o ambiente de acesso, manter autenticação, recordar preferências e dar suporte técnico ao funcionamento contínuo do Genesis Miner.',
      'Além de cookies tradicionais, o Genesis Miner pode utilizar armazenamento local do navegador, session storage, identificadores temporários, tokens de sessão, cache de aplicação, mecanismos antifraude e tecnologias equivalentes necessárias para estabilidade, segurança e continuidade das funcionalidades.',
      'Sempre que esta política mencionar “cookies”, a referência deve ser entendida de forma ampla, incluindo tecnologias semelhantes usadas para finalidades compatíveis com operação, segurança, medição e experiência do utilizador.'
    ]
  },
  {
    id: 'como-usamos',
    title: '2. Como usamos cookies',
    body: [
      'Utilizamos cookies e mecanismos equivalentes para autenticação, manutenção de sessão, segurança da conta, prevenção a fraude, limitação de abuso, persistência de preferências de interface, carregamento eficiente de recursos e estabilidade geral da aplicação.',
      'Essas tecnologias também podem ser usadas para registar se uma sessão já foi autenticada, reduzir chamadas desnecessárias a serviços internos, preservar opções de interface como tema visual, recordar estados temporários de navegação e melhorar a continuidade da experiência entre páginas e recarregamentos.',
      'Se mecanismos essenciais forem bloqueados, algumas funcionalidades podem deixar de operar corretamente, incluindo login, recuperação de sessão, proteção antifraude, certas rotas autenticadas e partes do fluxo operacional do jogo.'
    ]
  },
  {
    id: 'tipos',
    title: '3. Tipos de cookies que podem ser usados',
    body: [
      'Cookies estritamente necessários: essenciais para login, sessão, segurança, balanceamento técnico, proteção contra abuso e funcionamento básico do site e da aplicação.',
      'Cookies funcionais: usados para lembrar preferências, tema, idioma, configuração visual, estado de navegação, avisos já lidos ou outras escolhas feitas pelo utilizador.',
      'Cookies analíticos ou de medição: podem ser usados para compreender desempenho, erros, disponibilidade, uso agregado, comportamento de páginas e oportunidades de melhoria do produto, conforme a configuração ativa na plataforma.',
      'Cookies de integração ou multimédia: podem ser ativados quando recursos incorporados, fornecedores externos, players de vídeo, widgets ou ferramentas de terceiros forem carregados dentro da experiência do Genesis Miner.',
      'Nem todos os tipos acima estarão necessariamente ativos em todos os momentos. O conjunto efetivamente usado depende da versão do produto, dos serviços integrados e das ferramentas habilitadas em cada ambiente.'
    ]
  },
  {
    id: 'terceiros',
    title: '4. Cookies e tecnologias de terceiros',
    body: [
      'Alguns serviços externos integrados ao Genesis Miner podem definir, ler ou depender de cookies próprios, de acordo com as respetivas políticas e com o modo como esses serviços são carregados na plataforma.',
      'Esses terceiros podem incluir fornecedores de analytics, monitorização, segurança, proteção contra abuso, infraestrutura, multimédia incorporada, carteiras, serviços de rede, medição de desempenho ou publicidade, quando aplicável.',
      'O Genesis Miner não controla integralmente a política de cookies de terceiros. Sempre que você interage com uma funcionalidade operada por fornecedor externo, as práticas desse terceiro também podem ser relevantes.'
    ]
  },
  {
    id: 'gestao',
    title: '5. Como gerir cookies',
    body: [
      'Você pode gerir cookies por meio das configurações do navegador, extensões de privacidade, controlos do sistema operativo e, quando disponibilizado, por mecanismos internos da própria plataforma.',
      'Dependendo da jurisdição aplicável e da natureza do cookie, o Genesis Miner poderá apresentar mecanismos adicionais de consentimento, recusa ou personalização.',
      'A desativação de cookies estritamente necessários ou tecnologias equivalentes pode impedir login, persistência de sessão, continuidade de segurança, utilização de áreas autenticadas e funcionamento normal de elementos críticos do produto.'
    ]
  },
  {
    id: 'alteracoes',
    title: '6. Alterações',
    body: [
      'Podemos atualizar esta política sempre que mudarem as tecnologias usadas pelo Genesis Miner, os fornecedores integrados, os requisitos regulatórios ou a forma como funcionalidades do produto operam.',
      'A versão mais recente será publicada nas páginas legais da plataforma com data de atualização revista. Quando exigido por lei, poderemos apresentar aviso adicional ou recolher novo consentimento antes da ativação de determinadas categorias de cookies.'
    ]
  }
];

export const CookiesPolicyPage: React.FC = () => {
  return (
    <LegalPageLayout
      title="Política de Cookies"
      intro="Esta política descreve como o Genesis Miner utiliza cookies, armazenamento local e tecnologias semelhantes."
      updatedAt="21 de maio de 2026"
      accentClass="text-orange-700 dark:text-orange-400"
      accentHoverClass="hover:text-orange-600 dark:hover:text-orange-300"
      iconClass="text-orange-600 dark:text-orange-500"
      icon={Cookie}
      sections={sections}
    />
  );
};
